import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  processingJobId,
} from './queue.constants';
import type { ProcessVideoJobData } from './queue.types';

const ACTIVE_JOB_STATES = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
] as const;

@Injectable()
export class VideoQueueService implements OnModuleInit {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  // Forces bootstrap to fail fast when Redis is unreachable, rather than the
  // application starting successfully while BullMQ retries in the background.
  async onModuleInit(): Promise<void> {
    await this.queue.waitUntilReady();
  }

  async enqueueProcessing(videoId: string): Promise<string> {
    const job = await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { jobId: processingJobId(videoId) },
    );
    return job.id!;
  }

  async hasActiveProcessingJob(videoId: string): Promise<boolean> {
    const job = await this.queue.getJob(processingJobId(videoId));
    if (!job) {
      return false;
    }
    const state = await job.getState();
    return (ACTIVE_JOB_STATES as readonly string[]).includes(state);
  }
}
