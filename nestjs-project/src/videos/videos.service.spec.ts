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
  UploadLimitReachedException,
} from '../common/exceptions/domain.exception';
import { StorageUnavailableError } from '../storage/storage.errors';

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<Partial<Repository<Video>>>;
  let channelsService: jest.Mocked<Partial<ChannelsService>>;
  let storageService: jest.Mocked<Partial<StorageService>>;

  const config = {
    uploadPartSizeBytes: 52428800,
    uploadMaxSizeBytes: 10737418240,
    uploadMaxOpenPerChannel: 5,
  };

  beforeEach(async () => {
    videoRepository = {
      count: jest.fn(),
      create: jest.fn(
        (data: unknown) => data as Video,
      ) as unknown as Repository<Video>['create'],
      save: jest.fn(),
    };
    channelsService = {
      findByUserId: jest.fn(),
    };
    storageService = {
      createMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
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
});
