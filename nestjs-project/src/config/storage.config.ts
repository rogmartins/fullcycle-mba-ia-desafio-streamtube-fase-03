import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY!,
  secretKey: process.env.STORAGE_SECRET_KEY!,
  videoBucket: process.env.STORAGE_VIDEO_BUCKET || 'videos',
  thumbnailBucket: process.env.STORAGE_THUMBNAIL_BUCKET || 'thumbnails',
  uploadPartSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES || '52428800',
    10,
  ),
  uploadMaxSizeBytes: parseInt(
    process.env.UPLOAD_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  uploadMaxOpenPerChannel: parseInt(
    process.env.UPLOAD_MAX_OPEN_PER_CHANNEL || '5',
    10,
  ),
  uploadPartUrlTtlSeconds: parseInt(
    process.env.UPLOAD_PART_URL_TTL_SECONDS || '3600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.PLAYBACK_URL_TTL_SECONDS || '28800',
    10,
  ),
  downloadUrlTtlSeconds: parseInt(
    process.env.DOWNLOAD_URL_TTL_SECONDS || '900',
    10,
  ),
  workerSourceUrlTtlSeconds: parseInt(
    process.env.WORKER_SOURCE_URL_TTL_SECONDS || '7200',
    10,
  ),
}));
