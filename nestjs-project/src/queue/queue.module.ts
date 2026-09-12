import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import { VideoQueueService } from './video-queue.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.redisHost,
          port: config.redisPort,
          // Bounded retry so an unreachable Redis fails bootstrap fast instead of
          // retrying forever in the background (ioredis's default behavior).
          retryStrategy: (times: number) =>
            times > 5 ? null : Math.min(times * 200, 2000),
        },
        defaultJobOptions: {
          attempts: config.jobAttempts,
          backoff: {
            type: 'exponential',
            delay: config.jobBackoffMs,
          },
          removeOnComplete: true,
          removeOnFail: true,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: VIDEO_PROCESSING_QUEUE },
      { name: VIDEO_MAINTENANCE_QUEUE },
    ),
  ],
  providers: [VideoQueueService],
  exports: [BullModule, VideoQueueService],
})
export class QueueModule {}
