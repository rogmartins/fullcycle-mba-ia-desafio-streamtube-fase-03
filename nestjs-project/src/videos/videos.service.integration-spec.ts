import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.types';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import { VideoQueueService } from '../queue/video-queue.service';
import {
  VIDEO_PROCESSING_QUEUE,
  processingJobId,
} from '../queue/queue.constants';
import { VideosService } from './videos.service';

// STORAGE_PUBLIC_ENDPOINT (http://localhost:9000 by default) is the browser-facing
// address and is not reachable from inside this container's network namespace. This
// suite runs inside the nestjs-api container and fetches presigned URLs directly, so
// it points the "public" client at the Compose service name instead (see the same
// override and rationale in storage.service.integration-spec.ts).
process.env.STORAGE_PUBLIC_ENDPOINT = 'http://minio:9000';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storageService: StorageService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let videoQueueService: VideoQueueService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, User]),
        ChannelsModule,
        StorageModule,
        QueueModule,
      ],
      providers: [VideosService],
    }).compile();

    service = module.get(VideosService);
    storageService = module.get(StorageService);
    channelsService = module.get(ChannelsService);
    dataSource = module.get(DataSource);
    userRepository = module.get(getRepositoryToken(User));
    videoRepository = module.get(getRepositoryToken(Video));
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    videoQueueService = module.get(VideoQueueService);
  });

  afterAll(async () => {
    await queue.close();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createConfirmedUserWithChannel(): Promise<{
    userId: string;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vsvc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelsService.createChannel(user.id, user.email);
    return { userId: user.id };
  }

  it('persists a row in uploading with upload_id set and a visible multipart upload', async () => {
    const { userId } = await createConfirmedUserWithChannel();

    const video = await service.createUpload(userId, {
      filename: 'trip.mp4',
      size_bytes: 1000,
      content_type: 'video/mp4',
    });

    expect(video.status).toBe(VideoStatus.UPLOADING);
    expect(video.upload_id).toBeTruthy();

    const uploads = await storageService.listMultipartUploads(
      `videos/${video.id}/`,
    );
    expect(uploads.some((u) => u.uploadId === video.upload_id)).toBe(true);

    await storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id!,
    );
  });

  it('counts only uploading rows of the same channel toward the cap', async () => {
    const { userId } = await createConfirmedUserWithChannel();
    const created: Video[] = [];

    for (let i = 0; i < 5; i++) {
      const v = await service.createUpload(userId, {
        filename: `trip${i}.mp4`,
        size_bytes: 1000,
        content_type: 'video/mp4',
      });
      created.push(v);
    }

    // Mark one as ready — it should no longer count toward the open-upload cap.
    await videoRepository.update(created[0].id, { status: VideoStatus.READY });

    const video = await service.createUpload(userId, {
      filename: 'another.mp4',
      size_bytes: 1000,
      content_type: 'video/mp4',
    });
    expect(video.status).toBe(VideoStatus.UPLOADING);
    created.push(video);

    for (const v of created) {
      if (v.upload_id) {
        await storageService
          .abortMultipartUpload(v.storage_key, v.upload_id)
          .catch(() => undefined);
      }
    }
  });

  it('signs a part URL that accepts a real PUT, and listUploadedParts reflects it', async () => {
    const { userId } = await createConfirmedUserWithChannel();
    const video = await service.createUpload(userId, {
      filename: 'trip.mp4',
      size_bytes: 5 * 1024 * 1024,
      content_type: 'video/mp4',
    });

    const signed = await service.signPart(video.id, userId, 1);
    const putResponse = await fetch(signed.url, {
      method: 'PUT',
      body: Buffer.alloc(5 * 1024 * 1024, 'a'),
    });
    expect(putResponse.status).toBe(200);

    const parts = await service.listUploadedParts(video.id, userId);
    expect(parts).toHaveLength(1);
    expect(parts[0].part_number).toBe(1);
    expect(parts[0].etag).toBe(putResponse.headers.get('etag'));

    await storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id!,
    );
  });

  async function uploadAllParts(
    userId: string,
    video: Video,
  ): Promise<{ part_number: number; etag: string }[]> {
    const parts: { part_number: number; etag: string }[] = [];
    for (let i = 1; i <= video.part_count; i++) {
      const signed = await service.signPart(video.id, userId, i);
      const isLast = i === video.part_count;
      const size = isLast ? 1024 : video.part_size_bytes;
      const res = await fetch(signed.url, {
        method: 'PUT',
        body: Buffer.alloc(size, 'a'),
      });
      parts.push({ part_number: i, etag: res.headers.get('etag')! });
    }
    return parts;
  }

  it('completes a two-part upload into one object, transitions to processing, and enqueues a job', async () => {
    const { userId } = await createConfirmedUserWithChannel();
    // One byte over the default UPLOAD_PART_SIZE_BYTES (52428800) forces exactly 2 parts.
    const video = await service.createUpload(userId, {
      filename: 'trip.mp4',
      size_bytes: 52428800 + 1024,
      content_type: 'video/mp4',
    });
    const parts = await uploadAllParts(userId, video);

    const completed = await service.completeUpload(video.id, userId, parts);

    expect(completed.status).toBe(VideoStatus.PROCESSING);
    expect(completed.uploaded_at).toBeTruthy();

    const exists = await storageService.objectExists(
      'videos',
      video.storage_key,
    );
    expect(exists).toBe(true);

    const job = await queue.getJob(processingJobId(video.id));
    expect(job).toBeDefined();
    expect(await job!.getState()).toBe('waiting');

    await storageService.deleteByPrefix('videos', `videos/${video.id}/`);
  });

  it('cancels an upload: aborts, removes objects under the prefix and deletes the row', async () => {
    const { userId } = await createConfirmedUserWithChannel();
    const video = await service.createUpload(userId, {
      filename: 'trip.mp4',
      size_bytes: 1000,
      content_type: 'video/mp4',
    });

    await service.cancelUpload(video.id, userId);

    await expect(
      videoRepository.findOneByOrFail({ id: video.id }),
    ).rejects.toThrow();
    const uploads = await storageService.listMultipartUploads(
      `videos/${video.id}/`,
    );
    expect(uploads).toHaveLength(0);
  });

  it('runs exactly one of two concurrent completeUpload calls to success', async () => {
    const { userId } = await createConfirmedUserWithChannel();
    const video = await service.createUpload(userId, {
      filename: 'trip.mp4',
      size_bytes: 1000,
      content_type: 'video/mp4',
    });
    const parts = await uploadAllParts(userId, video);

    const results = await Promise.allSettled([
      service.completeUpload(video.id, userId, parts),
      service.completeUpload(video.id, userId, parts),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    await storageService.deleteByPrefix('videos', `videos/${video.id}/`);
  });

  async function createReadyVideo(
    userId: string,
    overrides: { title?: string } = {},
  ): Promise<Video> {
    const video = await service.createUpload(userId, {
      filename: 'trip.mp4',
      size_bytes: 1000,
      content_type: 'video/mp4',
    });
    const parts = await uploadAllParts(userId, video);
    await service.completeUpload(video.id, userId, parts);
    await videoRepository.update(video.id, {
      status: VideoStatus.READY,
      ...(overrides.title ? { title: overrides.title } : {}),
    });
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  it('serves the playback URL of a ready video with Range support (206)', async () => {
    const { userId } = await createConfirmedUserWithChannel();
    const video = await createReadyVideo(userId);

    const playback = await service.getPlaybackUrl(video.public_id);
    expect(playback.expires_at.getTime()).toBeGreaterThan(Date.now());

    const res = await fetch(playback.url, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(res.status).toBe(206);

    await storageService.deleteByPrefix('videos', `videos/${video.id}/`);
  });

  it('returns a download URL whose object carries a sanitized attachment filename', async () => {
    const { userId } = await createConfirmedUserWithChannel();
    const video = await createReadyVideo(userId, {
      title: 'Férias 2026: praia!',
    });

    const download = await service.getDownloadUrl(video.public_id);
    expect(download.filename).toBe('Ferias-2026-praia.mp4');

    const res = await fetch(download.url);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="Ferias-2026-praia.mp4"',
    );

    await storageService.deleteByPrefix('videos', `videos/${video.id}/`);
  });

  it('still completes with a processing row when the queue publish fails (job left to the sweep)', async () => {
    const { userId } = await createConfirmedUserWithChannel();
    const video = await service.createUpload(userId, {
      filename: 'trip.mp4',
      size_bytes: 1000,
      content_type: 'video/mp4',
    });
    const parts = await uploadAllParts(userId, video);

    const enqueueSpy = jest
      .spyOn(videoQueueService, 'enqueueProcessing')
      .mockRejectedValueOnce(new Error('redis unreachable'));

    const completed = await service.completeUpload(video.id, userId, parts);

    expect(completed.status).toBe(VideoStatus.PROCESSING);
    enqueueSpy.mockRestore();

    await storageService.deleteByPrefix('videos', `videos/${video.id}/`);
  });
});
