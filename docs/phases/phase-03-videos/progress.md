# phase-03-videos — Progress

**Status:** completed
**SIs:** 6/6 completed
**Full Suite Summary (DoD):**
- **Unit & Integration (`npm test -- --runInBand`):** 34/34 suites, 193/193 tests passing
- **End-to-End (`npm run test:e2e`):** 4/4 suites, 57/57 tests passing
- **TypeScript (`npx tsc --noEmit`):** exit code 0 (0 errors)
- **ESLint (`npm run lint`):** exit code 0 (0 errors)
- **Build (`npm run build`):** exit code 0 (`dist/main.js` and `dist/worker.js` built cleanly)

### SI-03.1 — Infrastructure: Docker Compose (`redis`, `minio`, `minio-init`), `ffmpeg` Image, Dependencies, and Config Namespaces
- **Status:** completed
- **Tests:** 6/6 passing (`src/config/env.validation.integration-spec.ts`, `test/app.e2e-spec.ts`)
- **Observations:** Used `elestio/minio:latest` in `compose.yaml` because upstream `minio/minio` removed public `:latest` images from Docker Hub; `elestio/minio:latest` includes both `minio` server and `mc` client binaries.

### SI-03.2 — StorageModule and StorageService (S3/MinIO Dual-Client Wrapper)
- **Status:** completed
- **Tests:** 2/2 passing (`src/storage/storage.module.spec.ts`, `src/storage/storage.service.integration-spec.ts`)
- **Observations:** Dual `S3Client` instances (`internalClient` + `publicSignerClient`) verified against real MinIO with 2-part multipart upload, `headObject`, HTTP `Range` (`206 Partial Content`), and `ResponseContentDisposition`.

### SI-03.3 — Video Entity and CreateVideos Migration
- **Status:** completed
- **Tests:** 6/6 passing (`src/videos/entities/video.entity.integration-spec.ts`, `src/database/migrations.integration-spec.ts`)
- **Observations:** Generated `1792884116464-CreateVideos.ts` migration with `video_status` enum, unique `slug`, `channel_id` and `status` indexes, and `ON DELETE CASCADE` FK. Changed `DROP TABLE` loop in `migrations.integration-spec.ts` to run sequentially to avoid PostgreSQL lock contention across FK-linked tables.

### SI-03.4 — Video Upload Flow: Draft Pre-Registration, Part URL Refresh, and Completion with Queue Dispatch
- **Status:** completed
- **Tests:** 40/40 passing (`src/channels/channels.service.spec.ts`, `src/channels/channels.service.integration-spec.ts`, `src/videos/slug.util.spec.ts`, `src/videos/dto/video-dtos.spec.ts`, `src/videos/videos.service.spec.ts`, `src/videos/videos.service.integration-spec.ts`, `src/openapi-export.integration-spec.ts`, `test/videos.e2e-spec.ts`)
- **Observations:** Implemented `POST /videos`, `POST /videos/:slug/upload/parts`, and `POST /videos/:slug/upload/complete` with transactional conditional `draft → processing` transition and BullMQ `jobId: videoId` deduplication.

### SI-03.5 — Video Worker: `FfmpegService`, `VideoProcessor`, `WorkerModule`, and `video-worker` Compose Service
- **Status:** completed
- **Tests:** 11/11 passing (`src/video-worker/ffprobe-parser.spec.ts`, `src/video-worker/ffmpeg.service.integration-spec.ts`, `src/video-worker/video.processor.spec.ts`, `src/video-worker/video.processor.integration-spec.ts`)
- **Observations:** Extracted synthetic MP4 fixture helper to `src/test/video-fixture.ts` so E2E and integration suites share it cleanly without cross-importing `.integration-spec.ts` files. Added `image: nestjs-project-nestjs-api:latest` to `nestjs-api` and `video-worker` in `compose.yaml` so both services share the single built image.

### SI-03.6 — Video Delivery: Optional Auth Guard, Metadata Endpoint, and `302` Redirects for Stream, Download, and Thumbnail
- **Status:** completed
- **Tests:** 58/58 passing (`src/auth/guards/jwt-auth.guard.spec.ts`: 7 unit, `src/videos/videos.service.spec.ts`: 16 unit, `test/videos.e2e-spec.ts`: 5 E2E, `test/auth.e2e-spec.ts`: 46 E2E)
- **Observations:** Updated `JwtAuthGuard` to attach `request.user` when a valid Bearer token is present on `@Public()` routes and fall back to anonymous (`undefined`) when absent/invalid. Verified `302` redirects for `/stream` (`206 Partial Content` with `Range`), `/download` (`Content-Disposition: attachment`), `/thumbnail` (`image/jpeg`), and `403` on expired presigned URLs.

---

## Critérios de Aceite Review (`streamtube.md` — Fase 03)

- [x] **Serviço de armazenamento de arquivos (vídeos e thumbnails):** MinIO (`streamtube-media` bucket) + `StorageService` (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`).
- [x] **Serviço de processamento em segundo plano (filas):** Redis 7 + BullMQ (`video-processing` queue, `process-video` job) + `video-worker` (`src/worker.ts`).
- [x] **Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance:** Direct-to-S3 multipart upload via presigned `PUT` URLs (`1..10737418240` bytes); zero video bytes pass through `nestjs-api`.
- [x] **Pré-cadastro automático do vídeo como rascunho ao iniciar o upload:** `POST /videos` creates `Video` row with `status = 'draft'` in the user's channel and derives `title` from `filename` if omitted.
- [x] **Processamento automático do vídeo após upload (extração de duração e metadados):** `POST /videos/:slug/upload/complete` transitions to `processing` and enqueues `process-video`; `VideoProcessor` runs `ffprobe` over internal presigned URL and stores `duration_seconds` and `metadata` (`width`, `height`, `video_codec`, `audio_codec`, `container`, `bitrate`, `frame_rate`).
- [x] **Geração automática de thumbnail a partir de um frame do vídeo:** `FfmpegService.extractFrame` extracts JPEG frame at `min(1s, 10% duration)` scaled to `min(1280, iw)` and stores at `videos/{id}/thumbnail.jpg`.
- [x] **URL única por vídeo, sem conflito com outros vídeos:** 11-char Base64URL `slug` (`^[A-Za-z0-9_-]{11}$`) with PostgreSQL `UNIQUE` constraint and 5-attempt collision retry loop.
- [x] **Reprodução via streaming (sem necessidade de download completo):** `GET /videos/:slug/stream` returns `302` redirect to presigned S3 GET URL supporting HTTP `Range` (`206 Partial Content`).
- [x] **Download do vídeo pelo usuário:** `GET /videos/:slug/download` returns `302` redirect to presigned S3 GET URL with `Content-Disposition: attachment; filename="<original_filename>"`.
