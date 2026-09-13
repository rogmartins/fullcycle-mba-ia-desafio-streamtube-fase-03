import { Repository } from 'typeorm';
import { UploadSweepService } from './upload-sweep.service';
import { Video } from '../videos/entities/video.entity';
import { VideoErrorReason, VideoStatus } from '../videos/videos.types';
import { StorageService } from '../storage/storage.service';
import { VideoQueueService } from '../queue/video-queue.service';
import { UploadNotFoundError } from '../storage/storage.errors';

describe('UploadSweepService (unit)', () => {
  let service: UploadSweepService;
  let videoRepository: jest.Mocked<Partial<Repository<Video>>>;
  let storageService: jest.Mocked<Partial<StorageService>>;
  let videoQueueService: jest.Mocked<Partial<VideoQueueService>>;
  let queryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    execute: jest.Mock;
  };

  const storageConfig = {
    videoBucket: 'videos',
    thumbnailBucket: 'thumbnails',
  };
  const queueConfig = {
    sweepStaleUploadMinutes: 60,
    sweepAbandonDays: 7,
    sweepStaleProcessingMinutes: 60,
  };

  function stubVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      storage_key: 'videos/video-1/source.mp4',
      upload_id: 'upload-1',
      status: VideoStatus.UPLOADING,
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
      ...overrides,
    } as Video;
  }

  beforeEach(() => {
    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    videoRepository = {
      count: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      createQueryBuilder: jest.fn(
        () => queryBuilder,
      ) as unknown as Repository<Video>['createQueryBuilder'],
    };
    storageService = {
      listParts: jest.fn(),
      objectExists: jest.fn(),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      listMultipartUploads: jest.fn().mockResolvedValue([]),
    };
    videoQueueService = {
      enqueueProcessing: jest.fn().mockResolvedValue('job-1'),
      hasActiveProcessingJob: jest.fn(),
    };

    service = new UploadSweepService(
      videoRepository as Repository<Video>,
      storageService as StorageService,
      videoQueueService as VideoQueueService,
      storageConfig as never,
      queueConfig as never,
    );
  });

  interface FindArgs {
    where?: { status?: VideoStatus };
  }

  function stubUploadingPage(videos: Video[]) {
    (videoRepository.count as jest.Mock).mockImplementation((args: FindArgs) =>
      args.where?.status === VideoStatus.UPLOADING
        ? Promise.resolve(videos.length)
        : Promise.resolve(0),
    );
    (videoRepository.find as jest.Mock).mockImplementation((args: FindArgs) =>
      args.where?.status === VideoStatus.UPLOADING
        ? Promise.resolve(videos)
        : Promise.resolve([]),
    );
  }

  function stubProcessingPage(videos: Video[]) {
    (videoRepository.count as jest.Mock).mockImplementation((args: FindArgs) =>
      args.where?.status === VideoStatus.PROCESSING
        ? Promise.resolve(videos.length)
        : Promise.resolve(0),
    );
    (videoRepository.find as jest.Mock).mockImplementation((args: FindArgs) =>
      args.where?.status === VideoStatus.PROCESSING
        ? Promise.resolve(videos)
        : Promise.resolve([]),
    );
  }

  describe('stale uploading rows', () => {
    it('(a) completed-but-unrecorded upload: transitions to processing and enqueues', async () => {
      const video = stubVideo();
      stubUploadingPage([video]);
      (storageService.listParts as jest.Mock).mockRejectedValue(
        new UploadNotFoundError(),
      );
      (storageService.objectExists as jest.Mock).mockResolvedValue(true);

      const report = await service.run();

      expect(queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: VideoStatus.PROCESSING }),
      );
      expect(videoQueueService.enqueueProcessing).toHaveBeenCalledWith(
        'video-1',
      );
      expect(report.completed).toBe(1);
    });

    it('(b) upload gone and no object: marks failed(UPLOAD_ABANDONED)', async () => {
      const video = stubVideo();
      stubUploadingPage([video]);
      (storageService.listParts as jest.Mock).mockRejectedValue(
        new UploadNotFoundError(),
      );
      (storageService.objectExists as jest.Mock).mockResolvedValue(false);

      const report = await service.run();

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        {
          status: VideoStatus.FAILED,
          error_reason: VideoErrorReason.UPLOAD_ABANDONED,
        },
      );
      expect(report.abandoned).toBe(1);
    });

    it('(c) newest part older than sweepAbandonDays: aborts and marks failed', async () => {
      const video = stubVideo();
      stubUploadingPage([video]);
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      (storageService.listParts as jest.Mock).mockResolvedValue([
        { partNumber: 1, etag: 'a', sizeBytes: 100, lastModified: oldDate },
      ]);

      const report = await service.run();

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        video.storage_key,
        video.upload_id,
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        {
          status: VideoStatus.FAILED,
          error_reason: VideoErrorReason.UPLOAD_ABANDONED,
        },
      );
      expect(report.abandoned).toBe(1);
    });

    it('(c) falls back to created_at when there are no parts yet', async () => {
      const oldCreatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const video = stubVideo({ created_at: oldCreatedAt });
      stubUploadingPage([video]);
      (storageService.listParts as jest.Mock).mockResolvedValue([]);

      const report = await service.run();

      expect(storageService.abortMultipartUpload).toHaveBeenCalled();
      expect(report.abandoned).toBe(1);
    });

    it('(d) recent part: left untouched', async () => {
      const video = stubVideo();
      stubUploadingPage([video]);
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      (storageService.listParts as jest.Mock).mockResolvedValue([
        { partNumber: 1, etag: 'a', sizeBytes: 100, lastModified: recentDate },
      ]);

      const report = await service.run();

      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(report.abandoned).toBe(0);
      expect(report.completed).toBe(0);
    });

    it('isolates a per-video error so the rest of the sweep still runs', async () => {
      const failing = stubVideo({ id: 'video-1' });
      const succeeding = stubVideo({ id: 'video-2' });
      stubUploadingPage([failing, succeeding]);
      (storageService.listParts as jest.Mock)
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new UploadNotFoundError());
      (storageService.objectExists as jest.Mock).mockResolvedValue(false);

      const report = await service.run();

      expect(report.abandoned).toBe(1);
    });

    it('reads the stale threshold from config', async () => {
      stubUploadingPage([]);
      await service.run();

      /* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest's nested
         expect.objectContaining() defeats strict inference here. */
      expect(videoRepository.count as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: VideoStatus.UPLOADING }),
        }),
      );
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    });
  });

  describe('stale processing rows', () => {
    it('re-enqueues when there is no active job', async () => {
      const video = stubVideo({
        id: 'video-3',
        status: VideoStatus.PROCESSING,
      });
      stubProcessingPage([video]);
      (videoQueueService.hasActiveProcessingJob as jest.Mock).mockResolvedValue(
        false,
      );

      const report = await service.run();

      expect(videoQueueService.enqueueProcessing).toHaveBeenCalledWith(
        'video-3',
      );
      expect(report.reenqueued).toBe(1);
    });

    it('does not re-enqueue when a job is already active', async () => {
      const video = stubVideo({
        id: 'video-3',
        status: VideoStatus.PROCESSING,
      });
      stubProcessingPage([video]);
      (videoQueueService.hasActiveProcessingJob as jest.Mock).mockResolvedValue(
        true,
      );

      const report = await service.run();

      expect(videoQueueService.enqueueProcessing).not.toHaveBeenCalled();
      expect(report.reenqueued).toBe(0);
    });
  });

  describe('orphaned multipart uploads', () => {
    it('aborts an upload under videos/ that matches no uploading row', async () => {
      (videoRepository.find as jest.Mock).mockResolvedValue([]);
      (storageService.listMultipartUploads as jest.Mock).mockResolvedValue([
        { key: 'videos/orphan/source.mp4', uploadId: 'orphan-upload' },
      ]);

      const report = await service.run();

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/orphan/source.mp4',
        'orphan-upload',
      );
      expect(report.orphansAborted).toBe(1);
    });

    it('leaves an upload alone when it matches a known uploading row', async () => {
      (videoRepository.find as jest.Mock).mockImplementation(
        (args: FindArgs) =>
          args.where?.status === VideoStatus.UPLOADING
            ? Promise.resolve([
                {
                  storage_key: 'videos/video-1/source.mp4',
                  upload_id: 'upload-1',
                },
              ])
            : Promise.resolve([]),
      );
      (storageService.listMultipartUploads as jest.Mock).mockResolvedValue([
        { key: 'videos/video-1/source.mp4', uploadId: 'upload-1' },
      ]);

      const report = await service.run();

      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(report.orphansAborted).toBe(0);
    });
  });
});
