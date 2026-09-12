# Phase 03 — Upload e Processamento de Vídeos — Progress

**Status:** in_progress
**SIs:** 7/14 completed

### SI-03.1 — Dependencies and Configuration Namespaces
- **Status:** completed
- **Tests:** No dedicated test file (config-only SI); verified via full existing suite (128 unit/integration + 46 e2e) passing, `npx tsc --noEmit` clean, and direct Joi schema validation checks (missing STORAGE_ACCESS_KEY/SECRET_KEY rejected, UPLOAD_PART_SIZE_BYTES below 5 MiB rejected, valid config accepted)
- **Observations:** none

### SI-03.2 — Docker Compose: Redis, MinIO, Provisioning and FFmpeg
- **Status:** completed
- **Tests:** No dedicated test file (infra-only SI). Verified manually: `docker compose up -d` brings up db/mailpit/redis/minio healthy + nestjs-api running + minio-init exits 0 (and is idempotent on rerun); `ffmpeg -version`/`ffprobe -version` report 5.1.9 inside nestjs-api; Redis PING from nestjs-api returns PONG and `maxmemory-policy` is `noeviction`; unsigned GET on `videos/` returns 403, unsigned GET on an existing `thumbnails/` object returns 200; preflight OPTIONS to MinIO returns correct `Access-Control-Allow-Origin`/methods and real responses expose ETag/Content-Range/Accept-Ranges/Content-Length; `tsc --noEmit` clean
- **Observations:** Two deviations from the plan's literal technical actions, both due to the actual images/behavior available today (verified directly, not assumed): (1) `minio/minio` and `minio/mc` are no longer available on Docker Hub — MinIO moved distribution to `quay.io/minio/minio` and `quay.io/minio/mc`; compose.yaml uses those instead. (2) This MinIO server build (RELEASE.2025-09-07) does not implement the S3 `PutBucketCors` API — `mc cors set` fails with "functionality that is not implemented" even using root credentials; verified MinIO instead handles CORS automatically server-side for every bucket (reflects request Origin, honours requested method/headers on preflight, always exposes ETag/Content-Range/Accept-Ranges/Content-Length on real responses) — the CORS acceptance criterion passes without any bucket-level config, so the `minio-init.sh` CORS step was replaced with a log line instead of a fatal `mc cors set` call. The `AbortIncompleteMultipartUpload` lifecycle rule still fails as the plan anticipated (tolerated with `|| true` + warning, TD-20 no-op on MinIO).

### SI-03.3 — Storage Module (S3 Client Wrapper)
- **Status:** completed
- **Tests:** `storage.module.spec.ts` (3 tests) and `storage.service.integration-spec.ts` (10 tests, real MinIO) all pass; full suite 22/22 suites, 138/138 tests green; `tsc --noEmit` clean. Manually verified: `StorageUnavailableError` thrown with MinIO stopped; tampered presigned GET URL rejected with 403
- **Observations:** MinIO's `ListMultipartUploadsCommand` `Prefix` param only matches an exact full key on this build, not a real prefix (verified directly with root credentials too) — worked around with client-side `startsWith` filtering in `listMultipartUploads`, which is also correct against real S3 (server-side prefix there is just a redundant optimization). No `storage.service.spec.ts` unit file was created — not listed in the plan's Tests table for this SI (integration test covers all behavior against real MinIO).

### SI-03.4 — Queue Module and Processing Job Publisher
- **Status:** completed
- **Tests:** `queue.module.spec.ts` (2 tests) and `video-queue.service.integration-spec.ts` (4 tests, real Redis) all pass; full suite 24/24 suites, 144/144 tests green; `tsc --noEmit` clean. Manually verified bootstrap fails fast (~3s) against an unreachable `REDIS_HOST`
- **Observations:** Default BullMQ/ioredis behavior does NOT fail bootstrap on an unreachable Redis — it retries forever silently in the background, so the literal AC ("bootstrap fails fast") would not hold out of the box. Added a bounded `retryStrategy` (gives up after 5 attempts) to the BullMQ connection config plus a `VideoQueueService.onModuleInit()` that calls `queue.waitUntilReady()`, so Nest's bootstrap now genuinely blocks on and rejects with a real connection error when Redis is unreachable.

### SI-03.5 — Video Entity and Migration
- **Status:** completed
- **Tests:** `video.entity.integration-spec.ts` (8 tests), `migrations.integration-spec.ts` (updated, 2 tests), `videos.module.spec.ts` (1 test) all pass; full suite 26/26 suites, 153/153 tests green; `tsc --noEmit` clean. Manually verified `npm run migration:run` creates the `videos` table/enum/indexes/FK exactly per the Data Model, and `npm run migration:revert` cleanly drops table + both enum types (state restored afterward)
- **Observations:** Two infra issues surfaced and fixed, unrelated to entity/migration design: (1) `migrations.integration-spec.ts`'s `beforeAll` dropped all managed tables concurrently via `Promise.all` — with `videos` now FK'd to `channels`, concurrent CASCADE drops from separate connections deadlocked; switched to sequential drops. (2) `DROP TABLE ... CASCADE` does not drop the enum types a dropped table depended on, so a killed/interrupted prior run left `videos_status_enum` behind and broke the next `CreateVideos` migration with "type already exists"; added explicit `DROP TYPE IF EXISTS ... CASCADE` cleanup for both video enums in the same `beforeAll`. Confirmed integration tests and `npm run migration:*` share the same real `streamtube` database (project convention, not a separate test DB).

### SI-03.6 — Video Domain Exceptions and Channel Lookup
- **Status:** completed
- **Tests:** `domain-exception.filter.spec.ts` extended with 8 new cases (Phase 03 subclasses incl. 415/503), `channels.service.integration-spec.ts` extended with 2 `findByUserId` cases; full suite 26/26 suites, 163/163 tests green; `tsc --noEmit` clean
- **Observations:** none

### SI-03.7 — Upload Initiation (Draft Pre-Registration)
- **Status:** completed
- **Tests:** `public-id.util.spec.ts` (2), `title.util.spec.ts` (12), `videos.service.spec.ts` (6, unit), `videos.service.integration-spec.ts` (2, real DB+MinIO), `test/videos.e2e-spec.ts` (7) — all pass. Full sweep: unit/integration 30/30 suites (185 tests), e2e 3/3 suites (53 tests), `tsc --noEmit` clean, `eslint` clean on all files this SI touched
- **Observations:** (1) `npm run test:e2e` was NOT actually configured with `--runInBand` despite CLAUDE.md stating "already configured" and requiring it — adding a third e2e suite exposed a real cross-file DB race (`cleanAllTables` FK violations from parallel Jest workers). Fixed by adding `--runInBand` to the `test:e2e` script in `package.json` — this is a project-wide fix, not scoped to videos. (2) Discovered `npm run lint` already fails with ~150 pre-existing `@typescript-eslint/no-unsafe-*` errors across files this phase never touched (`auth.e2e-spec.ts`, `channels.service.ts`, `channels.service.spec.ts`, `domain-exception.filter.spec.ts`, `validation-exception.filter.spec.ts`) — confirmed via `git diff` that these files are functionally untouched by Phase 03 (only reformatted by `--fix`). This is pre-existing technical debt, out of scope to fix here; all new Phase 03 files (including this SI's) are lint-clean. Flagging as a follow-up for the user since it means the Deliverables' "Lint passes" check will fail today regardless of Phase 03 completion.

### SI-03.8 — Part Signing and Upload Resumption
- **Status:** pending
- **Tests:** -
- **Observations:** -

### SI-03.9 — Upload Completion, Cancellation and Job Publication
- **Status:** pending
- **Tests:** -
- **Observations:** -

### SI-03.10 — Public Read, Playback URL and Download URL
- **Status:** pending
- **Tests:** -
- **Observations:** -

### SI-03.11 — FFmpeg Service (Probe and Frame Extraction)
- **Status:** pending
- **Tests:** -
- **Observations:** -

### SI-03.12 — Video Processing Job Consumer
- **Status:** pending
- **Tests:** -
- **Observations:** -

### SI-03.13 — Reconciliation Sweep
- **Status:** pending
- **Tests:** -
- **Observations:** -

### SI-03.14 — Worker Bootstrap, Scheduler Registration and Compose Service
- **Status:** pending
- **Tests:** -
- **Observations:** -
