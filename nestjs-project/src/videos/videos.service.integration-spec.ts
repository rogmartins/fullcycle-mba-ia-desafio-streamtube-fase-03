import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.types';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import storageConfig from '../config/storage.config';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storageService: StorageService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, User]),
        ChannelsModule,
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();

    service = module.get(VideosService);
    storageService = module.get(StorageService);
    channelsService = module.get(ChannelsService);
    dataSource = module.get(DataSource);
    userRepository = module.get(getRepositoryToken(User));
    videoRepository = module.get(getRepositoryToken(Video));
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createConfirmedUserWithChannel(): Promise<{
    userId: string;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vsvc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelsService.createChannel(user.id, user.email);
    return { userId: user.id };
  }

  it('persists a row in uploading with upload_id set and a visible multipart upload', async () => {
    const { userId } = await createConfirmedUserWithChannel();

    const video = await service.createUpload(userId, {
      filename: 'trip.mp4',
      size_bytes: 1000,
      content_type: 'video/mp4',
    });

    expect(video.status).toBe(VideoStatus.UPLOADING);
    expect(video.upload_id).toBeTruthy();

    const uploads = await storageService.listMultipartUploads(
      `videos/${video.id}/`,
    );
    expect(uploads.some((u) => u.uploadId === video.upload_id)).toBe(true);

    await storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id!,
    );
  });

  it('counts only uploading rows of the same channel toward the cap', async () => {
    const { userId } = await createConfirmedUserWithChannel();
    const created: Video[] = [];

    for (let i = 0; i < 5; i++) {
      const v = await service.createUpload(userId, {
        filename: `trip${i}.mp4`,
        size_bytes: 1000,
        content_type: 'video/mp4',
      });
      created.push(v);
    }

    // Mark one as ready — it should no longer count toward the open-upload cap.
    await videoRepository.update(created[0].id, { status: VideoStatus.READY });

    const video = await service.createUpload(userId, {
      filename: 'another.mp4',
      size_bytes: 1000,
      content_type: 'video/mp4',
    });
    expect(video.status).toBe(VideoStatus.UPLOADING);
    created.push(video);

    for (const v of created) {
      if (v.upload_id) {
        await storageService
          .abortMultipartUpload(v.storage_key, v.upload_id)
          .catch(() => undefined);
      }
    }
  });
});
