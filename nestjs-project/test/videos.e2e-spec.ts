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
});
