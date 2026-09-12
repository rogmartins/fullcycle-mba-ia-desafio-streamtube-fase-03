import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VideoQueueService } from './video-queue.service';
import { VIDEO_PROCESSING_QUEUE, processingJobId } from './queue.constants';

describe('VideoQueueService (integration)', () => {
  let module: TestingModule;
  let service: VideoQueueService;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    service = module.get(VideoQueueService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.close();
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('enqueues exactly one job with the expected id and data', async () => {
    const videoId = 'video-1';
    await service.enqueueProcessing(videoId);

    const job = await queue.getJob(processingJobId(videoId));
    expect(job).toBeDefined();
    expect(job!.data).toEqual({ videoId });
    expect(await job!.getState()).toBe('waiting');
  });

  it('does not create a second job when enqueued twice for the same video', async () => {
    const videoId = 'video-2';
    await service.enqueueProcessing(videoId);
    await service.enqueueProcessing(videoId);

    const counts = await queue.getJobCounts('waiting');
    expect(counts.waiting).toBe(1);
  });

  it('carries 3 attempts and exponential backoff starting at 30s', async () => {
    const videoId = 'video-3';
    await service.enqueueProcessing(videoId);

    const job = await queue.getJob(processingJobId(videoId));
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 30000 });
  });

  it('hasActiveProcessingJob is true while waiting and false after removal', async () => {
    const videoId = 'video-4';
    expect(await service.hasActiveProcessingJob(videoId)).toBe(false);

    await service.enqueueProcessing(videoId);
    expect(await service.hasActiveProcessingJob(videoId)).toBe(true);

    const job = await queue.getJob(processingJobId(videoId));
    await job!.remove();
    expect(await service.hasActiveProcessingJob(videoId)).toBe(false);
  });
});
