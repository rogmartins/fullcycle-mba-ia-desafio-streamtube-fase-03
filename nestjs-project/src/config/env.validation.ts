import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),

  // Queue (Phase 03)
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().default(6379),
  QUEUE_JOB_ATTEMPTS: Joi.number().default(3),
  QUEUE_JOB_BACKOFF_MS: Joi.number().default(30000),
  QUEUE_WORKER_CONCURRENCY: Joi.number().default(1),
  SWEEP_INTERVAL_MINUTES: Joi.number().default(15),
  SWEEP_STALE_UPLOAD_MINUTES: Joi.number().default(60),
  SWEEP_ABANDON_DAYS: Joi.number().default(7),
  SWEEP_STALE_PROCESSING_MINUTES: Joi.number().default(60),

  // Storage (Phase 03)
  STORAGE_ENDPOINT: Joi.string().default('http://minio:9000'),
  STORAGE_PUBLIC_ENDPOINT: Joi.string().default('http://localhost:9000'),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_ACCESS_KEY: Joi.string().required(),
  STORAGE_SECRET_KEY: Joi.string().required(),
  STORAGE_VIDEO_BUCKET: Joi.string().default('videos'),
  STORAGE_THUMBNAIL_BUCKET: Joi.string().default('thumbnails'),
  UPLOAD_PART_SIZE_BYTES: Joi.number()
    .min(5 * 1024 * 1024)
    .default(52428800),
  UPLOAD_MAX_SIZE_BYTES: Joi.number().default(10737418240),
  UPLOAD_MAX_OPEN_PER_CHANNEL: Joi.number().default(5),
  UPLOAD_PART_URL_TTL_SECONDS: Joi.number().default(3600),
  PLAYBACK_URL_TTL_SECONDS: Joi.number().default(28800),
  DOWNLOAD_URL_TTL_SECONDS: Joi.number().default(900),
  WORKER_SOURCE_URL_TTL_SECONDS: Joi.number().default(7200),

  // Processing (Phase 03)
  FFPROBE_TIMEOUT_MS: Joi.number().default(120000),
  FFMPEG_THUMBNAIL_TIMEOUT_MS: Joi.number().default(300000),
  THUMBNAIL_OFFSET_PERCENT: Joi.number().default(10),
  THUMBNAIL_MAX_WIDTH: Joi.number().default(1280),
  THUMBNAIL_JPEG_QUALITY: Joi.number().default(3),
}).custom((value: Record<string, number>, helpers) => {
  const partSize = value.UPLOAD_PART_SIZE_BYTES;
  const maxSize = value.UPLOAD_MAX_SIZE_BYTES;
  if (Math.ceil(maxSize / partSize) > 10000) {
    return helpers.message({
      custom:
        'UPLOAD_MAX_SIZE_BYTES / UPLOAD_PART_SIZE_BYTES must not exceed 10,000 parts',
    });
  }
  return value;
}, 'upload part count validation');
