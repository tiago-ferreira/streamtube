# GEMINI.md

> Antigravity / Gemini instructions for `nestjs-project/`. Mirrors `CLAUDE.md` with `.agents/rules/` references.

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, redis, minio, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all long-running services must show status "running" (minio-init exits 0 after creating bucket)
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO (Bucket check):** `docker compose exec minio /bin/sh -c "mc alias set local http://localhost:9000 minioadmin minioadmin >/dev/null && mc ls local"` — expect `streamtube-media/`
- **FFmpeg (inside `nestjs-api`):** `docker compose exec nestjs-api ffprobe -version` — expect `ffprobe version`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Build image when Dockerfile.dev changes (e.g. ffmpeg installation)
docker compose build

# Start containers
docker compose up -d

# Install dependencies (first time or after package.json changes)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (built from `Dockerfile.dev`, includes `ffmpeg` / `ffprobe`)
- `video-worker` — Standalone NestJS background worker (`src/worker.ts`, `WorkerModule`), runs `npm run start:worker:dev` (`restart: unless-stopped`), consumes BullMQ queue `video-processing` (`process-video` jobs)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — Mailpit SMTP (`1025`) and Web UI (`8025`)
- `redis` — Redis 7 (`redis:7-alpine`, `--maxmemory-policy noeviction --appendonly yes`), port `6379` (BullMQ backing store)
- `minio` — MinIO S3-compatible object storage, S3 API on port `9000`, Web Console on port `9001` (`minioadmin` / `minioadmin`)
- `minio-init` — One-shot container that creates the private `streamtube-media` bucket (`mc mb --ignore-existing`) when `minio` becomes healthy

### Video Worker Operation & Startup Order

`video-worker` shares the bind-mounted codebase volume (`node_modules`) with `nestjs-api`. After `docker compose up -d` and `docker compose exec nestjs-api npm install`, inspect worker readiness with `docker compose logs video-worker` (expect `VideoWorker started and listening on queue "video-processing"`). Worker scripts: `npm run start:worker:dev` and `npm run start:worker:prod`.

### Dual S3 Endpoint Rule (`S3_ENDPOINT` vs `S3_PUBLIC_ENDPOINT`)

SigV4 presigned URLs include the `Host` header in the cryptographic signature:
- `S3_ENDPOINT=http://minio:9000` is used by `nestjs-api` and `video-worker` for internal container-to-container S3 API calls and internal worker presigned URLs.
- `S3_PUBLIC_ENDPOINT=http://localhost:9000` is used exclusively to sign URLs returned to external clients (browsers, `curl` on host) for multipart part uploads and `302` stream/download/thumbnail redirects. In container-internal integration/E2E tests that follow presigned URLs from inside `nestjs-api`, override `S3_PUBLIC_ENDPOINT=http://minio:9000`.

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test -- --runInBand                  # Unit + integration tests
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
```
