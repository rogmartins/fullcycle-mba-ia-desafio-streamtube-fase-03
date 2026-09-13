import { UnrecoverableError, Job } from 'bullmq';
import { Repository } from 'typeorm';
import { VideoProcessor } from './video.processor';
import { Video } from '../videos/entities/video.entity';
import { VideoErrorReason, VideoStatus } from '../videos/videos.types';
import { StorageService } from '../storage/storage.service';
import { FfmpegService } from './ffmpeg.service';
import { InvalidMediaError } from './processing.errors';
import type { ProcessVideoJobData } from '../queue/queue.types';

describe('VideoProcessor (unit)', () => {
  let processor: VideoProcessor;
  let videoRepository: jest.Mocked<Partial<Repository<Video>>>;
  let storageService: jest.Mocked<Partial<StorageService>>;
  let ffmpegService: jest.Mocked<Partial<FfmpegService>>;
  let queryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    execute: jest.Mock;
  };

  const storageConfig = {
    workerSourceUrlTtlSeconds: 7200,
    thumbnailBucket: 'thumbnails',
  };
  const processingConfig = {
    thumbnailOffsetPercent: 10,
  };

  const PROBE_RESULT = {
    durationSeconds: 3.033,
    width: 320,
    height: 240,
    codecName: 'h264',
    containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
    moovAtEnd: true,
    raw: { format: {} },
  };

  function makeJob(
    overrides: Partial<Job<ProcessVideoJobData>> = {},
  ): Job<ProcessVideoJobData> {
    return {
      data: { videoId: 'video-1' },
      attemptsMade: 0,
      opts: { attempts: 3 },
      ...overrides,
    } as Job<ProcessVideoJobData>;
  }

  beforeEach(() => {
    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    videoRepository = {
      findOne: jest.fn(),
      increment: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(
        () => queryBuilder,
      ) as unknown as Repository<Video>['createQueryBuilder'],
    };
    storageService = {
      presignGetObject: jest.fn().mockResolvedValue({
        url: 'http://minio:9000/videos/video-1/source.mp4',
        expiresAt: new Date(),
      }),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    ffmpegService = {
      probe: jest.fn().mockResolvedValue(PROBE_RESULT),
      extractFrame: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')),
    };

    processor = new VideoProcessor(
      videoRepository as Repository<Video>,
      storageService as StorageService,
      ffmpegService as FfmpegService,
      storageConfig as never,
      processingConfig as never,
    );
  });

  describe('process', () => {
    it('is a no-op when the video row no longer exists', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(null);

      await processor.process(makeJob());

      expect(videoRepository.increment).not.toHaveBeenCalled();
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });

    it('is a no-op when the row is not in processing status', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.READY,
      });

      await processor.process(makeJob());

      expect(videoRepository.increment).not.toHaveBeenCalled();
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });

    it('marks the row failed(INVALID_MEDIA) and throws UnrecoverableError on InvalidMediaError', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/video-1/source.mp4',
      });
      (ffmpegService.probe as jest.Mock).mockRejectedValue(
        new InvalidMediaError('no video stream'),
      );

      await expect(processor.process(makeJob())).rejects.toThrow(
        UnrecoverableError,
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        {
          status: VideoStatus.FAILED,
          error_reason: VideoErrorReason.INVALID_MEDIA,
          error_detail: 'no video stream',
        },
      );
      expect(queryBuilder.execute).not.toHaveBeenCalled();
    });

    it('rethrows a transient probe error without touching the row', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/video-1/source.mp4',
      });
      const transientError = new Error('store unreachable');
      (ffmpegService.probe as jest.Mock).mockRejectedValue(transientError);

      await expect(processor.process(makeJob())).rejects.toThrow(
        transientError,
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('completes as ready with thumbnail_key = null and THUMBNAIL_FAILED when the thumbnail step fails', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/video-1/source.mp4',
      });
      (ffmpegService.extractFrame as jest.Mock).mockRejectedValue(
        new Error('ffmpeg crashed'),
      );

      await processor.process(makeJob());

      expect(queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.READY,
          thumbnail_key: null,
          error_reason: VideoErrorReason.THUMBNAIL_FAILED,
          error_detail: 'ffmpeg crashed',
        }),
      );
    });

    it('completes as ready with the thumbnail key set on success', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/video-1/source.mp4',
      });

      await processor.process(makeJob());

      expect(storageService.putObject).toHaveBeenCalledWith(
        'thumbnails',
        'videos/video-1/thumbnail.jpg',
        expect.any(Buffer),
        'image/jpeg',
        'public, max-age=31536000, immutable',
      );
      expect(queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.READY,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
          error_reason: null,
          error_detail: null,
          duration_seconds: '3.033',
          width: 320,
          height: 240,
          codec_name: 'h264',
          moov_at_end: true,
        }),
      );
    });

    it('uses offset 0 when the probed duration is 0', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/video-1/source.mp4',
      });
      (ffmpegService.probe as jest.Mock).mockResolvedValue({
        ...PROBE_RESULT,
        durationSeconds: 0,
      });

      await processor.process(makeJob());

      expect(ffmpegService.extractFrame).toHaveBeenCalledWith(
        'http://minio:9000/videos/video-1/source.mp4',
        0,
      );
    });

    it('logs and returns without throwing when the row changed underneath (zero rows affected)', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/video-1/source.mp4',
      });
      queryBuilder.execute.mockResolvedValue({ affected: 0 });

      await expect(processor.process(makeJob())).resolves.toBeUndefined();
    });
  });

  describe('onFailed', () => {
    it('does nothing for an UnrecoverableError (already handled in process())', async () => {
      await processor.onFailed(
        makeJob({ attemptsMade: 3 }),
        new UnrecoverableError('no video stream'),
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('does nothing when attemptsMade has not yet reached the configured attempts', async () => {
      await processor.onFailed(
        makeJob({ attemptsMade: 1, opts: { attempts: 3 } }),
        new Error('store unreachable'),
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('marks the row failed(PROCESSING_FAILED) on the last attempt', async () => {
      await processor.onFailed(
        makeJob({ attemptsMade: 3, opts: { attempts: 3 } }),
        new Error('store unreachable'),
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        {
          status: VideoStatus.FAILED,
          error_reason: VideoErrorReason.PROCESSING_FAILED,
          error_detail: 'store unreachable',
        },
      );
    });

    it('does nothing when there is no job', async () => {
      await processor.onFailed(undefined, new Error('x'));
      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });
});
