import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import storageConfig from '../config/storage.config';
import processingConfig from '../config/processing.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import type { ProcessVideoJobData } from '../queue/queue.types';
import { Video } from '../videos/entities/video.entity';
import { VideoErrorReason, VideoStatus } from '../videos/videos.types';
import { StorageService } from '../storage/storage.service';
import { FfmpegService } from './ffmpeg.service';
import { InvalidMediaError } from './processing.errors';

const QUEUE_WORKER_CONCURRENCY = parseInt(
  process.env.QUEUE_WORKER_CONCURRENCY || '1',
  10,
);

@Processor(VIDEO_PROCESSING_QUEUE, {
  concurrency: QUEUE_WORKER_CONCURRENCY,
  lockDuration: 600000,
  maxStalledCount: 1,
})
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
    @Inject(processingConfig.KEY)
    private readonly processingCfg: ConfigType<typeof processingConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      this.logger.log(
        `Video ${videoId} no longer exists — skipping (cancelled)`,
      );
      return;
    }
    if (video.status !== VideoStatus.PROCESSING) {
      this.logger.log(
        `Video ${videoId} is not in processing status (${video.status}) — skipping`,
      );
      return;
    }

    await this.videoRepository.increment(
      { id: videoId },
      'processing_attempts',
      1,
    );

    const { url: sourceUrl } = await this.storageService.presignGetObject(
      video.storage_key,
      this.storageCfg.workerSourceUrlTtlSeconds,
      { audience: 'internal' },
    );

    let probeResult: Awaited<ReturnType<FfmpegService['probe']>>;
    try {
      probeResult = await this.ffmpegService.probe(sourceUrl);
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        await this.videoRepository.update(
          { id: videoId },
          {
            status: VideoStatus.FAILED,
            error_reason: VideoErrorReason.INVALID_MEDIA,
            error_detail: error.message,
          },
        );
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }

    const offsetSeconds =
      probeResult.durationSeconds > 0
        ? (probeResult.durationSeconds *
            this.processingCfg.thumbnailOffsetPercent) /
          100
        : 0;

    let thumbnailKey: string | null = null;
    let thumbnailErrorReason: VideoErrorReason | null = null;
    let thumbnailErrorDetail: string | null = null;
    try {
      const frame = await this.ffmpegService.extractFrame(
        sourceUrl,
        offsetSeconds,
      );
      const key = `videos/${videoId}/thumbnail.jpg`;
      await this.storageService.putObject(
        this.storageCfg.thumbnailBucket,
        key,
        frame,
        'image/jpeg',
        'public, max-age=31536000, immutable',
      );
      thumbnailKey = key;
    } catch (error) {
      this.logger.error(
        `Thumbnail extraction failed for video ${videoId}`,
        error instanceof Error ? error.stack : undefined,
      );
      thumbnailErrorReason = VideoErrorReason.THUMBNAIL_FAILED;
      thumbnailErrorDetail =
        error instanceof Error ? error.message : String(error);
    }

    const result = await this.videoRepository
      .createQueryBuilder()
      .update(Video)
      .set({
        status: VideoStatus.READY,
        duration_seconds: String(probeResult.durationSeconds),
        width: probeResult.width,
        height: probeResult.height,
        codec_name: probeResult.codecName,
        container_format: probeResult.containerFormat,
        moov_at_end: probeResult.moovAtEnd,
        metadata: probeResult.raw,
        thumbnail_key: thumbnailKey,
        error_reason: thumbnailErrorReason,
        error_detail: thumbnailErrorDetail,
        processed_at: new Date(),
      } as QueryDeepPartialEntity<Video>)
      .where('id = :id AND status = :status', {
        id: videoId,
        status: VideoStatus.PROCESSING,
      })
      .execute();

    if (result.affected === 0) {
      this.logger.log(
        `Video ${videoId} row changed underneath while processing — discarding result`,
      );
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job<ProcessVideoJobData>): void {
    this.logger.log(
      `Started processing video ${job.data.videoId} (attempt ${job.attemptsMade + 1})`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<ProcessVideoJobData>): void {
    this.logger.log(
      `Completed processing video ${job.data.videoId} (attemptsMade=${job.attemptsMade})`,
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    if (error instanceof UnrecoverableError) {
      // Already recorded as failed(INVALID_MEDIA) inside process().
      return;
    }

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      return;
    }

    await this.videoRepository.update(
      { id: job.data.videoId },
      {
        status: VideoStatus.FAILED,
        error_reason: VideoErrorReason.PROCESSING_FAILED,
        error_detail: error.message,
      },
    );
  }
}
