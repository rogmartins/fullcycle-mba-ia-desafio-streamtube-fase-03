import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { StorageService } from '../src/storage/storage.service';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.types';

// STORAGE_PUBLIC_ENDPOINT (http://localhost:9000 by default) is the browser-facing
// address and is not reachable from inside this container's network namespace. This
// suite runs inside the nestjs-api container and PUTs to presigned URLs directly, so
// it points the "public" client at the Compose service name instead (see the same
// override and rationale in storage.service.integration-spec.ts).
process.env.STORAGE_PUBLIC_ENDPOINT = 'http://minio:9000';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storageService: StorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storageService = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as {
        mailService: { sendConfirmationEmail: (...args: unknown[]) => unknown };
      }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return (res.body as { access_token: string }).access_token;
  }

  async function cleanupUpload(res: {
    body: { upload?: { upload_id: string }; id?: string };
  }): Promise<void> {
    const videoId = res.body.id;
    const uploadId = res.body.upload?.upload_id;
    if (videoId && uploadId) {
      await storageService
        .abortMultipartUpload(`videos/${videoId}/source.mp4`, uploadId)
        .catch(() => undefined);
    }
  }

  interface CreatedVideo {
    id: string;
    public_id: string;
    upload: { upload_id: string; part_size_bytes: number; part_count: number };
  }

  async function createVideo(
    token: string,
    overrides: Partial<{
      filename: string;
      size_bytes: number;
      content_type: string;
    }> = {},
  ): Promise<CreatedVideo> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'trip.mp4',
        size_bytes: 5 * 1024 * 1024,
        content_type: 'video/mp4',
        ...overrides,
      })
      .expect(201);
    return res.body as CreatedVideo;
  }

  describe('POST /videos', () => {
    it('returns 201 with the upload shape and a Location header', async () => {
      const token = await registerConfirmAndLogin('creator1@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'trip.mp4',
          size_bytes: 10737418240,
          content_type: 'video/mp4',
        })
        .expect(201);

      expect(res.body).toMatchObject({
        status: 'uploading',
        title: 'trip',
        size_bytes: 10737418240,
        content_type: 'video/mp4',
        upload: {
          part_size_bytes: 52428800,
          part_count: 205,
        },
      });
      const body = res.body as {
        public_id: string;
        upload: { upload_id: string };
      };
      expect(body.public_id).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(body.upload.upload_id).toBeTruthy();
      expect(res.headers.location).toBe(`/videos/${body.public_id}`);

      await cleanupUpload(res);
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          filename: 'trip.mp4',
          size_bytes: 1000,
          content_type: 'video/mp4',
        })
        .expect(401);
    });

    it('returns 400 validation error for missing fields, size 0, or unknown content_type', async () => {
      const token = await registerConfirmAndLogin('creator2@example.com');

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ size_bytes: 1000, content_type: 'video/mp4' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ filename: 'a.mp4', size_bytes: 0, content_type: 'video/mp4' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'a.mkv',
          size_bytes: 1000,
          content_type: 'video/x-matroska',
        })
        .expect(400);
    });

    it('returns 415 on extension/content-type mismatch', async () => {
      const token = await registerConfirmAndLogin('creator3@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'movie.mkv',
          size_bytes: 1000,
          content_type: 'video/mp4',
        })
        .expect(415);

      expect((res.body as { error: string }).error).toBe(
        'UNSUPPORTED_MEDIA_TYPE',
      );
    });

    it('returns 400 validation error when size_bytes exceeds the 10 GiB limit', async () => {
      const token = await registerConfirmAndLogin('creator4@example.com');

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'a.mp4',
          size_bytes: 10737418241,
          content_type: 'video/mp4',
        })
        .expect(400);
    });

    it('returns 409 UPLOAD_LIMIT_REACHED on the 6th open upload for the same channel', async () => {
      const token = await registerConfirmAndLogin('creator5@example.com');
      const responses: request.Response[] = [];

      for (let i = 0; i < 5; i++) {
        const res = await request(app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${token}`)
          .send({
            filename: `trip${i}.mp4`,
            size_bytes: 1000,
            content_type: 'video/mp4',
          })
          .expect(201);
        responses.push(res);
      }

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'onemore.mp4',
          size_bytes: 1000,
          content_type: 'video/mp4',
        })
        .expect(409);
      expect((res.body as { error: string }).error).toBe(
        'UPLOAD_LIMIT_REACHED',
      );

      for (const r of responses) {
        await cleanupUpload(r);
      }
    });

    it('never returns 429 across 20 consecutive requests from the same client', async () => {
      const token = await registerConfirmAndLogin('creator6@example.com');
      const responses: request.Response[] = [];

      for (let i = 0; i < 20; i++) {
        const res = await request(app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${token}`)
          .send({
            filename: `burst${i}.mp4`,
            size_bytes: 1000,
            content_type: 'video/mp4',
          });
        expect(res.status).not.toBe(429);
        if (res.status === 201) {
          responses.push(res);
        }
      }

      for (const r of responses) {
        await cleanupUpload(r);
      }
    });
  });

  describe('POST /videos/:id/upload/parts/:partNumber/url and GET /videos/:id/upload/parts', () => {
    it('signs a part URL, accepts a real PUT, and lists it back', async () => {
      const token = await registerConfirmAndLogin('signer1@example.com');
      const video = await createVideo(token);

      const signRes = await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/parts/1/url`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const signed = signRes.body as {
        part_number: number;
        url: string;
        expires_at: string;
      };
      expect(signed.part_number).toBe(1);
      expect(signed.url.startsWith(process.env.STORAGE_PUBLIC_ENDPOINT!)).toBe(
        true,
      );

      const putRes = await fetch(signed.url, {
        method: 'PUT',
        body: Buffer.alloc(5 * 1024 * 1024, 'a'),
      });
      expect(putRes.status).toBe(200);

      const listRes = await request(app.getHttpServer())
        .get(`/videos/${video.id}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const listBody: unknown = listRes.body;
      expect(listBody).toEqual({
        parts: [
          {
            part_number: 1,
            etag: putRes.headers.get('etag'),
            size_bytes: 5 * 1024 * 1024,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Jest's expect.any() is typed `any`
            last_modified: expect.any(String),
          },
        ],
      });

      await storageService.abortMultipartUpload(
        `videos/${video.id}/source.mp4`,
        video.upload.upload_id,
      );
    });

    it('returns { parts: [] } before any part is uploaded', async () => {
      const token = await registerConfirmAndLogin('signer2@example.com');
      const video = await createVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body).toEqual({ parts: [] });

      await storageService.abortMultipartUpload(
        `videos/${video.id}/source.mp4`,
        video.upload.upload_id,
      );
    });

    it('returns 400 for part number 0, above part_count, or non-integer', async () => {
      const token = await registerConfirmAndLogin('signer3@example.com');
      const video = await createVideo(token);

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/parts/0/url`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      await request(app.getHttpServer())
        .post(
          `/videos/${video.id}/upload/parts/${video.upload.part_count + 1}/url`,
        )
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/parts/abc/url`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      await storageService.abortMultipartUpload(
        `videos/${video.id}/source.mp4`,
        video.upload.upload_id,
      );
    });

    it('returns 404 for an unknown video id', async () => {
      const token = await registerConfirmAndLogin('signer4@example.com');
      const unknownId = '00000000-0000-0000-0000-000000000000';

      await request(app.getHttpServer())
        .post(`/videos/${unknownId}/upload/parts/1/url`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/videos/${unknownId}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 403 when the caller does not own the video', async () => {
      const ownerToken = await registerConfirmAndLogin('owner1@example.com');
      const otherToken = await registerConfirmAndLogin('other1@example.com');
      const video = await createVideo(ownerToken);

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/parts/1/url`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/videos/${video.id}/upload/parts`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);

      await storageService.abortMultipartUpload(
        `videos/${video.id}/source.mp4`,
        video.upload.upload_id,
      );
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/upload/parts/1/url')
        .expect(401);
      await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/upload/parts')
        .expect(401);
    });

    it('returns 409 when the video is not in uploading state', async () => {
      const token = await registerConfirmAndLogin('signer5@example.com');
      const video = await createVideo(token);
      const videoRepository = dataSource.getRepository(Video);
      await videoRepository.update(video.id, { status: VideoStatus.READY });

      const signRes = await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/parts/1/url`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((signRes.body as { error: string }).error).toBe(
        'VIDEO_INVALID_STATE',
      );

      const listRes = await request(app.getHttpServer())
        .get(`/videos/${video.id}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((listRes.body as { error: string }).error).toBe(
        'VIDEO_INVALID_STATE',
      );

      await storageService.abortMultipartUpload(
        `videos/${video.id}/source.mp4`,
        video.upload.upload_id,
      );
    });
  });

  async function uploadAllPartsViaApi(
    token: string,
    video: CreatedVideo,
  ): Promise<{ part_number: number; etag: string }[]> {
    const parts: { part_number: number; etag: string }[] = [];
    for (let i = 1; i <= video.upload.part_count; i++) {
      const signRes = await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/parts/${i}/url`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const { url } = signRes.body as { url: string };
      const isLast = i === video.upload.part_count;
      const size = isLast ? 1024 : video.upload.part_size_bytes;
      const putRes = await fetch(url, {
        method: 'PUT',
        body: Buffer.alloc(size, 'a'),
      });
      parts.push({ part_number: i, etag: putRes.headers.get('etag')! });
    }
    return parts;
  }

  describe('POST /videos/:id/upload/complete', () => {
    it('completes the full happy path from POST /videos to a 200 completion', async () => {
      const token = await registerConfirmAndLogin('completer1@example.com');
      const video = await createVideo(token, {
        size_bytes: 52428800 + 1024, // forces exactly 2 parts
      });
      const parts = await uploadAllPartsViaApi(token, video);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      expect(res.body).toMatchObject({
        id: video.id,
        public_id: video.public_id,
        status: 'processing',
      });
      expect((res.body as { uploaded_at?: string }).uploaded_at).toBeTruthy();

      await storageService.deleteByPrefix('videos', `videos/${video.id}/`);
    });

    it('returns 409 UPLOAD_INCOMPLETE with a missing part or a wrong ETag', async () => {
      const token = await registerConfirmAndLogin('completer2@example.com');
      const video = await createVideo(token, {
        size_bytes: 52428800 + 1024, // forces exactly 2 parts
      });
      const parts = await uploadAllPartsViaApi(token, video);

      const missingRes = await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [parts[0]] })
        .expect(409);
      expect((missingRes.body as { error: string }).error).toBe(
        'UPLOAD_INCOMPLETE',
      );

      const wrongEtagRes = await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          parts: [
            { part_number: parts[0].part_number, etag: '"deadbeef"' },
            parts[1],
          ],
        })
        .expect(409);
      expect((wrongEtagRes.body as { error: string }).error).toBe(
        'UPLOAD_INCOMPLETE',
      );

      await storageService.abortMultipartUpload(
        `videos/${video.id}/source.mp4`,
        video.upload.upload_id,
      );
    });

    it('returns 409 VIDEO_INVALID_STATE on a second completion', async () => {
      const token = await registerConfirmAndLogin('completer3@example.com');
      const video = await createVideo(token, {
        size_bytes: 52428800 + 1024, // forces exactly 2 parts
      });
      const parts = await uploadAllPartsViaApi(token, video);

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(409);
      expect((res.body as { error: string }).error).toBe('VIDEO_INVALID_STATE');

      await storageService.deleteByPrefix('videos', `videos/${video.id}/`);
    });

    it('returns 400 validation error on an empty parts array', async () => {
      const token = await registerConfirmAndLogin('completer4@example.com');
      const video = await createVideo(token);

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [] })
        .expect(400);

      await storageService.abortMultipartUpload(
        `videos/${video.id}/source.mp4`,
        video.upload.upload_id,
      );
    });
  });

  describe('DELETE /videos/:id', () => {
    it('returns 204 for an uploading video, aborting the upload and removing the row', async () => {
      const token = await registerConfirmAndLogin('deleter1@example.com');
      const video = await createVideo(token);

      await request(app.getHttpServer())
        .delete(`/videos/${video.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const uploads = await storageService.listMultipartUploads(
        `videos/${video.id}/`,
      );
      expect(uploads).toHaveLength(0);
    });

    it('returns 204 for a failed video', async () => {
      const token = await registerConfirmAndLogin('deleter2@example.com');
      const video = await createVideo(token);
      await dataSource
        .getRepository(Video)
        .update(video.id, { status: VideoStatus.FAILED });

      await request(app.getHttpServer())
        .delete(`/videos/${video.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
    });

    it('returns 409 for processing or ready videos', async () => {
      const token = await registerConfirmAndLogin('deleter3@example.com');
      const video = await createVideo(token);
      const videoRepository = dataSource.getRepository(Video);

      await videoRepository.update(video.id, {
        status: VideoStatus.PROCESSING,
      });
      await request(app.getHttpServer())
        .delete(`/videos/${video.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      await videoRepository.update(video.id, { status: VideoStatus.READY });
      await request(app.getHttpServer())
        .delete(`/videos/${video.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      await videoRepository.delete({ id: video.id });
      await storageService.abortMultipartUpload(
        `videos/${video.id}/source.mp4`,
        video.upload.upload_id,
      );
    });

    it('returns 404 for an unknown video and 403 for a non-owner', async () => {
      const ownerToken = await registerConfirmAndLogin('deleter4@example.com');
      const otherToken = await registerConfirmAndLogin('deleter5@example.com');
      const video = await createVideo(ownerToken);

      await request(app.getHttpServer())
        .delete('/videos/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/videos/${video.id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);

      await storageService.abortMultipartUpload(
        `videos/${video.id}/source.mp4`,
        video.upload.upload_id,
      );
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .delete('/videos/00000000-0000-0000-0000-000000000000')
        .expect(401);
    });
  });

  async function createReadyVideo(
    token: string,
    overrides: Partial<{
      filename: string;
      size_bytes: number;
      content_type: string;
    }> = {},
  ): Promise<CreatedVideo> {
    const video = await createVideo(token, overrides);
    const parts = await uploadAllPartsViaApi(token, video);
    await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts })
      .expect(200);
    await dataSource
      .getRepository(Video)
      .update(video.id, { status: VideoStatus.READY });
    return video;
  }

  describe('GET /videos/:publicId', () => {
    it('returns the public shape without auth and never leaks internal fields', async () => {
      const token = await registerConfirmAndLogin('reader1@example.com');
      const video = await createReadyVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .expect(200);

      expect(res.body).toMatchObject({
        public_id: video.public_id,
        status: 'ready',
        thumbnail_url: null,
      });
      expect(res.body).not.toHaveProperty('id');
      expect(res.body).not.toHaveProperty('storage_key');
      expect(res.body).not.toHaveProperty('upload_id');
      expect(res.body).not.toHaveProperty('error_reason');
      expect(res.body).not.toHaveProperty('metadata');
      expect(res.body).not.toHaveProperty('channel_id');
    });

    it('returns 404 for an unknown 12-char id', async () => {
      await request(app.getHttpServer())
        .get('/videos/abcdefghijkl')
        .expect(404)
        .expect((res) => {
          expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
        });
    });

    it('returns 404 for a malformed id (e.g. a UUID)', async () => {
      await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });
  });

  describe('GET /videos/:publicId/playback', () => {
    it('returns 200 with { url, expires_at } for a ready video, and the url answers Range with 206', async () => {
      const token = await registerConfirmAndLogin('player1@example.com');
      const video = await createReadyVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback`)
        .expect(200);

      const body = res.body as { url: string; expires_at: string };
      expect(body.url).toBeTruthy();
      const expiresAt = new Date(body.expires_at).getTime();
      expect(expiresAt).toBeGreaterThan(Date.now() + 7 * 60 * 60 * 1000);

      const rangeRes = await fetch(body.url, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(rangeRes.status).toBe(206);
    });

    it.each([
      ['uploading', VideoStatus.UPLOADING],
      ['processing', VideoStatus.PROCESSING],
      ['failed', VideoStatus.FAILED],
    ])('returns 409 VIDEO_NOT_READY for a %s video', async (_label, status) => {
      const token = await registerConfirmAndLogin(
        `player-${status}@example.com`,
      );
      const video = await createVideo(token);
      await dataSource.getRepository(Video).update(video.id, { status });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback`)
        .expect(409);
      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');

      if (status === VideoStatus.UPLOADING) {
        await cleanupUpload({ body: video });
      }
    });

    it('returns 404 for an unknown publicId', async () => {
      await request(app.getHttpServer())
        .get('/videos/abcdefghijkl/playback')
        .expect(404);
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('returns 200 with a sanitized filename and matching Content-Disposition on the store', async () => {
      const token = await registerConfirmAndLogin('downloader1@example.com');
      const video = await createReadyVideo(token, {
        filename: 'Férias 2026: praia!.mp4',
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .expect(200);

      const body = res.body as {
        url: string;
        expires_at: string;
        filename: string;
      };
      expect(body.filename).toBe('Ferias-2026-praia.mp4');
      const expiresAt = new Date(body.expires_at).getTime();
      expect(expiresAt).toBeGreaterThan(Date.now() + 10 * 60 * 1000);
      expect(expiresAt).toBeLessThan(Date.now() + 20 * 60 * 1000);

      const getRes = await fetch(body.url);
      expect(getRes.headers.get('content-disposition')).toBe(
        'attachment; filename="Ferias-2026-praia.mp4"',
      );
    });

    it.each([
      ['uploading', VideoStatus.UPLOADING],
      ['processing', VideoStatus.PROCESSING],
      ['failed', VideoStatus.FAILED],
    ])('returns 409 VIDEO_NOT_READY for a %s video', async (_label, status) => {
      const token = await registerConfirmAndLogin(
        `downloader-${status}@example.com`,
      );
      const video = await createVideo(token);
      await dataSource.getRepository(Video).update(video.id, { status });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .expect(409);
      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');

      if (status === VideoStatus.UPLOADING) {
        await cleanupUpload({ body: video });
      }
    });

    it('returns 404 for an unknown publicId', async () => {
      await request(app.getHttpServer())
        .get('/videos/abcdefghijkl/download')
        .expect(404);
    });
  });
});
