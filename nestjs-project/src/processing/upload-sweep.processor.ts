import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VIDEO_MAINTENANCE_QUEUE } from '../queue/queue.constants';
import { UploadSweepService, SweepReport } from './upload-sweep.service';

@Processor(VIDEO_MAINTENANCE_QUEUE, { concurrency: 1 })
export class UploadSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(UploadSweepProcessor.name);

  constructor(private readonly uploadSweepService: UploadSweepService) {
    super();
  }

  async process(job: Job): Promise<SweepReport> {
    this.logger.log(`Starting reconciliation sweep (job ${job.id})`);
    return this.uploadSweepService.run();
  }
}
