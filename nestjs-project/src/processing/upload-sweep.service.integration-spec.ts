import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoErrorReason, VideoStatus } from '../videos/videos.types';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { QueueModule } from '../queue/queue.module';
import {
  VIDEO_PROCESSING_QUEUE,
  processingJobId,
} from '../queue/queue.constants';
import { VideoQueueService } from '../queue/video-queue.service';
import { UploadSweepService } from './upload-sweep.service';

// STORAGE_PUBLIC_ENDPOINT (http://localhost:9000 by default) is the browser-facing
// address and is not reachable from inside this container's network namespace. This
// suite runs inside the nestjs-api container and PUTs to presigned URLs directly, so
// it points the "public" client at the Compose service name instead (see the same
// override and rationale in storage.service.integration-spec.ts).
process.env.STORAGE_PUBLIC_ENDPOINT = 'http://minio:9000';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('UploadSweepService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: UploadSweepService;
  let storageService: StorageService;
  let videoQueueService: VideoQueueService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  const videoBucket = process.env.STORAGE_VIDEO_BUCKET || 'videos';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, User, Channel]),
        StorageModule,
        QueueModule,
      ],
      providers: [UploadSweepService],
    }).compile();

    dataSource = module.get(DataSource);
    service = module.get(UploadSweepService);
    storageService = module.get(StorageService);
    videoQueueService = module.get(VideoQueueService);
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));
    videoRepository = module.get(getRepositoryToken(Video));
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 60000);

  afterAll(async () => {
    await queue.close();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `sweep_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `sweep_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function backdate(
    videoId: string,
    column: 'created_at' | 'uploaded_at',
    date: Date,
  ): Promise<void> {
    await dataSource.query(`UPDATE videos SET ${column} = $1 WHERE id = $2`, [
      date,
      videoId,
    ]);
  }

  async function createUploadingRow(
    channelId: string,
    storageKey: string,
    uploadId: string | null,
  ): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        id: randomUUID(),
        public_id: randomUUID().replace(/-/g, '').slice(0, 12),
        channel_id: channelId,
        title: 'Sweep video',
        original_filename: 'trip.mp4',
        content_type: 'video/mp4',
        size_bytes: '1000',
        status: VideoStatus.UPLOADING,
        storage_key: storageKey,
        upload_id: uploadId,
        part_size_bytes: 5242880,
        part_count: 1,
      }),
    );
  }

  it('(a) reconciles a completed-but-unrecorded upload into processing with a job', async () => {
    const channel = await createChannel();
    const key = `videos/${randomUUID()}/source.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    const { url } = await storageService.presignUploadPart(
      key,
      uploadId,
      1,
      3600,
    );
    const putRes = await fetch(url, {
      method: 'PUT',
      body: Buffer.alloc(1024, 'a'),
    });
    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: putRes.headers.get('etag')! },
    ]);
    const video = await createUploadingRow(channel.id, key, uploadId);
    await backdate(
      video.id,
      'created_at',
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );

    const report = await service.run();

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.PROCESSING);
    expect(report.completed).toBeGreaterThanOrEqual(1);
    const job = await queue.getJob(processingJobId(video.id));
    expect(job).toBeDefined();

    await storageService.deleteByPrefix(videoBucket, `videos/${video.id}/`);
  }, 30000);

  it('(b) marks failed(UPLOAD_ABANDONED) when the upload is gone and no object exists', async () => {
    const channel = await createChannel();
    const key = `videos/${randomUUID()}/source.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    await storageService.abortMultipartUpload(key, uploadId);
    const video = await createUploadingRow(channel.id, key, uploadId);
    await backdate(
      video.id,
      'created_at',
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );

    const report = await service.run();

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.FAILED);
    expect(updated.error_reason).toBe(VideoErrorReason.UPLOAD_ABANDONED);
    expect(report.abandoned).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('(c) aborts an 8-day-old upload and marks it failed', async () => {
    // MinIO stamps a part's last_modified with the real wall-clock PUT time — it
    // cannot be back-dated through the API. This exercises the same "newest
    // activity older than SWEEP_ABANDON_DAYS" comparison via its created_at
    // fallback (no part ever uploaded), which the unit suite's mocked-lastModified
    // case (`upload-sweep.service.spec.ts`) covers for the with-parts branch.
    const channel = await createChannel();
    const key = `videos/${randomUUID()}/source.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    const video = await createUploadingRow(channel.id, key, uploadId);
    await backdate(
      video.id,
      'created_at',
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );

    const report = await service.run();

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.FAILED);
    expect(updated.error_reason).toBe(VideoErrorReason.UPLOAD_ABANDONED);
    expect(report.abandoned).toBeGreaterThanOrEqual(1);

    const remainingUploads = await storageService.listMultipartUploads(
      `videos/${video.id}/`,
    );
    expect(remainingUploads).toHaveLength(0);
  }, 30000);

  it('(d) a fresh upload older than the stale threshold but with a recent part is left untouched', async () => {
    const channel = await createChannel();
    const key = `videos/${randomUUID()}/source.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    const { url } = await storageService.presignUploadPart(
      key,
      uploadId,
      1,
      3600,
    );
    await fetch(url, { method: 'PUT', body: Buffer.alloc(1024, 'a') });
    const video = await createUploadingRow(channel.id, key, uploadId);
    await backdate(
      video.id,
      'created_at',
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );

    await service.run();

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.UPLOADING);

    await storageService.abortMultipartUpload(key, uploadId);
  }, 30000);

  it('re-enqueues a stale processing row that has no active job', async () => {
    const channel = await createChannel();
    const video = await createUploadingRow(
      channel.id,
      `videos/${randomUUID()}/source.mp4`,
      null,
    );
    await videoRepository.update(video.id, { status: VideoStatus.PROCESSING });
    await backdate(
      video.id,
      'uploaded_at',
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );

    const hasJobBefore = await videoQueueService.hasActiveProcessingJob(
      video.id,
    );
    expect(hasJobBefore).toBe(false);

    const report = await service.run();

    expect(report.reenqueued).toBeGreaterThanOrEqual(1);
    const job = await queue.getJob(processingJobId(video.id));
    expect(job).toBeDefined();
  }, 30000);

  it('aborts an orphaned multipart upload under videos/ that matches no uploading row', async () => {
    const key = `videos/${randomUUID()}/source.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );

    const report = await service.run();

    expect(report.orphansAborted).toBeGreaterThanOrEqual(1);
    const remaining = await storageService.listMultipartUploads(
      key.replace('/source.mp4', '/'),
    );
    expect(remaining.some((u) => u.uploadId === uploadId)).toBe(false);
  }, 30000);
});
