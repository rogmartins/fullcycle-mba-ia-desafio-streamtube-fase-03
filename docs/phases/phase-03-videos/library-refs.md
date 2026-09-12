# Phase 03 — Upload e Processamento de Vídeos — Library References

> New dependencies pinned for this phase, with versions confirmed on 2026-09-12 via context7 (`/nestjs/bull`, `/taskforcesh/bullmq`, `/aws/aws-sdk-js-v3`, `/nestjs/docs.nestjs.com`) and the npm registry, and load-tested inside `node:25.6.0-slim` against the project's toolchain (TypeScript 5.9.3 `module: nodenext` → CommonJS, Jest 30.3.0, ts-jest 29.4.6). Existing dependencies (NestJS 11, TypeORM 0.3, `@nestjs/config`, Joi, class-validator, `@nestjs/throttler`) are unchanged.

---

## New production dependencies

| Package | Pinned range | Confirmed latest in range | Module format | Node | Peers / notes | Decision |
|---------|--------------|---------------------------|---------------|------|---------------|----------|
| `@nestjs/bullmq` | `^11.0.5` | `11.0.5` (2025) | CommonJS | — | peers `@nestjs/common` / `@nestjs/core` `^10 \|\| ^11`, `bullmq` `^3 \|\| ^4 \|\| ^5` | TD-01, **TD-24** |
| `bullmq` | `^5.81.5` | `5.81.5` | CommonJS | ≥ 14.17 | bundles `ioredis@5.11.1` — **do not install `ioredis` separately** | TD-01, TD-24 |
| `@aws-sdk/client-s3` | `^3.1131.0` | `3.1131.0` (2026-09-11) | CommonJS (`dist-cjs`) | ≥ 20 | no peers | TD-07 |
| `@aws-sdk/s3-request-presigner` | `^3.1131.0` | `3.1131.0` (2026-09-11) | CommonJS (`dist-cjs`) | ≥ 20 | no peers; keep the same minor as `client-s3` | TD-07, TD-14, TD-16 |

**Deliberately not added:** `ioredis` (bundled by `bullmq@5`), any FFmpeg npm wrapper (TD-10 — `child_process.spawn`), any id library (TD-13 — `node:crypto`), `@nestjs/schedule` (the sweep is a BullMQ job scheduler, TD-06/TD-20), `minio` SDK (TD-07), `@aws-sdk/lib-storage` (TD-04 rejected streaming through the API).

**Explicitly excluded versions:** `@nestjs/bullmq@12.x` and `bullmq@6.x` — `@nestjs/bullmq@12.0.0` is ESM-only (`"type": "module"`, `exports["."].require` → the same ESM file) and fails to load under Jest + ts-jest (`SyntaxError: Unexpected token 'export'`); see [validation.md](validation.md) V-04 and TD-24.

## New infrastructure images (Compose)

| Image | Tag | Purpose | Decision |
|-------|-----|---------|----------|
| `redis` | `7-alpine` (or current 7.x) | BullMQ backend — `--maxmemory-policy noeviction --appendonly yes` | TD-01 |
| `minio/minio` | current | S3-API object store (API 9000, console 9001), `MINIO_API_STALE_UPLOADS_EXPIRY=192h` | TD-20, TD-21 |
| `minio/mc` | current | one-shot provisioning (`mc mb`, `mc anonymous set download`, `mc cors set`, `mc ilm` / lifecycle JSON) | TD-21 |
| `node:25.6.0-slim` + `apt-get install -y ffmpeg` | Debian 12 → FFmpeg `7:5.1.9-0+deb12u1` | `ffmpeg` + `ffprobe` in `Dockerfile.dev` (serves both `nestjs-api` and `video-worker`; N-10) | TD-09 |

---

## API surface used by the plan (verified)

### `@nestjs/bullmq@11` / `bullmq@5`

| Symbol | Used by | Notes |
|--------|---------|-------|
| `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory })` → `{ connection: { host, port }, defaultJobOptions }` | SI-03.4 | Global Redis connection; `defaultJobOptions` carries `attempts`, `backoff`, `removeOnComplete`, `removeOnFail` |
| `BullModule.registerQueue({ name })` | SI-03.4 | One call per queue: `video-processing`, `video-maintenance` |
| `@InjectQueue(name)` → `Queue` | SI-03.4, SI-03.13 | Publisher side; `getQueueToken(name)` for tests |
| `Queue.add(name, data, { jobId, attempts, backoff })` | SI-03.4 | Custom `jobId` makes a second `add` a no-op while the job exists; ids must not contain `:` nor be all digits — the plan uses `video-<uuid>` (N-17) |
| `Queue.getJob(jobId)` / `Job.getState()` | SI-03.13 | Sweep checks whether a `processing` row still has a live job (`waiting` / `active` / `delayed` / `prioritized` / `waiting-children`) |
| `Queue.upsertJobScheduler(id, { every }, { name, data, opts })` | SI-03.14 | Repeatable sweep every `SWEEP_INTERVAL_MINUTES`; idempotent on every worker boot |
| `@Processor(queueName, { concurrency, lockDuration, maxStalledCount })` + `class extends WorkerHost` + `process(job)` | SI-03.12, SI-03.13 | `WorkerHost.worker` exposes the BullMQ `Worker` |
| `@OnWorkerEvent('failed')` / `('completed')` | SI-03.12 | Terminal-failure hook: `job.attemptsMade >= job.opts.attempts` → mark the video `failed` |
| `UnrecoverableError` | SI-03.12 | Skips the remaining attempts (non-retryable `INVALID_MEDIA`, TD-22) |
| `backoff: { type: 'exponential', delay }` | SI-03.4 | TD-03: 3 attempts, 30 s base |

### `@aws-sdk/client-s3@3` / `@aws-sdk/s3-request-presigner@3`

| Symbol | Used by | Notes |
|--------|---------|-------|
| `new S3Client({ endpoint, region, forcePathStyle: true, credentials })` | SI-03.3 | Two instances: internal endpoint (`STORAGE_ENDPOINT`) and public endpoint (`STORAGE_PUBLIC_ENDPOINT`) — SigV4 signs the `Host`, so browser-facing URLs must be signed with the public client (N-09) |
| `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId` | SI-03.3, SI-03.7 | |
| `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` + `getSignedUrl(publicClient, cmd, { expiresIn })` | SI-03.3, SI-03.8 | `PartNumber` 1–10,000; the browser `PUT`s the body; response `ETag` header must be exposed by CORS |
| `ListPartsCommand({ Bucket, Key, UploadId, PartNumberMarker })` → `Parts[]` (`PartNumber`, `ETag`, `Size`, `LastModified`), `IsTruncated`, `NextPartNumberMarker` | SI-03.3, SI-03.8, SI-03.9, SI-03.13 | 1,000 parts/page; `NoSuchUpload` error when the upload no longer exists |
| `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` | SI-03.3, SI-03.9 | Parts must be ascending; `InvalidPart` / `InvalidPartOrder` on mismatch |
| `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` | SI-03.3, SI-03.9, SI-03.13 | Idempotent enough for the sweep (`NoSuchUpload` treated as already aborted) |
| `ListMultipartUploadsCommand({ Bucket, Prefix, KeyMarker, UploadIdMarker })` → `Uploads[]`, `IsTruncated`, `NextKeyMarker`, `NextUploadIdMarker` | SI-03.3, SI-03.13 | 1,000 uploads/page; orphan detection under `videos/` |
| `GetObjectCommand({ Bucket, Key, ResponseContentDisposition })` + `getSignedUrl(client, cmd, { expiresIn })` | SI-03.3, SI-03.10, SI-03.12 | Playback (public client, no disposition), download (public client, `attachment; filename="…"`), worker source (internal client). `Range` is not part of the signature, so the player may range-request freely (TD-14) |
| `HeadObjectCommand` / `PutObjectCommand({ Body, ContentType, CacheControl })` / `ListObjectsV2Command` + `DeleteObjectsCommand` | SI-03.3, SI-03.12, SI-03.9, SI-03.13 | Object existence (sweep heal path N-06a), thumbnail upload, delete-by-prefix on cancel |
| `getSignedUrl` default `expiresIn` = 900 s | — | Every call passes an explicit TTL from config |

### NestJS 11 (existing) — used in new ways

| Symbol | Used by | Notes |
|--------|---------|-------|
| `NestFactory.createApplicationContext(WorkerModule)` + `app.enableShutdownHooks()` | SI-03.14 | Standalone context (TD-08); no guards/pipes/filters; `SIGTERM` → `onModuleDestroy` → BullMQ worker closes after the in-flight job |
| `@SkipThrottle()` (class-level, `@nestjs/throttler@6`) | SI-03.7 | TD-23; precedent `src/app.controller.ts` |
| `nest start --entryFile main.worker` (`@nestjs/cli@11`) | SI-03.14 | Second entrypoint from the same build; `--watch` in Compose |
