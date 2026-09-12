import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video } from './video.entity';
import { VideoStatus } from '../videos.types';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function baseVideo(channelId: string, overrides: Partial<Video> = {}) {
    return {
      public_id: randomUUID().replace(/-/g, '').slice(0, 12),
      channel_id: channelId,
      title: 'My video',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      size_bytes: '1000',
      storage_key: `videos/${randomUUID()}/source.mp4`,
      part_size_bytes: 52428800,
      part_count: 1,
      ...overrides,
    };
  }

  it('enforces the unique public_id constraint', async () => {
    const channel = await createChannel();
    const publicId = 'abcdefghijkl';

    await videoRepository.save(
      videoRepository.create(baseVideo(channel.id, { public_id: publicId })),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(baseVideo(channel.id, { public_id: publicId })),
      ),
    ).rejects.toThrow();
  });

  it('enforces public_id max length of 12', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create(
          baseVideo(channel.id, { public_id: 'a'.repeat(13) }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('rejects an unknown status value and defaults to draft when omitted', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("public_id","channel_id","title","original_filename","content_type","size_bytes","storage_key","part_size_bytes","part_count","status")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'published')`,
        [
          'zzzzzzzzzzzz',
          channel.id,
          'title',
          'file.mp4',
          'video/mp4',
          '1000',
          'videos/x/source.mp4',
          52428800,
          1,
        ],
      ),
    ).rejects.toThrow();

    const saved = await videoRepository.save(
      videoRepository.create(baseVideo(channel.id)),
    );
    expect(saved.status).toBe(VideoStatus.DRAFT);
  });

  it('rejects an unknown channel_id (FK violation)', async () => {
    await expect(
      videoRepository.save(videoRepository.create(baseVideo(randomUUID()))),
    ).rejects.toThrow();
  });

  it('restricts deleting a channel that owns a video', async () => {
    const channel = await createChannel();
    await videoRepository.save(videoRepository.create(baseVideo(channel.id)));

    await expect(
      channelRepository.delete({ id: channel.id }),
    ).rejects.toThrow();
  });

  it('defaults nullable metadata columns to NULL', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create(baseVideo(channel.id)),
    );

    expect(saved.duration_seconds).toBeNull();
    expect(saved.width).toBeNull();
    expect(saved.height).toBeNull();
    expect(saved.thumbnail_key).toBeNull();
    expect(saved.error_reason).toBeNull();
    expect(saved.metadata).toBeNull();
  });

  it('stores size_bytes above 2^31 as bigint', async () => {
    const channel = await createChannel();
    const tenGiB = '10737418240';
    const saved = await videoRepository.save(
      videoRepository.create(baseVideo(channel.id, { size_bytes: tenGiB })),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(tenGiB);
  });

  it('auto-populates created_at and updated_at timestamps', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create(baseVideo(channel.id)),
    );

    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });
});
