# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

> **Phase:** 03 — Upload e Processamento de Vídeos
> **Status:** Decided (TD-01–TD-23)
> **Date:** 2026-09-06

---

## Scope of this document

Built in five research rounds:

- **Round 1 — Background processing queue** (TD-01 – TD-03, decided): the "Message Queue (TBD)" container in [software-arch.mermaid](../diagrams/software-arch.mermaid), plus where the worker runs and what happens when a job fails.
- **Round 2 — Large upload path** (TD-04 – TD-07): how a 10GB file reaches the object store without blocking the API, how the draft video record is pre-registered when the upload starts, how the API learns the upload finished, and which S3 client library to use.
- **Round 3 — Video worker runtime** (TD-08 – TD-12): how the worker process boots, how FFmpeg reaches the container, how it is invoked from Node, how it reads a 10GB source object, and which frame becomes the thumbnail. TD-02 already fixed the *topology* (separate container, shared codebase) and is not reopened here.
- **Round 4 — Playback and delivery** (TD-13 – TD-17): what goes in the public video URL, who answers the player's Range requests with `206 Partial Content`, how long a playback grant lives, how a direct download differs from playback, and whether the worker normalizes MP4 index placement.

- **Round 5 — Storage layout and expiry** (TD-18 – TD-21): how buckets are divided between source videos and thumbnails, what shape object keys take, how abandoned multipart uploads are reclaimed alongside the TD-06 sweep, and how that configuration is provisioned.

Still **not** covered and pending a separate round: the object storage **service** itself (self-hosted MinIO vs managed S3). Every decision in this document assumes only that the store speaks the **S3 API** and — from TD-04 Option A onwards — is reachable from the browser; both candidates satisfy that. Round 5 does surface the first place where the two genuinely diverge (TD-20: MinIO does not implement `AbortIncompleteMultipartUpload`), which is input to that decision rather than a resolution of it.

**Constraints inherited from previous phases (not reopened):** `@nestjs/config` with namespaced `registerAs` factories (TD-01.03), Joi env validation (TD-01.02), custom domain exception filter (TD-02.07), class-validator DTOs (TD-02.06), JWT access tokens via custom guards (TD-02.02), PostgreSQL 17 + TypeORM 0.3, NestJS 11 on Node 25 (`node:25.6.0-slim`), Docker Compose with `db` and `mailpit` services.

---

## TD-01: Background Job Queue Technology

**Context:** Phase 03 requires the capability *"Serviço de processamento em segundo plano (filas)"*. After an upload completes, the API must enqueue a job; a separate FFmpeg worker consumes it, extracts duration and metadata, generates a thumbnail from a frame, and updates the video record. The workload is **CPU-bound and long-running** (a 10GB source file can take many minutes to probe and transcode a frame), **low-volume** (one job per upload, not a high-throughput stream), and **needs observable per-job state** so the video can be shown as `processing` / `ready` / `failed` in the UI. This decision determines whether new infrastructure is added to the Docker Compose stack.

**Options:**

### Option A: BullMQ + Redis via `@nestjs/bullmq`

Redis-backed job queue. `@nestjs/bullmq@12` (peer: `@nestjs/common` `^10 || ^11 || ^12`, `bullmq` `^3–^6`) provides `BullModule.forRootAsync()`, `registerQueue()`, `@InjectQueue()`, and `@Processor()` classes extending `WorkerHost` with `concurrency` / `lockDuration` / `maxStalledCount`.

- **Pros:** Officially documented NestJS integration — decorators and DI match the patterns already used in Phases 01–02. Purpose-built for this workload: retries with backoff, job progress reporting, delayed jobs, per-worker concurrency, stalled-job recovery, flows. Redis becomes reusable later (cache in Phase 07, distributed `@nestjs/throttler` store).
- **Cons:** Adds a Redis container to the stack — one more service to run, configure, and operate. Production correctness requires `maxmemory-policy noeviction` (BullMQ states this is *the only* setting that guarantees correct queue behavior) plus AOF persistence. Job data lives outside PostgreSQL, so job state and video state are in two stores with no shared transaction.

### Option B: BullMQ + PostgreSQL backend (`createPostgresBackend`)

BullMQ v6 (released Aug 2026, current `6.3.4`) introduced pluggable backends. `createPostgresBackend` runs the identical `Queue`/`Worker`/`FlowProducer` API on PostgreSQL 13+ (project is on 17), storing jobs in a dedicated `bullmq` schema and using `LISTEN`/`NOTIFY` instead of Redis blocking commands.

- **Pros:** Zero new infrastructure — reuses the existing PostgreSQL 17 container. Full API parity (flows, schedulers, rate limiting, priorities, delayed jobs, deduplication, metrics). Same application code as Option A, so switching backends later is cheap.
- **Cons:** **Immature** — the backend is roughly one month old. `@nestjs/bullmq@12` has no `backendFactory` option in `RegisterQueueOptions` (verified in the published typings), so it must be wired via the process-wide `setDefaultBackendFactory()` before module init — an undocumented path for the Nest module. Throughput is ~1.5–2× lower than Redis. `runMigrations()` is **not** automatic and needs an explicit deployment step. No Redis Cluster / raw-client escape hatches.

### Option C: pg-boss (PostgreSQL-native queue)

Dedicated PostgreSQL job queue (`12.30.0`, requires Node ≥ 22.12 and PostgreSQL 13+) built on `SKIP LOCKED`. Workers are registered with `boss.work(queue, handler)`. Manages its own schema and migrations automatically, with a CLI for migration control.

- **Pros:** Zero new infrastructure and a mature, PG-native design. Rich feature set: retries with jittered exponential backoff (`retryBackoff`), dead-letter queues with redrive, cron scheduling, deferral, concurrency, priorities, rate limiting, debouncing, automatic archiving/maintenance.
- **Cons:** No maintained NestJS integration — `@apricote/nest-pg-boss@2.1.0` still peers `@nestjs/common ^9 || ^10` and `pg-boss ^8 || ^9`, so the module/DI wiring must be written by hand. No decorator-based processors. Queue traffic adds write load and vacuum pressure to the same database serving the API.

### Option D: RabbitMQ (`@golevelup/nestjs-rabbitmq` or `@nestjs/microservices`)

AMQP broker. `@golevelup/nestjs-rabbitmq@9.0.2` peers `@nestjs/common ^11.1.21`; `@nestjs/microservices@11` supports an RMQ transport via `amqplib` + `amqp-connection-manager`.

- **Pros:** Battle-tested broker with mature routing (exchanges, bindings), per-message acknowledgement, and prefetch-based load distribution. Strong operational tooling and a management UI.
- **Cons:** It is a message broker, not a job runtime — retries with backoff, dead-lettering, and delayed delivery must be assembled manually from DLX + TTL (or a plugin). No job-state store, so "is this video still processing?" needs separate bookkeeping. The default `consumer_timeout` is **30 minutes**, after which the channel is closed and *all* deliveries on it are requeued — a real hazard for FFmpeg on 10GB files, requiring explicit per-queue tuning. Adds a broker container plus its operational surface for a single job type.

> **Apache Kafka — evaluated and excluded.** Kafka is a partitioned, ordered event log, not a task queue: it has no per-message acknowledgement or redelivery, no delayed or prioritized jobs, and no built-in retry/backoff. A long-running FFmpeg consumer head-of-line blocks its entire partition, and rebalance timeouts would fire during normal processing. Its throughput and durable-log strengths are irrelevant to a one-job-per-upload workload, while its operational cost is the highest of all candidates. It is not carried forward as an option.

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)** — It is the only candidate that is simultaneously mature *and* officially integrated with NestJS, so the queue code stays consistent with the DI/decorator patterns established in Phases 01–02 instead of hand-rolled wiring. It provides exactly the primitives this workload needs (backoff retries, job progress, stalled-job recovery, per-worker concurrency) with no assembly required. The only real cost is one extra Compose service in a stack that already runs `db` and `mailpit`, and Redis pays for itself again in Phase 07.

If **avoiding a new container is a hard constraint**, choose **Option C (pg-boss)** over Option B: both keep everything in PostgreSQL, but pg-boss is mature and self-migrating, whereas BullMQ's Postgres backend is one month old *and* its NestJS wiring path is undocumented — two compounding risks on the critical path of the phase. Option B becomes attractive once `@nestjs/bullmq` exposes a first-class backend factory; because Options A and B share identical application code, starting on A leaves that door open.

**Decision:** **Option A**

---

## TD-02: Video Worker Deployment Topology

**Context:** The architecture diagram models the Video Worker as a container separate from the API. FFmpeg is CPU-bound and its binary is a heavy image dependency. This decision defines where the queue consumer actually runs. *Depends on TD-01.*

**Options:**

### Option A: Separate worker container, shared codebase
A second Compose service built from the same repository with a distinct bootstrap entrypoint (`main.worker.ts`) that creates an application context without the HTTP server, registering only the processor modules.

- **Pros:** Matches the architecture diagram. CPU-bound FFmpeg work cannot starve the API's event loop or delay HTTP responses. Worker and API scale and restart independently. FFmpeg is installed only in the worker image. Entities, config namespaces, and services stay shared — no duplication.
- **Cons:** A second Compose service and Dockerfile target. Two processes to observe locally. Shared modules must not assume an HTTP context.

### Option B: Processor inside the API process
The `@Processor()` class is registered in the API application itself; one container serves HTTP and consumes jobs.

- **Pros:** Simplest setup — no new service, no second entrypoint, single log stream.
- **Cons:** FFmpeg (native, CPU-bound) competes with the request event loop, degrading API latency during processing. Cannot scale workers without scaling the API. FFmpeg must be baked into the API image. Contradicts the architecture diagram.

### Option C: Sandboxed (threaded) processors inside the API
BullMQ runs the handler in a forked/threaded child process, still owned by the API container.

- **Pros:** Keeps the main event loop free without a second service. Supported natively by both `@nestjs/bull` and `@nestjs/bullmq`.
- **Cons:** Sandboxed processors run outside the Nest DI context — repositories and config must be re-bootstrapped in the child. Still one container: CPU contention and coupled scaling remain. FFmpeg still lives in the API image.

**Recommendation:** **Option A (separate worker container, shared codebase)** — The phase's stated risk is precisely that video processing must not block the user, and a 10GB FFmpeg job in-process is the failure mode Options B and C invite. Sharing the codebase keeps entities and config namespaces single-sourced while isolating the FFmpeg dependency in its own image, and it realizes the container boundary the architecture diagram already declares.

**Decision:** **Option A**

---

## TD-03: Job Failure and Retry Policy

**Context:** Video processing can fail transiently (storage timeout, worker restart mid-job) or permanently (corrupt file, unsupported codec). The video record must never be left silently stuck in `processing`. This sets the retry values and the terminal-failure contract consumed by Phase 04's management panel. *Depends on TD-01 and TD-02.*

**Options:**

### Option A: Bounded retries with exponential backoff + terminal `failed` status on the video
A small number of attempts (e.g. 3) with exponential backoff. On final failure, the worker writes a `failed` status and an error reason onto the video record.

- **Pros:** Transient faults self-heal without operator action. The user always sees a terminal state. The `failed` status is a natural input to Phase 04's panel and to a future "retry" button. Supported natively by all TD-01 candidates.
- **Cons:** A permanently broken file still burns its full retry budget. Requires distinguishing retryable from non-retryable errors to avoid pointless attempts.

### Option B: Bounded retries + dead-letter queue for exhausted jobs
Same as Option A, but exhausted jobs are also routed to a dedicated dead-letter queue for inspection and manual redrive.

- **Pros:** Failed payloads are preserved for debugging and can be reprocessed in bulk after a fix. First-class in pg-boss (DLQ with redrive) and expressible in BullMQ via the failed set or a dedicated queue.
- **Cons:** Extra queue and handler to build and monitor in a phase that has no operator tooling yet. Duplicates information already captured by the `failed` status on the video record.

### Option C: No automatic retry — mark failed on first error
Any error immediately marks the video `failed`; recovery is a user-initiated re-upload or reprocess.

- **Pros:** Simplest possible model. No risk of a poison job consuming worker capacity repeatedly.
- **Cons:** A single transient blip (worker restart, momentary storage error) forces the user to re-upload a 10GB file — unacceptable for the phase's headline capability.

**Recommendation:** **Option A** — It delivers the guarantee the phase actually needs (transient faults recover; the user never sees an indefinite `processing` state) using only built-in queue features, with no extra infrastructure. The dead-letter queue of Option B is a genuine improvement but belongs with the operator tooling of a later phase; because exhausted jobs are retained by the queue regardless, adding a DLQ later is not a breaking change.

**Decision:** **Option A**

---

## TD-04: Large Upload Transport Strategy

**Context:** Phase 03's headline capability is *"Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"*, and the plan's Pontos de Atenção add a second requirement: the upload must **survive a connection failure and resume**. Two hard limits from the S3 API shape every option: a single `PUT` uploads **at most 5 GB**, and multipart uploads accept **5 MiB–5 GiB parts, up to 10,000 parts** (a 10GB file at 50 MiB parts is ~200 parts — comfortably inside the limit). This decision determines whether 10GB of video bytes ever transit the NestJS container. *Feeds TD-05, TD-06 and TD-07.*

**Options:**

### Option A: Presigned multipart, uploaded directly to the object store

The API exposes signing endpoints only: it issues `CreateMultipartUpload`, presigns one URL per part via `@aws-sdk/s3-request-presigner`, then runs `CompleteMultipartUpload`. The client `PUT`s each part straight to MinIO/S3; the API never sees the bytes. `ListParts` makes resumption a query, not a re-upload.

- **Pros:** Video bytes never touch the API container — no memory, disk, bandwidth, or long-lived request held by a 10GB transfer. Resumability is native (`ListParts` returns what already landed; the client re-signs only the missing parts). Parts upload in parallel, so throughput is bounded by the client link, not the API. Client side is a solved problem: `@uppy/aws-s3@6` exposes exactly `createMultipartUpload` / `signPart` / `listParts` / `completeMultipartUpload` / `abortMultipartUpload` hooks that map 1:1 onto these endpoints, with no Companion server.
- **Cons:** The client must orchestrate part splitting and retries — more frontend logic than a plain form post. Requires CORS on the store for browser `PUT`s (MinIO defaults `MINIO_API_CORS_ALLOW_ORIGIN` to `*`, tightened per-bucket with `mc cors set`). Presigned URLs expire, so a slow client needs re-signing mid-upload. The store must be reachable from the browser, so its public endpoint becomes part of the deployment surface. Abandoned multipart uploads linger until an abort or lifecycle rule reclaims them.

### Option B: Streamed through the API with `@aws-sdk/lib-storage`

The client posts the file to a NestJS endpoint; the `Upload` helper from `@aws-sdk/lib-storage` streams the request body into S3 multipart as it arrives, without buffering the whole file.

- **Pros:** Single conventional endpoint — no CORS on the store, no presigning, no client-side part logic. The store never needs to be publicly reachable. Auth, validation, and quota checks apply naturally on the same request.
- **Cons:** All 10GB transit the API container, doubling bandwidth and occupying one connection for the whole transfer — the exact "impacto na performance" the phase exists to avoid. **No resumability:** an API restart, deploy, or dropped connection loses the entire upload, violating the plan's resume requirement. Reverse-proxy and platform body/time limits must be raised for a multi-hour request. Concurrent uploads scale API resource use linearly.

### Option C: tus resumable protocol via `@tus/server` + `@tus/s3-store`

Mount the tus 1.0 protocol (`@tus/server@2.4.5`, `@tus/s3-store@2.0.6`, both Node ≥ 20.19) on an Express route. `S3Store` translates tus offsets into S3 multipart internally (`partSize`, `minPartSize`, `maxMultipartParts`, `maxConcurrentPartUploads`), and `RedisKvStore` + `RedisLocker` share the Redis instance TD-01 already adds.

- **Pros:** Resumability is the protocol's entire purpose — an interrupted upload resumes from a byte offset with no application logic. `S3Store` owns the part-size math for 10GB files. Mature clients (`tus-js-client@4.3.1`, Uppy's tus plugin). Reuses the Redis from TD-01 for cross-instance locking and metadata.
- **Cons:** Bytes flow through the Node process again, reintroducing Option B's core drawback unless tus is deployed as its own service — which trades the problem for a third container. The tus server owns its own HTTP handling, sitting outside NestJS guards/filters, so auth and the TD-02.07 error contract need bridging via hooks. Adds a protocol and two packages for a resumability guarantee that Option A already gets from `ListParts`.

> **Presigned single `PUT` — evaluated and excluded.** The most common "presigned URL" recipe issues one signed `PutObjectCommand` and lets the client upload in a single request. It cannot satisfy this phase: S3 caps a single `PUT` at **5 GB**, half the required maximum, and a one-shot `PUT` has no resumption point — a failure at 9GB restarts from zero. It is not carried forward.

**Recommendation:** **Option A (presigned multipart, direct to store)** — It is the only option where 10GB never enters the API container, which is precisely what "sem impacto na performance" asks for, and it satisfies the resume requirement through `ListParts` without adopting a second protocol. The frontend cost that normally argues against it is largely neutralized because `@uppy/aws-s3@6`'s signing hooks correspond one-for-one to the endpoints the API must expose anyway. Option C is the stronger *protocol* and the better choice if the client cannot be Uppy or if uploads must resume across changing storage backends — but it puts the byte stream back through a Node process, which is the problem being solved.

**Decision:** **Option A**

---

## TD-05: Draft Pre-Registration and Upload State

**Context:** The phase requires *"Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"*. The draft must exist before any bytes are sent, so the upload can be attributed to a channel and the user sees the video in their panel while it uploads. The open question is where the in-flight upload state (`uploadId`, storage key, parts progress) lives. *Depends on TD-04.*

**Options:**

### Option A: Draft row on `videos`, upload state as columns
`POST /videos` creates the video in `draft` status owned by the authenticated user's channel and returns its id plus the upload credentials. `storageKey`, `uploadId`, and a status enum (`draft` → `uploading` → `processing` → `ready` / `failed`) live on the video row.

- **Pros:** One entity, one lifecycle — the status enum is needed anyway for Phase 04's draft→publish flow and Phase 03's `processing`/`failed` states from TD-03. No join to answer "what is this video doing?". Simplest ownership check on every signing request.
- **Cons:** Mixes transport concerns (`uploadId`) into the domain entity. Only models one file per video — a re-upload must either reuse the row or orphan the previous object.

### Option B: Separate `upload_sessions` entity referencing the video
`POST /videos` creates the draft; a companion `upload_sessions` row holds `uploadId`, key, part size, expiry, and session status, linked by FK.

- **Pros:** Keeps transport state out of the video entity, aligning with the project's single-responsibility principle. Naturally supports retries, replacement uploads, and multiple objects per video (source file, custom thumbnail). Expired sessions are cleanable without touching video rows.
- **Cons:** A second table, migration, and repository for state that is short-lived and one-to-one in practice. Every signing request joins to resolve ownership. More moving parts than Phase 03 needs today.

### Option C: No pre-registration — create the video only on completion
The client uploads to a temporary key, then `POST /videos` creates the record.

- **Pros:** No orphan draft rows from abandoned uploads. Video records are always backed by a real file.
- **Cons:** Directly contradicts the phase's stated capability. The user sees nothing in their panel during a multi-hour upload. Uploads cannot be attributed or quota-checked before bytes are spent.

**Recommendation:** **Option A** — The status enum it introduces is required regardless (TD-03's terminal `failed` state, Phase 04's draft→publish flow), so the marginal cost of two extra columns is near zero, and it keeps the ownership check that guards every part-signing request a single-row read. Option B is the right call the moment a video can have more than one uploadable object or a replaceable source file; because both designs expose the same HTTP contract, extracting `upload_sessions` later is an internal refactor, not a breaking change.

**Decision:** **Option A**

---

## TD-06: Upload Completion Trigger

**Context:** With TD-04 Option A the API does not observe the byte stream, so something must tell it the upload finished in order to run `CompleteMultipartUpload`, flip the video to `processing`, and enqueue the BullMQ job decided in TD-01. A client that closes its tab after the last part must not leave a video stuck in `uploading` forever. *Depends on TD-01 and TD-04.*

**Options:**

### Option A: Client-driven completion endpoint
The client calls `POST /videos/:id/complete` with the collected part ETags. The API runs `CompleteMultipartUpload`, updates the status, and enqueues the processing job in the same request.

- **Pros:** Explicit, synchronous contract — the client gets a definitive success or failure. Completion and enqueueing share one transaction boundary. Nothing new is exposed publicly; the existing JWT guard protects it.
- **Cons:** A client that dies after uploading its last part leaves the video in `uploading` and the multipart upload unassembled indefinitely. Recovery depends entirely on the client retrying.

### Option B: Storage event notification
MinIO/S3 publishes `s3:ObjectCreated:CompleteMultipartUpload` to a webhook endpoint on the API, which resolves the key to a video and enqueues the job.

- **Pros:** Fires from the storage layer, so it is immune to a client disappearing. Same mechanism works for any future object type. MinIO supports webhook targets natively (alongside Redis, PostgreSQL, AMQP, Kafka).
- **Cons:** Requires a publicly reachable, separately authenticated webhook endpoint outside the JWT scheme. MinIO notifications are asynchronous by default (`MINIO_API_SYNC_EVENTS` changes this), so delivery is best-effort and needs idempotency. The client still has to call `CompleteMultipartUpload` for the event to fire at all — so it does not by itself rescue a client that quits mid-way. Couples the API to storage-vendor event configuration.

### Option C: Client-driven completion plus a reconciliation sweep
Option A as the primary path, with a scheduled job that periodically lists videos stuck in `uploading` past a threshold, checks the store with `ListParts`, and then either completes-and-enqueues or aborts the multipart upload.

- **Pros:** Keeps Option A's clean synchronous contract while closing its orphan hole. Reclaims storage from abandoned multipart uploads, which otherwise accrue cost silently. Needs no new infrastructure — BullMQ's job schedulers (TD-01) already provide repeatable jobs, and the worker container (TD-02) already runs them.
- **Cons:** One more scheduled job to write and reason about. Reconciliation is eventually-consistent — a stuck video is resolved on the next sweep, not instantly. Requires a defensible staleness threshold.

**Recommendation:** **Option C** — Option A alone is the right primary path but leaves two real leaks (videos pinned in `uploading`, and abandoned multipart parts billed indefinitely), and Option B does not actually close them since the storage event only fires after a completion the client failed to request. The sweep costs one repeatable job on infrastructure TD-01 and TD-02 already put in place, which is a small price for making "stuck upload" a self-healing state rather than a support ticket.

**Decision:** **Option C**

---

## TD-07: S3 Client Library

**Context:** TD-04 requires presigning individual multipart part URLs and orchestrating create/complete/abort/list from NestJS. The store is MinIO locally and S3-compatible in production (the service choice itself is still open), so the client must work against both. *Depends on TD-04.*

**Options:**

### Option A: AWS SDK v3 — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
Official modular AWS SDK (`3.1127.0`, Node ≥ 20). Talks to MinIO by setting a custom `endpoint` and `forcePathStyle: true`. `getSignedUrl(client, new UploadPartCommand(...))` presigns individual parts, with `signableHeaders` / `unhoistableHeaders` when headers must be covered by the signature.

- **Pros:** Vendor-neutral — identical code against MinIO and real S3, with only endpoint config differing, so the still-open storage decision stays reversible. Command-per-operation model covers the full multipart surface. `@aws-sdk/lib-storage` is available from the same family if server-side streaming is ever needed (thumbnails, TD-04 Option B fallback). Largest ecosystem and documentation base.
- **Cons:** Modular packages mean several dependencies for one feature. Presigning nuances (path-style addressing, header hoisting, clock skew) need care. Heavier install than a single-purpose client.

### Option B: MinIO JavaScript SDK — `minio`
Official MinIO client (`8.0.7`), a single package with a simpler API (`presignedPutObject`, `presignedUrl`) and S3 compatibility for AWS endpoints.

- **Pros:** One dependency, terser API, first-class MinIO behavior and admin/notification helpers. Less configuration to talk to a self-hosted store.
- **Cons:** Its ergonomic surface centers on whole-object presigning; per-part multipart signing is less directly supported than in the AWS SDK, which is exactly what TD-04 Option A needs. Optimized for MinIO first, so migrating to managed S3 later means re-verifying behavior. Smaller ecosystem. A NestJS wrapper (`nestjs-minio-client@2.2.0`) exists but is a thin third-party layer with its own maintenance risk.

**Recommendation:** **Option A (AWS SDK v3)** — The deciding factor is that TD-04 Option A needs *per-part* presigning, which the AWS SDK expresses directly as `getSignedUrl` over an `UploadPartCommand`, while the MinIO SDK's presigning surface is oriented at whole objects. It also keeps the unresolved MinIO-vs-managed-S3 question genuinely reversible, since only the endpoint configuration changes. If TD-04 lands on Option B or C instead, the two libraries are much closer and this decision loses most of its weight.

**Decision:** **Option A**

---

## TD-08: Worker Process Bootstrap Mode

**Context:** TD-02 placed the video worker in its own container sharing the API codebase, and TD-01 chose BullMQ, whose workers are registered by `@nestjs/bullmq` during module initialization. What remains open is *how* that container's Node process boots: a NestJS process can start as a full HTTP application, as a standalone IoC context with no listeners, or as a Nest microservice bound to a transport. This also determines how the container answers a Docker health check. *Depends on TD-01 and TD-02.*

**Options:**

### Option A: Standalone context — `NestFactory.createApplicationContext()`
A `main.worker.ts` entrypoint instantiates the IoC container without any network listener, importing only the modules the worker needs. BullMQ workers start on module init and `app.close()` drives the shutdown hooks that drain in-flight jobs.

- **Pros:** Smallest surface — no HTTP server, port, or exposed routes on a container that serves no requests. The documented NestJS pattern for CRON jobs, CLI tools, and non-web contexts. DI, config namespaces, and TypeORM repositories all work normally.
- **Cons:** No HTTP means no `/health` endpoint — the Compose health check must be a `CMD`-based probe (a small script asserting the process and Redis connection) rather than an HTTP probe. NestJS states that HTTP-related features — middleware, interceptors, pipes, guards — are unavailable in this context, so any code assuming them must not be imported.

### Option B: Full HTTP application serving only operational routes
`NestFactory.create()` boots a normal HTTP app that registers the processors and exposes health/readiness (and later metrics), while serving none of the business controllers.

- **Pros:** Standard HTTP health and readiness probes work with any orchestrator. A natural home for queue metrics and a future Bull Board dashboard. Identical bootstrap shape to the API, so one mental model for both containers.
- **Cons:** Runs a web server on a container that exists to consume a queue — a port, and a surface, that must be secured and kept internal. Care needed to ensure business controllers are not transitively imported and accidentally exposed. More startup weight for functionality the phase does not require.

### Option C: Nest microservice — `NestFactory.createMicroservice()`
The worker boots as a Nest microservice bound to a transport, consuming messages through `@MessagePattern` handlers.

- **Pros:** First-class NestJS abstraction for non-HTTP consumers, with its own lifecycle and exception layer.
- **Cons:** Conflicts with TD-01 — Nest's transports do not include BullMQ, so the microservice layer would sit alongside the BullMQ worker doing nothing, or force replacing BullMQ with a transport that lacks its retry/backoff/progress semantics. Adds `@nestjs/microservices` and a second messaging concept for no gain.

**Recommendation:** **Option A (standalone context)** — It is the pattern NestJS documents for exactly this case, and it keeps a queue consumer from running a web server it has no use for. The one real cost is the health probe, and Docker Compose's `CMD`-form health check covers that without HTTP. Option C is effectively excluded by TD-01. If operational HTTP endpoints (metrics, Bull Board) are wanted later, moving to Option B changes only the bootstrap file — the modules and processors are untouched.

**Decision:** **Option A**

---

## TD-09: FFmpeg Binary Provisioning

**Context:** The phase requires extracting duration and metadata and generating a thumbnail — the first needs **ffprobe**, the second **ffmpeg**. Neither ships with Node, so the worker image (TD-02) must provide both. The base image is `node:25.6.0-slim`, which is **Debian 12 (bookworm)**. *Depends on TD-02.*

**Options:**

### Option A: Distro package via `apt-get install ffmpeg`
One `RUN` line in the worker Dockerfile. Debian bookworm currently offers `7:5.1.9-0+deb12u1`, and the package provides **both** `ffmpeg` and `ffprobe`.

- **Pros:** Both binaries from one command, on the `PATH`, no npm postinstall download. Security patches come from Debian's stream (`bookworm-security`), which matters for a tool parsing untrusted user-uploaded media. Same mechanism already used in `Dockerfile.dev` for `procps`/`curl`. Nothing to vendor or pin beyond the base image.
- **Cons:** FFmpeg 5.1, older than the latest release. The exact version is tied to the Debian release, so a base-image bump can move it. Adds build-time apt layers and image size.

### Option B: npm packages — `ffmpeg-static` (+ a separate ffprobe package)
`ffmpeg-static@5.3.0` downloads a prebuilt FFmpeg binary on install (currently 6.1.1) and exports its path.

- **Pros:** Version travels with `package.json`/lockfile, so builds are reproducible and independent of the base image. Newer FFmpeg than bookworm. No apt layer.
- **Cons:** **Ships `ffmpeg` only — there is no `ffprobe`** (verified: the package declares no `bin` and exports a single path), so metadata extraction needs a second package, and the candidates are stale: `@ffprobe-installer/ffprobe` last published 2023, `ffprobe-static` 2022. Security patches depend on the packager re-releasing, not on a distro stream. A postinstall network download inside a Docker build is a fragile, cache-unfriendly step.

### Option C: Multi-stage copy from a dedicated FFmpeg image
Pin an upstream FFmpeg image and `COPY --from=` the binaries into the worker image.

- **Pros:** Exact, reproducible, arbitrarily recent FFmpeg, decoupled from both the Debian release and npm. Common practice for media workloads.
- **Cons:** More Dockerfile machinery and a second image to track and update. Shared-library compatibility must be verified against the slim base (or a static build used). Overhead beyond what probing and single-frame extraction need.

**Recommendation:** **Option A (`apt-get install ffmpeg`)** — The deciding fact is that this phase needs *ffprobe as much as ffmpeg*, and Option A is the only one that delivers both from a single maintained source; Option B's headline appeal collapses once a stale, separately-maintained ffprobe package has to be bolted on. FFmpeg 5.1 is amply sufficient for reading container metadata and extracting one frame, and having a distro security stream behind a binary that parses untrusted uploads is worth more here than being two minor versions newer.

**Decision:** **Option A**

---

## TD-10: FFmpeg/ffprobe Invocation from Node

**Context:** The worker needs two invocations: ffprobe emitting machine-readable metadata (`-of json` with `-show_format` / `-show_streams`, whose output is explicitly "designed to be easily parsable"), and ffmpeg extracting a single frame. This decision picks the Node-side interface. *Depends on TD-09.*

**Options:**

### Option A: `child_process.spawn` wrapped in a small injectable service
A thin NestJS service builds the argument array, spawns the binary, collects stdout/stderr, and resolves or rejects on exit code — wrapped so tests can substitute a fake.

- **Pros:** No dependency to inherit or outlive. Full control of arguments, timeouts, cancellation (`kill` on job abort), and stderr streaming for progress reporting into BullMQ. Argument arrays avoid shell interpolation on user-controlled values. The wrapper is small: this phase makes two distinct calls.
- **Cons:** Argument construction is hand-written, so FFmpeg flag semantics must be understood rather than abstracted. No built-in helpers for progress parsing or format discovery. Slightly more code than a fluent builder.

### Option B: `fluent-ffmpeg`
The long-standing fluent wrapper (`ffmpeg().input(...).screenshots(...)`) with `ffprobe()` helpers.

- **Pros:** Expressive chainable API, `screenshots()` covers thumbnail generation in a few lines, and `@types/fluent-ffmpeg` is current (2.1.28, Oct 2025). Enormous body of examples.
- **Cons:** **Deprecated and archived.** npm marks `fluent-ffmpeg@2.1.3` "Package no longer supported"; the repository was archived read-only on 2025-05-22 and accepts no issues or PRs. No bug fixes and **no security patches** for a component processing untrusted user media, and the maintainers note it no longer works properly with recent FFmpeg versions. The alternatives it pointed to are also archived.

### Option C: `@ts-ffmpeg/fluent-ffmpeg` (maintained fork)
A TypeScript fork of fluent-ffmpeg (`2.2.6`, Aug 2025) carrying the same API with bundled types.

- **Pros:** Keeps fluent-ffmpeg's ergonomics and existing examples while being actively published. Native TypeScript types, no `@types` companion needed.
- **Cons:** Community fork with a small maintainer base and low adoption — the same single-point-of-failure risk that just materialized upstream, minus the ecosystem that softened it. Inherits the original's architecture and accumulated behaviors. Little independent documentation.

**Recommendation:** **Option A (`spawn` + thin service)** — Option B is disqualified on its own terms: an archived, security-patch-free dependency sitting directly in the path of untrusted user uploads is not an acceptable trade for syntactic convenience, and Option C asks the project to bet on one volunteer fork of the package that just died. The wrapper being replaced is genuinely small here — two invocations — and writing it directly buys precise control over timeouts and cancellation, which the long-running jobs of TD-03 need anyway.

**Decision:** **Option A**

---

## TD-11: Source File Access for Processing

**Context:** The source object can be 10GB and lives in the object store, not on the worker's disk. How FFmpeg reads it decides the worker's disk footprint, how long a job takes to start, and how much data crosses the network per job. FFmpeg's `http`/`https` protocol supports seeking through HTTP Range requests, with `seekable`, `reconnect`, and `multiple_requests` controlling the behavior. *Depends on TD-04 and TD-07.*

**Options:**

### Option A: Download the whole object to local disk, then process
The worker `GET`s the object to a temp file, runs ffprobe and ffmpeg against it, then deletes it.

- **Pros:** Simplest and most predictable — local file I/O, fully seekable, no dependency on network behavior mid-encode. Trivially debuggable; the file can be inspected on failure. Immune to presigned URL expiry during a long job.
- **Cons:** Requires up to 10GB of ephemeral disk **per concurrent job**, forcing volume sizing and cleanup-on-crash handling. Transfers the entire object even though probing plus one frame needs a tiny fraction of it. The full download completes before any work starts, inflating job duration and retry cost under TD-03.

### Option B: FFmpeg reads a presigned HTTPS URL directly
The worker generates a short-lived presigned `GET` (TD-07's signer) and passes the URL as the FFmpeg/ffprobe input; the HTTP protocol issues Range requests to seek.

- **Pros:** Fetches only the byte ranges actually needed — the container header, plus the neighborhood of the target frame — instead of 10GB. Near-zero worker disk usage, so concurrency is bounded by CPU rather than storage. Jobs start immediately. `reconnect` options make transient network faults recoverable inside FFmpeg, below TD-03's retry layer.
- **Cons:** Reading is coupled to store reachability and to the presigned URL outliving the job. An MP4 whose `moov` atom sits at the end forces a tail read before decoding — still megabytes, not gigabytes, but it makes cost format-dependent. Harder to reason about and to reproduce locally than a plain file.

### Option C: Stream the object into FFmpeg's stdin
The worker pipes the S3 response body straight into the process.

- **Pros:** No temp file and no presigned URL — the worker's existing S3 client does the reading.
- **Cons:** A pipe is **not seekable**, so `-ss` cannot jump to a timestamp and FFmpeg must decode forward from the start — the entire 10GB streams through for one frame, the worst outcome of the three. Formats needing a trailing atom may fail outright. No resumption after a mid-stream failure.

**Recommendation:** **Option B (presigned URL as FFmpeg input)** — Probing metadata and grabbing one frame are inherently sparse reads, and Option B is the only option that makes the transfer proportional to that instead of to file size; on a 10GB source it is the difference between megabytes and the whole object, and it removes per-job disk sizing entirely. Option C is excluded by seekability. Option A remains the honest fallback if presigned-URL lifetime or store reachability from the worker turns out to be awkward in deployment — and because both feed FFmpeg an input string, the switch is one line in the worker.

**Decision:** **Option B**

---

## TD-12: Thumbnail Frame Selection Policy

**Context:** The phase requires *"Geração automática de thumbnail a partir de um frame do vídeo"* without saying which frame. A poor rule produces black or slate frames on a large share of uploads. The video's duration is already known from the ffprobe step, so it can inform the choice. Phase 04 later lets users override with a custom thumbnail, so this is the default, not the final word. *Depends on TD-10 and TD-11.*

**Options:**

### Option A: Percentage-based offset (e.g. 10% of duration)
Seek to a fraction of the duration reported by ffprobe and extract one frame.

- **Pros:** Scales across the whole catalogue — it clears intros on a two-hour video and still lands mid-content on a 30-second clip, which a fixed timestamp cannot do. Uses duration the worker already has. Input seeking makes it a single jump, so under TD-11 Option B it costs roughly one Range request. Deterministic and trivially testable.
- **Cons:** No content awareness — it can still land on a fade, a transition, or a dark frame. A single sample means no fallback when that happens.

### Option B: FFmpeg `thumbnail` filter over a window
The `thumbnail` filter analyses a batch of frames and outputs the most representative one, avoiding the blandest candidates.

- **Pros:** Content-aware, so it dodges black frames and transitions that Options A and C hit by chance. Produces visibly better covers on average. Built into FFmpeg — no extra dependency.
- **Cons:** Must decode a window of frames rather than one, costing CPU and, under TD-11 Option B, a larger contiguous read. Selection is a heuristic, so results are less predictable and harder to assert in tests. Cost scales with the window size chosen.

### Option C: Fixed absolute timestamp (e.g. 3 seconds)
Always seek to the same offset.

- **Pros:** Simplest possible rule; needs no duration lookup and behaves identically for every file.
- **Cons:** Systematically wrong at the extremes — it lands in the intro or on a title card for long videos, and past the end for clips shorter than the offset, which needs its own fallback. Ignores information the worker already has.

**Recommendation:** **Option A (percentage-based offset)** — It is the only option that adapts to a catalogue holding both short clips and long videos while costing a single seek, and it reuses the duration the metadata step already produced. Option B yields better frames and is the natural upgrade once real uploads show how often A lands on a bad frame; because both are the same single ffmpeg invocation with different arguments, that change carries no structural cost. Output format and dimensions are left to `plan-phase`, which should also decide whether a failed thumbnail is fatal to the job or leaves the video `ready` with a placeholder.

**Decision:** **Option A**

---

## TD-13: Public Video Identifier (Unique URL)

**Context:** The phase requires *"URL única por vídeo, sem conflito com outros vídeos"*, and the plan's Pontos de Atenção sharpen it to *"uma URL curta e única que nunca conflite com outro vídeo"*. This identifier appears in every watch link and is the lookup key for the playback and download routes below. It also carries a security role: Phase 04 introduces **unlisted** videos, reachable *"somente via link"*, so the identifier is the only thing standing between an unlisted video and someone enumerating URLs. Existing entities use `@PrimaryGeneratedColumn('uuid')` (UUIDv4 via `uuid_generate_v4()`); that stays the internal PK regardless of what goes in the URL. *Feeds TD-14 and TD-16.*

**Options:**

### Option A: Random opaque `public_id` column, separate from the primary key
A short URL-safe random string — 12 characters of base64url ≈ 72 bits — stored in a `UNIQUE` column on `videos` and generated when the draft row is created (TD-05). Public routes resolve `/videos/:publicId`; the UUID PK stays internal.

- **Pros:** Short, and unguessable enough that enumeration is not a threat, which is precisely what Phase 04's unlisted visibility needs. The `UNIQUE` constraint makes "never conflicts" a database guarantee with a retry on the (astronomically rare) violation — at 72 bits the birthday probability across a million videos is ~1 in 10 billion. Decoupled from the PK, so internal keys can change without breaking published links. Generated from `node:crypto` (`randomBytes(9).toString('base64url')`) — no new dependency.
- **Cons:** One extra indexed column, and every public lookup resolves through it instead of the PK. Needs an explicit collision-retry path even though it will never fire. The value carries no ordering or meaning, so it is useless for sorting and opaque when debugging.

### Option B: Expose the UUID primary key
Put the existing UUIDv4 PK straight in the URL: `/videos/9f8e3c1a-....`

- **Pros:** Nothing to add — no column, no generator, no collision handling, uniqueness already guaranteed by the PK. One key for internal and public use. UUIDv4 is random, so unlisted videos are still unenumerable.
- **Cons:** 36 characters is the opposite of the "URL curta" the plan asks for. Publishes the internal identifier in every link, so the PK is frozen forever by URLs already in the wild. Reveals the entity's identifier surface to clients for no benefit.

### Option C: Sqids/Hashids encoding of a sequential counter
Add a `bigint` sequence to `videos` and encode it into a short string at read time (`sqids@0.3.0`, `hashids@2.3.0`), decoding on lookup.

- **Pros:** The shortest IDs of any option (4–6 characters early on) and no stored value beyond the sequence. Collision-free by construction, since the encoding is a bijection rather than a draw.
- **Cons:** It is an encoding, not a secret — Sqids' own FAQ states the IDs are decodable and must not be treated as a security mechanism. Sequential input means a valid ID reveals its neighbours, which defeats Phase 04's unlisted requirement and leaks the platform's total upload count. Adds a dependency plus a decode step on every request, and an alphabet/blocklist configuration to get right.

### Option D: Title slug plus a short suffix
`/videos/minhas-ferias-2026-x7Kq2p`.

- **Pros:** Human-readable and SEO-friendly; the random suffix keeps identical titles from colliding.
- **Cons:** TD-05 creates the draft *before* a title exists, so there is nothing to slugify at generation time. Titles are editable in Phase 04, so the slug either rots or freezes and drifts from the displayed title. Requires accent/punctuation normalization, length capping and a reserved-word list. Solves an SEO problem the phase never states.

**Recommendation:** **Option A** — it is the only option that satisfies both halves of the requirement at once: short enough to be a real watch URL, and random enough that Phase 04's unlisted videos are genuinely unreachable without the link, which Option C explicitly cannot promise and Option B pays 36 characters for. Generate it with `node:crypto` rather than a library: `nanoid@6.0.1` is ESM-only and declares `engines: ^22 || ^24 || >=26`, which excludes the Node 25 runtime this project pins, and pulling ESM into the CommonJS Jest setup is avoidable friction for what is one line of stdlib (`nanoid@3.3.18` still ships a CJS entry point if a library is ever preferred). Option D stays available later as an additive `/videos/:slug-:publicId` form that ignores everything but the id, so choosing A now does not close the SEO door.

**Decision:** **Option A**

---

## TD-14: Playback Delivery Path — who answers the Range request

**Context:** The phase requires *"Reprodução via streaming (sem necessidade de download completo)"*. Concretely: the origin serving the video must advertise `Accept-Ranges: bytes` and answer a player's `Range: bytes=…` with **`206 Partial Content`** plus `Content-Range`, so `<video>` starts on the first bytes and seeks without fetching the file. Every option below produces 206s — they differ in *who* emits them. TD-04 already established the principle that 10GB of video never transits the API container; this decision is where that principle is either upheld or abandoned on the read path, which carries far more concurrency than uploads. *Depends on TD-07 and TD-13.*

**Options:**

### Option A: API proxies the bytes, translating Range to S3
`GET /videos/:publicId/stream` parses the incoming `Range`, issues `GetObjectCommand` with the same `Range` (the SDK maps the input field to the HTTP header), then sets `206`, `Content-Range` and `Accept-Ranges` and returns a `StreamableFile` wrapping the S3 body.

- **Pros:** Single origin — no CORS, no store exposure to the browser, no signature lifetime to manage. Visibility rules (public/unlisted, Phase 04) and view counting are enforced on the very request that serves the bytes. Storage credentials never leave the API.
- **Cons:** Every concurrent viewer holds an API connection for the length of the video and every byte is paid twice (store → API → client) — the cost TD-04 refused for uploads, now on the busier path. `StreamableFile` handles `type`/`disposition`/`length` but has **no Range support**, so range parsing, `Content-Range` and the `416` case are hand-written. Seeking produces bursts of small ranges, each a fresh S3 round trip. Backpressure and aborted-request cleanup become the API's problem.

### Option B: API issues a presigned GET; the store serves the bytes
`GET /videos/:publicId/playback` returns the video's metadata plus a presigned URL and its expiry; `<video src>` points at that URL. S3 and MinIO natively advertise `Accept-Ranges: bytes` and answer Range with 206.

- **Pros:** Zero bytes through the API, consistent with TD-04 and TD-11, so the read path scales with the store rather than the Node process. Range semantics are the store's and are already correct for every player. Critically, the signature covers only headers present on the command — the presigner adds just `content-type` to the unsignable set and never signs an absent `Range` — so the player may range-request freely against the same URL. Reuses the TD-07 signer and the browser-facing store endpoint and CORS config that TD-04 Option A already requires.
- **Cons:** Exposes the store's public endpoint, and the URL is shareable until it expires (hotlinking), bounded but not eliminated by TTL (TD-15). Playback must survive expiry mid-video (TD-15). Because bytes bypass the API, Phase 05's view count becomes an explicit client call instead of a side effect of serving. CORS must expose `Content-Range`/`Accept-Ranges` to the page.

### Option C: Stable API route that 302-redirects to a freshly signed URL
`GET /videos/:publicId/stream` responds `302` to a URL signed on the spot, so the public link itself never contains a signature.

- **Pros:** A stable, signature-free, shareable URL that can go directly in `<video src>`, with the API re-authorizing on every request and no expiry embedded in what the user copies.
- **Cons:** Browsers treat **cross-origin redirected range requests from media elements inconsistently** — Chromium restricts responses to ranges whose origin differs from the initial response's origin, and 302-related playback bugs are long-standing in players. The redirect may be re-followed on every seek, adding a round trip and a signing call per range. Two hops to debug, for little gain over Option B.

### Option D: Public-read bucket with permanent object URLs
Objects are world-readable at a stable URL under a random key; the API just returns it.

- **Pros:** Simplest read path there is, trivially cacheable and CDN-ready, with no signing, expiry or refresh logic anywhere.
- **Cons:** No revocation — deleting the video row does not stop playback until the object itself is deleted. Unlisted semantics collapse into key obscurity with no time bound. One misconfigured prefix exposes the whole bucket, including in-flight uploads. Any future private or paid content becomes a migration rather than a config change.

**Recommendation:** **Option B (presigned GET, store serves the 206)** — it is the only option that gets correct Range/206 behaviour for free *and* keeps the read path off the API, which matters more here than on upload because every viewer is a concurrent streamer. It also reuses machinery TD-04 and TD-07 already put in place: the same signer, the same browser-reachable store endpoint, the same CORS policy. Option A remains the honest fallback if the store cannot be exposed to browsers in the target deployment — the API contract is unchanged, only the response body differs — but it should be adopted knowingly, since it puts every watched byte back through Node.

**Decision:** **Option B**

---

## TD-15: Playback URL Lifetime and Refresh

**Context:** With TD-14 Option B, the playback grant is a signature with an expiry (SigV4 allows up to 7 days from an SDK; the S3 console caps its own at 12 hours). The player reuses the *same* URL for every range request, so a viewer who pauses a two-hour video and then seeks hits a `403` mid-playback rather than a clean error. This decision sets how long the grant lives and who refreshes it. *Depends on TD-14.*

**Options:**

### Option A: Short TTL (~15 min) with player-side refresh on failure
The signer uses a small expiry; the frontend detects the failed range request, fetches a new URL and swaps `src`.

- **Pros:** Narrow sharing window — a leaked URL dies within minutes, which is the strongest posture of the three against hotlinking.
- **Cons:** Any pause or seek past the TTL breaks playback unless the frontend handles it, and doing that well means restoring the current time and re-buffering after a `src` swap. Real client complexity for a link that is still shareable within its window.

### Option B: TTL sized to exceed a viewing session (6–12h), issued per page load
One presigned URL per watch-page load, valid well past the longest plausible session.

- **Pros:** Playback simply never expires in practice — pausing, seeking and resuming all behave, with no refresh logic in the player. The API still gates *issuance*, so an unpublished, deleted or newly-restricted video stops handing out URLs immediately.
- **Cons:** A copied URL works for hours for anyone who has it. Revocation inside that window requires deleting or renaming the object, not just a DB change.

### Option C: Long TTL plus a proactive refresh endpoint
Option B's lifetime, with the frontend re-requesting the URL shortly before it expires rather than reacting to a failure.

- **Pros:** Smooth playback like B while keeping the window bounded, and refresh happens on a timer instead of in an error path.
- **Cons:** More moving parts on both sides for a marginal gain, given the content is publicly watchable by design.

**Recommendation:** **Option B** — the platform's premise is *"Acesso anônimo: qualquer pessoa pode assistir vídeos sem cadastro"*, so the presigned URL is not guarding a secret; its job is to keep the bucket from being open and to keep issuance under API control, and unlisted visibility (Phase 04) is enforced at issuance time by refusing to sign for a video the requester should not reach. Sizing the TTL above the longest plausible session removes an entire class of mid-playback failures that Option A trades real client complexity to create. Return the expiry alongside the URL so the frontend can adopt Option C later without an API change.

**Decision:** **Option B**

---

## TD-16: Direct Download Route

**Context:** The phase requires *"Download do vídeo pelo usuário"*, surfaced in Phase 05 as a download button. It differs from playback in exactly one respect: the response must arrive as a file save under a sensible name — `Content-Disposition: attachment; filename="…"` — instead of rendering inline. The storage key is opaque (TD-05), so the user-facing filename has to be supplied at request time. *Depends on TD-13 and TD-14.*

**Options:**

### Option A: Presigned GET with the `ResponseContentDisposition` override
`GET /videos/:publicId/download` signs a `GetObjectCommand` carrying `ResponseContentDisposition: 'attachment; filename="…"'`, which the SDK serializes as the `response-content-disposition` query parameter covered by the signature. S3 and MinIO both honour the response-header override parameters.

- **Pros:** Same path, client and cost profile as TD-14 Option B — a 10GB download never touches the API. Resumable for free, since the store answers Range on the download URL too. The filename is derived by the API from the video title, independent of the storage key. Implementation is the playback signer plus one parameter.
- **Cons:** A second endpoint and a second signature to reason about. Non-ASCII filenames need RFC 5987 encoding and have a history of producing `SignatureDoesNotMatch` on MinIO when quoting or spacing differs, so the name must be conservatively sanitized. Inherits TD-15's lifetime question, though a download URL can safely use a much shorter TTL.

### Option B: API-proxied download with `StreamableFile`
The API pipes the S3 body through, using `StreamableFile`'s documented `disposition` and `type` options.

- **Pros:** One origin, no signature, no CORS, and complete control over headers, authorization and any download counting. The disposition is exactly what `StreamableFile` is designed to set.
- **Cons:** Pushes a full 10GB per download through the API — worse than the playback case, because a download reads the object end to end by definition. Resumption must be hand-built (Range → S3 Range → 206) or an interrupted download restarts from zero. Concurrent downloads consume API sockets and bandwidth linearly.

### Option C: Reuse the playback URL with the HTML `download` attribute
The frontend renders `<a href={playbackUrl} download>`.

- **Pros:** No new endpoint or signer at all.
- **Cons:** The `download` attribute is **ignored for cross-origin URLs** — the browser navigates to the store and plays the video inline instead of saving it, which is exactly the situation TD-14 Option B creates. Even where it worked, the saved file would be named after the opaque storage key.

**Recommendation:** **Option A** — it is TD-14's signer with one added parameter, it keeps a 10GB transfer entirely off the API on the one route guaranteed to move the whole file, and it is the only option that can name the downloaded file after the video's title. Sanitize the filename to ASCII and keep the download TTL short, since a download URL is consumed immediately rather than held open for a session. Option B is the fallback if the store's response-header override behaves inconsistently in the chosen deployment; Option C does not work cross-origin and is not carried forward.

**Decision:** **Option A**

---

## TD-17: MP4 Index (`moov`) Placement Normalization

**Context:** Progressive playback needs the MP4 index (`moov` atom) before decoding can start, and many encoders and recorders write it at the *end* of the file. Against a Range-capable origin (TD-14) the player recovers by range-requesting the tail first, at the cost of extra round trips before the first frame; against a non-Range origin it would fail outright. The worker from TD-08–TD-12 is the only component that could normalize this, and TD-11 deliberately chose never to read the whole object. This decides whether Phase 03 pays to guarantee fast starts. *Depends on TD-10, TD-11 and TD-14.*

**Options:**

### Option A: No normalization — rely on Range plus the player's tail read
Store the uploaded file as-is and let the player fetch the index wherever it sits.

- **Pros:** Costs nothing and preserves TD-11's sparse-read property — the worker still never pulls 10GB. Already optimal for the many sources that are written faststart for the web. The extra tail fetch is one additional range request against a store that serves ranges natively.
- **Cons:** A moov-at-end file pays one or two extra round trips before playback begins, and a large index makes that pre-roll fetch megabytes rather than kilobytes. Startup latency then varies by source file in a way nothing surfaces until users complain.

### Option B: Conditional remux when the index is at the end
The probe step detects moov placement; only then does the worker run `ffmpeg -i <src> -c copy -movflags +faststart <dst>` and replace the object.

- **Pros:** Guarantees a fast start for every video while paying only for the files that need it. It is a stream copy, not a re-encode, so quality and duration are untouched.
- **Cons:** A copy still reads and writes the **entire** object — 10GB down, 10GB up, plus temp disk — which is exactly the cost TD-11 Option B was chosen to avoid, and it stretches job duration and TD-03's retry cost by minutes. Replacing an object that a viewer may already be streaming needs care. Detection is cheap; the remediation is not.

### Option C: Always remux on ingest
Every upload is rewritten with `+faststart` regardless of its original layout.

- **Pros:** One uniform code path with predictable output, and a natural hook for future container normalization.
- **Cons:** Pays Option B's full cost on every upload, including the majority that already start fast. Doubles storage traffic per video for no gain in the common case.

**Recommendation:** **Option A for Phase 03** — the stated requirement is that playback begins without a full download, and Range plus a tail read already delivers that; Option B's cure contradicts TD-11's entire premise by pulling 10GB through the worker for a benefit measured in a few hundred milliseconds of startup. Record the moov placement as metadata during the probe the worker already runs, so the question can be reopened against real data rather than assumption — and if slow starts do turn out to be common, Option B is a self-contained addition to the existing job, not a redesign.

**Decision:** **Option A**

---

## TD-18: Bucket Topology for Videos and Thumbnails

**Context:** Phase 03 stores two very different asset classes: multi-gigabyte source videos, written once by presigned multipart (TD-04) and read back through presigned GETs (TD-14), and small thumbnails generated by the worker (TD-12) that are rendered *in bulk* — the channel panel (Phase 04), the watch sidebar (Phase 05) and the home grid (Phase 07) all display dozens at a time. Bucket boundaries matter because CORS, public-access policy and lifecycle configuration are all **per-bucket** documents, and because bucket count is not a scarce resource (S3's default quota is 10,000 general purpose buckets per account). This decision sets where each asset class lives; TD-19 sets the key shape inside it. *Depends on TD-14; feeds TD-20 and TD-21.*

**Options:**

### Option A: One bucket, separated by top-level prefix
A single bucket holds everything under `videos/…` and `thumbnails/…`. Public read for thumbnails, if wanted, comes from a prefix-scoped policy (`mc anonymous set download <bucket>/thumbnails/`, or a bucket policy over the prefix ARN on S3).

- **Pros:** One bucket to create, name, and configure; one endpoint and one env var. Lifecycle rules still discriminate by prefix, so nothing is lost there. Simplest possible local setup.
- **Cons:** One CORS document and one policy document must satisfy both access patterns at once, and a mistake in the thumbnail prefix policy exposes source videos sitting in the same bucket. Public and private objects share a blast radius for no gain. Bucket-wide metrics, quotas and any future replication cannot distinguish cheap thumbnails from expensive sources.

### Option B: Two buckets split by asset type and access policy
A private bucket for source videos (presigned access only, per TD-14) and a separate public-read bucket for thumbnails, served at stable unsigned URLs.

- **Pros:** The policies genuinely differ, so the boundary is real rather than cosmetic: sources stay private with no public-access path at all, and a thumbnail policy error cannot reach them. Stable thumbnail URLs are **browser- and CDN-cacheable**, where presigned URLs are not — a home grid of 20 videos would otherwise cost 20 signatures per page load and re-download every time, since the changing query string defeats the cache. CORS, lifecycle and quota are configured independently per class. Costs one extra bucket and one extra env var; the SDK client is per-endpoint (TD-07), so no second client.
- **Cons:** Two buckets to provision, name and keep in sync across environments. Public thumbnails cannot be revoked by policy — an unlisted video's thumbnail is fetchable by anyone holding the key, which is acceptable only because TD-19 derives keys from unguessable ids (the same guarantee unlisted visibility already rests on). Slightly more configuration surface in Compose and in `.env`.

### Option C: Two buckets split by lifecycle stage (staging → media)
In-flight uploads land in a short-lived staging bucket; after processing succeeds, the worker copies the object into a durable media bucket and the staging copy expires.

- **Pros:** Puts every abandoned upload in one bucket that can be aggressively expired, keeping the durable bucket clean by construction. Failed processing never leaves a half-adopted object among the good ones.
- **Cons:** Promoting a 10GB object is a **server-side multipart copy**, doubling storage traffic and cost per successful upload and adding minutes to a job that TD-11 deliberately designed to read almost nothing. The key changes at promotion, so any URL issued before it breaks. Solves a cleanliness problem that TD-20's expiry policy already solves without moving bytes.

**Recommendation:** **Option B** — the split is justified by a real policy difference rather than tidiness: thumbnails need cacheable, unsigned, high-fan-out reads and sources need private, signed, one-at-a-time reads, and putting them in one bucket forces a single CORS and access policy to straddle both. The decisive detail is caching — with everything presigned in one private bucket, every listing page re-signs and re-downloads every thumbnail, which Phase 07's home grid makes a permanent cost. Option C is the right shape for a pipeline that transcodes into new renditions; here it pays a full 10GB copy per upload for a guarantee TD-20 gives for free.

**Decision:** **Option B**

---

## TD-19: Object Key Convention

**Context:** Keys are effectively permanent: S3 has no rename, so changing one means copying the object — a 10GB operation for a source video. The key is also visible, since it appears in the path of every presigned playback and download URL (TD-14, TD-16), and it is the handle for deletion and for scoping `ListMultipartUploads` in the TD-06 sweep. The obsolete advice to randomize key prefixes for throughput does not apply: since 2018 S3 sustains at least 3,500 PUT/5,500 GET per second *per prefix* with no limit on prefix count, so structure can be chosen for clarity. *Depends on TD-13 and TD-18.*

**Options:**

### Option A: Video-scoped prefix keyed by the internal video id
`videos/{videoId}/source.mp4` in the private bucket and `videos/{videoId}/thumbnail.jpg` in the thumbnail bucket, where `{videoId}` is the internal UUID primary key.

- **Pros:** Everything belonging to a video shares one prefix, so deletion is a prefix listing and the TD-06 sweep can scope `ListMultipartUploads` by prefix. Naturally extensible to future artifacts (custom thumbnail in Phase 04, renditions later) without inventing a new scheme. Keyed by the internal id rather than TD-13's `public_id`, so a public identifier could be rotated — a leaked unlisted link, say — without touching a single byte in storage. Leaks nothing: no email, no nickname, no title.
- **Cons:** The key duplicates an identifier that also lives in the database, so the two can drift if a row is deleted without its objects (which is exactly what TD-20 must cover). Prefix listings tell you nothing about ownership or date without a database lookup. Requires a small convention document so future artifacts do not diverge.

### Option B: Channel-partitioned hierarchy
`channels/{channelId}/videos/{videoId}/source.mp4`.

- **Pros:** Storage mirrors the ownership model, so "everything for this channel" is one prefix — convenient for a future per-channel export, quota or bulk delete. Prefix-scoped IAM policies could later restrict access per channel.
- **Cons:** Encodes an ownership fact into an immutable key; if a video ever moves channels, or a channel merges, the key lies or 10GB gets copied. Must use the channel **UUID**, never the nickname, since Phase 04 makes the nickname editable — which removes most of the human readability that motivates the hierarchy. Adds a level whose queries PostgreSQL already answers better than a bucket listing.

### Option C: Date-partitioned prefix
`videos/2026/09/06/{videoId}/source.mp4`.

- **Pros:** Bounds the number of keys under any single prefix and makes bulk operations by ingest period straightforward — convenient for auditing or archival transitions to a colder storage class later.
- **Cons:** Freezes the upload date into the key, so it survives every later edit and disagrees with a republished video's real dates. Date partitioning exists to spread request load or to enable time-based lifecycle transitions, neither of which Phase 03 needs — S3 no longer requires prefix spreading, and lifecycle rules already filter by object age directly.

**Recommendation:** **Option A** — it is the only option whose key contains nothing that can later become false: no channel that might change, no date that will be superseded, no public identifier that might be rotated. The per-video prefix is what the operations actually need — delete a video's assets, scope a sweep, add an artifact — and Options B and C both add a hierarchy level whose questions the database answers better, at the cost of baking a mutable fact into an immutable key. Keep the source file's original extension for debuggability; the user-facing download name comes from `ResponseContentDisposition` (TD-16), not from the key.

**Decision:** **Option A**

---

## TD-20: Abandoned Multipart Upload Expiry Policy

**Context:** TD-04 leaves an open multipart upload for every started upload, and TD-06 already noted that abandoned ones "accrue cost silently" — parts that are billed as storage while remaining invisible to a normal object listing. TD-06 chose a reconciliation sweep as the completion backstop; this decision is about the *storage* backstop and how the two compose. Two findings constrain it sharply. First, **MinIO does not implement `AbortIncompleteMultipartUpload`**: the field is documented as "not supported yet on MinIO" in `minio-go`, and setting it has been reported to fail validation or silently vanish on export (issues #16120, #19115). Second, MinIO instead applies a **server-wide** cleanup — `api.stale_uploads_expiry`, default **24h**, swept every `stale_uploads_cleanup_interval` (default 6h) — which is not per-bucket, and at 24h is far shorter than the resumable window TD-04 promises. *Depends on TD-04, TD-06 and TD-18.*

**Options:**

### Option A: Bucket lifecycle rule only
Apply `AbortIncompleteMultipartUpload` with `DaysAfterInitiation: 7` (AWS's documented best practice) on the video bucket and rely on the store to reclaim parts.

- **Pros:** Zero application code, and it keeps working when the API and worker are down or have lost track of an upload entirely. Applies to uploads that already exist as well as future ones, and incurs no early-delete charge. On S3 it is one JSON document set once.
- **Cons:** **It is a no-op on MinIO**, so the local environment gets no coverage from it and behaviour diverges from production — the worst kind of difference to discover late. It only reclaims bytes: the video row stays pinned in `uploading` forever, which is the half TD-06 exists to fix. Evaluation is asynchronous and roughly daily, so "7 days" is a floor, not a deadline, and days are the finest granularity available.

### Option B: Reconciliation sweep only
Extend TD-06's scheduled job to abort, not just complete: list videos stuck in `uploading` past a threshold, check the store, then either complete-and-enqueue or `AbortMultipartUpload` and mark the row failed.

- **Pros:** The only mechanism that fixes **both** halves — storage *and* the database row — in one place, with one threshold to reason about instead of two. Fully portable: `ListMultipartUploads` (with `Prefix`, and `KeyMarker`/`UploadIdMarker` paging) and `AbortMultipartUpload` are plain S3 API calls that MinIO implements. Runs on infrastructure TD-01/TD-02 already provide, and the threshold can be minutes or hours rather than a whole day.
- **Cons:** Coverage depends entirely on the worker running — a queue outage or a broken schedule means parts accumulate unnoticed. An upload the database never recorded (a race, a rolled-back transaction) is invisible to a row-driven sweep unless it also lists the store directly.

### Option C: Sweep as primary, lifecycle rule as backstop
Option B at a short horizon driven by the video row, plus the 7-day `AbortIncompleteMultipartUpload` rule on any store that honours it, and an explicit `MINIO_API_STALE_UPLOADS_EXPIRY` raised to match the intended resumable window locally.

- **Pros:** Each mechanism covers the other's gap: the sweep resolves state promptly and handles rows, the lifecycle rule catches orphans no row points at and keeps working when the worker does not. Setting the MinIO expiry explicitly is what keeps a resumable upload from being silently destroyed at 24h — the default is *more* aggressive than the resume guarantee TD-04 made, and nothing in the application would report why the parts vanished.
- **Cons:** Two expiry horizons to keep consistent, expressed in two different places (application config and store config), and they must be ordered deliberately — the sweep's threshold below the store's, or the store deletes parts the sweep still expects to find. The lifecycle rule contributes nothing on MinIO, so the local and production safety nets are not identical however it is configured.

**Recommendation:** **Option C** — with the emphasis on the sweep, because it is the only portable mechanism and the only one that can unpin a video row, and with the lifecycle rule added as a cheap backstop wherever the store honours it. The finding that reframes this decision is that the store-side default is a *hazard*, not just an absent feature: MinIO's 24h `stale_uploads_expiry` will quietly abort a 10GB upload that a user intends to resume the next day, which reads to the user as data loss and to the application as an upload that simply stopped existing. Whatever resumable window Phase 03 commits to, it has to be set explicitly on the store and mirrored by the sweep's threshold — the AWS 7-day figure is a sane default for both, and `plan-phase` should fix the exact values and their ordering.

**Decision:** **Option C**

---

## TD-21: Bucket, Policy and Lifecycle Provisioning

**Context:** TD-18 through TD-20 produce configuration that has to exist before the first upload: buckets created, CORS allowing browser `PUT` and ranged `GET` from the frontend origin, anonymous read on the thumbnail bucket, and the multipart-abort lifecycle rule. In the Compose environment this must happen on a fresh `docker compose up` with no manual step, or Phase 03 is not reproducible. Note that `mc ilm rule add` exposes only expiry, transition and noncurrent-version flags — it has **no** flag for `AbortIncompleteMultipartUpload` — so that rule is applied through the S3 API or a lifecycle JSON document rather than the ordinary CLI path. *Depends on TD-18 and TD-20.*

**Options:**

### Option A: `minio/mc` init service in Compose
A one-shot Compose service depending on the store runs `mc mb --ignore-existing`, `mc anonymous set download`, `mc cors set` and the lifecycle configuration, then exits.

- **Pros:** Provisioning lives beside the service it configures, is idempotent, and requires no admin credentials inside the API or worker. `docker compose up` yields a working environment with no README step. Uses the store's own tooling, so MinIO-specific behaviour (anonymous prefix policies, CORS) is expressed natively.
- **Cons:** Only provisions the local environment — production still needs its own path, so the two can drift. `mc` is MinIO's client, so a move to managed S3 means rewriting this step. The one rule `mc` cannot express (TD-20's abort rule) needs a JSON document or an `aws s3api` call anyway, splitting the mechanism in two.

### Option B: Application bootstrap on startup
The API (or worker) ensures buckets, CORS and lifecycle on boot via `HeadBucket`/`CreateBucket`/`PutBucketCors`/`PutBucketLifecycleConfiguration` with the TD-07 client.

- **Pros:** One portable implementation covering every environment and both candidate stores, written in the language and config system the project already uses (`registerAs`, Joi). Configuration drift self-heals on deploy, and the abort rule is expressible directly — no CLI gap.
- **Cons:** Requires the runtime credentials to hold bucket-administration rights, which is a real and permanent privilege escalation for a service that otherwise only needs object read/write. Must run in exactly one process (TD-02 gives two) or become a startup race. Startup now fails on transient storage errors, coupling boot to the store's availability.

### Option C: Documented manual setup, infrastructure-as-code later
A README and a script; nothing runs automatically.

- **Pros:** No privileges granted, no startup coupling, and it is honest about production, where this belongs in IaC alongside the rest of the infrastructure.
- **Cons:** A fresh clone does not work until a human reads the document, which contradicts the Phase 01 goal of a Compose environment that just starts. Every drift is a support conversation.

**Recommendation:** **Option A for the Compose environment**, leaving production provisioning to whatever the still-open storage decision brings, and expressing the TD-20 abort rule as a lifecycle JSON document applied by the same init service so the one gap in `mc`'s flags does not become a manual step. It keeps bucket-admin credentials out of the API and worker — the strongest argument against Option B, and one that matters more here because TD-14 already puts the store's endpoint in front of browsers. If the storage decision later lands on managed S3 with IaC, this init service stays as the local-only path and the two are reconciled there rather than in application startup.

**Decision:** **Option A**

---

## TD-22: Accepted Upload Formats

**Context:** Raised by `plan-phase` validation (V-01): no document defines which video containers/codecs `POST /videos` accepts. Since TD-17 stores the file as-is (no remux/re-encode) and TD-04 means the API never inspects the bytes at upload time, any container the browser cannot decode natively would be processed, thumbnailed, and marked `ready` — then simply fail to play, with no error path.

**Decision:** **Option A** — Allowlist at `POST /videos` by declared `content_type` + extension: `video/mp4` (`.mp4`, `.m4v`), `video/webm` (`.webm`), `video/quicktime` (`.mov`). Anything else is rejected with `415 UNSUPPORTED_MEDIA_TYPE`. If the worker's `ffprobe` succeeds but finds no video stream, or fails to parse the file, the job fails non-retryably with `error_reason = INVALID_MEDIA` (no retry budget burned, per TD-03). Codec validation inside an accepted container (e.g. ProRes inside `.mov`) is explicitly **not** enforced in Phase 03 — `codec_name` is recorded in stored metadata (N-14) so the question can be reopened against real data, the same posture TD-17 takes for `moov` placement.

---

## TD-23: Video Endpoint Rate Limiting and Upload Concurrency Cap

**Context:** Raised by `plan-phase` validation (V-02). Phase 02's plan (`phase-02-auth.md`, SI-02.13) states the rate limiter is scoped to `AuthController`, but the actual code registers `ThrottlerGuard` as an application-wide `APP_GUARD` in `AuthModule` — the documented scoping does not exist. Under the global limit (10 req/min per IP), a single 10GB upload (~200 presigned-part requests under TD-04) cannot complete: the phase's headline capability would be blocked by inherited configuration, not by anything decided in this document. Separately, no document bounds how many multipart uploads a channel may hold open at once; each reserves storage (TD-20) and a worker job slot (TD-03) until completed or swept.

**Decision:** **Option A** —
1. Apply `@SkipThrottle()` to `VideosController`, the same precedent already set on `AppController`. Properly scoping `ThrottlerGuard` to only `AuthController` (fixing the Phase 02 plan/code mismatch) is tracked as a separate follow-up task, not bundled into Phase 03.
2. Cap open uploads per channel at an environment-configurable `UPLOAD_MAX_OPEN_PER_CHANNEL`, **initial value 5** — `POST /videos` returns `409 UPLOAD_LIMIT_REACHED` when a channel already has 5 videos in `uploading` status. The value is deliberately adjustable without a code change if it proves too strict or too loose in practice.

---

## Decisions Summary

| ID | Decision | Recommendation | Choice |
|----|----------|---------------|--------|
| TD-01 | Background Job Queue Technology | A — BullMQ + Redis (`@nestjs/bullmq`) | **Option A** |
| TD-02 | Video Worker Deployment Topology | A — Separate worker container, shared codebase | **Option A** |
| TD-03 | Job Failure and Retry Policy | A — Bounded retries with backoff + terminal `failed` status | **Option A** |
| TD-04 | Large Upload Transport Strategy | A — Presigned multipart, direct to store | **Option A** |
| TD-05 | Draft Pre-Registration and Upload State | A — Draft row on `videos`, upload state as columns | **Option A** |
| TD-06 | Upload Completion Trigger | C — Client-driven completion + reconciliation sweep | **Option C** |
| TD-07 | S3 Client Library | A — AWS SDK v3 + `s3-request-presigner` | **Option A** |
| TD-08 | Worker Process Bootstrap Mode | A — Standalone `createApplicationContext()` | **Option A** |
| TD-09 | FFmpeg Binary Provisioning | A — `apt-get install ffmpeg` in the worker image | **Option A** |
| TD-10 | FFmpeg/ffprobe Invocation from Node | A — `spawn` + thin injectable service | **Option A** |
| TD-11 | Source File Access for Processing | B — Presigned URL as FFmpeg input | **Option B** |
| TD-12 | Thumbnail Frame Selection Policy | A — Percentage-based offset | **Option A** |
| TD-13 | Public Video Identifier (Unique URL) | A — Random `public_id` column via `node:crypto` | **Option A** |
| TD-14 | Playback Delivery Path | B — Presigned GET; store answers Range with 206 | **Option B** |
| TD-15 | Playback URL Lifetime and Refresh | B — Session-sized TTL (6–12h) per page load | **Option B** |
| TD-16 | Direct Download Route | A — Presigned GET with `ResponseContentDisposition` | **Option A** |
| TD-17 | MP4 `moov` Placement Normalization | A — No normalization; rely on Range + tail read | **Option A** |
| TD-18 | Bucket Topology for Videos and Thumbnails | B — Private video bucket + public-read thumbnail bucket | **Option B** |
| TD-19 | Object Key Convention | A — `videos/{videoId}/…` keyed by the internal id | **Option A** |
| TD-20 | Abandoned Multipart Upload Expiry Policy | C — Sweep as primary + lifecycle rule as backstop | **Option C** |
| TD-21 | Bucket, Policy and Lifecycle Provisioning | A — `minio/mc` init service in Compose | **Option A** |
| TD-22 | Accepted Upload Formats | A — Allowlist mp4/webm/mov; non-retryable failure on no video stream | **Option A** |
| TD-23 | Video Endpoint Rate Limiting and Upload Concurrency Cap | A — `@SkipThrottle()` + cap of 5 open uploads/channel | **Option A** |

---

## Reference Limits (S3 API)

These constrain TD-04 regardless of which store is chosen, since MinIO implements the same API.

| Limit | Value |
|-------|-------|
| Single `PUT` upload | **5 GB** — below the phase's 10GB requirement |
| Multipart part size | 5 MiB – 5 GiB (no minimum on the last part) |
| Maximum parts per upload | 10,000 |
| 10GB at 50 MiB parts | ~200 parts — well within limits |
| Maximum object size | 48.8 TiB |

---

## Infrastructure Impact

Reflects the decided TD-01 – TD-17 plus the recommended TD-18 – TD-21 (revise if the pending decisions change).

| Item | Change |
|------|--------|
| `nestjs-project/compose.yaml` | Add `redis` service; add `video-worker` service (TD-02); add S3-compatible store service |
| `.env.example` | `REDIS_HOST=redis`, `REDIS_PORT=6379`, queue tuning vars; storage endpoint, credentials, bucket, presign TTL, part size |
| `src/config/` | New `queue.config.ts` and `storage.config.ts` namespaces via `registerAs` (per TD-01.03) |
| `src/config/env.validation.ts` | Extend Joi schema with the new variables |
| Storage service | CORS allowing the frontend origin for browser `PUT`s (TD-04 A); lifecycle rule to abort incomplete multipart uploads |
| Database | `videos` table with status enum, `storageKey`, `uploadId` (TD-05 A) |
| Dependencies | `@nestjs/bullmq@^12`, `bullmq@^5`/`^6`, `ioredis`, `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3` — **no FFmpeg npm wrapper** (TD-10 A) |
| Worker Dockerfile | Separate stage/target on `node:25.6.0-slim` with `apt-get install -y ffmpeg` (TD-09 A); entrypoint `main.worker.ts` (TD-08 A) |
| Worker health check | Compose `CMD`-form probe — the standalone context exposes no HTTP port (TD-08 A) |
| Database | `public_id` on `videos`: `varchar(12)`, `NOT NULL`, `UNIQUE`, indexed — the lookup key for every public route (TD-13 A) |
| Storage CORS | Must also allow `GET` with the `Range` header from the frontend origin and list `Content-Range`, `Accept-Ranges` and `Content-Length` in `Access-Control-Expose-Headers`, or the player cannot read the 206 metadata (TD-14 B) |
| `.env.example` | Playback presign TTL (6–12h) and a shorter download presign TTL (TD-15 B, TD-16 A) |
| Dependencies | Rounds 4 and 5 add none — `node:crypto` covers TD-13, TD-14/TD-16 reuse the TD-07 signer, and TD-18 – TD-21 are configuration |
| Storage buckets | Two: a private bucket for source videos and a public-read bucket for thumbnails, each with its own CORS, policy and lifecycle document (TD-18 B) |
| Object keys | `videos/{videoId}/source.<ext>` and `videos/{videoId}/thumbnail.jpg`, keyed by the internal video UUID (TD-19 A) |
| Storage lifecycle | `AbortIncompleteMultipartUpload` (`DaysAfterInitiation`, AWS recommends 7) on the video bucket where honoured; **`MINIO_API_STALE_UPLOADS_EXPIRY` raised from its 24h default** to match the intended resumable window, or resumable uploads die silently (TD-20 C) |
| `nestjs-project/compose.yaml` | Add a one-shot `minio/mc` init service running `mc mb` / `mc anonymous set download` / `mc cors set` plus the lifecycle JSON (TD-21 A) |
| Reconciliation sweep | Extend the TD-06 job to also `AbortMultipartUpload` for uploads past the threshold, paging `ListMultipartUploads` with `Prefix` + `KeyMarker`/`UploadIdMarker` (TD-20 C) |

> Docker networking rule applies: the queue and storage hosts are Compose service names (`redis`, the store's service name), never `localhost`. Note the one exception this creates — the **browser** needs a separately configured, externally reachable storage endpoint for TD-04 Option A, distinct from the in-network host the API uses to sign.

---

## Sources

Verified 2026-09-06 against the versions currently published.

**Round 1 — queue**

- [NestJS — Queues](https://docs.nestjs.com/techniques/queues) (official docs)
- [`@nestjs/bull` module API](https://github.com/nestjs/bull) via Context7 — `BullModule.forRootAsync`, `registerQueue`, `@Processor`/`WorkerHost`
- [BullMQ — PostgreSQL backend](https://docs.bullmq.io/guide/postgresql) and [BullMQ — Going to Production](https://docs.bullmq.io/guide/going-to-production)
- [BullMQ releases](https://github.com/taskforcesh/bullmq/releases) — `6.3.4`, 2026-09-01
- [pg-boss documentation](https://pgboss.io/) — `12.30.0`
- [RabbitMQ — Consumers](https://www.rabbitmq.com/docs/consumers) — `consumer_timeout` default 30 min
- npm registry — peer-dependency ranges for `@nestjs/bullmq@12.0.0`, `@golevelup/nestjs-rabbitmq@9.0.2`, `@nestjs/microservices@11`, `@apricote/nest-pg-boss@2.1.0`

**Round 2 — upload**

- [Amazon S3 — Uploading objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html) — single `PUT` capped at 5 GB
- [Amazon S3 — Multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) — 5 MiB–5 GiB parts, 10,000 parts max
- [`@aws-sdk/s3-request-presigner` README](https://github.com/aws/aws-sdk-js-v3/tree/main/packages/s3-request-presigner) via Context7 — `getSignedUrl`, `signableHeaders`, `unhoistableHeaders`
- [tus-node-server docs](https://github.com/tus/tus-node-server) via Context7 — `S3Store` part sizing, `RedisKvStore` / `RedisLocker`, Express integration
- [Uppy — AWS S3 plugin](https://uppy.io/docs/aws-s3) via Context7 — `shouldUseMultipart`, `createMultipartUpload`, `signPart`, `listParts`, `completeMultipartUpload`
- [MinIO — Bucket notifications](https://docs.min.io/community/minio-object-store/administration/monitoring/bucket-notifications.html) — webhook target, `s3:ObjectCreated:CompleteMultipartUpload`, `MINIO_API_SYNC_EVENTS`
- [MinIO — CORS configuration](https://docs.min.io/aistor/administration/cors-configuration/) — `MINIO_API_CORS_ALLOW_ORIGIN`, per-bucket `mc cors set`
- npm registry — `@aws-sdk/client-s3@3.1127.0`, `minio@8.0.7`, `@tus/server@2.4.5`, `@tus/s3-store@2.0.6`, `tus-js-client@4.3.1`, `@uppy/aws-s3@6.0.0`

**Round 3 — worker runtime**

- [NestJS — Standalone applications](https://docs.nestjs.com/standalone-applications) — `createApplicationContext`, and the stated unavailability of middleware/interceptors/pipes/guards
- [FFmpeg — Protocols](https://ffmpeg.org/ffmpeg-protocols.html) — `http`/`https` seeking via Range, `seekable`, `reconnect`, `multiple_requests`, `request_size`
- [ffprobe documentation](https://ffmpeg.org/ffprobe.html) — `-of json`, `-show_format`, `-show_streams`, output "designed to be easily parsable"
- [FFmpeg — Filters](https://ffmpeg.org/ffmpeg-filters.html#thumbnail) — `thumbnail` filter and its `n`/`log` parameters
- [fluent-ffmpeg on npm](https://www.npmjs.com/package/fluent-ffmpeg) and [its repository](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) — deprecated; archived read-only 2025-05-22
- npm registry — `fluent-ffmpeg@2.1.3` (deprecated), `@ts-ffmpeg/fluent-ffmpeg@2.2.6`, `ffmpeg-static@5.3.0` (ffmpeg 6.1.1, **no `bin`, no ffprobe**), `@ffprobe-installer/ffprobe@2.1.2` (2023), `ffprobe-static@3.1.0` (2022)
- Verified directly in `node:25.6.0-slim` — Debian 12 bookworm, `apt-cache policy ffmpeg` → `7:5.1.9-0+deb12u1` from `bookworm/main` and `bookworm-security`

**Round 4 — playback and delivery**

- [Amazon S3 — Download and upload objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) — SDK expiry up to 7 days (console caps at 12h); response-header override parameters
- [`@aws-sdk/client-s3` `GetObjectCommand`](https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-s3) via Context7 — `Range` input serialized to the HTTP `Range` header; range response returns `ContentRange` + `AcceptRanges`; `ResponseContentDisposition` serialized as the `response-content-disposition` query parameter
- [`@aws-sdk/s3-request-presigner` presigner source](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/src/presigner.ts) via Context7 — only `content-type` is added to `unsignableHeaders`, so an **absent** `Range` is never signed and the player may range-request the presigned URL freely
- [NestJS — Streaming files](https://docs.nestjs.com/techniques/streaming-files) via Context7 — `StreamableFile` options `type` / `disposition` / `length`; **no Range or 206 handling**
- [MinIO — presigned GET response header overrides](https://github.com/minio/minio-go/blob/master/examples/s3/presignedgetobject.go) — `response-content-disposition` via `reqParams`; [minio-js #820](https://github.com/minio/minio-js/issues/820) — RFC 5987 filenames producing `SignatureDoesNotMatch`
- [Chromium issue 41190208](https://issues.chromium.org/issues/41190208) and player reports ([video.js #3408](https://github.com/videojs/video.js/issues/3408), [http-streaming #888](https://github.com/videojs/http-streaming/issues/888)) — media-element behaviour with redirected and cross-origin range requests
- [FFmpeg — `-movflags +faststart`](https://ffmpeg.org/ffmpeg-formats.html#toc-Options-11) — moves the `moov` atom to the front; a second full pass over the file, `-c copy` needs no re-encode
- [Sqids FAQ](https://sqids.org/faq) — IDs are decodable and explicitly not a security mechanism
- [Node.js — `require(esm)` marked stable in v25.4.0](https://nodejs.org/en/blog/release/v22.12.0) and [Joyee Cheung, *require(esm) from experiment to stability*](https://joyeecheung.github.io/blog/2025/12/30/require-esm-in-node-js-from-experiment-to-stability/)
- npm registry — `nanoid@6.0.1` (ESM-only, `engines: ^22 || ^24 || >=26` — excludes Node 25), `nanoid@3.3.18` (CJS entry via `exports.require`), `sqids@0.3.0`, `hashids@2.3.0`
- [PostgreSQL 18 release notes](https://www.postgresql.org/docs/current/release-18.html) — native `uuidv7()`; unavailable on the PostgreSQL 17 this project pins, which is why the UUIDv4 PK is left untouched by TD-13

**Round 5 — storage layout and expiry**

- [Amazon S3 — Configuring a bucket lifecycle configuration to delete incomplete multipart uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html) — `AbortIncompleteMultipartUpload` / `DaysAfterInitiation`, the 7-day example, applies to existing and future uploads, no early-delete charge
- [Amazon S3 — Discovering and deleting incomplete multipart uploads](https://aws.amazon.com/blogs/aws-cloud-financial-management/discovering-and-deleting-incomplete-multipart-uploads-to-lower-amazon-s3-costs/) — orphaned parts bill as storage while invisible to object listings
- [Amazon S3 — Lifecycle configuration elements](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html) — one configuration per bucket, up to 1,000 rules, `Filter` by prefix/tag/size
- [`minio-go` lifecycle package](https://pkg.go.dev/github.com/minio/minio-go/v7/pkg/lifecycle) — `AbortIncompleteMultipartUpload` documented as **"not supported yet on MinIO"**; corroborated by [minio#16120](https://github.com/minio/minio/issues/16120) (rejected as malformed XML) and [minio#19115](https://github.com/minio/minio/issues/19115) (accepted on import, absent on export)
- MinIO `api` settings — `stale_uploads_expiry` (default **24h**) and `stale_uploads_cleanup_interval` (default 6h), server-wide rather than per-bucket, set via `MINIO_API_STALE_UPLOADS_EXPIRY`; see [minio#20450](https://github.com/minio/minio/issues/20450) and [minio/docs/config](https://github.com/minio/minio/blob/master/docs/config/README.md)
- [`mc ilm rule add` reference](https://docs.min.io/enterprise/aistor-object-store/reference/cli/mc-ilm-rule/mc-ilm-rule-add/) — `--prefix`, `--expire-days`, `--noncurrent-expire-days`, transitions; **no flag for incomplete multipart uploads**
- [`mc anonymous set` reference](https://min.io/docs/minio/linux/reference/minio-mc/mc-anonymous-set.html) — `none|download|upload` applied to `alias/bucket[/prefix]`, so prefix-scoped public read is possible without a separate bucket
- [Amazon S3 — Best practices design patterns: optimizing performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html) and [S3 increased request rate performance (2018)](https://aws.amazon.com/about-aws/whats-new/2018/07/amazon-s3-announces-increased-request-rate-performance) — ≥3,500 PUT / 5,500 GET per second per prefix, unlimited prefixes, randomized key prefixes no longer required
- [Amazon S3 — General purpose bucket quotas](https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketRestrictions.html) and [1 million buckets per account (Nov 2024)](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-up-1-million-buckets-per-aws-account/) — default 10,000 buckets, so bucket count is not a constraint on TD-18
- [`ListMultipartUploadsCommand`](https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-s3/src/commands/ListMultipartUploadsCommand.ts) via Context7 — `Prefix` filter, 1,000-upload pages, `KeyMarker`/`UploadIdMarker` pagination for the TD-20 sweep
