import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  jobAttempts: parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10),
  jobBackoffMs: parseInt(process.env.QUEUE_JOB_BACKOFF_MS || '30000', 10),
  workerConcurrency: parseInt(process.env.QUEUE_WORKER_CONCURRENCY || '1', 10),
  sweepIntervalMinutes: parseInt(
    process.env.SWEEP_INTERVAL_MINUTES || '15',
    10,
  ),
  sweepStaleUploadMinutes: parseInt(
    process.env.SWEEP_STALE_UPLOAD_MINUTES || '60',
    10,
  ),
  sweepAbandonDays: parseInt(process.env.SWEEP_ABANDON_DAYS || '7', 10),
  sweepStaleProcessingMinutes: parseInt(
    process.env.SWEEP_STALE_PROCESSING_MINUTES || '60',
    10,
  ),
}));
