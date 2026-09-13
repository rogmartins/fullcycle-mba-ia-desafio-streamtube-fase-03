import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { VideosService } from './videos.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.types';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import storageConfig from '../config/storage.config';
import {
  StorageUnavailableException,
  UnsupportedMediaTypeException,
  UploadIncompleteException,
  UploadLimitReachedException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import {
  InvalidPartsError,
  StorageUnavailableError,
  UploadNotFoundError,
} from '../storage/storage.errors';
import { BadRequestException } from '@nestjs/common';
import { VideoQueueService } from '../queue/video-queue.service';
import { toPublicView } from './videos.presenter';

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<Partial<Repository<Video>>>;
  let channelsService: jest.Mocked<Partial<ChannelsService>>;
  let storageService: jest.Mocked<Partial<StorageService>>;
  let videoQueueService: jest.Mocked<Partial<VideoQueueService>>;
  let queryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    execute: jest.Mock;
  };

  const config = {
    uploadPartSizeBytes: 52428800,
    uploadMaxSizeBytes: 10737418240,
    uploadMaxOpenPerChannel: 5,
    uploadPartUrlTtlSeconds: 3600,
    playbackUrlTtlSeconds: 28800,
    downloadUrlTtlSeconds: 900,
    videoBucket: 'videos',
    thumbnailBucket: 'thumbnails',
  };

  beforeEach(async () => {
    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };
    videoRepository = {
      count: jest.fn(),
      create: jest.fn(
        (data: unknown) => data as Video,
      ) as unknown as Repository<Video>['create'],
      save: jest.fn(),
      findOne: jest.fn(),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(
        () => queryBuilder,
      ) as unknown as Repository<Video>['createQueryBuilder'],
    };
    channelsService = {
      findByUserId: jest.fn(),
    };
    storageService = {
      createMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
      presignUploadPart: jest.fn(),
      listParts: jest.fn(),
      completeMultipartUpload: jest.fn(),
      deleteByPrefix: jest.fn().mockResolvedValue(undefined),
      presignGetObject: jest.fn(),
      getThumbnailPublicUrl: jest.fn(
        (key: string) => `http://localhost:9000/thumbnails/${key}`,
      ),
    };
    videoQueueService = {
      enqueueProcessing: jest.fn(),
      removeIfWaitingOrDelayed: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoQueueService, useValue: videoQueueService },
        { provide: storageConfig.KEY, useValue: config },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  function stubChannel(id = 'channel-1') {
    (channelsService.findByUserId as jest.Mock).mockResolvedValue({
      id,
      user_id: 'user-1',
    });
  }

  it('throws UnsupportedMediaTypeException on extension/content-type mismatch', async () => {
    stubChannel();
    (videoRepository.count as jest.Mock).mockResolvedValue(0);

    await expect(
      service.createUpload('user-1', {
        filename: 'movie.mkv',
        size_bytes: 1000,
        content_type: 'video/mp4',
      }),
    ).rejects.toThrow(UnsupportedMediaTypeException);
  });

  it('throws UploadLimitReachedException at the open-upload cap', async () => {
    stubChannel();
    (videoRepository.count as jest.Mock).mockResolvedValue(5);

    await expect(
      service.createUpload('user-1', {
        filename: 'trip.mp4',
        size_bytes: 1000,
        content_type: 'video/mp4',
      }),
    ).rejects.toThrow(UploadLimitReachedException);
  });

  it('computes part_count for a 10 GiB file as 205 parts', async () => {
    stubChannel();
    (videoRepository.count as jest.Mock).mockResolvedValue(0);
    (storageService.createMultipartUpload as jest.Mock).mockResolvedValue(
      'upload-1',
    );
    (videoRepository.save as jest.Mock).mockImplementation((v: Video) => v);

    const result = await service.createUpload('user-1', {
      filename: 'trip.mp4',
      size_bytes: 10737418240,
      content_type: 'video/mp4',
    });

    expect(result.part_count).toBe(205);
    expect(result.part_size_bytes).toBe(52428800);
  });

  it('does not persist when the storage service is unavailable', async () => {
    stubChannel();
    (videoRepository.count as jest.Mock).mockResolvedValue(0);
    (storageService.createMultipartUpload as jest.Mock).mockRejectedValue(
      new StorageUnavailableError(),
    );

    await expect(
      service.createUpload('user-1', {
        filename: 'trip.mp4',
        size_bytes: 1000,
        content_type: 'video/mp4',
      }),
    ).rejects.toThrow(StorageUnavailableException);

    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('aborts the multipart upload when the insert fails', async () => {
    stubChannel();
    (videoRepository.count as jest.Mock).mockResolvedValue(0);
    (storageService.createMultipartUpload as jest.Mock).mockResolvedValue(
      'upload-1',
    );
    const genericError = new Error('insert failed');
    (videoRepository.save as jest.Mock).mockRejectedValue(genericError);

    await expect(
      service.createUpload('user-1', {
        filename: 'trip.mp4',
        size_bytes: 1000,
        content_type: 'video/mp4',
      }),
    ).rejects.toThrow(genericError);

    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      expect.any(String),
      'upload-1',
    );
  });

  it('retries public_id generation on a unique violation and eventually succeeds', async () => {
    stubChannel();
    (videoRepository.count as jest.Mock).mockResolvedValue(0);
    (storageService.createMultipartUpload as jest.Mock).mockResolvedValue(
      'upload-1',
    );

    const uniqueViolation = Object.assign(
      new QueryFailedError('insert', [], new Error('duplicate')),
      { code: '23505', detail: 'Key (public_id)=(x) already exists.' },
    );
    (videoRepository.save as jest.Mock)
      .mockRejectedValueOnce(uniqueViolation)
      .mockResolvedValueOnce({ id: 'video-1', status: VideoStatus.UPLOADING });

    const result = await service.createUpload('user-1', {
      filename: 'trip.mp4',
      size_bytes: 1000,
      content_type: 'video/mp4',
    });

    expect(result.id).toBe('video-1');
    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
  });

  function stubVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      upload_id: 'upload-1',
      storage_key: 'videos/video-1/source.mp4',
      part_count: 5,
      status: VideoStatus.UPLOADING,
      channel: { user_id: 'user-1' },
      ...overrides,
    } as Video;
  }

  describe('getOwnedVideo', () => {
    it('throws VideoNotFoundException when no video matches', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.getOwnedVideo('video-1', 'user-1')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoNotOwnedException when the channel belongs to another user', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubVideo({ channel: { user_id: 'other-user' } } as Partial<Video>),
      );

      await expect(service.getOwnedVideo('video-1', 'user-1')).rejects.toThrow(
        VideoNotOwnedException,
      );
    });

    it('returns the video when found and owned', async () => {
      const video = stubVideo();
      (videoRepository.findOne as jest.Mock).mockResolvedValue(video);

      await expect(service.getOwnedVideo('video-1', 'user-1')).resolves.toBe(
        video,
      );
    });
  });

  describe('signPart', () => {
    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'throws VideoInvalidStateException when status is %s',
      async (status) => {
        (videoRepository.findOne as jest.Mock).mockResolvedValue(
          stubVideo({ status }),
        );

        await expect(service.signPart('video-1', 'user-1', 1)).rejects.toThrow(
          VideoInvalidStateException,
        );
      },
    );

    it('throws BadRequestException for an out-of-range part number', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubVideo({ part_count: 5 }),
      );

      await expect(service.signPart('video-1', 'user-1', 6)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.signPart('video-1', 'user-1', 0)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('passes the configured TTL through to presignUploadPart', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(stubVideo());
      (storageService.presignUploadPart as jest.Mock).mockResolvedValue({
        url: 'https://example.com/signed',
        expiresAt: new Date('2026-01-01T00:00:00Z'),
      });

      const result = await service.signPart('video-1', 'user-1', 1);

      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-1/source.mp4',
        'upload-1',
        1,
        3600,
      );
      expect(result.part_number).toBe(1);
      expect(result.url).toBe('https://example.com/signed');
    });
  });

  describe('listUploadedParts', () => {
    it('throws VideoInvalidStateException when not uploading', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubVideo({ status: VideoStatus.READY }),
      );

      await expect(
        service.listUploadedParts('video-1', 'user-1'),
      ).rejects.toThrow(VideoInvalidStateException);
    });

    it('maps UploadNotFoundError to VideoInvalidStateException', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(stubVideo());
      (storageService.listParts as jest.Mock).mockRejectedValue(
        new UploadNotFoundError(),
      );

      await expect(
        service.listUploadedParts('video-1', 'user-1'),
      ).rejects.toThrow(VideoInvalidStateException);
    });

    it('returns parts mapped and sorted by part_number', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(stubVideo());
      (storageService.listParts as jest.Mock).mockResolvedValue([
        { partNumber: 2, etag: 'e2', sizeBytes: 10, lastModified: undefined },
        { partNumber: 1, etag: 'e1', sizeBytes: 20, lastModified: undefined },
      ]);

      const result = await service.listUploadedParts('video-1', 'user-1');

      expect(result).toEqual([
        {
          part_number: 1,
          etag: 'e1',
          size_bytes: 20,
          last_modified: undefined,
        },
        {
          part_number: 2,
          etag: 'e2',
          size_bytes: 10,
          last_modified: undefined,
        },
      ]);
    });
  });

  describe('completeUpload', () => {
    const declaredParts = [
      { part_number: 1, etag: 'e1' },
      { part_number: 2, etag: 'e2' },
    ];
    const matchingStoredParts = [
      {
        partNumber: 1,
        etag: 'e1',
        sizeBytes: 52428800,
        lastModified: undefined,
      },
      { partNumber: 2, etag: 'e2', sizeBytes: 1000, lastModified: undefined },
    ];

    function stubCompletableVideo(overrides: Partial<Video> = {}): Video {
      return stubVideo({
        part_count: 2,
        part_size_bytes: 52428800,
        ...overrides,
      });
    }

    it('throws UploadIncompleteException on a part count mismatch', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubCompletableVideo(),
      );
      (storageService.listParts as jest.Mock).mockResolvedValue([
        matchingStoredParts[0],
      ]);

      await expect(
        service.completeUpload('video-1', 'user-1', declaredParts),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('throws UploadIncompleteException when a non-last part has the wrong size', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubCompletableVideo(),
      );
      (storageService.listParts as jest.Mock).mockResolvedValue([
        { ...matchingStoredParts[0], sizeBytes: 1000 },
        matchingStoredParts[1],
      ]);

      await expect(
        service.completeUpload('video-1', 'user-1', declaredParts),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('throws UploadIncompleteException on an ETag mismatch', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubCompletableVideo(),
      );
      (storageService.listParts as jest.Mock).mockResolvedValue(
        matchingStoredParts,
      );

      await expect(
        service.completeUpload('video-1', 'user-1', [
          { part_number: 1, etag: 'wrong-etag' },
          declaredParts[1],
        ]),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('throws UploadIncompleteException when a declared part was never uploaded', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubCompletableVideo({ part_count: 3 }),
      );
      (storageService.listParts as jest.Mock).mockResolvedValue([
        ...matchingStoredParts,
        { partNumber: 3, etag: 'e3', sizeBytes: 1000, lastModified: undefined },
      ]);

      await expect(
        service.completeUpload('video-1', 'user-1', [
          ...declaredParts,
          { part_number: 4, etag: 'e4' },
        ]),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('maps InvalidPartsError from completeMultipartUpload to UploadIncompleteException', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubCompletableVideo(),
      );
      (storageService.listParts as jest.Mock).mockResolvedValue(
        matchingStoredParts,
      );
      (storageService.completeMultipartUpload as jest.Mock).mockRejectedValue(
        new InvalidPartsError(),
      );

      await expect(
        service.completeUpload('video-1', 'user-1', declaredParts),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('throws VideoInvalidStateException on a lost race (zero rows affected)', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubCompletableVideo(),
      );
      (storageService.listParts as jest.Mock).mockResolvedValue(
        matchingStoredParts,
      );
      queryBuilder.execute.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload('video-1', 'user-1', declaredParts),
      ).rejects.toThrow(VideoInvalidStateException);
    });

    it('swallows an enqueue failure and still returns the completed video', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubCompletableVideo(),
      );
      (storageService.listParts as jest.Mock).mockResolvedValue(
        matchingStoredParts,
      );
      queryBuilder.execute.mockResolvedValue({ affected: 1 });
      (videoQueueService.enqueueProcessing as jest.Mock).mockRejectedValue(
        new Error('redis down'),
      );

      const result = await service.completeUpload(
        'video-1',
        'user-1',
        declaredParts,
      );

      expect(result).toBeDefined();
    });

    it('succeeds and enqueues processing when everything matches', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubCompletableVideo(),
      );
      (storageService.listParts as jest.Mock).mockResolvedValue(
        matchingStoredParts,
      );
      queryBuilder.execute.mockResolvedValue({ affected: 1 });

      await service.completeUpload('video-1', 'user-1', declaredParts);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/source.mp4',
        'upload-1',
        declaredParts.map((p) => ({
          partNumber: p.part_number,
          etag: p.etag,
        })),
      );
      expect(videoQueueService.enqueueProcessing).toHaveBeenCalledWith(
        'video-1',
      );
    });
  });

  describe('cancelUpload', () => {
    it.each([VideoStatus.UPLOADING, VideoStatus.FAILED])(
      'aborts, deletes storage objects and the row when status is %s',
      async (status) => {
        (videoRepository.findOne as jest.Mock).mockResolvedValue(
          stubVideo({ status }),
        );

        await service.cancelUpload('video-1', 'user-1');

        expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
          'videos/video-1/source.mp4',
          'upload-1',
        );
        expect(storageService.deleteByPrefix).toHaveBeenCalledWith(
          'videos',
          'videos/video-1/',
        );
        expect(videoRepository.delete).toHaveBeenCalledWith({
          id: 'video-1',
        });
        expect(videoQueueService.removeIfWaitingOrDelayed).toHaveBeenCalledWith(
          'video-1',
        );
      },
    );

    it.each([VideoStatus.PROCESSING, VideoStatus.READY])(
      'throws VideoInvalidStateException when status is %s',
      async (status) => {
        (videoRepository.findOne as jest.Mock).mockResolvedValue(
          stubVideo({ status }),
        );

        await expect(service.cancelUpload('video-1', 'user-1')).rejects.toThrow(
          VideoInvalidStateException,
        );
        expect(videoRepository.delete).not.toHaveBeenCalled();
      },
    );

    it('also deletes the thumbnail when thumbnail_key is set', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(
        stubVideo({
          status: VideoStatus.FAILED,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
        }),
      );

      await service.cancelUpload('video-1', 'user-1');

      expect(storageService.deleteByPrefix).toHaveBeenCalledWith(
        'thumbnails',
        'videos/video-1/thumbnail.jpg',
      );
    });
  });

  describe('findByPublicId', () => {
    it('throws VideoNotFoundException for a malformed publicId', async () => {
      await expect(service.findByPublicId('not-a-uuid-shape')).rejects.toThrow(
        VideoNotFoundException,
      );
      expect(videoRepository.findOne).not.toHaveBeenCalled();
    });

    it('throws VideoNotFoundException when no row matches', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findByPublicId('abcdefghijkl')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('returns the video when found', async () => {
      const video = { id: 'video-1', public_id: 'abcdefghijkl' } as Video;
      (videoRepository.findOne as jest.Mock).mockResolvedValue(video);

      await expect(service.findByPublicId('abcdefghijkl')).resolves.toBe(video);
    });
  });

  describe('getThumbnailUrl', () => {
    it('returns null when thumbnail_key is unset', () => {
      expect(
        service.getThumbnailUrl({ thumbnail_key: null } as Video),
      ).toBeNull();
    });

    it('delegates to storageService.getThumbnailPublicUrl when set', () => {
      const url = service.getThumbnailUrl({
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
      } as Video);
      expect(storageService.getThumbnailPublicUrl).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
      );
      expect(url).toBe(
        'http://localhost:9000/thumbnails/videos/video-1/thumbnail.jpg',
      );
    });
  });

  describe('getPlaybackUrl', () => {
    it('throws VideoNotFoundException for a malformed publicId', async () => {
      await expect(service.getPlaybackUrl('bad')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoNotReadyException when status is not ready', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        public_id: 'abcdefghijkl',
        status: VideoStatus.PROCESSING,
      });

      await expect(service.getPlaybackUrl('abcdefghijkl')).rejects.toThrow(
        VideoNotReadyException,
      );
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });

    it('presigns with the public audience and the playback TTL', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        public_id: 'abcdefghijkl',
        status: VideoStatus.READY,
        storage_key: 'videos/video-1/source.mp4',
      });
      const expiresAt = new Date();
      (storageService.presignGetObject as jest.Mock).mockResolvedValue({
        url: 'http://localhost:9000/videos/video-1/source.mp4?sig=1',
        expiresAt,
      });

      const result = await service.getPlaybackUrl('abcdefghijkl');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/source.mp4',
        28800,
        { audience: 'public' },
      );
      expect(result).toEqual({
        url: 'http://localhost:9000/videos/video-1/source.mp4?sig=1',
        expires_at: expiresAt,
      });
    });
  });

  describe('getDownloadUrl', () => {
    it('throws VideoNotFoundException for a malformed publicId', async () => {
      await expect(service.getDownloadUrl('bad')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoNotReadyException when status is not ready', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        public_id: 'abcdefghijkl',
        status: VideoStatus.UPLOADING,
      });

      await expect(service.getDownloadUrl('abcdefghijkl')).rejects.toThrow(
        VideoNotReadyException,
      );
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });

    it('presigns with the download TTL and a sanitized attachment filename', async () => {
      (videoRepository.findOne as jest.Mock).mockResolvedValue({
        public_id: 'abcdefghijkl',
        status: VideoStatus.READY,
        storage_key: 'videos/video-1/source.mp4',
        title: 'Férias 2026: praia!',
      });
      const expiresAt = new Date();
      (storageService.presignGetObject as jest.Mock).mockResolvedValue({
        url: 'http://localhost:9000/videos/video-1/source.mp4?sig=1',
        expiresAt,
      });

      const result = await service.getDownloadUrl('abcdefghijkl');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/source.mp4',
        900,
        {
          audience: 'public',
          responseContentDisposition:
            'attachment; filename="Ferias-2026-praia.mp4"',
        },
      );
      expect(result).toEqual({
        url: 'http://localhost:9000/videos/video-1/source.mp4?sig=1',
        expires_at: expiresAt,
        filename: 'Ferias-2026-praia.mp4',
      });
    });
  });

  describe('toPublicView', () => {
    it('omits internal fields and exposes only the public shape', () => {
      const video = {
        id: 'video-1',
        public_id: 'abcdefghijkl',
        channel_id: 'channel-1',
        title: 'My video',
        status: VideoStatus.READY,
        storage_key: 'videos/video-1/source.mp4',
        upload_id: null,
        part_size_bytes: 1,
        part_count: 1,
        duration_seconds: '12.500',
        width: 1280,
        height: 720,
        size_bytes: '1000',
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
        error_reason: null,
        error_detail: null,
        metadata: { raw: true },
        created_at: new Date('2026-01-01T00:00:00Z'),
      } as unknown as Video;

      const view = toPublicView(
        video,
        'http://localhost:9000/thumbnails/videos/video-1/thumbnail.jpg',
      );

      expect(view).toEqual({
        public_id: 'abcdefghijkl',
        title: 'My video',
        status: VideoStatus.READY,
        duration_seconds: 12.5,
        width: 1280,
        height: 720,
        size_bytes: 1000,
        thumbnail_url:
          'http://localhost:9000/thumbnails/videos/video-1/thumbnail.jpg',
        created_at: video.created_at,
      });
      expect(view).not.toHaveProperty('id');
      expect(view).not.toHaveProperty('channel_id');
      expect(view).not.toHaveProperty('storage_key');
      expect(view).not.toHaveProperty('upload_id');
      expect(view).not.toHaveProperty('error_reason');
      expect(view).not.toHaveProperty('metadata');
    });

    it('returns null thumbnail_url when no thumbnail exists', () => {
      const video = {
        public_id: 'abcdefghijkl',
        title: 'My video',
        status: VideoStatus.UPLOADING,
        duration_seconds: null,
        width: null,
        height: null,
        size_bytes: '1000',
        created_at: new Date(),
      } as unknown as Video;

      expect(toPublicView(video, null).thumbnail_url).toBeNull();
    });
  });
});
