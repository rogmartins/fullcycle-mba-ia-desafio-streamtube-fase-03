# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

> **Phase:** 03 — Upload e Processamento de Vídeos
> **Status:** Decided
> **Date:** 2026-09-06

---

## Scope of this document

This round covers **only the background processing queue** — the "Message Queue (TBD)" container in [software-arch.mermaid](../diagrams/software-arch.mermaid) — and the two decisions that are inseparable from it (where the worker runs, and what happens when a job fails).

The remaining Phase 03 decisions (object storage / S3 vs MinIO, 10GB upload strategy, FFmpeg wrapper, unique URL generation, streaming with HTTP Range) are **not** covered here and should be researched in a separate round, per the project's scope-limit rule.

**Constraints inherited from previous phases (not reopened):** `@nestjs/config` with namespaced `registerAs` factories (TD-01.03), Joi env validation (TD-01.02), custom domain exception filter (TD-02.07), PostgreSQL 17 + TypeORM 0.3, NestJS 11 on Node 25 (`node:25.6.0-slim`), Docker Compose with `db` and `mailpit` services.

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

## Decisions Summary

| ID | Decision | Recommendation | Choice |
|----|----------|---------------|--------|
| TD-01 | Background Job Queue Technology | A — BullMQ + Redis (`@nestjs/bullmq`) | **Option A** |
| TD-02 | Video Worker Deployment Topology | A — Separate worker container, shared codebase | **Option A** |
| TD-03 | Job Failure and Retry Policy | A — Bounded retries with backoff + terminal `failed` status | **Option A** |

---

## Infrastructure Impact (if TD-01 = Option A)

| Item | Change |
|------|--------|
| `nestjs-project/compose.yaml` | Add `redis` service; add `video-worker` service (TD-02) |
| `.env.example` | Add `REDIS_HOST=redis`, `REDIS_PORT=6379`, queue tuning vars |
| `src/config/` | New `queue.config.ts` namespace via `registerAs` (per TD-01.03) |
| `src/config/env.validation.ts` | Extend Joi schema with the new variables |
| Dependencies | `@nestjs/bullmq@^12`, `bullmq@^5` or `^6`, `ioredis` |

> Docker networking rule applies: the queue host is the Compose service name (`redis`), never `localhost`.

---

## Sources

Verified 2026-09-06 against the versions currently published.

- [NestJS — Queues](https://docs.nestjs.com/techniques/queues) (official docs)
- [`@nestjs/bull` module API](https://github.com/nestjs/bull) via Context7 — `BullModule.forRootAsync`, `registerQueue`, `@Processor`/`WorkerHost`
- [BullMQ — PostgreSQL backend](https://docs.bullmq.io/guide/postgresql) and [BullMQ — Going to Production](https://docs.bullmq.io/guide/going-to-production)
- [BullMQ releases](https://github.com/taskforcesh/bullmq/releases) — `6.3.4`, 2026-09-01
- [pg-boss documentation](https://pgboss.io/) — `12.30.0`
- [RabbitMQ — Consumers](https://www.rabbitmq.com/docs/consumers) — `consumer_timeout` default 30 min
- npm registry — peer-dependency ranges for `@nestjs/bullmq@12.0.0`, `@golevelup/nestjs-rabbitmq@9.0.2`, `@nestjs/microservices@11`, `@apricote/nest-pg-boss@2.1.0`
