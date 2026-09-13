# Phase 03 — Manual End-to-End Verification (Upload → Processing → Playback)

## Purpose

`phase-03-videos.progress.md` (SI-03.14 observations) notes that the full HTTP
round-trip — real multipart upload from a client, through the API and MinIO,
processed by the worker, and served back for playback/download — had **not**
been exercised end-to-end; only unit/integration/e2e suites (which mock or
short-circuit parts of this path) had run. This document records a manual
verification of that exact gap, using `nestjs-project/scripts/test-upload.js`
against the environment started with `docker compose up -d`.

This is **not** a replacement for the automated suite documented in
`phase-03-videos.progress.md` — no assertions here duplicate what that suite
already covers.

## Run metadata

- **Date:** 2026-09-13, ~17:59–18:40 UTC (14:59–15:40 America/Sao_Paulo), across two back-to-back passes — the initial run (tests #1–#3, #4, #5) ending ~18:15 UTC, and test #4b (the intact-file 205-part counterpart, added after review of the #4 result) run separately from ~18:37 UTC
- **Command:** `node scripts/test-upload.js <file>` from `nestjs-project/`
- **Environment:** `docker compose up -d` (db, redis, mailpit, minio, nestjs-api, video-worker), all healthy
- **Files tested** (names/sizes only — full local paths omitted):

  | File | Size | Container |
  |---|---|---|
  | `smoke-test.mp4` | 1.2 MiB | video/mp4 |
  | `big-test.mp4` | 210.3 MiB | video/mp4 |
  | `big-test-10gb.mp4` (original) | 10 283.6 MiB (~10.045 GiB) | video/mp4 |
  | `big-test-10gb-trimmed.mp4` (derived, see below) | 10 239.0 MiB (exactly `UPLOAD_MAX_SIZE_BYTES - 1 MiB`) | video/mp4 |
  | `big-test-10gb-valid.mp4` (derived, see §4b) | 10 232.0 MiB (~9.993 GiB) | video/mp4 |

## Summary of results

| File | Parts | Upload time (create→complete) | Final status | Time to terminal state | Deviation? |
|---|---|---|---|---|---|
| `smoke-test.mp4` | 1 | ~0.1 s | `ready` | ~2 s | none |
| `big-test.mp4` | 5 | ~5 s | `ready` | ~7 s | none |
| `big-test-10gb.mp4` (original, 10 283.6 MiB) | — | — | rejected, **400 VALIDATION_ERROR** before any upload started | instant | see below |
| `big-test-10gb-trimmed.mp4` (10 239.0 MiB) | 205 | ~8 min 21 s | `failed` (`PROCESSING_FAILED`) | ~1 min 36 s after upload completed | see below |
| `big-test-10gb-valid.mp4` (10 232.0 MiB) | 205 | ~2 min 06 s | `ready` | ~8 s after upload completed | none |
| Abandoned-upload sweep (ad hoc, 1 part) | 1 | n/a (never completed) | `failed` (`UPLOAD_ABANDONED`) | see sweep section | none — worked as designed once correctly configured |

### Deviations observed vs. plan/decisions

1. **10 GiB fixture exceeds `UPLOAD_MAX_SIZE_BYTES`.** The original
   `big-test-10gb.mp4` fixture is 10 783 110 828 bytes, ~43.6 MiB above the
   configured cap (`UPLOAD_MAX_SIZE_BYTES=10737418240`, exactly 10 GiB, per
   `phase-03-videos.md`). `POST /videos` correctly rejected it with
   `400 VALIDATION_ERROR` before any multipart upload was opened — this is
   the API behaving correctly, not a bug, but it meant the fixture as
   generated could not exercise the ~205-part path described in
   `phase-03-videos.md` (`part_count: 205` example) and TD-04/TD-06. To
   proceed, a copy of the file was truncated to
   `UPLOAD_MAX_SIZE_BYTES - 1 MiB` (`10736369664` bytes) — this is
   `big-test-10gb-trimmed.mp4` — which does yield the documented 205 parts.
   Truncating an MP4 mid-container corrupts it, so a processing failure on
   this specific file was expected and is not evidence of an upload-path
   defect (see below).

2. **Worker process never emits any log output.** `src/main.worker.ts`
   calls `NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true })`
   but never calls `app.useLogger(...)` to flush the buffer. Per Nest's own
   contract, `bufferLogs: true` holds every log line (including the
   worker's own bootstrap message, `VideoProcessor` output, and
   `UploadSweepService`'s `Sweep finished: {...}` report) in memory
   indefinitely unless a logger is attached. In practice this means
   `docker compose logs video-worker` shows only the Nest CLI's own
   compilation messages — never anything the application logs — even
   though the worker is demonstrably running and processing jobs (BullMQ
   state in Redis, DB status transitions, and the `WorkerHeartbeatService`
   heartbeat file all confirm it is alive and working). This was found
   while trying to collect the "worker log excerpt" evidence requested for
   this document; per instruction, it was **not** fixed as part of this
   verification (out of scope — logged here as a separate finding for a
   future task) and all evidence below is sourced from the API
   (`GET /videos/:publicId`) and the database instead of worker logs.

3. **`test-upload.js` etag bug (pre-existing, fixed in an earlier session).**
   Not a new finding for this document, but worth noting: the script
   originally stripped quotes from the `ETag` response header before
   sending it to `POST /videos/:id/upload/complete`, which mismatched the
   quoted ETag the store returns via `ListParts` and caused a spurious
   `409 UPLOAD_INCOMPLETE`. Already fixed in `scripts/test-upload.js`
   (etag is now forwarded as received) before this run.

## Per-file evidence

### 1. `smoke-test.mp4` (1.2 MiB, 1 part)

```json
{
  "public_id": "FCR7U6SxL4s1",
  "title": "smoke-test",
  "status": "ready",
  "duration_seconds": 60,
  "width": 1280,
  "height": 720,
  "size_bytes": 1259169,
  "thumbnail_url": "http://localhost:9000/thumbnails/videos/2a2c283b-9298-4459-9374-bcb163bc6e63/thumbnail.jpg",
  "created_at": "2026-09-13T17:59:56.300Z"
}
```

- **Playback URL:** `http://localhost:9000/videos/videos/2a2c283b-9298-4459-9374-bcb163bc6e63/source.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260913T175958Z&X-Amz-Expires=28800&X-Amz-Signature=<redacted>&X-Amz-SignedHeaders=host&...`
- **Download URL:** `http://localhost:9000/videos/videos/2a2c283b-9298-4459-9374-bcb163bc6e63/source.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260913T175958Z&X-Amz-Expires=900&X-Amz-Signature=<redacted>&...&response-content-disposition=attachment%3B%20filename%3D%22smoke-test.mp4%22`
- **Worker log:** not available (see Deviation #2). Confirmed processed via DB row (`status=ready`, `error_reason` empty, `uploaded_at` populated) and via the MinIO console screenshots below, taken against this exact run's objects.
- **MinIO evidence (screenshots):**
  - `screenshots/minio-videos-bucket.png` — `videos` bucket → `videos/2a2c283b-9298-4459-9374-bcb163bc6e63/source.mp4` (1.2 MiB)
  - `screenshots/minio-thumbnails-bucket.png` — `thumbnails` bucket → `thumbnails/videos/2a2c283b-9298-4459-9374-bcb163bc6e63/thumbnail.jpg` (41.2 KiB)

### 2. `big-test.mp4` (210.3 MiB, 5 parts)

```json
{
  "public_id": "CfNXAqMlc4Zb",
  "title": "big-test",
  "status": "ready",
  "duration_seconds": 6000.024,
  "width": 1280,
  "height": 720,
  "size_bytes": 220514194,
  "thumbnail_url": "http://localhost:9000/thumbnails/videos/4d8b3a21-5274-4052-90c9-ec5dc3a0750a/thumbnail.jpg",
  "created_at": "2026-09-13T18:00:05.163Z"
}
```

- **Playback URL:** `http://localhost:9000/videos/videos/4d8b3a21-5274-4052-90c9-ec5dc3a0750a/source.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260913T180012Z&X-Amz-Expires=28800&X-Amz-Signature=<redacted>&...`
- **Download URL:** `http://localhost:9000/videos/videos/4d8b3a21-5274-4052-90c9-ec5dc3a0750a/source.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260913T180012Z&X-Amz-Expires=900&X-Amz-Signature=<redacted>&...&response-content-disposition=attachment%3B%20filename%3D%22big-test.mp4%22`
- **Parts:** 4 × 50.0 MiB + 1 × 10.3 MiB, all uploaded and completed without retries.
- **Worker log:** not available (Deviation #2). Confirmed via DB (`status=ready`) and the multipart upload transitioning cleanly through `processing` → `ready` within ~2 s of `complete-upload`.

### 3. 10 GiB fixture — oversize rejection

Request: `POST /videos` with `size_bytes: 10783110828` (the untouched
`big-test-10gb.mp4`):

```
400 Bad Request
{"statusCode":400,"error":"VALIDATION_ERROR","message":["size_bytes must not be greater than 10737418240"]}
```

No multipart upload was opened on the store (nothing to check in MinIO for
this case). This confirms `UPLOAD_MAX_SIZE_BYTES` validation at
`POST /videos` works as specified in `phase-03-videos.md`, but also means
the fixture as provided cannot exercise the 205-part / near-limit path —
hence the trimmed copy used below.

### 4. `big-test-10gb-trimmed.mp4` (10 239.0 MiB, 205 parts — TD-04/N-05 path)

```json
{
  "public_id": "vB_d7SdsrYKd",
  "title": "big-test-10gb-trimmed",
  "status": "failed",
  "duration_seconds": null,
  "width": null,
  "height": null,
  "size_bytes": 10736369664,
  "thumbnail_url": null,
  "created_at": "2026-09-13T18:02:59.510Z"
}
```

DB detail (not exposed on the public endpoint, queried directly for this
report):

| Column | Value |
|---|---|
| `status` | `failed` |
| `error_reason` | `PROCESSING_FAILED` |
| `error_detail` | `ffmpeg/ffprobe process exited with a non-zero status` |
| `processing_attempts` | `3` (matches `QUEUE_JOB_ATTEMPTS=3`) |
| `part_count` | `205` |
| `uploaded_at` | `2026-09-13 18:11:19.145` |

- **Upload plan returned by `POST /videos`:** `part_size_bytes: 52428800`, `part_count: 205` — matches the `phase-03-videos.md` §189/§199 example (`10 GiB → 205 parts`) exactly.
- **Upload timing:** created `18:02:59.510` (America/Sao_Paulo, UTC-3) → all 205 parts uploaded and `complete-upload` accepted at `18:11:19` → **~8 min 21 s** wall-clock for the full multipart transport (local MinIO, no artificial throttling). No part required a retry; every `PUT` returned 200 on the first attempt.
- **Processing outcome:** the worker picked up the job, retried 3 times (per `QUEUE_JOB_ATTEMPTS`), and set `status=failed` / `error_reason=PROCESSING_FAILED` roughly 1 min 36 s after the upload completed. This is the **expected** consequence of truncating the file for the size-limit workaround (see Deviation #1) — the trailing structure of the container (or, depending on how the fixture was originally muxed, the `moov` atom) was cut, so `ffprobe`/`ffmpeg` could not process it. **This is not evidence of a defect in the upload/multipart/queue path** — the transport of all 205 parts, `CompleteMultipartUpload`, the `processing` status flip, and 3 queue attempts with backoff all behaved exactly as documented; only the media payload itself was invalid by construction.
- **Worker log:** not available (Deviation #2).

### 4b. `big-test-10gb-valid.mp4` (10 232.0 MiB, 205 parts) — success counterpart

Since truncating the file for test #4 deliberately corrupted it, a second
~10 GiB fixture was generated to confirm the 205-part path also succeeds
end-to-end on an intact file. Rather than truncating again, this file was
**built directly at a safe size**: a 30 s H.264/AAC seed chunk was encoded
once with `ffmpeg` (`testsrc`/`sine` synthetic source) and concatenated via
the `concat` demuxer with stream copy (no re-encode, so no quality loss and
no risk of a bad encode) enough times to land at `10 729 074 410` bytes —
~8 MiB under `UPLOAD_MAX_SIZE_BYTES` (10 737 418 240) — comfortably inside
the limit while still exercising the same 205-part math as test #4.
`ffprobe` confirmed the output was a valid, fully-decodable container
before it was uploaded.

```json
{
  "public_id": "LFQm0XD7ZfVh",
  "title": "big-test-10gb-valid",
  "status": "ready",
  "duration_seconds": 226350.024,
  "width": 1280,
  "height": 720,
  "size_bytes": 10729074410,
  "thumbnail_url": "http://localhost:9000/thumbnails/videos/3b35df5f-2aab-4167-b4c8-9266fa1a3cac/thumbnail.jpg",
  "created_at": "2026-09-13T18:37:35.703Z"
}
```

- **Playback URL:** `http://localhost:9000/videos/videos/3b35df5f-2aab-4167-b4c8-9266fa1a3cac/source.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260913T183949Z&X-Amz-Expires=28800&X-Amz-Signature=<redacted>&...`
- **Download URL:** `http://localhost:9000/videos/videos/3b35df5f-2aab-4167-b4c8-9266fa1a3cac/source.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260913T183949Z&X-Amz-Expires=900&X-Amz-Signature=<redacted>&...&response-content-disposition=attachment%3B%20filename%3D%22big-test-10gb-valid.mp4%22`
- **Upload plan:** `part_size_bytes: 52428800`, `part_count: 205` — same shape as test #4.
- **Upload timing:** created `18:37:35` → `complete-upload` accepted `18:39:41` → **~2 min 06 s** wall-clock (faster than test #4's 8m21s run purely due to local machine/IO variance between the two runs, not a code difference — no part needed a retry in either run).
- **Processing outcome:** the worker probed, transcoded and thumbnailed the file successfully, reaching `status=ready` ~8 s after the upload completed — despite the synthetic file reporting an absurd `duration_seconds: 226350` (62.9 h), a byproduct of concatenating 7 545 copies of the same 30 s clip. This confirms the 205-part transport, completion, and processing pipeline all work correctly on a valid payload at this size — isolating test #4's failure to the deliberately-corrupted file, not the upload/processing path.
- **DB confirmation:** `status=ready`, `error_reason` empty, `storage_key=videos/3b35df5f-2aab-4167-b4c8-9266fa1a3cac/source.mp4`, `uploaded_at=2026-09-13 18:39:41.274`.
- **MinIO evidence:** `screenshots/minio-videos-10gb-bucket.png` — `videos` bucket → `videos/3b35df5f-2aab-4167-b4c8-9266fa1a3cac/source.mp4`, **10.0 GiB**, confirming the full object landed in the store.
- **Worker log:** not available (Deviation #2).

### 5. Abandoned-upload sweep (`UploadSweepService`, N-05/N-06, TD-06/TD-20)

The plan's default sweep timers (`SWEEP_INTERVAL_MINUTES=15`,
`SWEEP_STALE_UPLOAD_MINUTES=60`, `SWEEP_ABANDON_DAYS=7`) make a real-time
test impractical in a single session, so `.env` was **temporarily**
overridden and the `video-worker` container restarted (the `nestjs-api`
container was left untouched throughout, since it was mid-upload for the
205-part test above) to shrink the intervals; the original values were
restored and the worker restarted again immediately after this test.

**Reading `upload-sweep.service.ts` while investigating** turned up a
sequencing detail worth recording: `SWEEP_STALE_UPLOAD_MINUTES` only
selects which `uploading` rows are *candidates* for reconciliation (`created_at`
older than that many minutes); the actual decision to abort the multipart
upload and mark the video `failed`/`UPLOAD_ABANDONED` is gated on
`SWEEP_ABANDON_DAYS` measured from the **last uploaded part's timestamp**
(default 7 days). Lowering only `SWEEP_STALE_UPLOAD_MINUTES` (first attempt,
to 1 minute) was not sufficient by itself — after ~7 minutes and 14
scheduler iterations (confirmed via the BullMQ repeat-job key in Redis,
`bull:video-maintenance:repeat:upload-sweep-every`, `ic: 14`), the ad hoc
video was still `uploading`. `SWEEP_ABANDON_DAYS` also had to be lowered
(to `0.0007`, ≈ 1 minute) for the abandon branch to actually fire. This is
not a bug — TD-20's 7-day default is intentionally conservative relative to
the resumable-upload guarantee — but it means a real (non-accelerated) test
of this path takes on the order of a week, not minutes, which is worth
knowing for anyone tempted to "just wait and see" in the running
environment.

**Test procedure:**
1. `.env`: `SWEEP_INTERVAL_MINUTES=1`, `SWEEP_STALE_UPLOAD_MINUTES=1`, `SWEEP_ABANDON_DAYS=0.0007` → `docker compose restart video-worker`.
2. A one-off script registered a user, created a video (`smoke-test.mp4`, 1 part declared), uploaded **only** part 1 via its presigned URL, and deliberately never called `complete-upload` — simulating a client that abandons the upload mid-flight.
3. Waited for the scheduler to run with the lowered thresholds.

**Result:**

```json
{"public_id":"veQdRnI7UYJO","title":"smoke-test","status":"failed","duration_seconds":null,"width":null,"height":null,"size_bytes":1259169,"thumbnail_url":null,"created_at":"2026-09-13T18:05:05.755Z"}
```

DB: `error_reason = UPLOAD_ABANDONED`. Confirmed via the AWS SDK
(`ListMultipartUploadsCommand` against the `videos` bucket) that the
multipart upload was actually aborted on the store — zero open multipart
uploads remained after the sweep ran, where one had been open before.

`.env` and `video-worker` were restored to the original values
(`SWEEP_INTERVAL_MINUTES=15`, `SWEEP_STALE_UPLOAD_MINUTES=60`,
`SWEEP_ABANDON_DAYS=7`) immediately after this result was captured.

## Database evidence (all 4 files)

Queried directly against the `videos` table (not exposed as-is via the API)
to confirm each upload was both transported to the store *and* registered
correctly, with `storage_key` / `size_bytes` / `part_count` matching what
each test actually sent, and `uploaded_at` populated (only set after
`completeUpload` verifies every part against `StorageService.listParts` —
`videos.service.ts`, the check documented in `phase-03-videos.md` §256):

| public_id | title | status | error_reason | storage_key | size_bytes | part_count | uploaded_at |
|---|---|---|---|---|---|---|---|
| `FCR7U6SxL4s1` | smoke-test | `ready` | — | `videos/2a2c283b-9298-4459-9374-bcb163bc6e63/source.mp4` | 1259169 | 1 | 2026-09-13 17:59:56.364 |
| `CfNXAqMlc4Zb` | big-test | `ready` | — | `videos/4d8b3a21-5274-4052-90c9-ec5dc3a0750a/source.mp4` | 220514194 | 5 | 2026-09-13 18:00:10.55 |
| `vB_d7SdsrYKd` | big-test-10gb-trimmed | `failed` | `PROCESSING_FAILED` | `videos/f9c3d882-a500-4fed-9701-2bd2ff7c90a8/source.mp4` | 10736369664 | 205 | 2026-09-13 18:11:19.145 |
| `LFQm0XD7ZfVh` | big-test-10gb-valid | `ready` | — | `videos/3b35df5f-2aab-4167-b4c8-9266fa1a3cac/source.mp4` | 10729074410 | 205 | 2026-09-13 18:39:41.274 |

The third row's populated `uploaded_at` despite `status=failed` is itself
evidence that the **upload** (all 205 parts + `CompleteMultipartUpload`)
succeeded — the row only reaches `uploaded_at`/`processing` after that
check passes; the subsequent `failed` transition came later, from the
worker's processing attempt, not from the upload path. The fourth row is
the intact-file counterpart to that same 205-part path, reaching `ready`.

Storage-side (MinIO) confirmation is the three screenshots in
`screenshots/`: `minio-videos-bucket.png` and `minio-thumbnails-bucket.png`
(captured against file #1, `smoke-test.mp4`, before cleanup) and
`minio-videos-10gb-bucket.png` (captured against file #4b,
`big-test-10gb-valid.mp4`, showing the 10.0 GiB object in the store before
cleanup) — see the per-file sections above. All source objects were
deleted from MinIO during the cleanup pass described below; the buckets
are empty as of the end of this session.

## Cleanup

All objects created by these manual runs (`videos` and `thumbnails` buckets)
were deleted from MinIO after the evidence above (including the
screenshots) was captured, and the one open multipart upload left by the
abandoned-upload test was aborted by the sweep itself during the test. The
corresponding `videos` table rows were left in place as they carry no
storage cost and are useful as a record of this run.
