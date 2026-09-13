import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { LessThan, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { Video } from '../videos/entities/video.entity';
import { VideoErrorReason, VideoStatus } from '../videos/videos.types';
import { StorageService } from '../storage/storage.service';
import { VideoQueueService } from '../queue/video-queue.service';
import { UploadNotFoundError } from '../storage/storage.errors';

const PAGE_SIZE = 100;

export interface SweepReport {
  completed: number;
  reenqueued: number;
  abandoned: number;
  orphansAborted: number;
}

@Injectable()
export class UploadSweepService {
  private readonly logger = new Logger(UploadSweepService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
    @Inject(queueConfig.KEY)
    private readonly queueCfg: ConfigType<typeof queueConfig>,
  ) {}

  async run(): Promise<SweepReport> {
    const report: SweepReport = {
      completed: 0,
      reenqueued: 0,
      abandoned: 0,
      orphansAborted: 0,
    };

    await this.sweepStaleUploads(report);
    await this.sweepStaleProcessing(report);
    await this.sweepOrphanUploads(report);

    this.logger.log(`Sweep finished: ${JSON.stringify(report)}`);
    return report;
  }

  private async sweepStaleUploads(report: SweepReport): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.queueCfg.sweepStaleUploadMinutes * 60000,
    );
    const total = await this.videoRepository.count({
      where: { status: VideoStatus.UPLOADING, created_at: LessThan(cutoff) },
    });

    for (let skip = 0; skip < total; skip += PAGE_SIZE) {
      const rows = await this.videoRepository.find({
        where: { status: VideoStatus.UPLOADING, created_at: LessThan(cutoff) },
        order: { id: 'ASC' },
        skip,
        take: PAGE_SIZE,
      });

      for (const video of rows) {
        try {
          await this.reconcileStaleUpload(video, report);
        } catch (error) {
          this.logger.error(
            `Sweep failed to reconcile uploading video ${video.id}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    }
  }

  private async reconcileStaleUpload(
    video: Video,
    report: SweepReport,
  ): Promise<void> {
    const abandonCutoff = new Date(
      Date.now() - this.queueCfg.sweepAbandonDays * 24 * 60 * 60 * 1000,
    );

    let parts: Awaited<ReturnType<StorageService['listParts']>>;
    try {
      parts = await this.storageService.listParts(
        video.storage_key,
        video.upload_id!,
      );
    } catch (error) {
      if (!(error instanceof UploadNotFoundError)) {
        throw error;
      }
      const objectExists = await this.storageService.objectExists(
        this.storageCfg.videoBucket,
        video.storage_key,
      );
      if (objectExists) {
        // The multipart upload was already completed on the store, but the DB
        // update after CompleteMultipartUpload never landed — reconcile it here.
        const result = await this.videoRepository
          .createQueryBuilder()
          .update(Video)
          .set({ status: VideoStatus.PROCESSING, uploaded_at: new Date() })
          .where('id = :id AND status = :status', {
            id: video.id,
            status: VideoStatus.UPLOADING,
          })
          .execute();
        if (result.affected && result.affected > 0) {
          await this.videoQueueService.enqueueProcessing(video.id);
          report.completed++;
        }
        return;
      }

      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          error_reason: VideoErrorReason.UPLOAD_ABANDONED,
        },
      );
      report.abandoned++;
      return;
    }

    const newestPartAt = parts.reduce<Date | null>((latest, part) => {
      if (!part.lastModified) return latest;
      if (!latest || part.lastModified > latest) return part.lastModified;
      return latest;
    }, null);
    const lastActivityAt = newestPartAt ?? video.created_at;

    if (lastActivityAt < abandonCutoff) {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id!,
      );
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          error_reason: VideoErrorReason.UPLOAD_ABANDONED,
        },
      );
      report.abandoned++;
    }
    // Otherwise: still resumable, left untouched.
  }

  private async sweepStaleProcessing(report: SweepReport): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.queueCfg.sweepStaleProcessingMinutes * 60000,
    );
    const total = await this.videoRepository.count({
      where: { status: VideoStatus.PROCESSING, uploaded_at: LessThan(cutoff) },
    });

    for (let skip = 0; skip < total; skip += PAGE_SIZE) {
      const rows = await this.videoRepository.find({
        where: {
          status: VideoStatus.PROCESSING,
          uploaded_at: LessThan(cutoff),
        },
        order: { id: 'ASC' },
        skip,
        take: PAGE_SIZE,
      });

      for (const video of rows) {
        try {
          const hasActiveJob =
            await this.videoQueueService.hasActiveProcessingJob(video.id);
          if (!hasActiveJob) {
            await this.videoQueueService.enqueueProcessing(video.id);
            report.reenqueued++;
          }
        } catch (error) {
          this.logger.error(
            `Sweep failed to re-enqueue stale processing video ${video.id}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    }
  }

  private async sweepOrphanUploads(report: SweepReport): Promise<void> {
    const uploadingRows = await this.videoRepository.find({
      where: { status: VideoStatus.UPLOADING },
      select: ['storage_key', 'upload_id'],
    });
    const knownUploads = new Set(
      uploadingRows.map((row) => `${row.storage_key}::${row.upload_id}`),
    );

    const inProgressUploads =
      await this.storageService.listMultipartUploads('videos/');

    for (const upload of inProgressUploads) {
      const key = `${upload.key}::${upload.uploadId}`;
      if (knownUploads.has(key)) continue;

      try {
        await this.storageService.abortMultipartUpload(
          upload.key,
          upload.uploadId,
        );
        report.orphansAborted++;
      } catch (error) {
        this.logger.error(
          `Sweep failed to abort orphaned upload ${upload.key}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
