import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { UnrecoverableError, Job } from 'bullmq';
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
import { getVideoFixtures } from '../test/video-fixture';
import storageConfig from '../config/storage.config';
import processingConfig from '../config/processing.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { ProcessingModule } from './processing.module';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';
import type { ProcessVideoJobData } from '../queue/queue.types';

// STORAGE_PUBLIC_ENDPOINT (http://localhost:9000 by default) is the browser-facing
// address and is not reachable from inside this container's network namespace — this
// suite verifies the stored thumbnail with an unsigned public-endpoint GET (see the
// same override and rationale in storage.service.integration-spec.ts).
process.env.STORAGE_PUBLIC_ENDPOINT = 'http://minio:9000';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let processor: VideoProcessor;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let storageService: StorageService;
  const videoBucket = process.env.STORAGE_VIDEO_BUCKET || 'videos';
  const thumbnailBucket = process.env.STORAGE_THUMBNAIL_BUCKET || 'thumbnails';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, processingConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, User, Channel]),
        StorageModule,
        ProcessingModule,
      ],
    }).compile();

    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));
    storageService = module.get(StorageService);
    const ffmpegService = module.get(FfmpegService);

    processor = new VideoProcessor(
      videoRepository,
      storageService,
      ffmpegService,
      module.get(storageConfig.KEY),
      module.get(processingConfig.KEY),
    );
  }, 60000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `processor_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `proc_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function createProcessingVideo(
    channelId: string,
    storageKey: string,
  ): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        id: randomUUID(),
        public_id: randomUUID().replace(/-/g, '').slice(0, 12),
        channel_id: channelId,
        title: 'Test video',
        original_filename: 'trip.mp4',
        content_type: 'video/mp4',
        size_bytes: '1000',
        status: VideoStatus.PROCESSING,
        storage_key: storageKey,
        upload_id: null,
        part_size_bytes: 5242880,
        part_count: 1,
      }),
    );
  }

  function makeJob(videoId: string): Job<ProcessVideoJobData> {
    return {
      data: { videoId },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as Job<ProcessVideoJobData>;
  }

  it('turns a processing row with a real MP4 source into ready, with metadata and a stored thumbnail', async () => {
    const channel = await createChannel();
    const fixtures = getVideoFixtures();
    const key = `videos/${randomUUID()}/source.mp4`;
    await storageService.putObject(
      videoBucket,
      key,
      readFileSync(fixtures.plainMp4Path),
      'video/mp4',
    );
    const video = await createProcessingVideo(channel.id, key);

    await processor.process(makeJob(video.id));

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(Number(updated.duration_seconds)).toBeCloseTo(3, 0);
    expect(updated.width).toBe(320);
    expect(updated.height).toBe(240);
    expect(updated.codec_name).toBe('h264');
    expect(updated.container_format).toContain('mp4');
    expect(updated.moov_at_end).not.toBeNull();
    expect(updated.metadata).toBeTruthy();
    expect(updated.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(updated.processing_attempts).toBe(1);
    expect(updated.processed_at).toBeTruthy();

    const thumbUrl = storageService.getThumbnailPublicUrl(
      updated.thumbnail_key!,
    );
    const res = await fetch(thumbUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');

    await storageService.deleteByPrefix(videoBucket, `videos/${video.id}/`);
    await storageService.deleteByPrefix(
      thumbnailBucket,
      updated.thumbnail_key!,
    );
  }, 30000);

  it('marks a non-media source failed(INVALID_MEDIA) and throws UnrecoverableError', async () => {
    const channel = await createChannel();
    const fixtures = getVideoFixtures();
    const key = `videos/${randomUUID()}/source.mp4`;
    await storageService.putObject(
      videoBucket,
      key,
      readFileSync(fixtures.nonMediaPath),
      'video/mp4',
    );
    const video = await createProcessingVideo(channel.id, key);

    await expect(processor.process(makeJob(video.id))).rejects.toThrow(
      UnrecoverableError,
    );

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.FAILED);
    expect(updated.error_reason).toBe(VideoErrorReason.INVALID_MEDIA);
    expect(updated.error_detail).toBeTruthy();
    expect(updated.processing_attempts).toBe(1);

    await storageService.deleteByPrefix(videoBucket, `videos/${video.id}/`);
  }, 30000);
});
