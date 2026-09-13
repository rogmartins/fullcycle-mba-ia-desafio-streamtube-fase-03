import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  UPLOAD_SWEEP_JOB,
  UPLOAD_SWEEP_SCHEDULER,
  VIDEO_MAINTENANCE_QUEUE,
} from '../queue/queue.constants';

@Injectable()
export class UploadSweepScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_MAINTENANCE_QUEUE)
    private readonly queue: Queue,
    @Inject(queueConfig.KEY)
    private readonly queueCfg: ConfigType<typeof queueConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      UPLOAD_SWEEP_SCHEDULER,
      { every: this.queueCfg.sweepIntervalMinutes * 60000 },
      {
        name: UPLOAD_SWEEP_JOB,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: true },
      },
    );
  }
}
