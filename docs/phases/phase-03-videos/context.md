---
scope_type: phase
scope_id: phase-03-videos
phase_number: 3
phase_name: "Upload e Processamento de Vídeos"
status: ready
created_at: "2026-10-24T20:07:35-03:00"
sources_mtime:
  docs/project-plan.md: "2026-10-24 18:36:20.316958738 -0300"
  docs/diagrams/software-arch.mermaid: "2026-10-24 18:36:20.316431891 -0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24 20:07:12.284490777 -0300"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-10-24 19:13:21.712332742 -0300"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-10-24 19:13:21.712332742 -0300"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-24 19:13:21.712332742 -0300"
  docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md: "2026-10-24 19:13:21.713660817 -0300"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-10-24 19:13:21.714051535 -0300"
---

# Context — Phase 03: Upload e Processamento de Vídeos

## Scope

**Origin:** `docs/project-plan.md` — Fase 03: Upload e Processamento de Vídeos

### Capabilities

1. Serviço de armazenamento de arquivos (vídeos e thumbnails)
2. Serviço de processamento em segundo plano (filas)
3. Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
4. Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
5. Processamento automático do vídeo após upload (extração de duração e metadados)
6. Geração automática de thumbnail a partir de um frame do vídeo
7. URL única por vídeo, sem conflito com outros vídeos
8. Reprodução via streaming (sem necessidade de download completo)
9. Download do vídeo pelo usuário

### Dependencies

- **Phase 01 (`phase-01-configuracao-base`)**: `UsersModule`, `ChannelsModule`, `Channel` entity (`channels` table with `user_id` FK), TypeORM setup (`src/database/`), `DomainException` + `DomainExceptionFilter`, `ConfigModule` (`registerAs` + Joi `env.validation.ts`), `createTestDataSource` / `cleanAllTables`.
- **Phase 02 (`phase-02-auth`)**: `AuthModule`, global `JwtAuthGuard` + `@Public()` + `@CurrentUser()`, global `ThrottlerGuard` + `@Throttle()` / `@SkipThrottle()`.
- **Task OpenAPI (`task-openapi-docs-nestjs`)**: Swagger decorators (`@ApiTags`, `@ApiOperation`, `@ApiResponse`, `@ApiBearerAuth`) and `npm run openapi:export`.

---

## Decisions Index

| Source File | TD | Title | Capability | Status |
|---|---|---|---|---|
| `docs/decisions/technical-decisions-phase-03-videos.md` | TD-01 | Background Queue Technology (BullMQ + Redis vs RabbitMQ, SQS, pg-boss) | Serviço de processamento em segundo plano (filas) | decided |
| `docs/decisions/technical-decisions-phase-03-videos.md` | TD-02 | Large Video Upload Strategy (S3 Multipart Presigned URLs) & Automatic Draft Pre-Registration | Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance, Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | decided |
| `docs/decisions/technical-decisions-phase-03-videos.md` | TD-03 | Storage Key Layout & Dual-Endpoint S3 Signing (`S3_ENDPOINT` vs `S3_PUBLIC_ENDPOINT`) | Serviço de armazenamento de arquivos (vídeos e thumbnails) | decided |
| `docs/decisions/technical-decisions-phase-03-videos.md` | TD-04 | Worker Architecture & FFmpeg Execution via `child_process.spawn` over HTTP Range | Processamento automático do vídeo após upload (extração de duração e metadados), Geração automática de thumbnail a partir de um frame do vídeo | decided |
| `docs/decisions/technical-decisions-phase-03-videos.md` | TD-05 | Video Status Lifecycle, Transaction Atomicity, Retries, and Idempotency | Serviço de processamento em segundo plano (filas), Processamento automático do vídeo após upload (extração de duração e metadados) | decided |
| `docs/decisions/technical-decisions-phase-03-videos.md` | TD-06 | Collision-Free Unique Video URL Identifier (11-char Base64URL Slug) | URL única por vídeo, sem conflito com outros vídeos | decided |
| `docs/decisions/technical-decisions-phase-03-videos.md` | TD-07 | Video Streaming (HTTP Range), Download, Thumbnail Redirects (`302`), and Optional Auth Visibility | Reprodução via streaming (sem necessidade de download completo), Download do vídeo pelo usuário | decided |

---

## Capability Coverage

| Capability (from `docs/project-plan.md`) | Covered By | Status |
|---|---|---|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | TD-03 | Covered |
| Serviço de processamento em segundo plano (filas) | TD-01, TD-05 | Covered |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | TD-02 | Covered |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | TD-02 | Covered |
| Processamento automático do vídeo após upload (extração de duração e metadados) | TD-04, TD-05 | Covered |
| Geração automática de thumbnail a partir de um frame do vídeo | TD-04 | Covered |
| URL única por vídeo, sem conflito com outros vídeos | TD-06 | Covered |
| Reprodução via streaming (sem necessidade de download completo) | TD-07 | Covered |
| Download do vídeo pelo usuário | TD-07 | Covered |

---

## Decisions Detail

### TD-01: Background Queue Technology (BullMQ + Redis vs RabbitMQ, SQS, pg-boss)
- **Capability:** Serviço de processamento em segundo plano (filas)
- **Recommendation:** Option A — BullMQ + Redis (`bullmq` + `@nestjs/bullmq`) on `redis:7-alpine` (`--maxmemory-policy noeviction --appendonly yes`).
- **Decision:** BullMQ + Redis (`bullmq` + `@nestjs/bullmq`) using queue `video-processing`, job name `process-video`, `jobId: videoId` for deduplication, 3 attempts with exponential backoff (`delay: 5000ms`), and `UnrecoverableError` for deterministic media failures (`NO_VIDEO_STREAM`).
- **Libraries:** `bullmq@^5.70.0`, `@nestjs/bullmq@^11.0.4`

### TD-02: Large Video Upload Strategy (S3 Multipart Presigned URLs) & Automatic Draft Pre-Registration
- **Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance, Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- **Recommendation:** Option A — Direct-to-S3 Multipart Upload with Presigned `PUT` URLs (`UPLOAD_PART_SIZE_BYTES=67108864` default), automatic `draft` pre-registration on `POST /videos`, on-demand part URL refresh on `POST /videos/:slug/upload/parts`, and verified completion on `POST /videos/:slug/upload/complete`.
- **Decision:** Direct-to-S3 Multipart Upload via presigned `UploadPartCommand` URLs (`UPLOAD_PART_SIZE_BYTES=67108864` default, 64 MiB), pre-registering the `Video` record with `status = 'draft'` on `POST /videos`, supporting URL refresh via `POST /videos/:slug/upload/parts`, and completing assembly + `HeadObject` size verification + transition to `processing` + BullMQ job dispatch on `POST /videos/:slug/upload/complete`.
- **Libraries:** `@aws-sdk/client-s3@^3.1000.0`, `@aws-sdk/s3-request-presigner@^3.1000.0`

### TD-03: Storage Key Layout & Dual-Endpoint S3 Signing (`S3_ENDPOINT` vs `S3_PUBLIC_ENDPOINT`)
- **Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)
- **Recommendation:** Option A — Single private bucket `streamtube-media` with keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`, and dual `S3Client` instances (`S3_ENDPOINT=http://minio:9000` and `S3_PUBLIC_ENDPOINT=http://localhost:9000`) with `forcePathStyle: true`.
- **Decision:** Single private bucket `streamtube-media` initialized by `minio-init`, deterministic keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`, and dual `S3Client` instances (`internalClient` on `S3_ENDPOINT` and `publicSignerClient` on `S3_PUBLIC_ENDPOINT`, both with `forcePathStyle: true`).
- **Libraries:** `@aws-sdk/client-s3@^3.1000.0`, `@aws-sdk/s3-request-presigner@^3.1000.0`

### TD-04: Worker Architecture & FFmpeg Execution via `child_process.spawn` over HTTP Range
- **Capability:** Processamento automático do vídeo após upload (extração de duração e metadados), Geração automática de thumbnail a partir de um frame do vídeo
- **Recommendation:** Option A — Standalone `src/worker.ts` (`WorkerModule`) in a dedicated `video-worker` container + `FfmpegService` using `child_process.spawn` (`ffprobe` JSON output + `ffmpeg` `pipe:1` JPEG output) over internal presigned S3 GET URLs.
- **Decision:** Dedicated `video-worker` Compose service running `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`) with `ffmpeg` installed in `Dockerfile.dev`, and `FfmpegService` invoking `ffprobe` and `ffmpeg` (`pipe:1`) via `child_process.spawn` over internal presigned URLs.
- **Libraries:** Built-in Node.js `node:child_process` + system binary `ffmpeg`

### TD-05: Video Status Lifecycle, Transaction Atomicity, Retries, and Idempotency
- **Capability:** Serviço de processamento em segundo plano (filas), Processamento automático do vídeo após upload (extração de duração e metadados)
- **Recommendation:** Option A — Conditional `UPDATE ... WHERE status = ...` guards, transactional `draft → processing` + `queue.add` (`jobId: videoId`, 3 attempts, 5s exponential backoff), `UnrecoverableError` for invalid media, and `@OnWorkerEvent('failed')` terminal failure recording.
- **Decision:** Enforce `video_status` (`draft | processing | ready | failed`) via conditional `WHERE status = ...` updates, transactional `completeUpload` + `queue.add` (`jobId: videoId`, `attempts: 3`, exponential backoff `5000ms`), `UnrecoverableError('NO_VIDEO_STREAM')`, and `@OnWorkerEvent('failed')` handler setting `status = 'failed'` with `failure_reason` (truncated to 500 chars).
- **Libraries:** `bullmq@^5.70.0`, `@nestjs/bullmq@^11.0.4`, `typeorm@^0.3.28`

### TD-06: Collision-Free Unique Video URL Identifier (11-char Base64URL Slug)
- **Capability:** URL única por vídeo, sem conflito com outros vídeos
- **Recommendation:** Option A — `crypto.randomBytes(8).toString('base64url')` stored in `varchar(11) UNIQUE` with up to 5 collision retries.
- **Decision:** 11-character Base64URL slug generated via `crypto.randomBytes(8).toString('base64url')`, enforced by a PostgreSQL `UNIQUE` constraint on `videos.slug` and a 5-attempt collision retry loop in `VideosService.initiateUpload`.
- **Libraries:** Built-in Node.js `node:crypto`

### TD-07: Video Streaming (HTTP Range), Download, Thumbnail Redirects (`302`), and Optional Auth Visibility
- **Capability:** Reprodução via streaming (sem necessidade de download completo), Download do vídeo pelo usuário
- **Recommendation:** Option A — `302 Found` redirects to presigned S3 GET URLs on `/stream`, `/download`, and `/thumbnail` (`@Public()`, `@SkipThrottle()`), combined with optional JWT authentication in `JwtAuthGuard` for owner visibility on `GET /videos/:slug`.
- **Decision:** `GET /videos/:slug/stream`, `/download`, and `/thumbnail` (`@Public()`, `@SkipThrottle()`) return `302 Found` redirects to presigned `GetObject` URLs (`DOWNLOAD_URL_TTL_SECONDS=3600`), delegating HTTP `Range` (`206 Partial Content`) and `Content-Disposition: attachment` delivery directly to MinIO/S3. `JwtAuthGuard` performs optional token verification on `@Public()` routes so `GET /videos/:slug` serves `ready` videos publicly and `draft`/`processing`/`failed` videos exclusively to their authenticated channel owner.
- **Libraries:** `@aws-sdk/client-s3@^3.1000.0`, `@aws-sdk/s3-request-presigner@^3.1000.0`

---

## Inherited Decisions & Conventions

1. **Architecture (`docs/diagrams/software-arch.mermaid` & `technical-decisions-next-frontend-config-base.md`)**:
   - Media files are stored in S3-compatible object storage (MinIO in development) and delivered via presigned URLs rather than streamed through `nestjs-api`.
   - Background processing runs in a dedicated `video-worker` container consuming from the message queue.
2. **Configuration (`phase-01-configuracao-base`)**:
   - All environment variables are validated at startup via Joi in `src/config/env.validation.ts` and exposed through typed `registerAs` namespaces (`src/config/*.config.ts`).
   - Internal container-to-container endpoints MUST use Docker Compose service names (`db`, `redis`, `minio`, `mailpit`), never `localhost`. Only browser-facing URLs (`APP_URL`, `S3_PUBLIC_ENDPOINT`) use `localhost` by default.
3. **Domain Error Handling (`phase-01-configuracao-base`)**:
   - Business/domain errors extend `DomainException` (`src/common/exceptions/domain.exception.ts`) and are formatted by `DomainExceptionFilter` into `{ statusCode, error, message }`.
   - DTO validation uses `class-validator` + `class-transformer` with global `ValidationPipe` returning `400 VALIDATION_ERROR`.
4. **Authentication & Rate Limiting (`phase-02-auth`)**:
   - `JwtAuthGuard` is registered globally via `APP_GUARD`; public endpoints opt out via `@Public()`.
   - `@CurrentUser()` extracts `{ sub, email }` from `request.user`.
   - `ThrottlerGuard` is registered globally (default 10 req/min); controllers/endpoints can override with `@Throttle()` or opt out with `@SkipThrottle()`.
5. **Database & Testing (`phase-01-configuracao-base` & `phase-02-auth`)**:
   - TypeORM entities use explicit snake_case column names and migrations generated via `npm run migration:generate`.
   - Tests are split into `*.spec.ts` (unit), `*.integration-spec.ts` (real PostgreSQL/MinIO/Redis), and `test/*.e2e-spec.ts` (full HTTP pipeline), executed inside the `nestjs-api` container with `--runInBand`.
   - `cleanAllTables(dataSource)` in `src/test/create-test-data-source.ts` truncates tables in child-first foreign-key order (`videos` must precede `channels` and `users`).
