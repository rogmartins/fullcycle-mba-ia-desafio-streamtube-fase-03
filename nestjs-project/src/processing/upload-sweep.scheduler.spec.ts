import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import { VIDEO_MAINTENANCE_QUEUE } from '../queue/queue.constants';
import { UploadSweepScheduler } from './upload-sweep.scheduler';

describe('UploadSweepScheduler (unit, real Redis)', () => {
  let module: TestingModule;
  let queue: Queue;
  let scheduler: UploadSweepScheduler;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
      providers: [UploadSweepScheduler],
    }).compile();

    queue = module.get(getQueueToken(VIDEO_MAINTENANCE_QUEUE));
    scheduler = module.get(UploadSweepScheduler);
  }, 30000);

  afterAll(async () => {
    await queue.close();
    await module.close();
  });

  beforeEach(async () => {
    const schedulers = await queue.getJobSchedulers();
    for (const s of schedulers) {
      await queue.removeJobScheduler(s.key);
    }
  });

  it('registers exactly one "upload-sweep-every" scheduler with the configured interval', async () => {
    await scheduler.onApplicationBootstrap();

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0].key).toBe('upload-sweep-every');
    expect(schedulers[0].every).toBe(15 * 60000);
  }, 15000);

  it('leaves exactly one scheduler when called twice', async () => {
    await scheduler.onApplicationBootstrap();
    await scheduler.onApplicationBootstrap();

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
  }, 15000);
});
