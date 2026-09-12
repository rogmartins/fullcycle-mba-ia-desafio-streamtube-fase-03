# Phase 03 — Upload e Processamento de Vídeos — Context

> Consolidated context read before planning. Sources: [project-plan.md](../../project-plan.md), [technical-decisions-phase-03-upload-processing.md](../../decisions/technical-decisions-phase-03-upload-processing.md), the Decisions Summary tables of Phases 01 and 02, [phase-01-configuracao-base.md](../phase-01-configuracao-base.md), [phase-02-auth.md](../phase-02-auth.md), [phase-02-auth.progress.md](../phase-02-auth.progress.md), the `testing-guide-nestjs-project` skill, and the current `nestjs-project/` source tree.
>
> Date: 2026-09-12

---

## 1. Phase scope (from project-plan.md)

> Depende de: Fase 01, Fase 02
>
> Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única.

Capabilities, verbatim:

| # | Capability | Decisions that shape it |
|---|------------|-------------------------|
| C1 | Serviço de armazenamento de arquivos (vídeos e thumbnails) | TD-07, TD-18, TD-19, TD-21 |
| C2 | Serviço de processamento em segundo plano (filas) | TD-01, TD-02, TD-03, TD-08 |
| C3 | Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | TD-04, TD-06, TD-07, TD-20 |
| C4 | Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | TD-05, TD-13 |
| C5 | Processamento automático do vídeo após upload (extração de duração e metadados) | TD-09, TD-10, TD-11, TD-17 |
| C6 | Geração automática de thumbnail a partir de um frame do vídeo | TD-12, TD-18, TD-19 |
| C7 | URL única por vídeo, sem conflito com outros vídeos | TD-13 |
| C8 | Reprodução via streaming (sem necessidade de download completo) | TD-14, TD-15, TD-17 |
| C9 | Download do vídeo pelo usuário | TD-16 |

**Deliverables (project-plan):** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Pontos de Atenção that bind this phase:** upload must not block the system *and* must be resumable after a connection failure; processing must run in the background; every video needs a short, unique URL; storage growth must be planned; playback must start without a full download.

### Boundaries with neighbouring phases

| Belongs to Phase 03 | Belongs to a later phase |
|---------------------|--------------------------|
| `videos` table with upload/processing lifecycle, `public_id`, storage keys, duration/metadata, auto-generated thumbnail | Title/description/category editing, custom thumbnail, visibility (public/unlisted), draft→publish flow, channel panel (Phase 04) |
| API endpoints to create the draft, sign parts, list parts, complete/abort the upload, poll status | Watch page, player UI, view counting, suggestions, download *button* (Phase 05) |
| Playback URL issuance (presigned GET) and download URL issuance (presigned GET + `Content-Disposition`) | Enforcing visibility at issuance time — TD-15 explicitly defers "refusing to sign for a video the requester should not reach" to Phase 04 |
| Redis + BullMQ queue, separate worker container, FFmpeg processing, thumbnail, reconciliation sweep | Operator tooling / dead-letter queue (TD-03 defers), Bull Board (TD-08 defers) |
| MinIO + `mc` init provisioning in Compose | Production storage service and provisioning (still-open decision in the TD document; deploy is Phase 07) |
| Backend (`nestjs-project`) + Compose infrastructure | Any frontend/uploader UI — `nextjs-project` is not initialized (same situation Phase 02 planned under) |

---

## 2. Technical decisions — TD-01 to TD-24 (all decided; TD-22–TD-24 added during validation — see [validation.md](validation.md))

| ID | Decision | Choice | Practical consequence for the plan |
|----|----------|--------|------------------------------------|
| TD-01 | Background job queue | **A** — BullMQ + Redis via `@nestjs/bullmq` | New `redis` Compose service (`maxmemory-policy noeviction`, AOF); `BullModule.forRootAsync` + `registerQueue`; `@Processor` extending `WorkerHost` |
| TD-02 | Worker topology | **A** — Separate worker container, shared codebase | New `video-worker` Compose service; distinct entrypoint `main.worker.ts`; entities/config shared |
| TD-03 | Failure/retry policy | **A** — Bounded retries + exponential backoff + terminal `failed` on the video | Retryable vs non-retryable classification; `failed` status + error reason column; never leave `processing` indefinitely |
| TD-04 | Upload transport | **A** — Presigned multipart, direct to store | API only signs: create multipart, sign part, list parts, complete, abort. Bytes never touch the API. Store must be browser-reachable with CORS. Client hooks map 1:1 to `@uppy/aws-s3@6` |
| TD-05 | Draft pre-registration | **A** — Draft row on `videos`, upload state as columns | `status` enum `draft → uploading → processing → ready / failed`; `storage_key`, `upload_id` on the row; one source file per video |
| TD-06 | Completion trigger | **C** — Client `POST /videos/:id/complete` + reconciliation sweep | Sweep is a BullMQ repeatable job on the worker: for stale `uploading` rows, `ListParts` → complete-and-enqueue or abort-and-fail |
| TD-07 | S3 client | **A** — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | Custom `endpoint`, `forcePathStyle: true`; `getSignedUrl(client, new UploadPartCommand(...))` per part |
| TD-08 | Worker bootstrap | **A** — `NestFactory.createApplicationContext()` | No HTTP in the worker; guards/pipes/interceptors unavailable; Compose `CMD`-form health check |
| TD-09 | FFmpeg provisioning | **A** — `apt-get install ffmpeg` on `node:25.6.0-slim` (Debian 12, FFmpeg 5.1) | Provides both `ffmpeg` and `ffprobe`; no npm wrapper |
| TD-10 | FFmpeg invocation | **A** — `child_process.spawn` in a thin injectable service | Argument arrays (no shell), timeouts, kill on abort; fakeable in tests |
| TD-11 | Source access | **B** — FFmpeg reads a presigned HTTPS URL | Sparse reads via Range; near-zero worker disk; presigned GET must outlive the job |
| TD-12 | Thumbnail frame | **A** — Percentage offset of duration (e.g. 10%) | Single seek + one frame. **Output format, dimensions and failure semantics delegated to plan-phase** |
| TD-13 | Public identifier | **A** — Random `public_id`, 12-char base64url from `node:crypto` (`randomBytes(9)`) | `varchar(12) NOT NULL UNIQUE`; collision retry; UUID PK stays internal; public routes use `/videos/:publicId` |
| TD-14 | Playback delivery | **B** — API issues presigned GET; store answers Range with 206 | `GET /videos/:publicId/playback` returns URL + expiry; store CORS must expose `Content-Range`, `Accept-Ranges`, `Content-Length` |
| TD-15 | Playback URL lifetime | **B** — Session-sized TTL (6–12h) per page load | Return `expires_at` alongside the URL; visibility gate at issuance is Phase 04's |
| TD-16 | Download route | **A** — Presigned GET with `ResponseContentDisposition: attachment` | Filename derived from title, ASCII-sanitized; short TTL |
| TD-17 | `moov` normalization | **A** — None; rely on Range + tail read | Record moov placement as metadata during probe; no remux, no re-encode |
| TD-18 | Bucket topology | **B** — Private video bucket + public-read thumbnail bucket | Two buckets, two env vars; thumbnails at stable unsigned URLs (cacheable) |
| TD-19 | Object keys | **A** — `videos/{videoId}/source.<ext>` and `videos/{videoId}/thumbnail.jpg`, keyed by internal UUID | Keep original extension; nothing mutable in the key |
| TD-20 | Abandoned multipart expiry | **C** — Sweep as primary + lifecycle rule as backstop | Sweep also aborts; `AbortIncompleteMultipartUpload` lifecycle JSON where honoured (no-op on MinIO); `MINIO_API_STALE_UPLOADS_EXPIRY` raised above the sweep threshold. **Exact values and ordering delegated to plan-phase** |
| TD-21 | Provisioning | **A** — One-shot `minio/mc` init service in Compose | `mc mb --ignore-existing`, `mc anonymous set download`, `mc cors set`, lifecycle JSON; no admin credentials in API/worker |
| TD-22 | Accepted upload formats | **A** — Allowlist `video/mp4` (`.mp4`, `.m4v`), `video/webm` (`.webm`), `video/quicktime` (`.mov`) | `415 UNSUPPORTED_MEDIA_TYPE` on mismatch; no video stream / unparsable → non-retryable `failed(INVALID_MEDIA)`; codec recorded, not enforced |
| TD-23 | Video endpoint rate limiting + upload cap | **A** — `@SkipThrottle()` on `VideosController`; `UPLOAD_MAX_OPEN_PER_CHANNEL=5` | `409 UPLOAD_LIMIT_REACHED` on `POST /videos`; throttler scoping to `AuthController` is a separate follow-up task |
| TD-24 | Queue library version pinning | **A** — `@nestjs/bullmq@^11.0.5` + `bullmq@^5.81.5` (CommonJS) | No Jest/tsconfig changes; `ioredis` bundled; v12/v6 (ESM-only) deferred to a future NestJS 12 / ESM migration |

### Choices the decision document explicitly delegates to plan-phase

- **TD-12:** thumbnail output format and dimensions; whether a failed thumbnail fails the job or leaves the video `ready` with a placeholder.
- **TD-20:** the sweep threshold, the store-side stale-upload expiry, the lifecycle `DaysAfterInitiation`, and their ordering (sweep < store).
- **Infrastructure Impact table:** the concrete env vars — part size, presign TTLs (upload part, playback 6–12h, download "short"), queue tuning.

### Reference limits carried from the decision document

| Limit | Value |
|-------|-------|
| Single `PUT` | 5 GB (below the 10GB requirement → multipart is mandatory) |
| Multipart part size | 5 MiB – 5 GiB; last part unconstrained |
| Max parts | 10,000 (10GB at 50 MiB ≈ 200 parts) |
| MinIO `stale_uploads_expiry` default | 24h (must be raised explicitly) |

### Dependencies the decisions add

`@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5` (CommonJS line — TD-24, decided after validation V-04; `ioredis` bundled), `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`. No FFmpeg npm wrapper (TD-10), no id library (TD-13). Exact versions confirmed via context7 in [library-refs.md](library-refs.md).

---

## 3. Constraints inherited from previous phases (not reopened)

### Phase 01 decisions

| ID | Constraint |
|----|-----------|
| TD-01.01 | `@nestjs/config` is the configuration module |
| TD-01.02 | Env validation with Joi (`src/config/env.validation.ts`, `allowUnknown: true, abortEarly: false`) |
| TD-01.03 | Namespaced `registerAs` factories, one file per namespace in `src/config/` |
| TD-01.04 | TypeORM CLI shares the `registerAs` factory (`src/database/data-source.ts`, `entities: ['src/**/*.entity.ts']`, migrations under `src/database/migrations/*.ts`) |

### Phase 02 decisions

| ID | Constraint |
|----|-----------|
| TD-02.02 | Custom guards with `@nestjs/jwt` only — `JwtAuthGuard` is a global `APP_GUARD`; opt out with `@Public()` |
| TD-02.06 | class-validator + class-transformer DTOs; global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) |
| TD-02.07 | Custom domain exception filter — error shape `{ statusCode, error, message }`; services throw `DomainException` subclasses, never Nest HTTP exceptions |
| TD-02.08 | `@nestjs/throttler` at 10 req/min per IP, registered as an `APP_GUARD` from `AuthModule` (see validation.md — this guard is global, not auth-scoped) |
| TD-02.10 | Nickname `[a-z0-9_]` derivation lives in `ChannelsModule` |

### Conventions from CLAUDE.md files

- Every `npm`/`npx`/`node` command runs **inside the container** (`docker compose exec nestjs-api …`); integration and e2e suites run with `--runInBand`.
- Service hosts are always Compose service names (`db`, `mailpit`, and now `redis`, `minio`) — never `localhost`. The decision document records the one legitimate exception: the **browser-facing** storage endpoint must be host-reachable.
- Test suffixes: `*.spec.ts` (unit, no I/O), `*.integration-spec.ts` (real DB / real external systems), `*.e2e-spec.ts` in `test/` (supertest). Jest `testRegex` already matches `(spec|integration-spec)`. `setupFiles: ["dotenv/config"]` in both configs.
- Non-TS runtime assets must be declared in `nest-cli.json` `compilerOptions.assets`.
- REST conventions: 201 + representation for creation, 200 for data, 204 with no body for actions; `Location` header when a GET exists.
- One scope per task; out-of-scope findings become separate tasks.

### Testing guide requirements that shape the Tests sections

- Entities → Integration (constraints, defaults). Services with branching + DB → Unit + Integration. Services with side-effect deps (storage, queue) → Integration against the real system in Docker. Modules with configured imports → compilation test. Controllers/DTOs/guards → E2E only. Queue processors → Unit (mock deps) + Integration. Scheduled/repeatable jobs → test the method directly.
- Queue: real Redis in Docker; publisher tests assert the job is in the queue; consumer tests call `process()` directly.
- Object storage: the guide currently prescribes a **local-filesystem adapter** — this conflicts with TD-04/TD-07/TD-21 (see validation.md).

---

## 4. What already exists in the code that Phase 03 integrates with

### Application bootstrap — `src/main.ts`, `src/app.module.ts`

- `NestFactory.create(AppModule)`, global `ValidationPipe`, global `DomainExceptionFilter` + `ValidationExceptionFilter`, port from `app.port`.
- `AppModule` loads `appConfig`, `authConfig`, `databaseConfig`, `mailConfig` into `ConfigModule.forRoot({ isGlobal: true, validationSchema })` and `TypeOrmModule.forRootAsync` (`autoLoadEntities: true, synchronize: false`). Only `AuthModule` is imported as a feature module (it pulls `UsersModule`, `ChannelsModule`, `MailModule`).
- **Integration points:** a `VideosModule` (and a queue/storage module) must be added to `AppModule`; `queue.config.ts` and `storage.config.ts` must be added to `load` and to the Joi schema; `main.worker.ts` needs a separate root module that imports config + TypeORM + queue + storage + processors but **not** `AuthModule`/controllers. The E2E fixture reproduces `main.ts` globals manually (`Test.createTestingModule({ imports: [AppModule] })`).

### Config — `src/config/*.ts`

- `app.config.ts`: `port`, `nodeEnv`, `url` (`APP_URL`, default `http://localhost:3000`).
- `auth.config.ts`, `mail.config.ts`, `database.config.ts` follow the same `registerAs` shape with `process.env` defaults; `env.validation.ts` lists every var with Joi defaults/`required()`.
- `.env.example` documents all vars with Compose-compatible defaults; values with shell-special characters must be quoted.

### Auth — `src/auth/`

- `JwtAuthGuard` (global `APP_GUARD`): verifies Bearer token, sets `request.user = { sub: userId, email }` (`JwtPayload` in `auth.types.ts`). `@Public()` bypasses it. `@CurrentUser()` returns the payload.
- `ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])` + `ThrottlerGuard` as `APP_GUARD` — **global**; `AppController` opts out with `@SkipThrottle()`. E2E tests clear `ThrottlerStorage` in `beforeEach`.
- `AuthController` routes: `POST /auth/register|login|refresh|logout|resend-confirmation|forgot-password|reset-password`, `GET /auth/confirm-email`, `GET /auth/me`.
- **Integration points:** video endpoints are protected by default; `@CurrentUser().sub` gives the user id; the channel id must be resolved from it.

### Users and Channels — `src/users/`, `src/channels/`

- `User` entity (`users`): `id`, `email` (unique), `password` (`select: false`), `is_confirmed`, timestamps, `@OneToOne(Channel, cascade)`.
- `Channel` entity (`channels`): `id`, `name` (50), `nickname` (50, unique), `description`, `user_id` (unique FK), timestamps.
- `UsersService`: `createUserWithChannel`, `findByEmail`, `findByEmailWithChannel`, `save`.
- `ChannelsService`: `createChannel(userId, email)` only — **there is no `findByUserId`**; the plan must add one in `ChannelsModule` (single-responsibility: channel lookups belong there). `ChannelsModule` exports `TypeOrmModule` and `ChannelsService`; `UsersModule` re-exports `ChannelsModule`.
- Video ownership model for this phase: `videos.channel_id → channels.id`; the requester is the owner when `channel.user_id === request.user.sub`.

### Common — `src/common/`

- `DomainException(errorCode, httpStatus, message)` base + Phase 02 subclasses in `domain.exception.ts`; `DomainExceptionFilter` maps to `{ statusCode, error, message }`; `ValidationExceptionFilter` normalizes class-validator errors to `VALIDATION_ERROR`.
- **Integration point:** Phase 03 adds its own `DomainException` subclasses (video not found, invalid state, not owner, upload errors) and extends the filter's unit test.

### Database — `src/database/`

- `data-source.ts` for the CLI; migrations `1775687773260-CreateUsersAndChannels.ts`, `1777579850478-CreateAuthTokens.ts`; `migrations.integration-spec.ts` asserts exactly two migrations and four tables — **must be updated** when the `videos` migration lands. Seeds runner exists with no seeds.
- Naming: snake_case columns, `uuid_generate_v4()` PKs, PostgreSQL enums for status-like columns.

### Test infrastructure — `src/test/`, `test/`

- `createTestDataSource(entities, { synchronize, migrations })` reads `DB_*` from env (defaults to host `db`); `cleanAllTables()` deletes `refresh_tokens`, `verification_tokens`, `channels`, `users` in FK order — **must add `videos`** (before `channels`).
- `mailpit.ts` helper for the Mailpit API. E2E fixtures in `test/auth.e2e-spec.ts` show the pattern: import `AppModule`, apply pipes/filters, clean tables + throttler storage in `beforeEach`, `app.close()` in `afterAll`.
- `package.json` scripts: `test`, `test:integration` (`--runInBand --testRegex integration-spec`), `test:e2e`, `migration:*`, `seed`, `lint`, `build`.

### Docker — `nestjs-project/compose.yaml`, `compose.override.yaml`, `Dockerfile.dev`

- Services: `nestjs-api` (built from `Dockerfile.dev`, bind-mounts `.`, `CMD tail -f /dev/null` — the app is started manually), `db` (postgres:17, healthcheck), `mailpit`. Override remaps the DB host port to 5433.
- `Dockerfile.dev`: `node:25.6.0-slim` + `procps curl`, `USER node`. No production Dockerfile exists yet.
- **Integration points:** add `redis`, `minio`, `minio-init` (`minio/mc`), `video-worker`; add health checks; decide how the worker dev container runs (`nest start --entryFile main.worker --watch` or equivalent); FFmpeg must be present wherever worker tests execute (tests run in `nestjs-api` today).

### Documentation

- `docs/diagrams/software-arch.mermaid`: API → storage "Uploads", frontend → storage "Streams", API → queue "Publishes job", queue → worker, worker → storage/DB. The decided design refines "API uploads" into "API signs; browser uploads" — the diagram may deserve a label tweak (out of scope for this plan).

---

## 5. Infrastructure impact summary (from the decision document, confirmed against the tree)

| Item | Change |
|------|--------|
| `compose.yaml` | + `redis` (noeviction, AOF), + `minio` (API 9000, console 9001, `MINIO_API_STALE_UPLOADS_EXPIRY`), + `minio-init` one-shot `minio/mc`, + `video-worker`; `nestjs-api` depends on `redis` and `minio` |
| `Dockerfile.dev` | FFmpeg/ffprobe available to the worker (and to the container that runs worker tests) |
| `.env.example` | `REDIS_HOST=redis`, `REDIS_PORT`, `STORAGE_ENDPOINT` (internal), `STORAGE_PUBLIC_ENDPOINT` (browser), credentials, `STORAGE_VIDEO_BUCKET`, `STORAGE_THUMBNAIL_BUCKET`, `STORAGE_REGION`, `UPLOAD_PART_SIZE_BYTES`, `UPLOAD_MAX_SIZE_BYTES`, presign TTLs (part / playback / download / worker source), sweep thresholds |
| `src/config/` | `queue.config.ts`, `storage.config.ts` (+ upload/playback tuning) via `registerAs`; Joi schema extended |
| Database | `videos` table: status enum, `public_id` (12, unique), `channel_id` FK, `storage_key`, `upload_id`, size/part bookkeeping, duration, metadata, thumbnail key, error reason, timestamps |
| Dependencies | `@nestjs/bullmq@^11`, `bullmq@^5` (TD-24), `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| Worker | `src/main.worker.ts` + `WorkerModule`; `nest-cli.json` may need an additional entry/`entryFile` handling; Compose `CMD` health probe |
| Storage config | Video bucket private + CORS (PUT parts, GET with Range, expose `ETag`, `Content-Range`, `Accept-Ranges`, `Content-Length`); thumbnail bucket anonymous download; lifecycle JSON with `AbortIncompleteMultipartUpload` |
