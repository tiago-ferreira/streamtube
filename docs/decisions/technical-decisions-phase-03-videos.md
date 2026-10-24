---
scope_type: phase
related_phases: [3]
status: decided
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

## Context

Phase 03 introduces video upload, background processing, and video delivery (streaming, download, and thumbnail serving) on top of the foundation built in Phases 01 and 02 (`UsersModule`, `ChannelsModule`, `AuthModule`, `MailModule`, PostgreSQL + TypeORM, and Docker Compose).

Per `docs/project-plan.md`, Phase 03 must deliver 9 capabilities:
1. `Serviço de armazenamento de arquivos (vídeos e thumbnails)`
2. `Serviço de processamento em segundo plano (filas)`
3. `Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance`
4. `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`
5. `Processamento automático do vídeo após upload (extração de duração e metadados)`
6. `Geração automática de thumbnail a partir de um frame do vídeo`
7. `URL única por vídeo, sem conflito com outros vídeos`
8. `Reprodução via streaming (sem necessidade de download completo)`
9. `Download do vídeo pelo usuário`

Additionally, `docs/architecture.md` specifies a **Modular Monolith + Dedicated Worker** pattern: `nestjs-api` and `video-worker` share the same codebase and Docker image (`Dockerfile.dev`) with separate entrypoints (`src/main.ts` vs `src/worker.ts`), communicating asynchronously via a message queue and shared S3-compatible object storage (MinIO in development, AWS S3 in production).

---

## Technical Decisions

### TD-01: Background Queue Technology (BullMQ + Redis vs RabbitMQ, SQS, pg-boss)

**Capability:** Serviço de processamento em segundo plano (filas)
**Context:** Video probing and thumbnail extraction are CPU- and I/O-bound tasks executed via FFmpeg. Running them inside the HTTP request/response lifecycle of `nestjs-api` would block the Node.js event loop and risk HTTP timeouts. `docs/architecture.md` specifies a separate `video-worker` process consuming jobs from a queue.

#### Option A: BullMQ + Redis (`bullmq` + `@nestjs/bullmq`)
Use Redis 7 (`redis:7-alpine`, `--maxmemory-policy noeviction --appendonly yes`) as the backing store and `@nestjs/bullmq` (`bullmq`) to manage the `video-processing` queue. `nestjs-api` registers the queue producer in `VideosModule` (`BullModule.registerQueue({ name: 'video-processing' })`). `video-worker` consumes jobs via `VideoProcessor extends WorkerHost` (`@Processor('video-processing')`).
- **Pros:** Official NestJS integration (`BullModule.forRootAsync`, `registerQueue`, `@Processor`/`WorkerHost`), lightweight `redis:7-alpine` footprint (~30 MB RAM), built-in exponential backoff retries, deterministic job deduplication (`jobId: videoId`), `UnrecoverableError` support to bypass retries on invalid media files, and configurable worker concurrency.
- **Cons:** Adds a lightweight `redis` container to Docker Compose.

#### Option B: RabbitMQ (`amqplib` / `@nestjs/microservices`)
Use RabbitMQ with AMQP exchanges and dead-letter queues.
- **Pros:** Rich AMQP routing topologies and broker-level delivery guarantees.
- **Cons:** No native exponential backoff retry without manually wiring Dead-Letter Exchanges (DLX) and per-TTL delay queues, higher memory footprint (~150–250 MB RAM), and more operational overhead than needed for a single worker queue.

#### Option C: AWS SQS + LocalStack
Use `@aws-sdk/client-sqs` against LocalStack in development.
- **Pros:** Matches managed AWS SQS in production.
- **Cons:** LocalStack is heavy for local development and couples the queue layer to a single cloud provider.

#### Option D: PostgreSQL-Backed Queue (`pg-boss`)
Use PostgreSQL tables with `SKIP LOCKED` polling for job queuing.
- **Pros:** No additional container in Docker Compose.
- **Cons:** `docs/architecture.md` explicitly models a dedicated Message Queue container, and polling traffic would contend with transactional workload on PostgreSQL.

**Recommendation:** Option A — BullMQ + Redis (`bullmq` + `@nestjs/bullmq`) on `redis:7-alpine` (`--maxmemory-policy noeviction --appendonly yes`).

**Decision:** BullMQ + Redis (`bullmq` + `@nestjs/bullmq`) using queue `video-processing`, job name `process-video`, `jobId: videoId` for deduplication, 3 attempts with exponential backoff (`delay: 5000ms`), and `UnrecoverableError` for deterministic media failures (`NO_VIDEO_STREAM`).
**Libraries:** `bullmq@^5.70.0`, `@nestjs/bullmq@^11.0.4`

---

### TD-02: Large Video Upload Strategy (S3 Multipart Presigned URLs) & Automatic Draft Pre-Registration

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance, Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
**Context:** Supporting video uploads up to 10 GiB (`10,737,418,240` bytes) without degrading `nestjs-api` performance means raw video bytes must never flow through the NestJS process memory or disk. Furthermore, S3 puts a 5 GiB ceiling on single `PUT` requests, and uploading multi-gigabyte files in a single HTTP request is brittle on unstable networks. Starting an upload must also automatically pre-register the video in PostgreSQL with `status = 'draft'`.

#### Option A: Direct-to-S3 Multipart Upload via Presigned Part URLs with Automatic `draft` Pre-Registration
1. `POST /videos` (authenticated): validates channel ownership, MIME type (`video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`), and file size (`1..10,737,418,240` bytes). Creates the `Video` row in `draft` status, initiates S3 Multipart Upload (`CreateMultipartUploadCommand` with `ContentType = mime_type`), saves `upload_id`, computes `part_size = UPLOAD_PART_SIZE_BYTES` (default `67,108,864` bytes = 64 MiB, producing 160 parts for a 10 GiB file, well below S3's 10,000-part limit; minimum 5 MiB per S3 spec) and `part_count = Math.max(1, Math.ceil(size_bytes / part_size))`, and returns presigned `UploadPartCommand` URLs (`UPLOAD_URL_TTL_SECONDS`, default `3600`) for all parts `1..part_count`.
2. `POST /videos/:slug/upload/parts` (authenticated owner): refreshes presigned URLs for up to 100 requested `part_numbers` (`1..part_count`) for long-running uploads.
3. `POST /videos/:slug/upload/complete` (authenticated owner): validates the complete contiguous list of `{ part_number, etag }`, calls `CompleteMultipartUploadCommand`, verifies actual assembled object size via `HeadObjectCommand` (`ContentLength === size_bytes`; if mismatched, deletes the object, marks the video `failed`, and throws `422 UPLOAD_SIZE_MISMATCH`), transitions `draft → processing`, and enqueues the `process-video` job.
- **Pros:** Zero byte proxying through `nestjs-api` (constant ~few KB JSON payload in Node.js regardless of whether the file is 10 MB or 10 GiB), parallelizable chunk uploads, resumable per part via `/upload/parts`, and enforces exact size verification at completion.
- **Cons:** Client must send `PUT` requests per part and collect `ETag` response headers.

#### Option B: Single Presigned `PUT` URL
Generate a single presigned `PutObjectCommand` URL.
- **Pros:** Simpler 2-step client flow.
- **Cons:** Violates S3's 5 GiB maximum limit for a single `PUT` operation (cannot support 10 GiB files) and cannot resume failed parts.

#### Option C: Streaming / Multer / tus Proxy Upload through `nestjs-api`
Stream `multipart/form-data` or tus chunks through `nestjs-api` into S3.
- **Pros:** Simple client upload endpoint.
- **Cons:** Ties up `nestjs-api` connections and bandwidth during multi-gigabyte uploads, directly violating "sem impacto na performance" and `docs/architecture.md`.

**Recommendation:** Option A — Direct-to-S3 Multipart Upload with Presigned `PUT` URLs (`UPLOAD_PART_SIZE_BYTES=67108864` default), automatic `draft` pre-registration on `POST /videos`, on-demand part URL refresh on `POST /videos/:slug/upload/parts`, and verified completion on `POST /videos/:slug/upload/complete`.

**Decision:** Direct-to-S3 Multipart Upload via presigned `UploadPartCommand` URLs (`UPLOAD_PART_SIZE_BYTES=67108864` default, 64 MiB), pre-registering the `Video` record with `status = 'draft'` on `POST /videos`, supporting URL refresh via `POST /videos/:slug/upload/parts`, and completing assembly + `HeadObject` size verification + transition to `processing` + BullMQ job dispatch on `POST /videos/:slug/upload/complete`.
**Libraries:** `@aws-sdk/client-s3@^3.1000.0`, `@aws-sdk/s3-request-presigner@^3.1000.0`

---

### TD-03: Storage Key Layout & Dual-Endpoint S3 Signing (`S3_ENDPOINT` vs `S3_PUBLIC_ENDPOINT`)

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)
**Context:** Both `nestjs-api` and `video-worker` run inside a Docker Compose network where MinIO is reachable at `http://minio:9000` (using Compose service names per `CLAUDE.md`). External clients (browsers, curl on host) reach MinIO at `http://localhost:9000`. In SigV4, the `Host` header is part of the signature: a URL signed for `minio:9000` fails with `403 SignatureDoesNotMatch` when requested against `localhost:9000`. Additionally, storage keys must avoid user-controlled filenames to prevent path traversal and key collisions.

#### Option A: Dual `S3Client` Instances (`internalClient` + `publicSignerClient`) & Immutable ID-Based Storage Keys in a Single Private Bucket
1. Use a single private bucket `S3_BUCKET=streamtube-media` initialized via a one-shot `minio-init` (`minio/mc`: `mc mb --ignore-existing`) service in Docker Compose.
2. Derive deterministic keys from the immutable video UUID (`id`):
   - `videos/{videoId}/source` for the original video object (with `ContentType` set to `mime_type`).
   - `videos/{videoId}/thumbnail.jpg` for the extracted JPEG thumbnail.
3. Maintain two `S3Client` instances in `StorageService` (both with `forcePathStyle: true`):
   - `internalClient` (`endpoint = S3_ENDPOINT`, `http://minio:9000`) for server-side commands (`CreateMultipartUpload`, `CompleteMultipartUpload`, `HeadObject`, `PutObject`, `DeleteObject`) and internal worker presigned URLs (`presignInternalGetObject`).
   - `publicSignerClient` (`endpoint = S3_PUBLIC_ENDPOINT`, default `http://localhost:9000`, overridden to `http://minio:9000` in container-internal E2E tests) used solely with `getSignedUrl` to sign client-facing URLs (`presignUploadParts`, `presignGetObject`).
- **Pros:** Eliminates SigV4 host mismatch without mutating `/etc/hosts` or running a reverse proxy, prevents path traversal and filename collisions via `videos/{videoId}/source`, and keeps all objects in a single private bucket.
- **Cons:** Requires configuring both `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT`.

#### Option B: Single `S3Client` with Reverse Proxy or Shared `/etc/hosts` Alias
Require developers to add `127.0.0.1 minio` to `/etc/hosts` on the host machine.
- **Pros:** Single endpoint string.
- **Cons:** Fragile developer experience that breaks out-of-the-box setup on host machines.

**Recommendation:** Option A — Single private bucket `streamtube-media` with keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`, and dual `S3Client` instances (`S3_ENDPOINT=http://minio:9000` and `S3_PUBLIC_ENDPOINT=http://localhost:9000`) with `forcePathStyle: true`.

**Decision:** Single private bucket `streamtube-media` initialized by `minio-init`, deterministic keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`, and dual `S3Client` instances (`internalClient` on `S3_ENDPOINT` and `publicSignerClient` on `S3_PUBLIC_ENDPOINT`, both with `forcePathStyle: true`).
**Libraries:** `@aws-sdk/client-s3@^3.1000.0`, `@aws-sdk/s3-request-presigner@^3.1000.0`

---

### TD-04: Worker Architecture & FFmpeg Execution via `child_process.spawn` over HTTP Range

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados), Geração automática de thumbnail a partir de um frame do vídeo
**Context:** `video-worker` must extract `duration_seconds` and technical metadata (`width`, `height`, `video_codec`, `audio_codec`, `container`, `bitrate`, `frame_rate`), generate a JPEG thumbnail at `min(1s, 10% duration)` with max width 1280px preserving aspect ratio, and store it at `videos/{videoId}/thumbnail.jpg` without blocking `nestjs-api` or downloading 10 GiB files to container disk.

#### Option A: Separate `src/worker.ts` Entrypoint (`createApplicationContext(WorkerModule)`) + `FfmpegService` (`spawn` over Internal Presigned URLs)
1. **Worker Process:** `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server) with `enableShutdownHooks()`. `compose.yaml` defines service `video-worker` sharing the same `Dockerfile.dev` (updated to install `ffmpeg`) and bind-mounted code volume, running `npm run start:worker:dev` (`nest start --watch --entryFile worker`).
2. **FFmpeg / FFprobe Execution:** `FfmpegService` spawns `ffprobe` and `ffmpeg` directly (`shell: false`) with a configurable timeout, passing an internal presigned URL (`http://minio:9000/...`) so FFmpeg reads only required byte ranges via HTTP Range requests:
   - Probe: `ffprobe -v error -print_format json -show_format -show_streams <internalPresignedUrl>`, parsed into `duration_seconds` and `metadata: { width, height, video_codec, audio_codec, container, bitrate, frame_rate }`. If no stream with `codec_type === 'video'` exists, throw BullMQ `UnrecoverableError('NO_VIDEO_STREAM')`.
   - Thumbnail: `ffmpeg -ss <t> -i <internalPresignedUrl> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg pipe:1` where `t = Math.min(1, duration * 0.1)`, capturing the JPEG buffer from `stdout` (`pipe:1`) and uploading it via `storageService.putObject('videos/{videoId}/thumbnail.jpg', buffer, 'image/jpeg')`.
- **Pros:** Reuses entities, config, and lint rules from the monorepo while isolating FFmpeg CPU load in `video-worker`; avoids deprecated `fluent-ffmpeg`; streams only header/frame byte ranges from MinIO via HTTP Range; streams thumbnail output directly via `pipe:1` without temporary disk files.
- **Cons:** Requires maintaining a concise `spawn` + stdout/stderr buffer helper in `FfmpegService`.

#### Option B: In-Process Worker inside `nestjs-api` + `fluent-ffmpeg`
Run `@Processor` inside `AppModule` and use `fluent-ffmpeg`.
- **Pros:** Fewer Compose services.
- **Cons:** `fluent-ffmpeg` is archived/unmaintained, and running FFmpeg inside `nestjs-api` contends for CPU and event-loop resources with HTTP requests.

**Recommendation:** Option A — Standalone `src/worker.ts` (`WorkerModule`) in a dedicated `video-worker` container + `FfmpegService` using `child_process.spawn` (`ffprobe` JSON output + `ffmpeg` `pipe:1` JPEG output) over internal presigned S3 GET URLs.

**Decision:** Dedicated `video-worker` Compose service running `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`) with `ffmpeg` installed in `Dockerfile.dev`, and `FfmpegService` invoking `ffprobe` and `ffmpeg` (`pipe:1`) via `child_process.spawn` over internal presigned URLs.
**Libraries:** Built-in Node.js `node:child_process` + system binary `ffmpeg`

---

### TD-05: Video Status Lifecycle, Transaction Atomicity, Retries, and Idempotency

**Capability:** Serviço de processamento em segundo plano (filas), Processamento automático do vídeo após upload (extração de duração e metadados)
**Context:** A video transitions through `draft | processing | ready | failed`. Retries, duplicate `complete` calls, or redelivered BullMQ jobs must never corrupt video state, enqueue duplicate active jobs, or overwrite a `ready` video.

#### Option A: Optimistic Conditional SQL Updates (`WHERE status = ...`) + Transactional Enqueue + BullMQ `jobId` Deduplication
1. **Allowed transitions:** `draft → processing`, `draft → failed`, `processing → ready`, `processing → failed`. `ready` and `failed` are terminal in Phase 03.
2. **Completion (`VideosService.completeUpload`):** Inside `dataSource.transaction`, execute `UPDATE videos SET status = 'processing', uploaded_at = NOW(), upload_id = NULL WHERE id = :id AND status = 'draft'`. If `affected === 0`, throw `409 VIDEO_UPLOAD_NOT_IN_PROGRESS`. Still inside the transaction callback, call `queue.add('process-video', { videoId }, { jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 100 })`. If `queue.add` throws, the DB transaction rolls back so the video stays in `draft`.
3. **Worker Idempotency & Retries (`VideoProcessor`):**
   - Load video; if `!video || video.status !== 'processing'`, return early without error (no-op on redelivered jobs for `ready`/`failed` videos).
   - On success, update with `WHERE id = :id AND status = 'processing'` to `status = 'ready'`, `duration_seconds`, `metadata`, `thumbnail_key`, `processed_at = new Date()`.
   - When no video stream is present, throw `new UnrecoverableError('NO_VIDEO_STREAM')` to skip remaining retry attempts.
   - In `@OnWorkerEvent('failed')`, when a job fails permanently (`err instanceof UnrecoverableError` or `job.attemptsMade >= (job.opts.attempts ?? 1)`), update `status = 'failed'` and `failure_reason = err.message.slice(0, 500)` (`WHERE id = :id AND status = 'processing'`).
- **Pros:** Guarantees at most one active job per video (`jobId: videoId`), prevents race conditions on concurrent `/complete` requests, rolls back `processing` status if Redis enqueue fails, and ensures idempotent worker execution.
- **Cons:** Minimal window if DB commit fails after `queue.add` succeeds (mitigated because the worker sees `status !== 'processing'` and exits cleanly).

#### Option B: Unconditional `repository.save()` without Status Guards
Load entity, mutate `video.status`, and call `save()`.
- **Pros:** Slightly simpler code.
- **Cons:** Vulnerable to race conditions on concurrent requests or redelivered jobs overwriting terminal states.

**Recommendation:** Option A — Conditional `UPDATE ... WHERE status = ...` guards, transactional `draft → processing` + `queue.add` (`jobId: videoId`, 3 attempts, 5s exponential backoff), `UnrecoverableError` for invalid media, and `@OnWorkerEvent('failed')` terminal failure recording.

**Decision:** Enforce `video_status` (`draft | processing | ready | failed`) via conditional `WHERE status = ...` updates, transactional `completeUpload` + `queue.add` (`jobId: videoId`, `attempts: 3`, exponential backoff `5000ms`), `UnrecoverableError('NO_VIDEO_STREAM')`, and `@OnWorkerEvent('failed')` handler setting `status = 'failed'` with `failure_reason` (truncated to 500 chars).
**Libraries:** `bullmq@^5.70.0`, `@nestjs/bullmq@^11.0.4`, `typeorm@^0.3.28`

---

### TD-06: Collision-Free Unique Video URL Identifier (11-char Base64URL Slug)

**Capability:** URL única por vídeo, sem conflito com outros vídeos
**Context:** Every video requires a unique, non-enumerable, URL-safe public identifier (`slug`) used across all `/videos/:slug` routes without colliding with other videos.

#### Option A: Cryptographically Random 11-Character Base64URL Slug (`crypto.randomBytes(8).toString('base64url')`) + DB `UNIQUE` Constraint & Retry Loop
Generate 8 random bytes via Node's built-in `node:crypto` (`randomBytes(8).toString('base64url')`), producing an 11-character string from `[A-Za-z0-9_-]` (64 bits of entropy, YouTube-style ID). Store in `varchar(11) UNIQUE` (`UQ_videos_slug`) while keeping `id` (UUID) as internal primary key. On creation, check/retry up to 5 times if a collision or PostgreSQL `23505` unique violation occurs on `slug` (following the pattern in `ChannelsService`).
- **Pros:** Zero external dependencies, non-enumerable, compact 11-char URL, immutable even if the video title changes in future phases, and guaranteed unique by PostgreSQL.
- **Cons:** Opaque identifier rather than human-readable words.

#### Option B: Title-Derived Slug or `nanoid`
Derive slug from title or add `nanoid` dependency.
- **Pros:** Title slug is readable.
- **Cons:** Title slugs collide frequently and break URLs when titles change; `nanoid` adds an extra ESM dependency for a one-line `node:crypto` call.

**Recommendation:** Option A — `crypto.randomBytes(8).toString('base64url')` stored in `varchar(11) UNIQUE` with up to 5 collision retries.

**Decision:** 11-character Base64URL slug generated via `crypto.randomBytes(8).toString('base64url')`, enforced by a PostgreSQL `UNIQUE` constraint on `videos.slug` and a 5-attempt collision retry loop in `VideosService.initiateUpload`.
**Libraries:** Built-in Node.js `node:crypto`

---

### TD-07: Video Streaming (HTTP Range), Download, Thumbnail Redirects (`302`), and Optional Auth Visibility

**Capability:** Reprodução via streaming (sem necessidade de download completo), Download do vídeo pelo usuário
**Context:** Clients need to query video metadata (`GET /videos/:slug`), stream ready videos via HTTP `Range` (`206 Partial Content`) without downloading the entire file first, download the original file with its original filename, and load the video thumbnail. Non-ready videos (`draft`, `processing`, `failed`) must only be visible to their authenticated owner.

#### Option A: `302 Found` Redirects to Presigned S3 GET URLs + Optional JWT Auth on `@Public()` Routes
1. **Optional JWT Auth (`JwtAuthGuard`):** When a route is marked `@Public()` and carries an `Authorization: Bearer <token>` header, `JwtAuthGuard` attempts `jwtService.verifyAsync(token)`. If valid, it populates `request.user`; if invalid/expired or absent, it proceeds anonymously (`request.user = undefined`) and never throws `401` on a public route.
2. **Metadata (`GET /videos/:slug`, `@Public()`):** `VideosService.findBySlugForViewer(slug, viewerUserId)` returns `200` for any viewer when `status === 'ready'`, including `stream_url`, `download_url`, and `thumbnail_url` (`/videos/{slug}/stream`, `/videos/{slug}/download`, `/videos/{slug}/thumbnail`). When `status !== 'ready'`, returns `200` (without media URLs, and with `failure_reason` when `status === 'failed'`) **only** if `viewerUserId === video.channel.user_id`; otherwise throws `404 VIDEO_NOT_FOUND`.
3. **Media Delivery Redirects (`@Public()`, `@SkipThrottle()`):**
   - `GET /videos/:slug/stream`: Verifies `status === 'ready'` (`404 VIDEO_NOT_FOUND` otherwise) and returns `302 Found` to a presigned `GetObject` URL (`DOWNLOAD_URL_TTL_SECONDS`, default `3600`) with `ResponseContentType = video.mime_type`. MinIO/S3 natively handles `Range: bytes=...` with `206 Partial Content` and `Content-Range`.
   - `GET /videos/:slug/download`: Verifies `status === 'ready'` and returns `302 Found` to a presigned `GetObject` URL with `ResponseContentType = video.mime_type` and `ResponseContentDisposition = attachment; filename="<ascii_fallback>"; filename*=UTF-8''<encoded_original_filename>`.
   - `GET /videos/:slug/thumbnail`: Verifies `status === 'ready'` and `thumbnail_key !== null` (`404 VIDEO_NOT_FOUND` otherwise) and returns `302 Found` to a presigned `GetObject` URL for `thumbnail_key` with `ResponseContentType = 'image/jpeg'`.
- **Pros:** Follows the C4 architecture diagram and `technical-decisions-next-frontend-config-base.md`; keeps `nestjs-api` completely out of the video byte path; supports native HTTP Range (`206 Partial Content`) seeking in browsers; and cleanly supports both anonymous viewers and authenticated owners on `GET /videos/:slug`.
- **Cons:** Requires one `302` redirect hop before connecting to object storage.

#### Option B: API Stream Proxy + Separate `/me/videos/:slug` Endpoint
Proxy `GetObject` byte streams through `nestjs-api` and create a separate endpoint for owners.
- **Pros:** Single HTTP hop.
- **Cons:** Channels all video bandwidth through `nestjs-api` and duplicates REST metadata routes.

**Recommendation:** Option A — `302 Found` redirects to presigned S3 GET URLs on `/stream`, `/download`, and `/thumbnail` (`@Public()`, `@SkipThrottle()`), combined with optional JWT authentication in `JwtAuthGuard` for owner visibility on `GET /videos/:slug`.

**Decision:** `GET /videos/:slug/stream`, `/download`, and `/thumbnail` (`@Public()`, `@SkipThrottle()`) return `302 Found` redirects to presigned `GetObject` URLs (`DOWNLOAD_URL_TTL_SECONDS=3600`), delegating HTTP `Range` (`206 Partial Content`) and `Content-Disposition: attachment` delivery directly to MinIO/S3. `JwtAuthGuard` performs optional token verification on `@Public()` routes so `GET /videos/:slug` serves `ready` videos publicly and `draft`/`processing`/`failed` videos exclusively to their authenticated channel owner.
**Libraries:** `@aws-sdk/client-s3@^3.1000.0`, `@aws-sdk/s3-request-presigner@^3.1000.0`
