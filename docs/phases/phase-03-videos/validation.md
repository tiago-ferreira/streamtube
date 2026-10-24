---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-24 20:08:09.597492024 -0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24 20:07:12.284490777 -0300"
issues: []
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **OQ-01 (TD-01: Queue Technology)** — Resolved `2026-10-24`: Selected Option A (`bullmq@^5.70.0` + `@nestjs/bullmq@^11.0.4` backed by `redis:7-alpine` with `--maxmemory-policy noeviction --appendonly yes`).
- **OQ-02 (TD-02: Multipart Upload & Draft Pre-Registration)** — Resolved `2026-10-24`: Selected Option A (Direct-to-S3 Multipart Upload with presigned `UploadPartCommand` URLs, `UPLOAD_PART_SIZE_BYTES=67108864` default, automatic `draft` pre-registration on `POST /videos`, part URL refresh on `POST /videos/:slug/upload/parts`, and verified completion on `POST /videos/:slug/upload/complete`).
- **OQ-03 (TD-03: Storage Key Layout & Dual-Endpoint Signing)** — Resolved `2026-10-24`: Selected Option A (Single private bucket `streamtube-media`, deterministic keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`, dual `S3Client` instances on `S3_ENDPOINT=http://minio:9000` and `S3_PUBLIC_ENDPOINT=http://localhost:9000` with `forcePathStyle: true`).
- **OQ-04 (TD-04: Worker Architecture & FFmpeg Execution)** — Resolved `2026-10-24`: Selected Option A (`src/worker.ts` with `NestFactory.createApplicationContext(WorkerModule)` in dedicated `video-worker` Compose container; `FfmpegService` using `child_process.spawn` for `ffprobe` JSON metadata and `ffmpeg` `pipe:1` JPEG thumbnail over internal presigned URLs).
- **OQ-05 (TD-05: Status Lifecycle, Retries & Idempotency)** — Resolved `2026-10-24`: Selected Option A (Optimistic `WHERE status = ...` SQL guards, transactional `draft → processing` + `queue.add` with `jobId: videoId`, 3 attempts, 5000ms exponential backoff, `UnrecoverableError('NO_VIDEO_STREAM')`, and `@OnWorkerEvent('failed')` setting `status = 'failed'` with `failure_reason`).
- **OQ-06 (TD-06: Unique Video URL Slug)** — Resolved `2026-10-24`: Selected Option A (11-char Base64URL slug via `crypto.randomBytes(8).toString('base64url')`, `UNIQUE` constraint on `videos.slug`, and 5-attempt collision retry loop).
- **OQ-07 (TD-07: Streaming, Download, Thumbnail Redirects & Optional Auth)** — Resolved `2026-10-24`: Selected Option A (`302 Found` redirects on `/stream`, `/download`, `/thumbnail` with `@Public()` + `@SkipThrottle()`; optional JWT authentication in `JwtAuthGuard` for `@Public()` routes so `GET /videos/:slug` exposes non-ready videos only to their authenticated owner).
