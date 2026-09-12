# Phase 03 — Upload e Processamento de Vídeos — Validation

> Run on 2026-09-12 against the sources listed in [context.md](context.md). Findings are grouped by type. Each **blocking** finding quotes the conflicting or missing statement, describes the consequence for the plan, and proposes a resolution. **Non-blocking** items are assumptions the plan will adopt unless vetoed — they are listed so the resolution round covers everything at once.

---

## Blocking findings

### V-01 — Missing decision: accepted video formats / containers

**Type:** Missing decision (interacts with an unmapped consequence of TD-17).

**Sources:**

- project-plan.md, Phase 03: *"Upload de vídeos com suporte a arquivos de até 10GB"* — the file type is never stated anywhere in the plan or in TD-01–TD-21.
- TD-19: *"Keep the source file's original extension for debuggability"* — implies more than one extension is expected, without saying which.
- TD-17 (Option A chosen): *"Store the uploaded file as-is"* — no remux and no re-encode in this phase.
- project-plan.md, Phase 05: *"Player de vídeo com controles"* — i.e. the browser's `<video>` element against the presigned URL (TD-14).

**Consequence:** with TD-04 the API never sees the bytes, so the only validation points are (a) the declared `content_type` / filename extension at draft creation and (b) `ffprobe` in the worker. With TD-17 nothing is transcoded. Therefore any container or codec the browser cannot decode natively (MKV, AVI, WMV, FLV, ProRes/MOV, HEVC-in-MP4 on browsers without HEVC support, AV1 on older ones) would be processed, get a thumbnail, be marked `ready`, and then fail to play in Phase 05 — with no error path defined. The plan cannot write the `POST /videos` validation rules, the `Error Catalog` entry for a rejected type, or the worker's "non-retryable failure" branch without this decision.

**Decision needed:**

1. Allowlist accepted at `POST /videos` (declared `content_type` + extension). **Recommendation:** `video/mp4` (`.mp4`, `.m4v`), `video/webm` (`.webm`), `video/quicktime` (`.mov`) — the three containers browsers decode natively when the codec is H.264/AAC or VP8/VP9/Opus. Anything else → `400`/`415 UNSUPPORTED_MEDIA_TYPE`.
2. Worker behaviour when `ffprobe` succeeds but finds **no video stream**, or fails to parse the file at all. **Recommendation:** non-retryable → `failed` with `error_reason = INVALID_MEDIA` (no retry budget burned, per TD-03's note on distinguishing retryable errors).
3. Whether the worker also validates the **codec** (e.g. rejects HEVC/ProRes inside an accepted container). **Recommendation:** not in Phase 03 — record `codec_name` in the stored metadata so the question can be reopened against real data (same posture TD-17 takes for `moov`).

---

### V-02 — Dependency gap: Phase 02's rate limiter is global and would break multipart signing

**Type:** Dependency gap (Phase 02 artefact) + unmapped consequence (abuse on video endpoints).

**Sources:**

- phase-02-auth.md, SI-02.13: *"Configure `ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])` in `AuthModule` imports — scoped to auth endpoints only, not globally"* and *"Since `ThrottlerModule` is imported in `AuthModule` (not `AppModule`), the guard only activates for routes handled by `AuthController`"*.
- Actual code, `src/auth/auth.module.ts`: `{ provide: APP_GUARD, useClass: ThrottlerGuard }` — `APP_GUARD` is application-wide regardless of which module registers it. `src/app.controller.ts` had to add `@SkipThrottle()` to escape it, and `test/auth.e2e-spec.ts` clears `ThrottlerStorage` in every `beforeEach`. The scoping the Phase 02 plan claims does not exist.
- TD-04: a 10GB upload at 50 MiB parts is *"~200 parts"*; each part needs its own presigned URL from the API.

**Consequence:** every Phase 03 endpoint inherits 10 requests/minute per IP. The upload flow (create + ~200 `sign-part` calls + `list-parts` on resume + `complete`) returns `429` after the 10th request in a minute — the headline capability of the phase cannot work as specified. Separately, no document limits how many drafts / open multipart uploads a single user may hold; each open upload reserves storage (TD-20) and a worker job (TD-03), so an unbounded count is an abuse vector the sweep only mitigates after days.

**Decision needed:**

1. How Phase 03 endpoints escape the 10/min throttle. **Recommendation:** `@SkipThrottle()` on `VideosController` (the precedent `AppController` already set), and register a separate task *"scope `ThrottlerGuard` to `AuthController` as the Phase 02 plan intended"* — not done inside Phase 03 (scope rule: one change at a time).
2. Whether Phase 03 caps open uploads per channel. Options: (a) explicit **out of scope** for Phase 03 (noted as a Phase 04 panel concern); (b) a cap on videos in `uploading` per channel (e.g. `UPLOAD_MAX_OPEN_PER_CHANNEL=5`, `409 UPLOAD_LIMIT_REACHED` on `POST /videos`). **Recommendation:** (b) — it is one query on the same row TD-05 already reads for ownership, and it bounds the sweep's worst case.

---

### V-03 — Inconsistency: testing guide prescribes a local-filesystem storage adapter; the decisions require an S3-API store

**Type:** Inconsistency across documents.

**Sources:**

- `.claude/skills/testing-guide-nestjs-project/references/external-systems.md`, section *Object Storage — Local Filesystem*: *"Local filesystem storage in development and tests. S3 in production. The storage layer should use an abstraction (e.g., `StorageService` interface) that allows switching between local filesystem and S3. In tests, use the local filesystem adapter — no mocking needed."* (marked "confirmed with the team").
- TD-04 (A): the browser `PUT`s parts to **presigned S3 URLs**; TD-07 (A): AWS SDK v3 against *"MinIO locally and S3-compatible in production"*; TD-11 (B): FFmpeg reads a **presigned GET**; TD-14 (B) / TD-16 (A): playback and download are presigned GETs; TD-21 (A): MinIO provisioned by `minio/mc` in Compose.

**Consequence:** a local-filesystem adapter cannot issue presigned URLs, answer `Range` with `206`, honour `ResponseContentDisposition`, or accept a browser `PUT` — every storage behaviour this phase tests is S3-protocol behaviour. Under the decisions, storage tests must run against the real MinIO service in Docker, exactly as the guide already prescribes for PostgreSQL, Mailpit and the queue. The plan's **Tests** sections (`*.integration-spec.ts` for the storage service, upload service, sweep, processor, plus the E2E upload flow) depend on which strategy is authoritative.

**Decision needed:** confirm that the decisions win and that the guide's storage section will be updated to *"Real (Docker) — MinIO via the S3 API; no local adapter; use dedicated test buckets or clean prefixes between tests"* (as a separate docs task). The plan will then be written against MinIO-backed integration tests.

---

## Non-blocking — assumptions the plan will adopt unless vetoed

These are either explicitly delegated to plan-phase by the decision document or are plan-level design consequences with one defensible answer. Say "veto N-xx: …" in the resolution round to change any of them.

| # | Topic | Assumption the plan will adopt |
|---|-------|--------------------------------|
| N-01 | Draft creation contract (TD-05: *"returns its id plus the upload credentials"*) | One request: `POST /videos { filename, size_bytes, content_type }` creates the row **and** calls `CreateMultipartUpload`, returning `{ id, public_id, status, upload: { upload_id, part_size_bytes, part_count } }`. The row is persisted directly in `uploading`; `draft` stays in the enum per TD-05 but no Phase 03 code writes it (Phase 04's draft→publish flow decides its meaning). If `CreateMultipartUpload` fails, nothing is persisted (`503 STORAGE_UNAVAILABLE`). Alternative if vetoed: two-step `POST /videos` (draft) → `POST /videos/:id/upload` (uploading). |
| N-02 | Title in Phase 03 (TD-16 derives the download filename from the title; TD-13 notes no title exists at draft creation) | `videos.title varchar(100) NOT NULL`, seeded from the original filename stem (trimmed, whitespace-collapsed, truncated). Download filename = ASCII-sanitized title + original extension, fallback `video-<public_id>.<ext>`. Phase 04 owns title editing and its validation rules. |
| N-03 | Access to read endpoints before Phase 04 visibility exists | `GET /videos/:publicId`, `GET /videos/:publicId/playback`, `GET /videos/:publicId/download` are **public** (`@Public()`), consistent with TD-15 (*"unlisted visibility (Phase 04) is enforced at issuance time"*) and the platform premise of anonymous viewing; `public_id` is unguessable so exposure equals "unlisted". Unknown id → `404 VIDEO_NOT_FOUND`; known but not `ready` → `409 VIDEO_NOT_READY`. Upload-control endpoints (sign/list/complete/abort) are owner-only → `403 VIDEO_NOT_OWNED` (existence of the id is not hidden from authenticated users — ids are UUIDs, not enumerable). |
| N-04 | Thumbnail output and failure semantics (delegated by TD-12) | JPEG, `scale=1280:-2` (≤1280 px wide, aspect preserved, even height), `-q:v 3`, single frame at `10%` of duration (`0s` when duration is unknown/zero). **Thumbnail failure is non-fatal:** the video becomes `ready` with `thumbnail_key = null` (frontend shows a placeholder); the ffmpeg error is logged and stored in `error_reason` for diagnosis. Metadata extraction failure *is* fatal (see V-01.2). |
| N-05 | Tunable values (delegated by TD-20 and the Infrastructure Impact table) — all env-configurable with these defaults | Part size **50 MiB**; max file size **10 GiB** (→ ≤ 205 parts, within 10,000); part-URL TTL **1 h** (re-signed per part on demand); playback URL TTL **8 h** (inside TD-15's 6–12h); download URL TTL **15 min**; worker source presign TTL **2 h**, regenerated per attempt. Retries: **3 attempts**, exponential backoff from **30 s** (TD-03). Worker concurrency **1**; ffprobe timeout **2 min**, ffmpeg thumbnail timeout **5 min**. Sweep: repeatable job every **15 min**; an `uploading` row is *checked* once `created_at` is older than **1 h**; it is *abandoned* when the newest part's `LastModified` (or `created_at` if no parts) is older than **7 days** → `AbortMultipartUpload` + `failed(UPLOAD_ABANDONED)`. Store side, strictly above the sweep: `MINIO_API_STALE_UPLOADS_EXPIRY=192h` (8 days) and lifecycle `DaysAfterInitiation: 8`. |
| N-06 | Sweep also heals two failure paths TD-06 does not spell out | (a) `uploading` row whose multipart upload no longer exists but whose object **does** (`CompleteMultipartUpload` succeeded, then the DB update/enqueue failed) → transition to `processing` and enqueue. (b) `processing` row older than **1 h** with no waiting/active/delayed job → re-enqueue. Jobs use a deterministic `jobId = video.id` so re-enqueueing is idempotent. |
| N-07 | Cancelling an upload (TD-04 lists Uppy's `abortMultipartUpload` hook) | `DELETE /videos/:id`, owner-only, allowed while `status ∈ { uploading, failed }`: aborts the multipart upload if open, deletes any objects under `videos/{id}/`, deletes the row → `204`. Deleting a `ready` video is **not** in any phase of the project plan — flagged as a Phase 04 gap, not added here. |
| N-08 | Ownership model | `videos.channel_id → channels.id` (FK, `ON DELETE RESTRICT`; user/channel deletion is not in any phase). Owner = `channel.user_id === request.user.sub`. `ChannelsService.findByUserId(userId)` is added in `ChannelsModule` (lookup belongs to the channel domain, per the SRP rule). |
| N-09 | Two storage endpoints (decision doc: the browser *"needs a separately configured, externally reachable storage endpoint"*) | Two `S3Client` instances from the same credentials: **internal** (`STORAGE_ENDPOINT=http://minio:9000`) for every API/worker call and for the worker's own presigns; **public** (`STORAGE_PUBLIC_ENDPOINT`, e.g. `http://localhost:9000` on the host) used only to presign browser-facing URLs and to build thumbnail URLs, because SigV4 signs the `Host`. Inside the container (E2E tests) `STORAGE_PUBLIC_ENDPOINT` is set to the internal value. |
| N-10 | FFmpeg in the dev image | `Dockerfile.dev` gains `ffmpeg` so the single dev image serves both `nestjs-api` and `video-worker`, and worker integration tests (real `ffprobe`/`ffmpeg` on a small generated fixture) run in the container that runs the suite. TD-02's "FFmpeg only in the worker image" is preserved for the production images (Phase 07). |
| N-11 | No frontend, production store open | E2E tests act as the upload client (they `PUT` parts to the presigned URLs from inside the container). Local store = MinIO (TD-20/TD-21 assume it). The production MinIO-vs-managed-S3 decision stays open and does not block this phase (deploy is Phase 07). |
| N-12 | Phase 02 migration test | `src/database/migrations.integration-spec.ts` asserts exactly two migrations and four tables — updated in the migration SI to three migrations and five tables. `cleanAllTables()` gains `videos` (before `channels`). |
| N-13 | Concurrency on completion | `POST /videos/:id/complete` verifies `ListParts` count == expected `part_count` and each ETag matches, then updates with a conditional `WHERE status = 'uploading'`; a lost race returns `409 VIDEO_INVALID_STATE`. Enqueue happens after the commit with `jobId = video.id` (idempotent). |
| N-14 | Metadata stored from ffprobe | `duration_seconds` (numeric), `width`, `height`, `codec_name`, `container_format`, `moov_at_end` (TD-17), raw `ffprobe -show_format -show_streams` JSON in a `metadata jsonb` column for later reopening of TD-12/TD-17. |
| N-15 | Docs follow-ups (not in this phase) | Architecture diagram label *"API → Object Storage: Uploads"* now means "signs"; the testing guide storage section (V-03); the throttler scoping task (V-02). Each becomes a separate task. |

---

## Checks that passed

- **Decision-vs-decision consistency:** TD-01…TD-21 form a coherent chain (each "Depends on" is satisfied by an earlier decided option); no chosen option contradicts another (e.g. TD-11 B and TD-17 A are mutually consistent about never reading the whole object; TD-14 B reuses TD-04 A's CORS surface).
- **Previous-phase constraints:** no Phase 03 decision reopens a Phase 01/02 choice — `registerAs` + Joi (01.01–01.04), custom guards (02.02), class-validator (02.06), domain exception filter (02.07), nickname ownership in `ChannelsModule` (02.10) are all respected. The Phase 02 error response format is inherited unchanged.
- **Capability coverage:** every capability C1–C9 in [context.md](context.md) §1 maps to at least one decided TD; the only capability-level gap is the format policy (V-01).
- **Dependency on delivered work:** everything Phase 03 needs from Phase 02 exists in the tree — `JwtAuthGuard` + `@Public()` + `@CurrentUser()`, `Channel` entity and `ChannelsModule`, `DomainException` base, config namespaces, migration/seed/test infrastructure. Only `ChannelsService.findByUserId` is missing and is added in-phase (N-08).
- **Library compatibility (from the decision document, to be re-confirmed via context7 in `library-refs.md`):** `@nestjs/bullmq@12` peers `@nestjs/common ^10 || ^11 || ^12` and `bullmq ^3–^6`; AWS SDK v3 requires Node ≥ 20; no ESM-only package on the critical path (TD-13 explicitly avoided `nanoid@6`).
- **REST conventions:** every planned endpoint has a conventional status code (201 create, 200 data, 204 actions/deletes) and the `{ statusCode, error, message }` error shape.
- **Docker networking rule:** all service hosts are Compose names; the single exception (browser-facing storage endpoint) is documented by the decision document itself and handled in N-09.

---

## Verdict

**`dirty`** — three blocking findings (V-01 accepted formats, V-02 global throttler + upload cap, V-03 testing-guide storage strategy). No plan artefacts (`library-refs.md`, `phase-03-videos.md`, `progress.md`) were generated.

**To unblock:** answer V-01 (1–3), V-02 (1–2) and V-03, and veto any N-xx you disagree with. Record V-01 and V-02.2 in `docs/decisions/technical-decisions-phase-03-upload-processing.md` (e.g. as TD-22 *Accepted upload formats* and TD-23 *Video endpoint rate limiting and upload cap*), and V-03 in the testing guide. Validation is then re-run against the updated sources before the plan is drafted.
