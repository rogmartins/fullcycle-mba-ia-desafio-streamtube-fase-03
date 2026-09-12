import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VideoQueueService } from './video-queue.service';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';

describe('QueueModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)).close();
    await module.get<Queue>(getQueueToken(VIDEO_MAINTENANCE_QUEUE)).close();
    await module.close();
  });

  it('resolves BullModule with both queues registered from queueConfig', () => {
    expect(
      module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)),
    ).toBeInstanceOf(Queue);
    expect(
      module.get<Queue>(getQueueToken(VIDEO_MAINTENANCE_QUEUE)),
    ).toBeInstanceOf(Queue);
  });

  it('resolves VideoQueueService', () => {
    expect(module.get(VideoQueueService)).toBeInstanceOf(VideoQueueService);
  });
});
