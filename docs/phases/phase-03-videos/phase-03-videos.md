# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video ingestion pipeline — resumable multipart upload of files up to 10 GB directly to the object store, automatic draft pre-registration, background processing (metadata extraction and thumbnail generation) by a dedicated FFmpeg worker, a unique public identifier per video, and presigned streaming/download URLs — establishing the storage, queue and worker infrastructure for all subsequent phases.

> Inputs: [context.md](context.md), [validation.md](validation.md) (verdict `clean`, Run 3), [library-refs.md](library-refs.md), and [technical-decisions-phase-03-upload-processing.md](../../decisions/technical-decisions-phase-03-upload-processing.md) (TD-01–TD-24). Assumptions N-01–N-17 from validation.md are applied as written. Target subproject: `nestjs-project` only.

---

## Step Implementations

### SI-03.1 — Dependencies and Configuration Namespaces

**Description:** Install the Phase 03 production dependencies (queue client and S3 client — versions per TD-24 and [library-refs.md](library-refs.md)), create the `queue`, `storage` and `processing` config namespaces following the `registerAs` pattern from Phase 01, extend the Joi validation schema, and document every new variable in `.env.example`.

**Technical actions:**

- Install production dependencies in nestjs-project: `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5` (CommonJS line, `ioredis` bundled — TD-24), `@aws-sdk/client-s3@^3.1131.0`, `@aws-sdk/s3-request-presigner@^3.1131.0` (Node ≥ 20, NestJS 11 compatible). Do **not** install `ioredis`, an FFmpeg wrapper or an id library (TD-10, TD-13)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`), `QUEUE_JOB_ATTEMPTS` (number, default `3`), `QUEUE_JOB_BACKOFF_MS` (number, default `30000`), `QUEUE_WORKER_CONCURRENCY` (number, default `1`), `SWEEP_INTERVAL_MINUTES` (number, default `15`), `SWEEP_STALE_UPLOAD_MINUTES` (number, default `60`), `SWEEP_ABANDON_DAYS` (number, default `7`), `SWEEP_STALE_PROCESSING_MINUTES` (number, default `60`)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (string, default `'http://minio:9000'` — internal, Compose service name), `STORAGE_PUBLIC_ENDPOINT` (string, default `'http://localhost:9000'` — the one documented exception to the Docker networking rule: browser-facing), `STORAGE_REGION` (string, default `'us-east-1'`), `STORAGE_ACCESS_KEY` (string, required), `STORAGE_SECRET_KEY` (string, required), `STORAGE_VIDEO_BUCKET` (string, default `'videos'`), `STORAGE_THUMBNAIL_BUCKET` (string, default `'thumbnails'`), `UPLOAD_PART_SIZE_BYTES` (number, default `52428800` = 50 MiB), `UPLOAD_MAX_SIZE_BYTES` (number, default `10737418240` = 10 GiB), `UPLOAD_MAX_OPEN_PER_CHANNEL` (number, default `5` — TD-23), `UPLOAD_PART_URL_TTL_SECONDS` (number, default `3600`), `PLAYBACK_URL_TTL_SECONDS` (number, default `28800` = 8 h, TD-15), `DOWNLOAD_URL_TTL_SECONDS` (number, default `900`), `WORKER_SOURCE_URL_TTL_SECONDS` (number, default `7200`)
- Create `src/config/processing.config.ts` — `registerAs('processing', ...)` reading `FFPROBE_TIMEOUT_MS` (number, default `120000`), `FFMPEG_THUMBNAIL_TIMEOUT_MS` (number, default `300000`), `THUMBNAIL_OFFSET_PERCENT` (number, default `10` — TD-12), `THUMBNAIL_MAX_WIDTH` (number, default `1280`), `THUMBNAIL_JPEG_QUALITY` (number, default `3` — ffmpeg `-q:v` scale)
- Update `src/config/env.validation.ts` — add every variable above to the Joi schema (`STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` required, the rest with the defaults listed; enforce `UPLOAD_PART_SIZE_BYTES` ≥ 5 MiB and `UPLOAD_MAX_SIZE_BYTES / UPLOAD_PART_SIZE_BYTES` ≤ 10,000 via a custom Joi rule) and register the three namespaces in `AppModule`'s `ConfigModule.forRoot({ load })`. Update `.env.example` with all variables and Compose-compatible defaults

**Dependencies:** None

**Acceptance criteria:**

- Application starts without errors when all new environment variables are provided — existing E2E test (`GET /` returns 200) and the full Phase 02 suite still pass
- Starting the application without `STORAGE_ACCESS_KEY` or `STORAGE_SECRET_KEY` causes a Joi validation error at bootstrap — the app does not start
- Starting the application with `UPLOAD_PART_SIZE_BYTES=1048576` (below the 5 MiB S3 minimum) causes a Joi validation error at bootstrap
- `npx tsc --noEmit` exits with code 0 after the dependency installation (no ESM/CJS type resolution errors)

---

### SI-03.2 — Docker Compose: Redis, MinIO, Provisioning and FFmpeg

**Description:** Add the queue backend, the S3-compatible object store with its one-shot provisioning service, and FFmpeg to the development image, so every external system the phase depends on runs in Compose with Compose service names as hosts. The `video-worker` service itself is added in SI-03.14 together with its entrypoint.

**Technical actions:**

- Add a `redis` service to `nestjs-project/compose.yaml` — image `redis:7-alpine`, command `redis-server --maxmemory-policy noeviction --appendonly yes` (TD-01), named volume for `/data`, healthcheck `redis-cli ping`; add `nestjs-api` `depends_on: redis: condition: service_healthy`
- Add a `minio` service — image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000:9000` and `9001:9001` (the API port must be published because the browser uploads directly — TD-04), environment `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (dev-only admin credentials, distinct from `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` used by the application) and `MINIO_API_STALE_UPLOADS_EXPIRY=192h` (8 days — strictly above `SWEEP_ABANDON_DAYS=7`, TD-20/N-05), named volume for `/data`, healthcheck via `mc ready local` or `curl -f http://localhost:9000/minio/health/live`
- Add a `minio-init` one-shot service (image `minio/mc`, `depends_on: minio: condition: service_healthy`, `restart: "no"`) running an entrypoint script (`nestjs-project/docker/minio-init.sh`, mounted read-only) that: sets the alias with the root credentials; creates the application access key (`mc admin user add` + `mc admin policy attach readwrite`) so the API/worker never hold admin credentials (TD-21); runs `mc mb --ignore-existing` for `STORAGE_VIDEO_BUCKET` and `STORAGE_THUMBNAIL_BUCKET`; `mc anonymous set download` on the thumbnail bucket only (TD-18); applies a CORS document to the video bucket allowing `PUT`, `GET`, `HEAD` from `APP_CORS_ORIGIN` (added to `.env.example` with default `http://localhost:3001`, the future frontend origin; consumed only by `minio-init` — not part of the Joi schema) with `AllowedHeaders: *` and `ExposeHeaders: ETag, Content-Range, Accept-Ranges, Content-Length` (TD-04, TD-14); applies a lifecycle JSON with `AbortIncompleteMultipartUpload.DaysAfterInitiation: 8` to the video bucket via `mc ilm import`, tolerating MinIO's rejection of that rule (`|| true` with a logged warning — no-op on MinIO, honoured on S3, TD-20); `nestjs-api` `depends_on: minio-init: condition: service_completed_successfully`
- Update `Dockerfile.dev` — `apt-get install -y --no-install-recommends ffmpeg` alongside `procps curl` (Debian 12 → FFmpeg 5.1 with `ffprobe`, TD-09/N-10) and clean the apt lists; add a comment that production images (Phase 07) keep FFmpeg only in the worker target (TD-02)

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose up -d` brings up `db`, `mailpit`, `redis`, `minio` (healthy) and `nestjs-api` (running) and `minio-init` exits with code 0
- `docker compose exec nestjs-api sh -c 'ffmpeg -version && ffprobe -version'` prints FFmpeg 5.1.x for both binaries
- `docker compose exec nestjs-api node -e "..."` connecting to `redis:6379` receives `PONG`; `redis-cli CONFIG GET maxmemory-policy` inside the `redis` container returns `noeviction`
- After `minio-init` completes, the `videos` bucket exists with no anonymous access (an unsigned `GET http://localhost:9000/videos/` returns 403) and the `thumbnails` bucket answers unsigned `GET`s for existing objects (200) — verifiable with `mc anonymous get`
- A preflight `OPTIONS` request to `http://localhost:9000/videos/any-key` with `Origin: http://localhost:3001` and `Access-Control-Request-Method: PUT` returns `Access-Control-Allow-Origin: http://localhost:3001` and exposes `ETag`, `Content-Range`, `Accept-Ranges`, `Content-Length`
- Running `docker compose up -d minio-init` a second time is idempotent — exit code 0, buckets/policies unchanged

---

### SI-03.3 — Storage Module (S3 Client Wrapper)

**Description:** Create the `StorageModule` with a `StorageService` that wraps two AWS SDK v3 `S3Client` instances (internal and public endpoints) and exposes every storage operation the phase needs — multipart lifecycle, presigned URLs, object upload/delete/existence and the public thumbnail URL — so no other module imports the AWS SDK directly.

**Technical actions:**

- Create `src/storage/storage.module.ts` — a regular (non-global) module that `providers` `StorageService` plus two factory providers `STORAGE_INTERNAL_CLIENT` and `STORAGE_PUBLIC_CLIENT` (tokens in `src/storage/storage.constants.ts`), each a `new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })` built from `storageConfig` (`inject: [storageConfig.KEY]`); `exports: [StorageService]`
- Implement multipart operations in `src/storage/storage.service.ts` using the internal client: `createMultipartUpload(key, contentType)` → `uploadId` (`CreateMultipartUploadCommand`); `listParts(key, uploadId)` → all parts across pages (`ListPartsCommand` with `PartNumberMarker` until `IsTruncated` is false), mapping the SDK `NoSuchUpload` error to a typed `UploadNotFoundError` (plain error class in `src/storage/storage.errors.ts`, not a `DomainException`); `completeMultipartUpload(key, uploadId, parts[])` (`CompleteMultipartUploadCommand`, parts sorted ascending; SDK `InvalidPart` / `InvalidPartOrder` → typed `InvalidPartsError`); `abortMultipartUpload(key, uploadId)` (`AbortMultipartUploadCommand`, `NoSuchUpload` swallowed); `listMultipartUploads(prefix)` → all in-progress uploads across pages (`ListMultipartUploadsCommand` with `KeyMarker` / `UploadIdMarker`)
- Implement presigning with `getSignedUrl` from `@aws-sdk/s3-request-presigner`: `presignUploadPart(key, uploadId, partNumber, ttlSeconds)` on the **public** client (`UploadPartCommand`); `presignGetObject(key, ttlSeconds, { audience: 'public' | 'internal', responseContentDisposition? })` (`GetObjectCommand`, `ResponseContentDisposition` only when provided) — every method returns `{ url, expiresAt }` computed from `ttlSeconds`
- Implement object operations on the internal client: `putObject(bucket, key, body, contentType, cacheControl?)` (`PutObjectCommand`); `objectExists(bucket, key)` (`HeadObjectCommand`, `NotFound` → `false`); `deleteByPrefix(bucket, prefix)` (`ListObjectsV2Command` pages + `DeleteObjectsCommand`); `getThumbnailPublicUrl(key)` → `${STORAGE_PUBLIC_ENDPOINT}/${STORAGE_THUMBNAIL_BUCKET}/${key}` (unsigned — the thumbnail bucket is public-read, TD-18)
- Wrap every SDK call so connectivity/5xx failures (no `$metadata.httpStatusCode` or ≥ 500, `ECONNREFUSED`) are rethrown as a typed `StorageUnavailableError` (plain error, mapped to the `STORAGE_UNAVAILABLE` domain exception by callers in SI-03.6/SI-03.7) — logical S3 errors (`NoSuchUpload`, `InvalidPart`, `NotFound`) keep their typed classes

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with both client providers resolved from `storageConfig` |
| `src/storage/storage.service.integration-spec.ts` | Integration | Against real MinIO (`minio` service, per-run key prefix, cleanup in `afterAll`): create → presigned part `PUT` (via `fetch` from inside the container) → `listParts` returns the part with its ETag → `complete` produces a readable object; `abort` removes the upload; `listParts` on an unknown upload throws `UploadNotFoundError`; `complete` with a wrong ETag throws `InvalidPartsError`; `presignGetObject` URL answers `Range: bytes=0-9` with `206` + `Content-Range`; `ResponseContentDisposition` is reflected in the `Content-Disposition` response header; `deleteByPrefix` removes every object under the prefix; `listMultipartUploads` pages and filters by prefix |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- Creating a multipart upload, `PUT`ting one 5 MiB part to the URL returned by `presignUploadPart`, and completing with the returned ETag produces an object whose size equals the part size — verifiable with `mc stat`
- A presigned GET URL obtained from `presignGetObject` answers a request with `Range: bytes=0-1023` with `206 Partial Content`, `Content-Range: bytes 0-1023/<size>` and `Accept-Ranges: bytes`
- A presigned GET URL created with `responseContentDisposition: 'attachment; filename="x.mp4"'` returns `Content-Disposition: attachment; filename="x.mp4"`
- A presigned URL requested after its TTL elapsed (or with a tampered query string) is rejected by the store with 403 — the API never proxies bytes
- `listParts` on an aborted or unknown `uploadId` raises `UploadNotFoundError`; with the `minio` service stopped, any operation raises `StorageUnavailableError` within the SDK's default retry budget
- URLs produced by `presignUploadPart` and `presignGetObject({ audience: 'public' })` start with `STORAGE_PUBLIC_ENDPOINT`; URLs produced with `audience: 'internal'` start with `STORAGE_ENDPOINT`

---

### SI-03.4 — Queue Module and Processing Job Publisher

**Description:** Create the `QueueModule` that configures the BullMQ connection and registers the two queues of the phase (`video-processing`, `video-maintenance`), plus a `VideoQueueService` publisher that enqueues idempotent processing jobs. Consumers are added in SI-03.12/SI-03.13.

**Technical actions:**

- Create `src/queue/queue.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_MAINTENANCE_QUEUE = 'video-maintenance'`, job names `PROCESS_VIDEO_JOB = 'process-video'`, `UPLOAD_SWEEP_JOB = 'upload-sweep'`, scheduler id `UPLOAD_SWEEP_SCHEDULER = 'upload-sweep-every'`, and `processingJobId(videoId) => 'video-' + videoId` (no `:` and never all-digits — BullMQ custom id rules, N-17)
- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory })` returning `{ connection: { host, port }, defaultJobOptions: { attempts: QUEUE_JOB_ATTEMPTS, backoff: { type: 'exponential', delay: QUEUE_JOB_BACKOFF_MS }, removeOnComplete: true, removeOnFail: true } }` (TD-03; `removeOn*` so a finished job id can be re-added by the sweep, N-17), plus `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }, { name: VIDEO_MAINTENANCE_QUEUE })`; `exports: [BullModule, VideoQueueService]`
- Create `src/queue/video-queue.service.ts` — `@InjectQueue(VIDEO_PROCESSING_QUEUE)`; `enqueueProcessing(videoId)` calls `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: processingJobId(videoId) })` and returns the job id; `hasActiveProcessingJob(videoId)` returns `true` when `queue.getJob(processingJobId(videoId))` exists and `job.getState()` is one of `waiting`, `active`, `delayed`, `prioritized`, `waiting-children` (used by the sweep, N-06b)
- Add a typed `ProcessVideoJobData { videoId: string }` interface in `src/queue/queue.types.ts` shared by publisher and processor

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/queue.module.spec.ts` | Unit | Module compiles with `BullModule.forRootAsync` resolved from `queueConfig` and both queues registered (real Redis connection from Compose — configured-lib contract) |
| `src/queue/video-queue.service.integration-spec.ts` | Integration | Against real Redis (queue drained with `queue.obliterate({ force: true })` in `beforeEach`): `enqueueProcessing` puts one job in `waiting` with `{ videoId }` and id `video-<id>`; calling it twice for the same video leaves exactly one job; job options carry `attempts` = 3 and exponential backoff; `hasActiveProcessingJob` is `true` while waiting and `false` after the job is removed |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- Enqueueing processing for a video id causes exactly one job named `process-video` with data `{ videoId }` and id `video-<videoId>` to appear in the `video-processing` queue's waiting list (observable via `redis-cli` keys `bull:video-processing:*` or the BullMQ `Queue` API)
- Enqueueing processing twice for the same video id while the first job is still queued does not create a second job
- The enqueued job carries 3 attempts and an exponential backoff starting at 30 s (from `QUEUE_JOB_ATTEMPTS` / `QUEUE_JOB_BACKOFF_MS`)
- Application bootstrap fails fast with a connection error when `REDIS_HOST` points to an unreachable host

---

### SI-03.5 — Video Entity and Migration

**Description:** Create the `Video` entity that carries the upload/processing lifecycle, the public identifier, storage keys and extracted metadata (TD-05, TD-13, TD-19, TD-22, N-14), generate its migration, and extend the shared test infrastructure to the new table.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with the columns, enum, relation and indexes specified in **Data Model → Video** (status enum `VideoStatus` with `draft`, `uploading`, `processing`, `ready`, `failed` exported from `src/videos/videos.types.ts` together with `VideoErrorReason` = `INVALID_MEDIA`, `PROCESSING_FAILED`, `UPLOAD_ABANDONED`, `THUMBNAIL_FAILED`); `@ManyToOne(() => Channel, { onDelete: 'RESTRICT' })` with `@JoinColumn({ name: 'channel_id' })` (N-08); `metadata` as `jsonb`
- Generate the migration via `npm run migration:generate -- src/database/migrations/CreateVideos` (inside the container) and review the SQL: PostgreSQL enum type `videos_status_enum`, unique index on `public_id`, composite indexes `(channel_id, status)` and `(status, created_at)`, FK `videos.channel_id → channels.id ON DELETE RESTRICT`
- Update `src/test/create-test-data-source.ts` — `cleanAllTables()` deletes `videos` **before** `channels` (N-12)
- Update `src/database/migrations.integration-spec.ts` — import `CreateVideos<timestamp>`, expect three migrations and five managed tables (`videos` added), and keep the `afterAll` re-run so the shared DB stays migrated (N-12)
- Create `src/videos/videos.module.ts` skeleton — `TypeOrmModule.forFeature([Video])`, imports `ChannelsModule`, exports `TypeOrmModule` (providers/controllers are added in SI-03.7)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `public_id` constraint; `public_id` max length 12; `status` enum rejects unknown values and defaults to `draft`; `channel_id` FK violation on unknown channel and `RESTRICT` on channel delete; nullable metadata columns (`duration_seconds`, `width`, `height`, `thumbnail_key`, `error_reason`, `metadata`) default to `NULL`; `size_bytes` stores values above 2^31 (bigint); timestamps auto-populated |
| `src/database/migrations.integration-spec.ts` | Integration | Three migrations apply and revert bidirectionally; five tables exist after `runMigrations()` |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature([Video])` and `ChannelsModule` wiring (extended in SI-03.7 when `StorageModule`/`QueueModule` are added) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, the `videos_status_enum` type, the unique index on `public_id`, the `(channel_id, status)` and `(status, created_at)` indexes and the FK to `channels`
- Inserting two videos with the same `public_id` fails with a unique constraint violation
- Inserting a video with `status = 'published'` fails with an enum constraint violation
- Deleting a channel that owns a video fails with a foreign-key violation (`RESTRICT`)
- Inserting a video with `size_bytes = 10737418240` (10 GiB) succeeds and reads back unchanged
- `npm run migration:revert` drops the `videos` table and the enum type cleanly

---

### SI-03.6 — Video Domain Exceptions and Channel Lookup

**Description:** Define the Phase 03 domain exceptions in the shared exception module (error codes from the **Error Catalog**) and add the channel-by-user lookup that every owner-scoped video operation needs — in `ChannelsModule`, where channel lookups belong (SRP, N-08).

**Technical actions:**

- Add to `src/common/exceptions/domain.exception.ts` the subclasses `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoNotOwnedException` (`VIDEO_NOT_OWNED`, 403), `VideoInvalidStateException(current, expected[])` (`VIDEO_INVALID_STATE`, 409), `VideoNotReadyException` (`VIDEO_NOT_READY`, 409), `UploadLimitReachedException(limit)` (`UPLOAD_LIMIT_REACHED`, 409), `UnsupportedMediaTypeException` (`UNSUPPORTED_MEDIA_TYPE`, 415), `UploadIncompleteException` (`UPLOAD_INCOMPLETE`, 409), `StorageUnavailableException` (`STORAGE_UNAVAILABLE`, 503) — messages exactly as in the Error Catalog
- Add `ChannelsService.findByUserId(userId): Promise<Channel | null>` in `src/channels/channels.service.ts` (single `findOne` on `user_id`) — no exception thrown here; callers decide (a confirmed user always has a channel, Phase 02)
- Extend `src/common/filters/domain-exception.filter.spec.ts` with one case per new subclass (status + code + message), including the 415 and 503 mappings which are the first non-4xx/401/403/409 codes the filter handles

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/common/filters/domain-exception.filter.spec.ts` | Unit | Each Phase 03 `DomainException` subclass maps to the correct `{ statusCode, error, message }` |
| `src/channels/channels.service.integration-spec.ts` | Integration | `findByUserId` returns the user's channel and `null` for an unknown user id |

**Dependencies:** None

**Acceptance criteria:**

- A service throwing `UnsupportedMediaTypeException` results in an HTTP response `{ statusCode: 415, error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' }`
- A service throwing `StorageUnavailableException` results in `{ statusCode: 503, error: 'STORAGE_UNAVAILABLE', message: 'Storage service is unavailable' }`
- `ChannelsService.findByUserId` with the id of a registered user returns that user's channel; with a random UUID returns `null` — no exception

---

### SI-03.7 — Upload Initiation (Draft Pre-Registration)

**Description:** Implement `POST /videos`: validate the declared file against the TD-22 allowlist and size limits, enforce the TD-23 open-upload cap, generate the unique `public_id`, open the multipart upload on the store and persist the video row in `uploading` — returning the upload credentials the client needs to start sending parts (N-01, N-02).

**Technical actions:**

- Create `src/videos/public-id.util.ts` — `generatePublicId()` returning 12 base64url characters from `randomBytes(9)` (`node:crypto`, TD-13); create `src/videos/title.util.ts` — `deriveTitle(filename)` (strip extension, trim, collapse whitespace, truncate to 100, fallback `'Untitled video'` when empty) and `getExtension(filename, contentType)` (lower-cased extension from the filename, validated against the allowlist for that content type); create `src/videos/media-types.ts` — the TD-22 allowlist map `video/mp4 → [.mp4, .m4v]`, `video/webm → [.webm]`, `video/quicktime → [.mov]`
- Create `src/videos/dto/create-video.dto.ts` — `filename` (`@IsString`, `@Length(1, 255)`), `size_bytes` (`@IsInt`, `@Min(1)`, `@Max(UPLOAD_MAX_SIZE_BYTES)` — the max read from config via a custom validator or a factory-built DTO; a plain `@Max` with the default is acceptable if the value is documented as the schema limit), `content_type` (`@IsIn(Object.keys(allowlist))`)
- Implement `VideosService.createUpload(userId, dto)` in `src/videos/videos.service.ts`: resolve the channel via `ChannelsService.findByUserId`; reject content type / extension mismatch with `UnsupportedMediaTypeException` (415); count `videos` in `uploading` for the channel and throw `UploadLimitReachedException` when ≥ `UPLOAD_MAX_OPEN_PER_CHANNEL` (TD-23); compute `part_size_bytes = UPLOAD_PART_SIZE_BYTES` and `part_count = ceil(size_bytes / part_size_bytes)`; build `storage_key = videos/{id}/source.{ext}` from a pre-generated UUID (`randomUUID()`) so the key is known before insert (TD-19); call `StorageService.createMultipartUpload` **before** persisting (map `StorageUnavailableError` → `StorageUnavailableException`, nothing persisted); insert the row with `status = uploading`, retrying `generatePublicId()` up to 5 times on a `public_id` unique violation (PG `23505` on that column — same helper pattern as `ChannelsService`); on insert failure after the upload was created, abort the multipart upload before rethrowing
- Complete `src/videos/videos.module.ts` — imports `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `QueueModule`; providers `VideosService`; controllers `VideosController`; register `VideosModule` in `AppModule`
- Create `src/videos/videos.controller.ts` — `@Controller('videos')`, class-level `@SkipThrottle()` (TD-23), `POST /` handler with `@CurrentUser()` returning 201 with the representation from **API Contracts → POST /videos** and `Location: /videos/{public_id}`; add `VideosService.toOwnerView(video)` / `toPublicView(video)` mappers in `src/videos/videos.presenter.ts` used by every endpoint of the phase (owner view includes `id`; public view never does — TD-13)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/public-id.util.spec.ts` | Unit | 12 chars, base64url alphabet only, 1,000 generations without collision |
| `src/videos/title.util.spec.ts` | Unit | Extension stripped, whitespace collapsed, 100-char truncation, empty stem fallback, extension/content-type matching (`.MOV` accepted for quicktime, `.mkv` rejected) |
| `src/videos/videos.service.spec.ts` | Unit | Branches with mocked repository/storage/channels: 415 on mismatch, 409 at the cap, part math for 10 GiB (205 parts), no persistence when storage fails, abort called when insert fails, `public_id` retry on unique violation |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + real MinIO: row persisted in `uploading` with `upload_id` set and the multipart upload visible in `listMultipartUploads`; cap counts only `uploading` rows of the same channel |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos`: 201 shape + `Location`; 401 without token; 400 validation (missing fields, size 0, unknown `content_type`); 415 on extension/content-type mismatch; 409 `UPLOAD_LIMIT_REACHED` on the 6th open upload; 11+ requests in a minute are **not** throttled (429 never returned) |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5, SI-03.6

**Acceptance criteria:**

- `POST /videos` with a valid access token and `{ filename: 'trip.mp4', size_bytes: 10737418240, content_type: 'video/mp4' }` returns 201 with `{ id, public_id, status: 'uploading', title: 'trip', upload: { upload_id, part_size_bytes: 52428800, part_count: 205 } }` and a `Location: /videos/<public_id>` header; a multipart upload for key `videos/<id>/source.mp4` is open on the store
- `POST /videos` with `filename: 'movie.mkv'` and `content_type: 'video/x-matroska'` returns 400 validation error (content type not allowed); with `filename: 'movie.mkv'` and `content_type: 'video/mp4'` returns 415 with `UNSUPPORTED_MEDIA_TYPE`
- `POST /videos` with `size_bytes` above 10 GiB returns 400 validation error
- `POST /videos` when the channel already has 5 videos in `uploading` returns 409 with `UPLOAD_LIMIT_REACHED`; a channel with 5 videos in `ready`/`failed` and none uploading is not blocked
- `POST /videos` without an `Authorization` header returns 401
- With the `minio` service stopped, `POST /videos` returns 503 with `STORAGE_UNAVAILABLE` and no `videos` row is created
- Two `public_id` values are never equal across created videos; the value is 12 characters from `[A-Za-z0-9_-]`
- 20 consecutive `POST /videos` requests from the same IP within one minute never return 429

---

### SI-03.8 — Part Signing and Upload Resumption

**Description:** Implement the owner-only endpoints the client calls while uploading: presign one part URL on demand and list the parts already stored, so an interrupted upload resumes by re-signing only the missing parts (TD-04).

**Technical actions:**

- Implement `VideosService.getOwnedVideo(videoId, userId)` — loads the video with its channel; throws `VideoNotFoundException` (404) when absent, `VideoNotOwnedException` (403) when `channel.user_id !== userId`; and `assertStatus(video, ...expected)` throwing `VideoInvalidStateException` (409) — both reused by SI-03.9
- Implement `VideosService.signPart(videoId, userId, partNumber)` — requires `status = uploading`; `partNumber` is parsed by `ParseIntPipe` at the controller and range-checked in the service (`1 ≤ partNumber ≤ part_count`) — an out-of-range value is a client error, reported as a 400 validation error by throwing `BadRequestException` (normalized to `VALIDATION_ERROR` by the existing `ValidationExceptionFilter`), not as a domain code; returns `{ part_number, url, expires_at }` from `StorageService.presignUploadPart` with `UPLOAD_PART_URL_TTL_SECONDS`
- Implement `VideosService.listUploadedParts(videoId, userId)` — requires `status = uploading`; returns `StorageService.listParts` mapped to `{ part_number, etag, size_bytes, last_modified }`; `UploadNotFoundError` (store no longer has the upload) → `VideoInvalidStateException` with a message pointing to `POST …/upload/complete` or `DELETE`
- Add the two handlers to `VideosController`: `POST /videos/:id/upload/parts/:partNumber/url` (200) and `GET /videos/:id/upload/parts` (200); `:id` validated with `ParseUUIDPipe`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Ownership and state branches (404, 403, 409 for `processing`/`ready`/`failed`), part range check, TTL passed through |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real MinIO: a `PUT` of 5 MiB to the signed URL succeeds and `listUploadedParts` returns that part with the ETag the store issued |
| `test/videos.e2e-spec.ts` | E2E | Sign URL 200 shape; list parts 200 after a real part upload from the test; 404 unknown id; 403 other user's video; 409 when not `uploading`; 400 for part number 0 / above `part_count` / non-integer; 401 without token |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `POST /videos/:id/upload/parts/1/url` by the owner of an `uploading` video returns 200 with `{ part_number: 1, url, expires_at }` where `url` starts with `STORAGE_PUBLIC_ENDPOINT` and `expires_at` is ~1 h ahead; a `PUT` of 5 MiB of bytes to that URL is accepted by the store (200 + `ETag`)
- `GET /videos/:id/upload/parts` after that `PUT` returns 200 with `{ parts: [{ part_number: 1, etag, size_bytes: 5242880, last_modified }] }`; before any upload it returns `{ parts: [] }`
- `POST /videos/:id/upload/parts/206/url` on a video with `part_count = 205` returns 400 validation error; `…/parts/0/url` and `…/parts/abc/url` return 400
- Either endpoint called by an authenticated user who does not own the video returns 403 with `VIDEO_NOT_OWNED`; with an unknown UUID returns 404 with `VIDEO_NOT_FOUND`
- Either endpoint on a video whose status is `processing`, `ready` or `failed` returns 409 with `VIDEO_INVALID_STATE`
- Re-signing the same part number twice returns two distinct valid URLs — the client can retry a failed part without server-side state

---

### SI-03.9 — Upload Completion, Cancellation and Job Publication

**Description:** Implement the completion endpoint that assembles the object on the store, transitions the video to `processing` and publishes the processing job (TD-06 primary path, N-13), and the cancellation endpoint that aborts an in-flight or failed upload and removes its objects (N-07).

**Technical actions:**

- Implement `VideosService.completeUpload(videoId, userId, parts[])` — `getOwnedVideo` + `assertStatus(uploading)`; fetch `StorageService.listParts` and verify the stored parts count equals `part_count`, every stored part except the last has `size_bytes = part_size_bytes`, and every `(part_number, etag)` pair the client sent matches the store — any mismatch → `UploadIncompleteException` (409, message lists the missing/mismatched part numbers); call `completeMultipartUpload` (`InvalidPartsError` → `UploadIncompleteException`; `StorageUnavailableError` → `StorageUnavailableException`); then run `UPDATE videos SET status = 'processing', uploaded_at = now() WHERE id = ? AND status = 'uploading'` — zero affected rows (lost race) → `VideoInvalidStateException`; after the commit call `VideoQueueService.enqueueProcessing(videoId)` (idempotent `jobId`); a failure to enqueue is logged and **not** surfaced (the sweep re-enqueues stale `processing` rows, N-06b)
- Implement `VideosService.cancelUpload(videoId, userId)` — `getOwnedVideo` + `assertStatus(uploading, failed)`; if `upload_id` is set, `abortMultipartUpload` (already-gone tolerated); `deleteByPrefix(videoBucket, 'videos/{id}/')` and, when `thumbnail_key` is set, delete it from the thumbnail bucket; delete the row; if a processing job with that id exists and is `waiting`/`delayed`, remove it (`Queue.getJob` + `job.remove()`) — an `active` job is left to finish and fail on the missing row
- Create `src/videos/dto/complete-upload.dto.ts` — `parts: { part_number: int ≥ 1, etag: non-empty string }[]` with `@ValidateNested({ each: true })`, `@ArrayMinSize(1)`, `@Type(() => PartDto)`
- Add the handlers to `VideosController`: `POST /videos/:id/upload/complete` (200, owner representation with `status: 'processing'`) and `DELETE /videos/:id` (204)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Part verification matrix (count mismatch, size mismatch, ETag mismatch, order), lost-race update → 409, enqueue failure swallowed, cancel branches by status and job state |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + MinIO + Redis: a two-part upload completes into one object of the expected size, the row is `processing` with `uploaded_at`, and a `process-video` job with id `video-<id>` is waiting; cancel aborts the upload, removes objects under the prefix and deletes the row; two concurrent `completeUpload` calls — exactly one succeeds |
| `test/videos.e2e-spec.ts` | E2E | Full happy path from `POST /videos` through real part `PUT`s to `POST …/upload/complete` 200; 409 `UPLOAD_INCOMPLETE` with a missing part / wrong ETag; 409 `VIDEO_INVALID_STATE` on a second completion; 400 validation on an empty `parts` array; `DELETE` 204 for `uploading` and `failed`, 409 for `processing`/`ready`, 404/403 boundaries |

**Dependencies:** SI-03.4, SI-03.8

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` with the `{ part_number, etag }` pairs of all uploaded parts returns 200 with `{ id, public_id, status: 'processing', … }`; the object `videos/<id>/source.<ext>` exists on the store with `size_bytes` bytes, the multipart upload is no longer listed, and a `process-video` job with id `video-<id>` is waiting in the `video-processing` queue
- `POST /videos/:id/upload/complete` when one declared part was never uploaded, or an ETag differs from the store's, returns 409 with `UPLOAD_INCOMPLETE` — the video stays `uploading` and the multipart upload stays open (the client can resume)
- Calling `POST /videos/:id/upload/complete` a second time returns 409 with `VIDEO_INVALID_STATE`; two concurrent completion requests result in exactly one 200 and one 409, and exactly one job
- `DELETE /videos/:id` by the owner of an `uploading` video returns 204 with no response body — the multipart upload is aborted, no object remains under `videos/<id>/`, and the row is gone (`GET /videos/:publicId` → 404)
- `DELETE /videos/:id` on a `failed` video returns 204 and removes its source object and thumbnail (if any); on a `processing` or `ready` video returns 409 with `VIDEO_INVALID_STATE`
- With Redis stopped, `POST …/upload/complete` still returns 200 and the row is `processing` (the job is published later by the sweep)

---

### SI-03.10 — Public Read, Playback URL and Download URL

**Description:** Implement the public read endpoints keyed by `public_id` (TD-13, N-03): the video representation with its thumbnail URL, a session-sized presigned playback URL (TD-14, TD-15) and a short-lived presigned download URL with an attachment filename derived from the title (TD-16, N-02).

**Technical actions:**

- Implement `VideosService.findByPublicId(publicId)` → `VideoNotFoundException` when absent (any status); `getPlaybackUrl(publicId)` and `getDownloadUrl(publicId)` → `VideoNotReadyException` (409) unless `status = ready`
- Create `src/videos/download-filename.util.ts` — `buildDownloadFilename(title, storageKey)`: ASCII-only (strip diacritics via `normalize('NFKD')`, replace anything outside `[A-Za-z0-9._-]` with `-`, collapse repeats, trim `-`/`.`), max 80 chars plus the original extension from `storage_key`; fallback `video-<public_id>.<ext>` when the sanitized stem is empty (N-02); the `Content-Disposition` value is `attachment; filename="<name>"` — no RFC 5987 `filename*` (MinIO signature issue noted in the decision document's sources)
- Presign with the **public** client: playback = `presignGetObject(storage_key, PLAYBACK_URL_TTL_SECONDS, { audience: 'public' })`; download = same with `DOWNLOAD_URL_TTL_SECONDS` and `responseContentDisposition`; both return `{ url, expires_at }` (download adds `filename`)
- Add to `VideosController` three `@Public()` handlers: `GET /videos/:publicId` (200, public view: `public_id`, `title`, `status`, `duration_seconds`, `width`, `height`, `size_bytes`, `thumbnail_url` — `null` unless `thumbnail_key` is set — `created_at`; never `id`, `storage_key`, `upload_id`, `error_*`), `GET /videos/:publicId/playback` (200) and `GET /videos/:publicId/download` (200); `:publicId` validated by a `@Matches(/^[A-Za-z0-9_-]{12}$/)` param DTO

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/download-filename.util.spec.ts` | Unit | Diacritics stripped, unsafe chars replaced, length cap, extension from key, empty-stem fallback |
| `src/videos/videos.service.spec.ts` | Unit | 404 / 409 branches; TTLs and disposition passed to storage; public view omits internal fields |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real MinIO: the playback URL of a seeded `ready` video answers `Range: bytes=0-99` with 206; the download URL returns `Content-Disposition: attachment; filename="<sanitized>.mp4"` |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId` 200 public shape without auth and 404 for unknown/malformed ids; `/playback` and `/download` 200 shape for `ready`, 409 `VIDEO_NOT_READY` for `uploading`/`processing`/`failed`; response never contains `storage_key`, `upload_id` or `id` |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `GET /videos/:publicId` without any token returns 200 with `{ public_id, title, status, duration_seconds, width, height, size_bytes, thumbnail_url, created_at }` and never includes `id`, `storage_key`, `upload_id`, `error_reason` or `metadata`
- `GET /videos/:publicId` with an unknown 12-char id, or with `:publicId` of the wrong shape (e.g. a UUID), returns 404 with `VIDEO_NOT_FOUND`
- `GET /videos/:publicId/playback` for a `ready` video returns 200 with `{ url, expires_at }` where `expires_at` is ~8 h ahead; a request to `url` with `Range: bytes=0-1023` returns 206 from the store — the API response contains no video bytes
- `GET /videos/:publicId/playback` for a video in `uploading`, `processing` or `failed` returns 409 with `VIDEO_NOT_READY`
- `GET /videos/:publicId/download` for a `ready` video titled `Férias 2026: praia!` stored as `.mp4` returns 200 with `{ url, expires_at, filename: 'Ferias-2026-praia.mp4' }` and `expires_at` ~15 min ahead; a GET to `url` returns `Content-Disposition: attachment; filename="Ferias-2026-praia.mp4"`
- `thumbnail_url` is `null` while `thumbnail_key` is unset and equals `<STORAGE_PUBLIC_ENDPOINT>/<thumbnail bucket>/videos/<id>/thumbnail.jpg` once set — an unsigned GET to it returns 200

---

### SI-03.11 — FFmpeg Service (Probe and Frame Extraction)

**Description:** Create the thin injectable wrapper around the `ffprobe` / `ffmpeg` binaries (TD-10) that reads the source over a presigned URL (TD-11) and returns typed results — media metadata and a JPEG frame — with timeouts, process kill and error classification, so the processor never touches `child_process` directly.

**Technical actions:**

- Create `src/processing/ffmpeg.service.ts` with `probe(sourceUrl)` — spawns `ffprobe -v error -print_format json -show_format -show_streams <url>` (argument array, no shell), collects stdout, kills the process after `FFPROBE_TIMEOUT_MS`, parses the JSON and returns `ProbeResult { durationSeconds, width, height, codecName, containerFormat, moovAtEnd, raw }` where the first `codec_type = 'video'` stream is used; **no video stream** or **unparsable output / non-zero exit with `Invalid data found`** → throws `InvalidMediaError` (plain error, TD-22); other non-zero exits / timeouts → `FfmpegExecutionError { stderr, timedOut }`
- Detect `moov` placement for MP4/MOV inputs (TD-17) without a second FFmpeg pass: `detectMoovPlacement(sourceUrl)` issues one `Range: bytes=0-65535` request (`fetch`) to the presigned URL and walks the ISO-BMFF box headers of that head chunk (`size` + `type`, honouring 64-bit `largesize`): if a `moov` box is encountered before any `mdat` → `moovAtEnd = false`; if `mdat` (or the end of the chunk with no `moov`) comes first → `moovAtEnd = true`; for non-ISO-BMFF containers (WebM) → `null`. The result is exposed on `ProbeResult.moovAtEnd`
- Create `extractFrame(sourceUrl, offsetSeconds)` — spawns `ffmpeg -v error -ss <offset> -i <url> -frames:v 1 -vf scale='min(<THUMBNAIL_MAX_WIDTH>,iw)':-2 -q:v <THUMBNAIL_JPEG_QUALITY> -f image2 pipe:1` (input-seeking before `-i` for a single fast seek; `-2` keeps the height even), collects stdout into a `Buffer`, kills after `FFMPEG_THUMBNAIL_TIMEOUT_MS`; empty output or non-zero exit → `FfmpegExecutionError`
- Create `src/processing/processing.module.ts` — provides and exports `FfmpegService` (config via `processingConfig.KEY`); create the test fixture helper `src/test/video-fixture.ts` that generates a 3-second 320×240 H.264/MP4 (`ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=10 -c:v libx264 -pix_fmt yuv420p`) and a `-movflags +faststart` variant, plus a non-media file, into the scratch dir once per test run

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/processing/ffmpeg.service.spec.ts` | Unit | With a stubbed spawn: argument arrays built as specified (no shell), timeout kills the child and raises `FfmpegExecutionError { timedOut: true }`, `Invalid data found` and missing video stream map to `InvalidMediaError`, JSON parsing of a canned `ffprobe` output |
| `src/processing/ffmpeg.service.integration-spec.ts` | Integration | Real binaries + real MinIO (fixture uploaded, presigned internal URL): `probe` returns duration ≈ 3 s, 320×240, `h264`, `mov,mp4,m4a,3gp,3g2,mj2`, `moovAtEnd` `true` for the plain fixture and `false` for the faststart one; `extractFrame` at 0.3 s returns a JPEG (`FF D8 FF` magic) ≤ 320 px wide; probing the non-media object throws `InvalidMediaError` |
| `src/processing/processing.module.spec.ts` | Unit | Module compiles with `processingConfig` resolved |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- Probing a presigned URL of a 3-second MP4 fixture returns `durationSeconds ≈ 3`, `width 320`, `height 240`, `codecName 'h264'`, a non-empty `containerFormat` and the raw `ffprobe` JSON — without downloading the whole object (the worker's disk usage does not grow with the file size)
- Probing a presigned URL of a text file throws `InvalidMediaError`; probing an expired URL throws `FfmpegExecutionError` (retryable), not `InvalidMediaError`
- Extracting a frame at 10 % of the duration returns a valid JPEG whose width is `min(1280, source width)` and whose height is even
- A probe that exceeds `FFPROBE_TIMEOUT_MS` is killed and reported as a timed-out `FfmpegExecutionError` — no `ffprobe` process remains alive afterwards (`ps` inside the container)
- `moovAtEnd` is `true` for an MP4 written without `faststart`, `false` with `faststart`, and `null` for WebM

---

### SI-03.12 — Video Processing Job Consumer

**Description:** Implement the BullMQ processor that turns a `processing` video into `ready`: presigns the source for FFmpeg, extracts metadata, generates and stores the thumbnail (non-fatal, N-04) and persists the results — with TD-03's retry semantics and TD-22's non-retryable `INVALID_MEDIA` path.

**Technical actions:**

- Create `src/processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: QUEUE_WORKER_CONCURRENCY, lockDuration: 600000, maxStalledCount: 1 })` extending `WorkerHost`; `process(job: Job<ProcessVideoJobData>)`: load the video; if missing → return (cancelled, N-07); if `status ≠ processing` → return (already handled); increment `processing_attempts`; presign the source with the **internal** client and `WORKER_SOURCE_URL_TTL_SECONDS` (regenerated per attempt, N-05); `FfmpegService.probe` → on `InvalidMediaError` set `status = failed`, `error_reason = INVALID_MEDIA`, `error_detail = <message>` and throw `UnrecoverableError` (no further attempts, TD-22); on any other error rethrow (BullMQ retries with backoff, TD-03)
- After a successful probe: `extractFrame` at `THUMBNAIL_OFFSET_PERCENT` % of the duration (`0` when duration is unknown or zero) and `putObject(thumbnailBucket, 'videos/{id}/thumbnail.jpg', buffer, 'image/jpeg', 'public, max-age=31536000, immutable')` (TD-18/TD-19); any thumbnail error is caught, logged and recorded as `error_reason = THUMBNAIL_FAILED` + `error_detail` while the job still succeeds (N-04)
- Persist the outcome in one `UPDATE … WHERE id = ? AND status = 'processing'`: `status = ready`, `duration_seconds`, `width`, `height`, `codec_name`, `container_format`, `moov_at_end`, `metadata` (raw JSON), `thumbnail_key` (or `NULL`), `processed_at = now()`; zero rows affected → log and return (row changed underneath, e.g. cancelled)
- Add `@OnWorkerEvent('failed')` — when `job.attemptsMade >= (job.opts.attempts ?? 1)` and the error is not an `UnrecoverableError` already handled, set `status = failed`, `error_reason = PROCESSING_FAILED`, `error_detail = <error message>` on the row (terminal failure, TD-03 — never leave `processing` indefinitely); add `@OnWorkerEvent('active')` / `('completed')` log lines with `videoId` and `attemptsMade`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/processing/video.processor.spec.ts` | Unit | With mocked repository/storage/ffmpeg: missing row and non-`processing` row are no-ops; `InvalidMediaError` → row `failed(INVALID_MEDIA)` + `UnrecoverableError` thrown; transient probe error rethrown without touching status; thumbnail failure → `ready` with `thumbnail_key = null` and `THUMBNAIL_FAILED`; `failed` event on the last attempt → `PROCESSING_FAILED`, on earlier attempts → untouched |
| `src/processing/video.processor.integration-spec.ts` | Integration | Real DB + MinIO + ffmpeg, calling `process()` directly with a job stub: a `processing` row whose source is the MP4 fixture becomes `ready` with duration/width/height/codec/`moov_at_end`/`metadata` filled and `videos/<id>/thumbnail.jpg` present in the thumbnail bucket (unsigned GET 200); a text-file source becomes `failed(INVALID_MEDIA)` and the thrown error is an `UnrecoverableError` |

**Dependencies:** SI-03.4, SI-03.5, SI-03.11

**Acceptance criteria:**

- After `POST …/upload/complete` of a valid MP4, the video becomes `ready` within the worker's processing time with `duration_seconds`, `width`, `height`, `codec_name`, `container_format`, `moov_at_end` and `metadata` populated, and `GET /videos/:publicId` returns a `thumbnail_url` that serves a JPEG
- Completing an upload whose bytes are not a media file causes the video to become `failed` with `error_reason = INVALID_MEDIA` after **one** attempt (`processing_attempts = 1`) — no retries are scheduled
- When the store is unreachable during the probe, the job is retried with exponential backoff and, after 3 attempts, the video is `failed` with `error_reason = PROCESSING_FAILED` and `processing_attempts = 3`
- When only the thumbnail step fails, the video is `ready`, `thumbnail_url` is `null` and `error_reason = THUMBNAIL_FAILED`
- Processing a video that was cancelled (`DELETE /videos/:id`) between enqueue and execution completes the job without error and without recreating any row or object
- The stored thumbnail is served with `Content-Type: image/jpeg` and a long-lived `Cache-Control` header

---

### SI-03.13 — Reconciliation Sweep

**Description:** Implement the repeatable maintenance job (TD-06 Option C, TD-20 Option C, N-05, N-06) that heals uploads stuck in `uploading`, re-publishes jobs for stale `processing` rows, and aborts abandoned or orphaned multipart uploads — so no video stays in a transient state and no multipart parts accrue indefinitely.

**Technical actions:**

- Create `src/processing/upload-sweep.service.ts` with `run()` returning a `SweepReport { completed, reenqueued, abandoned, orphansAborted }`, and `src/processing/upload-sweep.processor.ts` — `@Processor(VIDEO_MAINTENANCE_QUEUE, { concurrency: 1 })` whose `process()` delegates to `UploadSweepService.run()` (the job carries no data)
- Stale `uploading` rows (`created_at < now() − SWEEP_STALE_UPLOAD_MINUTES`, paged by 100): call `listParts`; **(a)** `UploadNotFoundError` and `objectExists(storage_key)` → the completion succeeded but the DB update did not: `UPDATE … SET status = 'processing', uploaded_at = now() WHERE status = 'uploading'` then `enqueueProcessing` (N-06a); **(b)** `UploadNotFoundError` and no object → `failed(UPLOAD_ABANDONED)`; **(c)** upload exists and the newest part's `last_modified` (or `created_at` when no parts) is older than `SWEEP_ABANDON_DAYS` → `abortMultipartUpload` + `failed(UPLOAD_ABANDONED)`; **(d)** otherwise leave untouched (still resumable)
- Stale `processing` rows (`uploaded_at < now() − SWEEP_STALE_PROCESSING_MINUTES`): when `VideoQueueService.hasActiveProcessingJob(id)` is `false`, `enqueueProcessing(id)` (N-06b, idempotent `jobId`)
- Orphaned multipart uploads: `listMultipartUploads('videos/')`, and for every upload whose `(key, uploadId)` does not match an `uploading` row → `abortMultipartUpload` (covers rows deleted or failed while the store kept the upload; also the backstop for MinIO's missing lifecycle rule, TD-20); every branch is wrapped so one failing video does not stop the sweep, and the report is logged at the end

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/processing/upload-sweep.service.spec.ts` | Unit | With mocked repository/storage/queue: each branch (a)–(d), the `processing` re-enqueue branch and the orphan branch; per-video errors isolated; thresholds read from config |
| `src/processing/upload-sweep.service.integration-spec.ts` | Integration | Real DB + MinIO + Redis with seeded rows and real multipart uploads (timestamps back-dated via direct `UPDATE`): completed-but-not-recorded upload → `processing` + job; upload gone + no object → `failed(UPLOAD_ABANDONED)`; 8-day-old upload → aborted + `failed`; fresh upload untouched; stale `processing` without a job → job present afterwards; orphan upload under `videos/` aborted |

**Dependencies:** SI-03.9, SI-03.12

**Acceptance criteria:**

- Running the sweep against an `uploading` row older than 1 h whose multipart upload was completed on the store but never recorded results in the row being `processing` and a `process-video` job with id `video-<id>` waiting
- Running the sweep against an `uploading` row older than 1 h whose multipart upload no longer exists and has no object results in `failed` with `error_reason = UPLOAD_ABANDONED`
- Running the sweep against an `uploading` row whose newest part is older than 7 days aborts the multipart upload on the store (`ListMultipartUploads` no longer lists it) and marks the row `failed(UPLOAD_ABANDONED)`; a row older than 1 h with a part uploaded 1 day ago is left `uploading`
- Running the sweep against a `processing` row uploaded more than 1 h ago with no queued/active job publishes a new `process-video` job for it; a `processing` row that still has an active job is not re-enqueued
- Running the sweep with an in-progress multipart upload under `videos/` that matches no `uploading` row aborts that upload
- A storage error on one video does not prevent the remaining videos from being swept — the report counts the others

---

### SI-03.14 — Worker Bootstrap, Scheduler Registration and Compose Service

**Description:** Create the standalone worker entrypoint (TD-08) with its own root module, register the sweep scheduler on boot, wire the heartbeat health probe, add the npm scripts and the `video-worker` Compose service (TD-02).

**Technical actions:**

- Create `src/worker.module.ts` — `ConfigModule.forRoot` (same `load`/`validationSchema` as `AppModule`), `TypeOrmModule.forRootAsync` (same factory, `autoLoadEntities`), `TypeOrmModule.forFeature([Video])`, `StorageModule`, `QueueModule`, `ProcessingModule`; providers `VideoProcessor`, `UploadSweepProcessor`, `UploadSweepService`, `WorkerHeartbeatService`; **no** `AuthModule`, controllers, guards or filters — extract the shared config/TypeORM factories into `src/config/config.module-options.ts` and `src/database/typeorm.module-options.ts` so `AppModule` and `WorkerModule` cannot drift
- Create `src/main.worker.ts` — `NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true })`, `app.enableShutdownHooks()`, log the queues being consumed; on `SIGTERM`/`SIGINT` Nest's `onModuleDestroy` closes the BullMQ workers so an in-flight job finishes before exit (verified by the AC below)
- Create `src/processing/upload-sweep.scheduler.ts` — `OnApplicationBootstrap` hook calling `maintenanceQueue.upsertJobScheduler(UPLOAD_SWEEP_SCHEDULER, { every: SWEEP_INTERVAL_MINUTES × 60 000 }, { name: UPLOAD_SWEEP_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: true } })` — idempotent across restarts (upsert), registered only in `WorkerModule`
- Create `src/worker/worker-heartbeat.service.ts` — `OnModuleInit` sets a 15 s `setInterval` (`unref()`) that touches `/tmp/worker-heartbeat` (`utimes`/`writeFile`), `OnModuleDestroy` clears it; add npm scripts `start:worker` (`nest start --entryFile main.worker`), `start:worker:dev` (`nest start --watch --entryFile main.worker`) and `start:worker:prod` (`node dist/main.worker`)
- Add the `video-worker` service to `compose.yaml` — same `build` (`Dockerfile.dev`), bind mount and env as `nestjs-api`; `command: npm run start:worker:dev`; `depends_on` `db` (healthy), `redis` (healthy), `minio-init` (completed successfully); healthcheck `CMD-SHELL` `test $(( $(date +%s) - $(stat -c %Y /tmp/worker-heartbeat 2>/dev/null || echo 0) )) -lt 60` with `interval: 30s`, `start_period: 60s`; `restart: unless-stopped`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker.module.spec.ts` | Unit | `WorkerModule` compiles (all processors and services resolvable; real Redis/DB connections from Compose as configured-lib contracts) and does not expose `AuthModule` providers |
| `src/processing/upload-sweep.scheduler.spec.ts` | Unit | Against real Redis: after `onApplicationBootstrap`, `getJobSchedulers()` lists `upload-sweep-every` with the configured `every`; calling it twice leaves exactly one scheduler |

**Dependencies:** SI-03.12, SI-03.13

**Acceptance criteria:**

- `docker compose up -d video-worker` starts a container that logs the two queues it consumes and becomes `healthy` within 60 s; stopping the worker process makes the container `unhealthy` after the heartbeat ages past 60 s
- With the worker running, `POST …/upload/complete` of a valid MP4 leads to `GET /videos/:publicId` reporting `status: 'ready'` without any manual step — the end-to-end pipeline of the phase works through Compose alone
- `redis-cli` shows exactly one job scheduler `upload-sweep-every` in the `video-maintenance` queue after the worker boots, and still exactly one after `docker compose restart video-worker`
- Sending `SIGTERM` to the worker while a job is `active` lets the job finish (the video ends `ready`) before the process exits; the job is not re-run after restart
- `docker compose exec nestjs-api npm run build` produces both `dist/main.js` and `dist/main.worker.js`; `node dist/main.worker.js` starts without binding any TCP port
- The worker process never handles HTTP: `curl` to the worker container on port 3000 is refused

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal id; used in storage keys (TD-19) and owner routes; never in public routes |
| public_id | varchar(12) | unique, not null | 12 base64url chars from `randomBytes(9)` (TD-13); the key of every public route |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE RESTRICT` | Owner channel (N-08) |
| title | varchar(100) | not null | Seeded from the filename stem (N-02); editing is Phase 04 |
| original_filename | varchar(255) | not null | As declared at `POST /videos` |
| content_type | varchar(50) | not null | One of the TD-22 allowlist values |
| size_bytes | bigint | not null | Declared size; ≤ `UPLOAD_MAX_SIZE_BYTES` |
| status | enum `videos_status_enum` | not null, default `'draft'`, values `draft`, `uploading`, `processing`, `ready`, `failed` | Phase 03 writes `uploading` → `processing` → `ready` / `failed`; `draft` is reserved for Phase 04 (TD-05, N-01) |
| storage_key | varchar(255) | not null | `videos/{id}/source.{ext}` (TD-19) |
| upload_id | text | nullable | S3 multipart `UploadId`; set while `uploading`, cleared on completion/abort |
| part_size_bytes | integer | not null | Snapshot of `UPLOAD_PART_SIZE_BYTES` at creation |
| part_count | integer | not null | `ceil(size_bytes / part_size_bytes)`, ≤ 10,000 |
| duration_seconds | numeric(10,3) | nullable | From `ffprobe` `format.duration` |
| width | integer | nullable | First video stream |
| height | integer | nullable | First video stream |
| codec_name | varchar(50) | nullable | e.g. `h264`, `vp9`, `hevc` — recorded, not enforced (TD-22) |
| container_format | varchar(100) | nullable | `ffprobe` `format.format_name` |
| moov_at_end | boolean | nullable | TD-17 diagnostic; `null` for non-MP4 |
| metadata | jsonb | nullable | Raw `ffprobe -show_format -show_streams` output (N-14) |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg` in the thumbnail bucket; `null` when generation failed (N-04) |
| error_reason | varchar(50) | nullable | `INVALID_MEDIA`, `PROCESSING_FAILED`, `UPLOAD_ABANDONED`, `THUMBNAIL_FAILED` |
| error_detail | text | nullable | Last error message (ffmpeg stderr excerpt, SDK error name) for diagnosis |
| processing_attempts | integer | not null, default `0` | Incremented by the processor on every attempt |
| uploaded_at | timestamp | nullable | Set on successful completion (client or sweep) |
| processed_at | timestamp | nullable | Set when the video becomes `ready` |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel ↛ Video (no inverse relation added in this phase — the channel panel is Phase 04)
**Indexes:** `(public_id)` — unique; `(channel_id, status)` — open-upload cap and future channel listings; `(status, created_at)` — sweep scans; `(channel_id)` — FK

**State machine (Phase 03):**

```
uploading ──complete (client or sweep)──▶ processing ──worker ok──▶ ready
    │                                         │
    ├─ DELETE /videos/:id ──▶ (row deleted)   ├─ INVALID_MEDIA (no retry) ──▶ failed
    └─ sweep: abandoned ────▶ failed          └─ 3 failed attempts ──────────▶ failed
failed ── DELETE /videos/:id ──▶ (row deleted)
```

---

### API Contracts

All endpoints are under `/videos`. Owner-scoped routes use the internal `:id` (UUID) returned by `POST /videos`; public routes use `:publicId` (12 chars). `VideosController` is exempt from the global rate limiter (TD-23).

#### POST /videos (SI-03.7)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- filename: string, required — 1–255 chars; its extension must belong to the declared `content_type` (`.mp4`/`.m4v` for `video/mp4`, `.webm` for `video/webm`, `.mov` for `video/quicktime`), case-insensitive
- size_bytes: integer, required — 1 ≤ value ≤ `UPLOAD_MAX_SIZE_BYTES` (10 GiB)
- content_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`

**Response 201:**
- id: string (uuid)
- public_id: string (12 chars)
- status: `'uploading'`
- title: string
- size_bytes: integer
- content_type: string
- upload: object
  - upload_id: string — the S3 multipart upload id (opaque; echoed for client bookkeeping)
  - part_size_bytes: integer
  - part_count: integer
- created_at: string (ISO 8601)

**Response headers:**
- Location: /videos/:publicId

**Error responses:**
- 415 UNSUPPORTED_MEDIA_TYPE: when the filename extension does not match the declared `content_type`
- 409 UPLOAD_LIMIT_REACHED: when the channel already has `UPLOAD_MAX_OPEN_PER_CHANNEL` videos in `uploading`
- 503 STORAGE_UNAVAILABLE: when the multipart upload cannot be opened on the store (nothing persisted)
- 401: when the access token is missing or invalid
- 400 validation error: when the request body fails schema validation (including `content_type` outside the allowlist and `size_bytes` above the limit)

---

#### POST /videos/:id/upload/parts/:partNumber/url (SI-03.8)

**Request headers:**
- Authorization: Bearer <access_token>

**Request path parameters:**
- id: uuid — the internal video id
- partNumber: integer — 1 ≤ value ≤ `part_count`

**Response 200:**
- part_number: integer
- url: string — presigned `PUT` URL on `STORAGE_PUBLIC_ENDPOINT`; the client `PUT`s exactly `part_size_bytes` bytes (the last part may be shorter) with no extra headers and keeps the `ETag` response header
- expires_at: string (ISO 8601) — `now + UPLOAD_PART_URL_TTL_SECONDS`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this id
- 403 VIDEO_NOT_OWNED: when the video belongs to another user's channel
- 409 VIDEO_INVALID_STATE: when the video is not `uploading`
- 401: when the access token is missing or invalid
- 400 validation error: when `id` is not a UUID or `partNumber` is not an integer in range

---

#### GET /videos/:id/upload/parts (SI-03.8)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- parts: array of objects, ascending by `part_number` — empty when nothing was uploaded yet
  - part_number: integer
  - etag: string — as issued by the store; must be sent back verbatim on completion
  - size_bytes: integer
  - last_modified: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND / 403 VIDEO_NOT_OWNED / 409 VIDEO_INVALID_STATE (not `uploading`, or the store no longer has the multipart upload — the message says to complete or delete): as above
- 401: when the access token is missing or invalid

---

#### POST /videos/:id/upload/complete (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required — at least one element, one per uploaded part
  - part_number: integer, required — ≥ 1
  - etag: string, required — non-empty

**Response 200:**
- id, public_id, title, size_bytes, content_type, created_at: as in `POST /videos`
- status: `'processing'`
- uploaded_at: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND / 403 VIDEO_NOT_OWNED: as above
- 409 VIDEO_INVALID_STATE: when the video is not `uploading` (including a second completion or a lost race)
- 409 UPLOAD_INCOMPLETE: when the stored parts do not match `part_count` / `part_size_bytes` or the submitted `(part_number, etag)` pairs — the video stays `uploading`
- 503 STORAGE_UNAVAILABLE: when the store cannot be reached while assembling the object
- 401: when the access token is missing or invalid
- 400 validation error: when the request body fails schema validation

---

#### DELETE /videos/:id (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content. The multipart upload (if open), every object under `videos/:id/` and the thumbnail are removed, and the row is deleted.

**Error responses:**
- 404 VIDEO_NOT_FOUND / 403 VIDEO_NOT_OWNED: as above
- 409 VIDEO_INVALID_STATE: when the video is `processing` or `ready` (deleting a ready video is not part of any phase in the project plan — flagged as a Phase 04 gap, N-07)
- 401: when the access token is missing or invalid

---

#### GET /videos/:publicId (SI-03.10)

**Request path parameters:**
- publicId: string — exactly 12 chars of `[A-Za-z0-9_-]`; any other shape is treated as not found

**Response 200:**
- public_id: string
- title: string
- status: `'uploading' | 'processing' | 'ready' | 'failed'`
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- size_bytes: integer
- thumbnail_url: string | null — unsigned URL on the public thumbnail bucket
- created_at: string (ISO 8601)

Never included: `id`, `channel_id`, `storage_key`, `upload_id`, `part_*`, `error_*`, `metadata`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this public id (or the id is malformed)

---

#### GET /videos/:publicId/playback (SI-03.10)

**Response 200:**
- url: string — presigned `GET` URL on `STORAGE_PUBLIC_ENDPOINT`; the store answers `Range` requests with `206 Partial Content` (TD-14)
- expires_at: string (ISO 8601) — `now + PLAYBACK_URL_TTL_SECONDS` (8 h, TD-15)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this public id
- 409 VIDEO_NOT_READY: when the video is not `ready`

---

#### GET /videos/:publicId/download (SI-03.10)

**Response 200:**
- url: string — presigned `GET` URL with `response-content-disposition=attachment; filename="<filename>"` (TD-16)
- expires_at: string (ISO 8601) — `now + DOWNLOAD_URL_TTL_SECONDS` (15 min)
- filename: string — ASCII-sanitized title + original extension, e.g. `Ferias-2026-praia.mp4`; fallback `video-<publicId>.<ext>`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this public id
- 409 VIDEO_NOT_READY: when the video is not `ready`

---

#### Validation Rules — POST /videos

| Field | Rule | Error message |
|-------|------|---------------|
| filename | Non-empty string, max 255 chars | filename must be longer than or equal to 1 and shorter than or equal to 255 characters |
| filename | Extension matches `content_type` (domain check) | Unsupported media type (415, `UNSUPPORTED_MEDIA_TYPE`) |
| size_bytes | Integer ≥ 1 | size_bytes must not be less than 1 |
| size_bytes | Integer ≤ `UPLOAD_MAX_SIZE_BYTES` | size_bytes must not be greater than 10737418240 |
| content_type | One of `video/mp4`, `video/webm`, `video/quicktime` | content_type must be one of the following values: video/mp4, video/webm, video/quicktime |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Role |
|----------|--------|---------------|------|
| POST /videos | | ✓ | Any confirmed user (the video is attached to the caller's channel) |
| POST /videos/:id/upload/parts/:partNumber/url | | ✓ | OWNER (channel.user_id = caller) |
| GET /videos/:id/upload/parts | | ✓ | OWNER |
| POST /videos/:id/upload/complete | | ✓ | OWNER |
| DELETE /videos/:id | | ✓ | OWNER |
| GET /videos/:publicId | ✓ | | Anonymous viewing (project premise); visibility rules are Phase 04 (TD-15) |
| GET /videos/:publicId/playback | ✓ | | Same |
| GET /videos/:publicId/download | ✓ | | Same |

Ownership is resolved as `video.channel.user_id === request.user.sub` (N-08); there are no roles in this phase. `VideosController` carries `@SkipThrottle()` (TD-23) — the 10 req/min limiter keeps applying to `/auth/*` only.

---

### Error Catalog

Error response format inherited from Phase 02: `{ statusCode, error, message }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| UNSUPPORTED_MEDIA_TYPE | 415 | Unsupported media type | POST /videos when the filename extension does not belong to the declared `content_type` (TD-22) |
| UPLOAD_LIMIT_REACHED | 409 | Too many uploads in progress for this channel | POST /videos when the channel has ≥ `UPLOAD_MAX_OPEN_PER_CHANNEL` videos in `uploading` (TD-23) |
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/:id` or `/videos/:publicId` route when no row matches (malformed public ids included) |
| VIDEO_NOT_OWNED | 403 | You do not own this video | Owner-scoped routes when the video's channel belongs to another user |
| VIDEO_INVALID_STATE | 409 | Video is not in a valid state for this operation | Upload-control routes when `status` is not the expected one (sign/list/complete require `uploading`; delete requires `uploading` or `failed`); lost race on completion; store no longer has the multipart upload on list-parts |
| UPLOAD_INCOMPLETE | 409 | Uploaded parts do not match the expected upload | POST /videos/:id/upload/complete when part count, part sizes or `(part_number, etag)` pairs differ from what the store holds |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | GET /videos/:publicId/playback or /download when `status ≠ ready` |
| STORAGE_UNAVAILABLE | 503 | Storage service is unavailable | POST /videos or POST …/upload/complete when the object store cannot be reached |

Worker-side outcomes are not HTTP errors; they surface through `GET /videos/:publicId` as `status: 'failed'` with the internal `error_reason` values `INVALID_MEDIA` (TD-22), `PROCESSING_FAILED` (TD-03), `UPLOAD_ABANDONED` (TD-20) and, on a `ready` video, `THUMBNAIL_FAILED` (N-04).

---

### Events/Messages

| Event | Payload | Publisher | Consumer | Delivery |
|-------|---------|-----------|----------|----------|
| `process-video` (queue `video-processing`, jobId `video-<videoId>`) | `{ videoId: string }` | `VideoQueueService` — from `VideosService.completeUpload` (SI-03.9) and `UploadSweepService` (SI-03.13) | `VideoProcessor` (worker, SI-03.12) | ack-required — BullMQ lock (`lockDuration` 10 min, `maxStalledCount` 1); 3 attempts, exponential backoff from 30 s; `UnrecoverableError` short-circuits; `removeOnComplete` / `removeOnFail` so the id can be re-added later; duplicate `add` while queued is a no-op |
| `upload-sweep` (queue `video-maintenance`, scheduler `upload-sweep-every`) | `{}` | BullMQ job scheduler registered by `UploadSweepScheduler` on worker bootstrap (SI-03.14), `every` = `SWEEP_INTERVAL_MINUTES` (15 min) | `UploadSweepProcessor` → `UploadSweepService.run()` (worker, SI-03.13) | ack-required — concurrency 1; a run that throws is retried by the next tick, not re-queued |

Redis is the only transport (TD-01); both queues share the `BullModule.forRootAsync` connection. The API process publishes only; the worker process consumes both queues and never serves HTTP (TD-02, TD-08).

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
│   ├── SI-03.3
│   ├── SI-03.4
│   └── SI-03.11 (also needs SI-03.3)
└── SI-03.5

SI-03.6 (no deps)

SI-03.3 + SI-03.4 + SI-03.5 + SI-03.6
└── SI-03.7
    ├── SI-03.8
    │   └── SI-03.9 (also needs SI-03.4)
    └── SI-03.10

SI-03.4 + SI-03.5 + SI-03.11
└── SI-03.12

SI-03.9 + SI-03.12
└── SI-03.13
    └── SI-03.14 (also needs SI-03.12)
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.5, SI-03.6 (parallel) → SI-03.3, SI-03.4 (parallel) → SI-03.7, SI-03.11 (parallel) → SI-03.8, SI-03.10, SI-03.12 (parallel) → SI-03.9 → SI-03.13 → SI-03.14

Out-of-scope follow-ups recorded during planning (separate tasks, not part of this phase): scope `ThrottlerGuard` to `AuthController` as Phase 02 intended (TD-23); remove the residual "local adapter" wording from the testing-guide skill (N-16); relabel "API → Object Storage: Uploads" as "signs" in `docs/diagrams/software-arch.mermaid` (N-15); decide deletion of `ready` videos (Phase 04, N-07); production storage service and Dockerfile targets (Phase 07).

## Deliverables

- [ ] Redis, MinIO (with one-shot `mc` provisioning: two buckets, thumbnail bucket public-read, CORS, lifecycle backstop, application access key) and FFmpeg available through Docker Compose using Compose service names
- [ ] `queue`, `storage` and `processing` configuration namespaces with Joi validation and `.env.example` defaults
- [ ] `StorageModule` wrapping AWS SDK v3 with internal and public `S3Client`s — multipart lifecycle, presigned PUT/GET, object put/delete, unsigned thumbnail URLs
- [ ] `QueueModule` with BullMQ (`@nestjs/bullmq@^11`, `bullmq@^5`) — `video-processing` and `video-maintenance` queues, idempotent `process-video` jobs (`jobId = video-<id>`, 3 attempts, exponential backoff)
- [ ] `videos` table and migration with lifecycle status enum, unique 12-char `public_id`, storage keys, part bookkeeping, extracted metadata and error columns
- [ ] Phase 03 domain exceptions mapped by the existing filter; `ChannelsService.findByUserId`
- [ ] `POST /videos` — draft pre-registration in `uploading` with TD-22 format allowlist, TD-23 cap of 5 open uploads per channel, unique `public_id`, multipart upload opened on the store
- [ ] `POST /videos/:id/upload/parts/:partNumber/url` and `GET /videos/:id/upload/parts` — per-part presigning and resumable upload state, owner-only
- [ ] `POST /videos/:id/upload/complete` — part verification, object assembly, `processing` transition and job publication; `DELETE /videos/:id` — abort and cleanup for `uploading`/`failed` videos
- [ ] `GET /videos/:publicId`, `/playback` (8 h presigned URL, Range/206 served by the store) and `/download` (15 min presigned URL with ASCII attachment filename) — public
- [ ] `FfmpegService` — `ffprobe` metadata + `moov` placement detection + single-frame JPEG thumbnail over presigned URLs, with timeouts and error classification
- [ ] `VideoProcessor` — `processing` → `ready` with metadata and thumbnail; non-retryable `INVALID_MEDIA`; terminal `PROCESSING_FAILED` after 3 attempts; thumbnail failure non-fatal
- [ ] Reconciliation sweep every 15 min — heals unrecorded completions, abandons uploads idle for 7 days, re-enqueues stale `processing` rows, aborts orphaned multipart uploads
- [ ] Standalone worker (`main.worker.ts`, `createApplicationContext`) as the `video-worker` Compose service with heartbeat health check and graceful shutdown
- [ ] A 10 GiB upload (205 parts) can be signed, uploaded, resumed and completed without a single 429 from the API
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Integration tests pass against real PostgreSQL, Redis, MinIO and FFmpeg (`docker compose exec nestjs-api npm run test:integration`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully, producing `dist/main.js` and `dist/main.worker.js` (`docker compose exec nestjs-api npm run build`)
