# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

> **Phase:** 03 — Upload e Processamento de Vídeos
> **Status:** Decided (TD-01–TD-12)
> **Date:** 2026-09-06

---

## Scope of this document

Built in two research rounds:

- **Round 1 — Background processing queue** (TD-01 – TD-03, decided): the "Message Queue (TBD)" container in [software-arch.mermaid](../diagrams/software-arch.mermaid), plus where the worker runs and what happens when a job fails.
- **Round 2 — Large upload path** (TD-04 – TD-07): how a 10GB file reaches the object store without blocking the API, how the draft video record is pre-registered when the upload starts, how the API learns the upload finished, and which S3 client library to use.
- **Round 3 — Video worker runtime** (TD-08 – TD-12): how the worker process boots, how FFmpeg reaches the container, how it is invoked from Node, how it reads a 10GB source object, and which frame becomes the thumbnail. TD-02 already fixed the *topology* (separate container, shared codebase) and is not reopened here.

Still **not** covered and pending a separate round: the object storage service itself (self-hosted MinIO vs managed S3 and its bucket/lifecycle layout), unique short URL generation, HTTP Range streaming, and the download endpoint. TD-04 – TD-12 assume only that the store speaks the **S3 API**, which both candidates do.

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

Reflects the decided TD-01 – TD-03 plus the recommended TD-04 – TD-07 (revise if those decisions change).

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
