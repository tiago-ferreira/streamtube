---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-24 18:36:20.316958738 -0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24 20:07:12.284490777 -0300"
  docs/phases/phase-03-videos/context.md: "2026-10-24 20:08:09.597492024 -0300"
  docs/phases/phase-03-videos/validation.md: "2026-10-24 20:09:16.003646929 -0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-24 20:09:17.071665462 -0300"
  docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md: "2026-10-24 19:13:21.713660817 -0300"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-10-24 19:13:21.714051535 -0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the complete video upload, background processing, and delivery pipeline — direct-to-S3 multipart upload supporting files up to 10 GiB with automatic `draft` pre-registration, asynchronous FFmpeg/FFprobe metadata extraction and thumbnail generation in a dedicated BullMQ `video-worker`, collision-free 11-character video slugs, and presigned `302` redirects for HTTP Range streaming (`206 Partial Content`), file download, and thumbnail serving.

---

## Step Implementations

### SI-03.1 — Infrastructure: Docker Compose (`redis`, `minio`, `minio-init`), `ffmpeg` Image, Dependencies, and Config Namespaces

**Description:** Add `ffmpeg` to `Dockerfile.dev`, provision `redis`, `minio`, and `minio-init` (creating bucket `streamtube-media`) in `compose.yaml`, install AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) and BullMQ (`bullmq`, `@nestjs/bullmq`), and create the `storage`, `queue`, and `upload` configuration namespaces with Joi validation.

**Technical actions:**

- Update `nestjs-project/Dockerfile.dev` — add `ffmpeg` to `apt update && apt install -y procps curl ffmpeg` and rebuild container image (`docker compose build`)
- Update `nestjs-project/compose.yaml`:
  - Add `redis` service (`redis:7-alpine`, command `redis-server --maxmemory-policy noeviction --appendonly yes`, port `6379:6379`, named volume `redis_data`, healthcheck `redis-cli ping`)
  - Add `minio` service (`minio/minio`, command `server /data --console-address ":9001"`, ports `9000:9000` and `9001:9001`, named volume `minio_data`, healthcheck `curl -f http://localhost:9000/minio/health/live`)
  - Add `minio-init` one-shot service (`minio/mc`, depends on `minio: service_healthy`, entrypoint creating alias and running `mc mb --ignore-existing local/${S3_BUCKET:-streamtube-media}`)
  - Update `nestjs-api.depends_on` to include `redis` (`service_healthy`), `minio` (`service_healthy`), and `minio-init` (`service_completed_successfully`)
- Install production dependencies inside `nestjs-api`: `@aws-sdk/client-s3@^3.1000.0`, `@aws-sdk/s3-request-presigner@^3.1000.0`, `bullmq@^5.70.0`, `@nestjs/bullmq@^11.0.4`
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` exposing `endpoint` (`S3_ENDPOINT`, default `'http://minio:9000'`), `publicEndpoint` (`S3_PUBLIC_ENDPOINT`, default `'http://localhost:9000'`), `region` (`S3_REGION`, default `'us-east-1'`), `accessKey` (`S3_ACCESS_KEY`), `secretKey` (`S3_SECRET_KEY`), `bucket` (`S3_BUCKET`, default `'streamtube-media'`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` exposing `redisHost` (`REDIS_HOST`, default `'redis'`), `redisPort` (`REDIS_PORT`, default `6379`)
- Create `src/config/upload.config.ts` — `registerAs('upload', ...)` exposing `maxSizeBytes` (`UPLOAD_MAX_SIZE_BYTES`, default `10737418240`), `partSizeBytes` (`UPLOAD_PART_SIZE_BYTES`, default `67108864`), `uploadUrlTtlSeconds` (`UPLOAD_URL_TTL_SECONDS`, default `3600`), `downloadUrlTtlSeconds` (`DOWNLOAD_URL_TTL_SECONDS`, default `3600`), `workerConcurrency` (`VIDEO_WORKER_CONCURRENCY`, default `2`)
- Register `storageConfig`, `queueConfig`, and `uploadConfig` in `AppModule` (`ConfigModule.forRoot({ load: [...] })`), extend `src/config/env.validation.ts` (`S3_ACCESS_KEY` and `S3_SECRET_KEY` required, others with defaults), and update `.env.example` and `.env`
- Document `redis`, `minio`, `minio-init`, readiness checks, `docker compose build`, and `S3_PUBLIC_ENDPOINT` in `nestjs-project/CLAUDE.md` and `GEMINI.md`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Integration | Missing `S3_ACCESS_KEY` or `S3_SECRET_KEY` fails Joi validation at bootstrap; valid storage/queue/upload config loads with defaults |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` starts `db`, `mailpit`, `redis`, `minio`, `minio-init`, and `nestjs-api`, with `streamtube-media` bucket created automatically
- `docker compose exec nestjs-api ffprobe -version` succeeds inside the container
- Missing `S3_ACCESS_KEY` or `S3_SECRET_KEY` causes Joi validation failure on bootstrap
- Existing `GET /` E2E test continues returning `200`

---

### SI-03.2 — StorageModule and StorageService (S3/MinIO Dual-Client Wrapper)

**Description:** Create `StorageModule` and `StorageService` wrapping `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` with dual `S3Client` instances (`internalClient` using `S3_ENDPOINT` for server/worker operations and `publicSignerClient` using `S3_PUBLIC_ENDPOINT` for client-facing presigned URLs), both with `forcePathStyle: true`.

**Technical actions:**

- Create `src/storage/storage.service.ts` implementing:
  - `createMultipartUpload(key: string, mimeType: string): Promise<string>` (`CreateMultipartUploadCommand`, returns `UploadId`)
  - `presignUploadParts(key: string, uploadId: string, partNumbers: number[], ttlSeconds: number): Promise<{ part_number: number; url: string }[]>` (`UploadPartCommand` signed with `publicSignerClient`)
  - `completeMultipartUpload(key: string, uploadId: string, parts: { part_number: number; etag: string }[]): Promise<void>` (`CompleteMultipartUploadCommand` sorting parts ascending by `part_number`)
  - `abortMultipartUpload(key: string, uploadId: string): Promise<void>` (`AbortMultipartUploadCommand`)
  - `headObject(key: string): Promise<{ sizeBytes: number; contentType?: string }>` (`HeadObjectCommand`)
  - `putObject(key: string, body: Buffer, contentType: string): Promise<void>` (`PutObjectCommand`)
  - `deleteObject(key: string): Promise<void>` (`DeleteObjectCommand`)
  - `presignGetObject(key: string, ttlSeconds: number, options?: { responseContentType?: string; responseContentDisposition?: string }): Promise<string>` (`GetObjectCommand` signed with `publicSignerClient`)
  - `presignInternalGetObject(key: string, ttlSeconds: number): Promise<string>` (`GetObjectCommand` signed with `internalClient`)
- Create `src/storage/storage.module.ts` — provides and exports `StorageService`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.module.spec.ts` | Unit | `StorageModule` compiles with `ConfigModule` |
| `src/storage/storage.service.integration-spec.ts` | Integration | Real MinIO: 2-part multipart upload (5 MiB + 1 MiB) via presigned `PUT` URLs, `completeMultipartUpload`, `headObject` returns exact 6 MiB size, `presignGetObject` with `Range: bytes=0-1023` returns `206 Partial Content`, `ResponseContentDisposition` applied, `deleteObject` removes object |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Client-facing presigned URLs use `S3_PUBLIC_ENDPOINT` host while internal worker presigned URLs use `S3_ENDPOINT` (`http://minio:9000`)
- Multipart upload of 2 parts (5 MiB + 1 MiB) directly to presigned URLs completes and assembles a single 6 MiB object in `streamtube-media`
- Presigned GET URL supports HTTP `Range` requests returning `206 Partial Content` and applies `ResponseContentType` / `ResponseContentDisposition` query parameters

---

### SI-03.3 — Video Entity and CreateVideos Migration

**Description:** Create the `Video` entity (`videos` table) with `VideoStatus` enum (`draft | processing | ready | failed`), numeric transformers for `size_bytes` (`bigint → number`) and `duration_seconds` (`numeric(10,3) → number`), JSONB `metadata`, and `@ManyToOne(() => Channel, { onDelete: 'CASCADE' })`. Generate and review the `CreateVideos` migration.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with all columns per Data Model specification (`id`, `channel_id`, `slug`, `title`, `status`, `original_filename`, `mime_type`, `size_bytes`, `storage_key`, `upload_id`, `thumbnail_key`, `duration_seconds`, `metadata`, `failure_reason`, `uploaded_at`, `processed_at`, `created_at`, `updated_at`)
- Create skeleton `src/videos/videos.module.ts` with `TypeOrmModule.forFeature([Video])` and import it in `AppModule`
- Generate `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` and verify SQL (`videos_status_enum`, unique constraint on `slug`, indexes on `channel_id` and `status`, FK `channel_id → channels(id) ON DELETE CASCADE`)
- Update `cleanAllTables` in `src/test/create-test-data-source.ts` to truncate `videos` first (before `channels` and `users`)
- Update `src/database/migrations.integration-spec.ts` to include `CreateVideos` in bidirectional apply/revert verification

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Duplicate `slug` rejected (`23505`), invalid status enum rejected, `size_bytes` of 10 GiB (`10737418240`) round-trips as exact JS `number`, `duration_seconds` round-trips as `number`, `metadata` JSONB persisted, deleting `Channel` cascades to delete its `Video` rows |
| `src/database/migrations.integration-spec.ts` | Integration | `CreateVideos` applies and reverts cleanly |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run`, `npm run migration:revert`, and `npm run migration:run` execute without errors
- `size_bytes = 10737418240` (10 GiB) and `duration_seconds = 123.456` are returned as JavaScript `number` instances on entity load
- Duplicate `slug` violates the PostgreSQL unique constraint

---

### SI-03.4 — Video Upload Flow: Draft Pre-Registration, Part URL Refresh, and Completion with Queue Dispatch

**Description:** Implement `ChannelsService.findByUserId`, 11-character Base64URL slug generator (`slug.util.ts`), video domain exceptions, upload DTOs, `VideosService` (`initiateUpload`, `presignParts`, `completeUpload`), and `VideosController` (`POST /videos`, `POST /videos/:slug/upload/parts`, `POST /videos/:slug/upload/complete`).

**Technical actions:**

- Add `findByUserId(userId: string): Promise<Channel | null>` to `ChannelsService` (`src/channels/channels.service.ts`)
- Create `src/videos/slug.util.ts` — `generateVideoSlug(): string` using `crypto.randomBytes(8).toString('base64url')` (11 chars matching `^[A-Za-z0-9_-]{11}$`)
- Create `src/videos/videos.constants.ts` — queue name `'video-processing'`, job name `'process-video'`, allowed MIME types `['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']`, max slug retries `5`
- Create `src/videos/exceptions/video.exceptions.ts` — `VideoNotFoundException` (`404 VIDEO_NOT_FOUND`), `VideoUploadNotInProgressException` (`409 VIDEO_UPLOAD_NOT_IN_PROGRESS`), `InvalidUploadPartsException` (`400 INVALID_UPLOAD_PARTS`), `UploadSizeMismatchException` (`422 UPLOAD_SIZE_MISMATCH`) extending `DomainException`
- Create DTOs in `src/videos/dto/`:
  - `CreateVideoDto`: `filename` (`@IsString`, `@Length(1, 255)`), `size_bytes` (`@IsInt`, `@Min(1)`, `@Max(10737418240)`), `mime_type` (`@IsIn(ALLOWED_VIDEO_MIME_TYPES)`), `title?` (`@IsOptional`, `@IsString`, `@Length(1, 100)`)
  - `PresignPartsDto`: `part_numbers` (`@IsArray`, `@ArrayMinSize(1)`, `@ArrayMaxSize(100)`, `@ArrayUnique()`, `@IsInt({ each: true })`, `@Min(1, { each: true })`)
  - `CompleteUploadDto`: `parts` (`@IsArray`, `@ArrayMinSize(1)`, `@ValidateNested({ each: true })`, `@Type(() => CompletedPartDto)` with `part_number` `@IsInt @Min(1)` and `etag` `@IsString @IsNotEmpty`)
  - Response DTOs (`InitiateUploadResponseDto`, `PresignPartsResponseDto`, `CompleteUploadResponseDto`) with `@nestjs/swagger` decorators
- Implement `VideosService` (`src/videos/videos.service.ts`):
  - `initiateUpload(userId, dto)`: resolves user's channel, derives title from `filename` (strips extension, trims, truncates to 100 chars, fallback `'Untitled'`) when `dto.title` is omitted, generates unique 11-char slug with up to 5 collision retries, creates `Video` with `status = 'draft'` and `storage_key = 'videos/{id}/source'`, calls `storageService.createMultipartUpload`, saves `upload_id`, computes `part_size` (`uploadConfig.partSizeBytes`) and `part_count = Math.max(1, Math.ceil(size_bytes / part_size))`, and returns presigned part URLs and `expires_at`
  - `presignParts(userId, slug, dto)`: verifies video exists and belongs to `userId`'s channel (`404 VIDEO_NOT_FOUND` otherwise), verifies `status === 'draft'` (`409 VIDEO_UPLOAD_NOT_IN_PROGRESS` otherwise), verifies all `part_numbers` are within `1..part_count` (`400 INVALID_UPLOAD_PARTS` otherwise), returns new presigned URLs and `expires_at`
  - `completeUpload(userId, slug, dto)`: verifies ownership (`404`) and `status === 'draft'` (`409`), verifies `dto.parts` contains every part `1..part_count` with no duplicates (`400 INVALID_UPLOAD_PARTS`), calls `storageService.completeMultipartUpload` (mapping S3 errors to `400 INVALID_UPLOAD_PARTS`), verifies `headObject(storage_key).sizeBytes === video.size_bytes` (on mismatch: deletes object, updates video to `status = 'failed'` with `failure_reason`, throws `422 UPLOAD_SIZE_MISMATCH`), and inside `dataSource.transaction` executes conditional `UPDATE videos SET status = 'processing', uploaded_at = NOW(), upload_id = NULL WHERE id = :id AND status = 'draft'` (`409` if 0 rows affected) followed by `videoQueue.add('process-video', { videoId: video.id }, { jobId: video.id, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 100 })`
- Implement `VideosController` (`src/videos/videos.controller.ts`) with `@Throttle({ default: { ttl: 60000, limit: 60 } })`, Swagger decorators, and endpoints `POST /videos` (`201`), `POST /videos/:slug/upload/parts` (`200`), and `POST /videos/:slug/upload/complete` (`202`)
- Register `BullModule.forRootAsync` and `BullModule.registerQueue({ name: 'video-processing' })` in `VideosModule`
- Export updated `openapi.json` via `npm run openapi:export`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/channels/channels.service.spec.ts` | Unit | `findByUserId` returns channel or null |
| `src/channels/channels.service.integration-spec.ts` | Integration | `findByUserId` against real PostgreSQL |
| `src/videos/slug.util.spec.ts` | Unit | Generates 11-char Base64URL strings matching `^[A-Za-z0-9_-]{11}$` without collisions |
| `src/videos/dto/video-dtos.spec.ts` | Unit | `ValidationPipe` rejects `size_bytes: 10737418241`, `size_bytes: 0`, `mime_type: "image/png"`, duplicate/empty `part_numbers`, invalid `parts` |
| `src/videos/videos.service.spec.ts` | Unit | Part calculation (1 B, 64 MiB, 10 GiB), derived title from filename, slug collision retry, `404` for non-owner, `409` when not `draft`, `400` for missing/duplicate parts or S3 error, `422` size mismatch cleanup, transactional rollback if `queue.add` fails |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real Postgres + MinIO + Redis: `completeUpload` transitions `draft → processing`, creates BullMQ job with `jobId = video.id`, duplicate complete throws `409` without adding second job |
| `test/videos.e2e-spec.ts` | E2E | Upload endpoints (`401` unauthenticated, `201` initiate, `PUT` parts to MinIO, `200` refresh parts, `202` complete, `400` invalid parts/validation, `404` non-owner, `409` duplicate complete) |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` pre-registers video as `draft` in the authenticated user's channel and returns `upload.part_size`, `upload.part_count`, `upload.expires_at`, and `upload.parts`
- When `title` is omitted, `title` is derived from `filename` without extension (truncated to 100 chars)
- Files `> 10737418240` bytes or with unsupported MIME types (`image/png`) are rejected with `400 VALIDATION_ERROR` before creating any DB record
- `POST /videos/:slug/upload/parts` returns refreshed URLs for `1..part_count`, `400 INVALID_UPLOAD_PARTS` for out-of-range parts, `404 VIDEO_NOT_FOUND` for non-owners, and `409 VIDEO_UPLOAD_NOT_IN_PROGRESS` for non-`draft` videos
- `POST /videos/:slug/upload/complete` returns `202` with `status: "processing"`, assembles the object in MinIO, and enqueues a single `process-video` job; returns `400 INVALID_UPLOAD_PARTS` on missing/duplicate parts or invalid ETag; returns `422 UPLOAD_SIZE_MISMATCH` (marking video `failed` and deleting the object) when assembled size differs from `size_bytes`; returns `409` on repeated completion

---

### SI-03.5 — Video Worker: `FfmpegService`, `VideoProcessor`, `WorkerModule`, and `video-worker` Compose Service

**Description:** Implement `FfmpegService` (`probe` and `extractFrame` via `child_process.spawn` over internal presigned URLs), `VideoProcessor` (`@Processor('video-processing')` extending `WorkerHost` with retries, `UnrecoverableError`, and idempotency), standalone `WorkerModule` + `src/worker.ts`, and the `video-worker` Docker Compose service.

**Technical actions:**

- Create `src/video-worker/ffprobe-parser.ts` and `src/video-worker/ffmpeg.service.ts`:
  - `probe(internalUrl: string)`: spawns `ffprobe -v error -print_format json -show_format -show_streams <internalUrl>` with timeout; parses `duration_seconds` and `metadata: { width, height, video_codec, audio_codec, container, bitrate, frame_rate }`. Throws `UnrecoverableError('NO_VIDEO_STREAM')` when no stream has `codec_type === 'video'`
  - `extractFrame(internalUrl: string, timestampSeconds: number): Promise<Buffer>`: spawns `ffmpeg -ss <t> -i <internalUrl> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg pipe:1` with timeout and collects the JPEG buffer from `stdout`
- Create `src/video-worker/video.processor.ts` (`@Processor('video-processing')`, extends `WorkerHost`):
  - Loads `Video` by `job.data.videoId`; if not found or `status !== 'processing'`, exits without error (idempotent no-op)
  - Generates internal presigned GET URL (`storageService.presignInternalGetObject`), calls `ffmpegService.probe(url)`
  - Computes `seekSeconds = Math.min(1, duration_seconds * 0.1)`, calls `ffmpegService.extractFrame(url, seekSeconds)`
  - Uploads thumbnail to `videos/{id}/thumbnail.jpg` (`image/jpeg`) via `storageService.putObject`
  - Updates `Video` with conditional `WHERE id = :id AND status = 'processing'` setting `status = 'ready'`, `duration_seconds`, `metadata`, `thumbnail_key = 'videos/{id}/thumbnail.jpg'`, `processed_at = new Date()`
  - Implements `@OnWorkerEvent('failed')` to transition `Video` from `processing` to `failed` with `failure_reason` (truncated to 500 chars) when `error` is `UnrecoverableError` or `job.attemptsMade >= (job.opts.attempts ?? 1)`
- Create `src/video-worker/worker.module.ts` and `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`, `app.enableShutdownHooks()`)
- Add `"start:worker:dev": "nest start --watch --entryFile worker"` and `"start:worker:prod": "node dist/worker"` to `package.json`
- Add `video-worker` service to `compose.yaml` (`build: Dockerfile.dev`, `command: npm run start:worker:dev`, `restart: unless-stopped`, `depends_on` on `db`, `redis`, `minio`, `minio-init`)
- Document worker operation, logs, and startup order in `nestjs-project/CLAUDE.md` and `GEMINI.md`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/video-worker/ffprobe-parser.spec.ts` | Unit | Parses `ffprobe` JSON with audio, without audio (`audio_codec: null`), and throws `UnrecoverableError('NO_VIDEO_STREAM')` when video stream is missing |
| `src/video-worker/ffmpeg.service.integration-spec.ts` | Integration | Real `ffprobe` + `ffmpeg` + MinIO using dynamically generated 2s 320x240 MP4 fixture (`ffmpeg -f lavfi`): extracts `duration_seconds ≈ 2`, `320x240`, valid JPEG buffer (`0xFFD8` magic bytes, width ≤ 1280) |
| `src/video-worker/video.processor.spec.ts` | Unit | Skips non-`processing` videos, processes valid video to `ready`, throws `UnrecoverableError` on non-video, marks `failed` with truncated `failure_reason` on unrecoverable or exhausted attempts, rethrows transient storage errors for retry |
| `src/video-worker/video.processor.integration-spec.ts` | Integration | Real Postgres + MinIO + FFmpeg: valid video transitions `processing → ready` with metadata and thumbnail in MinIO; non-video file transitions to `failed` without thumbnail; redelivered job on `ready` video is a no-op |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Valid uploaded video is processed asynchronously to `status: "ready"` with `duration_seconds`, `metadata` (`width`, `height`, `video_codec`, `audio_codec`, `container`, `bitrate`, `frame_rate`), `thumbnail_key`, and `processed_at` populated
- Video without audio track completes as `ready` with `metadata.audio_codec = null`
- JPEG thumbnail is extracted at `min(1s, 10% duration)` with max width 1280px and stored at `videos/{id}/thumbnail.jpg`
- Object without a readable video stream fails immediately (`UnrecoverableError`) without retries and transitions to `status: "failed"` with `failure_reason`
- Transient errors retry up to 3 attempts; if all 3 fail, video transitions to `status: "failed"` with `failure_reason`
- Redelivered job for a video already in `ready` or `failed` exits cleanly without modifying the database or overwriting the thumbnail
- `docker compose up -d` starts `video-worker` connected to Redis, PostgreSQL, and MinIO using Docker service names

---

### SI-03.6 — Video Delivery: Optional Auth Guard, Metadata Endpoint, and `302` Redirects for Stream, Download, and Thumbnail

**Description:** Update `JwtAuthGuard` to support optional authentication on `@Public()` routes, implement `VideosService.findBySlugForViewer` and presigned redirect resolvers (`getStreamRedirectUrl`, `getDownloadRedirectUrl`, `getThumbnailRedirectUrl`), and expose `GET /videos/:slug`, `GET /videos/:slug/stream`, `GET /videos/:slug/download`, and `GET /videos/:slug/thumbnail` on `VideosController`.

**Technical actions:**

- Update `src/auth/guards/jwt-auth.guard.ts`: when `isPublic` is `true`, if an `Authorization: Bearer <token>` header is present, attempt `jwtService.verifyAsync(token)` and set `request.user = payload`; if verification fails or header is absent, leave `request.user = undefined` and return `true` (never throw `401` on `@Public()` routes). Protected routes remain unchanged (`401` on missing/invalid token)
- Update `src/auth/decorators/current-user.decorator.ts` typing to support optional user (`JwtPayload | undefined`) on `@Public()` routes
- Implement delivery methods in `VideosService`:
  - `findBySlugForViewer(slug: string, viewerUserId?: string)`: loads `Video` with `channel` relation (`id`, `nickname`, `name`, `user_id`). If not found, throws `404 VIDEO_NOT_FOUND`. If `status === 'ready'`, returns full metadata DTO including `stream_url: '/videos/${slug}/stream'`, `download_url: '/videos/${slug}/download'`, `thumbnail_url: '/videos/${slug}/thumbnail'`. If `status !== 'ready'`, checks `viewerUserId && video.channel.user_id === viewerUserId`; if owner, returns metadata DTO without `stream_url`/`download_url`/`thumbnail_url` (and includes `failure_reason` when `status === 'failed'`); if not owner or anonymous, throws `404 VIDEO_NOT_FOUND`
  - `getStreamRedirectUrl(slug: string)`: requires `status === 'ready'` (`404` otherwise); returns `storageService.presignGetObject(video.storage_key, downloadUrlTtlSeconds, { responseContentType: video.mime_type })`
  - `getDownloadRedirectUrl(slug: string)`: requires `status === 'ready'` (`404` otherwise); builds `attachment; filename="<ascii_fallback>"; filename*=UTF-8''<encoded>` from `video.original_filename` and returns `storageService.presignGetObject(video.storage_key, downloadUrlTtlSeconds, { responseContentType: video.mime_type, responseContentDisposition })`
  - `getThumbnailRedirectUrl(slug: string)`: requires `status === 'ready'` and `video.thumbnail_key` (`404` otherwise); returns `storageService.presignGetObject(video.thumbnail_key, downloadUrlTtlSeconds, { responseContentType: 'image/jpeg' })`
- Add `@Public()` endpoints to `VideosController`:
  - `GET /videos/:slug` (`200 OK`)
  - `GET /videos/:slug/stream` (`@SkipThrottle()`, `302 Found` redirect)
  - `GET /videos/:slug/download` (`@SkipThrottle()`, `302 Found` redirect)
  - `GET /videos/:slug/thumbnail` (`@SkipThrottle()`, `302 Found` redirect)
- Export updated `openapi.json` via `npm run openapi:export`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/auth/guards/jwt-auth.guard.spec.ts` | Unit | Public route with valid token populates `request.user`; public route with invalid/expired token proceeds anonymously (`true`, `request.user === undefined`); protected route still throws `401` |
| `src/videos/videos.service.spec.ts` | Unit | `findBySlugForViewer` visibility matrix (anonymous/owner/non-owner × `draft`/`processing`/`ready`/`failed`), stream/download/thumbnail redirect URL generation and `404` when not `ready` |
| `test/videos.e2e-spec.ts` | E2E | Complete lifecycle E2E: upload → complete → worker processes to `ready` → anonymous `GET /videos/:slug` (`200` with URLs) → `/stream` redirect followed with `Range: bytes=0-1023` returns `206 Partial Content` with `Content-Range` and 1024 bytes → `/download` redirect returns `200` with `Content-Disposition: attachment; filename="..."` → `/thumbnail` redirect returns `200` with `image/jpeg` → `processing`/`failed` visibility for owner (`200`) vs anonymous/other user (`404`) → invalid Bearer token on public route returns `200` → expired presigned URL returns `403` |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- `GET /videos/:slug` returns `200` with metadata and `stream_url`, `download_url`, `thumbnail_url` for any viewer when `status === 'ready'`
- `GET /videos/:slug` for `draft`, `processing`, or `failed` returns `200` (without media URLs, and with `failure_reason` when `failed`) for the authenticated owner, and `404 VIDEO_NOT_FOUND` for anonymous or non-owner callers
- Sending an invalid/expired Bearer token to `GET /videos/:slug` for a `ready` video treats the request as anonymous and returns `200`
- Following `GET /videos/:slug/stream` (`302`) with `Range: bytes=0-1023` returns `206 Partial Content` from MinIO with `Content-Range: bytes 0-1023/<size_bytes>` and 1024 bytes
- Following `GET /videos/:slug/download` (`302`) returns `200` from MinIO with `Content-Disposition: attachment; filename="<original_filename>"`
- Following `GET /videos/:slug/thumbnail` (`302`) returns `200` from MinIO with `Content-Type: image/jpeg`
- Requesting `/stream`, `/download`, or `/thumbnail` for a non-`ready` or non-existent video returns `404 VIDEO_NOT_FOUND`
- Presigned URLs expire after the configured TTL, after which MinIO returns `403 Forbidden`

---

## Technical Specifications

### Data Model

#### `videos` Table (`src/videos/entities/video.entity.ts`)

| Column | Type | Nullable | Default | Constraints / Notes |
|--------|------|----------|---------|---------------------|
| `id` | `uuid` | No | `uuid_generate_v4()` | Primary Key |
| `channel_id` | `uuid` | No | — | FK → `channels(id) ON DELETE CASCADE`, indexed (`IDX_videos_channel_id`) |
| `slug` | `varchar(11)` | No | — | `UNIQUE` (`UQ_videos_slug`), 11-char Base64URL `[A-Za-z0-9_-]{11}` |
| `title` | `varchar(100)` | No | — | Provided or derived from `original_filename` |
| `status` | `enum('draft','processing','ready','failed')` | No | `'draft'` | PostgreSQL enum `videos_status_enum`, indexed (`IDX_videos_status`) |
| `original_filename` | `varchar(255)` | No | — | Client filename at upload initiation |
| `mime_type` | `varchar(100)` | No | — | One of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` |
| `size_bytes` | `bigint` | No | — | `1..10737418240`, column transformer `{ to: (v) => v, from: (v) => Number(v) }` |
| `storage_key` | `varchar(512)` | No | — | `videos/{id}/source` |
| `upload_id` | `varchar(1024)` | Yes | `null` | Active S3 Multipart `UploadId`; cleared to `null` on `complete` |
| `thumbnail_key` | `varchar(512)` | Yes | `null` | `videos/{id}/thumbnail.jpg` once `ready` |
| `duration_seconds` | `numeric(10,3)` | Yes | `null` | Column transformer `{ to: (v) => v, from: (v) => (v === null ? null : Number(v)) }` |
| `metadata` | `jsonb` | Yes | `null` | `{ width, height, video_codec, audio_codec, container, bitrate, frame_rate }` |
| `failure_reason` | `varchar(500)` | Yes | `null` | Populated when `status = 'failed'` |
| `uploaded_at` | `timestamp` | Yes | `null` | Set when upload completes (`draft → processing`) |
| `processed_at` | `timestamp` | Yes | `null` | Set when processing succeeds (`processing → ready`) |
| `created_at` | `timestamp` | No | `now()` | `@CreateDateColumn()` |
| `updated_at` | `timestamp` | No | `now()` | `@UpdateDateColumn()` |

---

### API Contracts

#### POST /videos (SI-03.4)

**Request headers:**
- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`

**Request body:**
- `filename`: string, required — length 1..255
- `size_bytes`: integer, required — min `1`, max `10737418240` (10 GiB)
- `mime_type`: string, required — one of `'video/mp4'`, `'video/webm'`, `'video/quicktime'`, `'video/x-matroska'`
- `title`: string, optional — length 1..100 (derived from `filename` without extension if omitted)

**Response 201:**
```json
{
  "id": "uuid",
  "slug": "dQw4w9WgXcQ",
  "title": "Aula 1",
  "status": "draft",
  "upload": {
    "part_size": 67108864,
    "part_count": 3,
    "expires_at": "2026-10-24T21:00:00.000Z",
    "parts": [
      { "part_number": 1, "url": "http://localhost:9000/streamtube-media/..." },
      { "part_number": 2, "url": "http://localhost:9000/streamtube-media/..." },
      { "part_number": 3, "url": "http://localhost:9000/streamtube-media/..." }
    ]
  }
}
```

**Error responses:**
- `401`: missing or invalid access token
- `400 VALIDATION_ERROR`: invalid body (`size_bytes > 10737418240`, unsupported `mime_type`, etc.)

---

#### POST /videos/:slug/upload/parts (SI-03.4)

**Request headers:**
- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`

**Request body:**
- `part_numbers`: integer[], required — 1..100 unique integers `>= 1`

**Response 200:**
```json
{
  "expires_at": "2026-10-24T21:00:00.000Z",
  "parts": [
    { "part_number": 3, "url": "http://localhost:9000/streamtube-media/..." }
  ]
}
```

**Error responses:**
- `401`: missing or invalid access token
- `400 VALIDATION_ERROR` / `400 INVALID_UPLOAD_PARTS`: invalid `part_numbers` or part number `> part_count`
- `404 VIDEO_NOT_FOUND`: slug does not exist or authenticated user is not the channel owner
- `409 VIDEO_UPLOAD_NOT_IN_PROGRESS`: video status is not `draft`

---

#### POST /videos/:slug/upload/complete (SI-03.4)

**Request headers:**
- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`

**Request body:**
- `parts`: `{ part_number: integer, etag: string }[]`, required — complete list `1..part_count`

**Response 202:**
```json
{
  "id": "uuid",
  "slug": "dQw4w9WgXcQ",
  "status": "processing"
}
```

**Error responses:**
- `401`: missing or invalid access token
- `400 INVALID_UPLOAD_PARTS`: missing/duplicate part numbers or S3 multipart completion failure (invalid ETag / part too small)
- `404 VIDEO_NOT_FOUND`: slug does not exist or authenticated user is not the channel owner
- `409 VIDEO_UPLOAD_NOT_IN_PROGRESS`: video status is not `draft`
- `422 UPLOAD_SIZE_MISMATCH`: assembled object size in S3 does not match declared `size_bytes` (video marked `failed` and object deleted)

---

#### GET /videos/:slug (SI-03.6)

**Request headers:**
- `Authorization: Bearer <access_token>` (optional)

**Response 200 (when `status === 'ready'`):**
```json
{
  "id": "uuid",
  "slug": "dQw4w9WgXcQ",
  "title": "Aula 1",
  "status": "ready",
  "original_filename": "aula.mp4",
  "mime_type": "video/mp4",
  "size_bytes": 157286400,
  "duration_seconds": 120.5,
  "metadata": {
    "width": 1920,
    "height": 1080,
    "video_codec": "h264",
    "audio_codec": "aac",
    "container": "mov,mp4,m4a,3gp,3g2,mj2",
    "bitrate": 1044000,
    "frame_rate": 30
  },
  "channel": {
    "id": "uuid",
    "nickname": "tiago",
    "name": "tiago"
  },
  "created_at": "2026-10-24T20:00:00.000Z",
  "processed_at": "2026-10-24T20:01:00.000Z",
  "stream_url": "/videos/dQw4w9WgXcQ/stream",
  "download_url": "/videos/dQw4w9WgXcQ/download",
  "thumbnail_url": "/videos/dQw4w9WgXcQ/thumbnail"
}
```
*(When `status !== 'ready'` and caller is the authenticated owner: `stream_url`, `download_url`, and `thumbnail_url` are omitted; `failure_reason` is included when `status === 'failed'`.)*

**Error responses:**
- `404 VIDEO_NOT_FOUND`: video does not exist, or `status !== 'ready'` and caller is not the authenticated owner

---

#### GET /videos/:slug/stream, GET /videos/:slug/download, GET /videos/:slug/thumbnail (SI-03.6)

**Response 302:**
- `Location`: presigned S3 GET URL (`DOWNLOAD_URL_TTL_SECONDS`, default `3600`s)

**Error responses:**
- `404 VIDEO_NOT_FOUND`: video does not exist or `status !== 'ready'`

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Throttle | Notes |
|----------|--------|---------------|----------|-------|
| `POST /videos` | | ✓ | 60 req/min | Creates `draft` video in caller's channel |
| `POST /videos/:slug/upload/parts` | | ✓ (Owner) | 60 req/min | Returns `404` if caller is not owner |
| `POST /videos/:slug/upload/complete` | | ✓ (Owner) | 60 req/min | Returns `404` if caller is not owner |
| `GET /videos/:slug` | ✓ (Optional JWT) | ✓ (Owner for non-`ready`) | 60 req/min | `ready` is public; `draft`/`processing`/`failed` owner-only (`404` otherwise) |
| `GET /videos/:slug/stream` | ✓ | | `@SkipThrottle()` | `302` redirect when `ready`, `404` otherwise |
| `GET /videos/:slug/download` | ✓ | | `@SkipThrottle()` | `302` redirect when `ready`, `404` otherwise |
| `GET /videos/:slug/thumbnail` | ✓ | | `@SkipThrottle()` | `302` redirect when `ready`, `404` otherwise |

---

### Error Catalog

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| `VIDEO_NOT_FOUND` | 404 | Video not found | Unknown slug, non-owner accessing upload endpoints or non-`ready` metadata, or requesting stream/download/thumbnail for non-`ready` video |
| `VIDEO_UPLOAD_NOT_IN_PROGRESS` | 409 | Video upload is not in progress | Calling `/upload/parts` or `/upload/complete` when `video.status !== 'draft'` |
| `INVALID_UPLOAD_PARTS` | 400 | Invalid upload parts | Part numbers out of `1..part_count`, missing/duplicate parts on complete, or S3 `CompleteMultipartUpload` failure |
| `UPLOAD_SIZE_MISMATCH` | 422 | Uploaded object size does not match declared size | `HeadObject.ContentLength !== video.size_bytes` after multipart completion |

---

### Events/Messages

#### `process-video` (Queue: `video-processing`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` (per `phase-03-videos/TD-01`, `TD-05`)
**Consumer:** `VideoProcessor` in `video-worker` (per `phase-03-videos/TD-01`, `TD-04`, `TD-05`)
**Trigger:** Fired inside `VideosService.completeUpload` after `CompleteMultipartUpload` + `HeadObject` size verification and conditional `draft → processing` database update.
**Delivery semantics:** At-least-once with `jobId: videoId` deduplication, `attempts: 3`, exponential backoff (`delay: 5000ms`), `UnrecoverableError('NO_VIDEO_STREAM')` for non-retryable media errors, and idempotent `status === 'processing'` guard in `VideoProcessor`.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
└── SI-03.3

SI-03.2 + SI-03.3
└── SI-03.4
    └── SI-03.5
        └── SI-03.6
```

Linearized implementation order: `SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6`

---

## Deliverables

- [ ] `Dockerfile.dev` includes `ffmpeg` and `compose.yaml` runs `redis`, `minio`, `minio-init` (bucket `streamtube-media`), and `video-worker`
- [ ] `storage`, `queue`, and `upload` configuration namespaces registered and validated with Joi
- [ ] `StorageModule` and `StorageService` with dual `S3Client` instances (`internalClient` + `publicSignerClient`, `forcePathStyle: true`) tested against real MinIO
- [ ] `Video` entity (`videos` table) and `CreateVideos` migration with `video_status` enum, 11-char unique `slug`, and numeric transformers
- [ ] `POST /videos`, `POST /videos/:slug/upload/parts`, and `POST /videos/:slug/upload/complete` supporting direct-to-S3 multipart uploads up to 10 GiB with `draft` pre-registration and transactional BullMQ job dispatch
- [ ] `video-worker` (`src/worker.ts`, `WorkerModule`, `VideoProcessor`, `FfmpegService`) extracting duration, metadata, and JPEG thumbnail (`min(1s, 10% duration)`, max width 1280px) over internal presigned URLs
- [ ] Optional JWT authentication on `@Public()` routes in `JwtAuthGuard`
- [ ] `GET /videos/:slug`, `GET /videos/:slug/stream`, `GET /videos/:slug/download`, and `GET /videos/:slug/thumbnail` delivering metadata and `302` presigned redirects with HTTP `Range` (`206 Partial Content`) support
- [ ] All unit, integration, and E2E tests pass inside container (`npm test -- --runInBand`, `npm run test:e2e`)
- [ ] Zero TypeScript or ESLint errors (`npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run openapi:export`)
