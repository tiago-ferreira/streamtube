---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1000.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-24T20:08:30-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1000.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-24T20:08:30-03:00"
  "bullmq":
    version: "^5.70.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-24T20:08:30-03:00"
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-24T20:08:30-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24 20:07:12.284490777 -0300"
---

# Library References — phase-03-videos

Cached Context7 excerpts and verified API signatures for libraries decided in Phase 03 (`Upload e Processamento de Vídeos`). Compatible with NestJS 11 (`@nestjs/common ^11.0.1`, `@nestjs/core ^11.0.1`).

---

## 1. `@aws-sdk/client-s3` & `@aws-sdk/s3-request-presigner`

**Version line:** `^3.1000.0`
**Decided in:** `TD-02`, `TD-03`, `TD-07`
**Context7 ID:** `/aws/aws-sdk-js-v3`

### Client Instantiation (`forcePathStyle` & Dual-Endpoint Signing)

MinIO requires `forcePathStyle: true` so bucket names are placed in the URL path (`http://minio:9000/streamtube-media/videos/...`) rather than virtual-hosted subdomains (`http://streamtube-media.minio:9000/...`).

Because SigV4 includes the `Host` header in the canonical request signature, `StorageService` instantiates two `S3Client` instances:
1. `internalClient` (`endpoint = S3_ENDPOINT`, e.g., `http://minio:9000`) for server-to-storage calls (`send(...)`) and internal worker presigned URLs (`presignInternalGetObject`).
2. `publicSignerClient` (`endpoint = S3_PUBLIC_ENDPOINT`, e.g., `http://localhost:9000`) used exclusively with `getSignedUrl(this.publicSignerClient, command, { expiresIn })` (which signs offline without making network calls).

```typescript
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const internalClient = new S3Client({
  region: config.region,
  endpoint: config.endpoint, // http://minio:9000
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey,
  },
});

const publicSignerClient = new S3Client({
  region: config.region,
  endpoint: config.publicEndpoint, // http://localhost:9000
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey,
  },
});
```

### Multipart Upload Lifecycle & Presigning Parts

```typescript
// 1. Initiate multipart upload
const { UploadId } = await internalClient.send(
  new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: mimeType,
  }),
);

// 2. Presign individual UploadPartCommand URLs (signed with publicSignerClient)
const url = await getSignedUrl(
  publicSignerClient,
  new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber, // 1-indexed integer (1..10000)
  }),
  { expiresIn: ttlSeconds },
);

// 3. Complete multipart upload (Parts MUST be sorted ascending by PartNumber)
await internalClient.send(
  new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts
        .slice()
        .sort((a, b) => a.part_number - b.part_number)
        .map((p) => ({
          PartNumber: p.part_number,
          ETag: p.etag,
        })),
    },
  }),
);
```

### Presigning `GetObjectCommand` for Stream, Download, and Thumbnail

```typescript
const url = await getSignedUrl(
  publicSignerClient,
  new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentType: options?.responseContentType,
    ResponseContentDisposition: options?.responseContentDisposition,
  }),
  { expiresIn: ttlSeconds },
);
```

### Key Pitfalls & Notes
- **Part size minimum:** S3/MinIO enforces a minimum part size of `5 MiB` (`5 * 1024 * 1024 = 5,242,880` bytes) for every part except the last part in `CompleteMultipartUploadCommand` (otherwise S3 throws `EntityTooSmall`).
- **Part ordering:** `CompleteMultipartUploadCommand` requires `MultipartUpload.Parts` sorted in strictly ascending order by `PartNumber`.
- **`ResponseContentDisposition` RFC 5987 encoding:** For filenames with non-ASCII characters or quotes, sanitize the ASCII fallback `filename="..."` and include `filename*=UTF-8''${encodeURIComponent(originalFilename)}`.

---

## 2. `bullmq` & `@nestjs/bullmq`

**Version line:** `bullmq@^5.70.0`, `@nestjs/bullmq@^11.0.4`
**Decided in:** `TD-01`, `TD-05`
**Context7 ID:** `/taskforcesh/bullmq`, `/nestjs/bull`

### Root & Queue Registration (`VideosModule` / `WorkerModule`)

```typescript
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';

BullModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => ({
    connection: {
      host: configService.getOrThrow<string>('queue.redisHost'),
      port: configService.getOrThrow<number>('queue.redisPort'),
    },
  }),
});

BullModule.registerQueue({
  name: 'video-processing',
});
```

### Producer (`@InjectQueue` in `VideosService`)

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(
  @InjectQueue('video-processing')
  private readonly videoQueue: Queue,
) {}

await this.videoQueue.add(
  'process-video',
  { videoId: video.id },
  {
    jobId: video.id, // Deduplicates active jobs per videoId
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: 100,
  },
);
```

### Consumer (`@Processor`, `WorkerHost`, `@OnWorkerEvent`, `UnrecoverableError`)

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';

@Processor('video-processing', {
  concurrency: Number(process.env.VIDEO_WORKER_CONCURRENCY ?? 2),
})
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // Throw UnrecoverableError to abort remaining retry attempts immediately:
    // throw new UnrecoverableError('NO_VIDEO_STREAM');
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ videoId: string }> | undefined, error: Error): Promise<void> {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    const isTerminal =
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError' ||
      job.attemptsMade >= maxAttempts;

    if (isTerminal) {
      // Transition video status from 'processing' to 'failed' with truncated failure_reason
    }
  }
}
```

### Key Pitfalls & Notes
- **Redis `maxmemory-policy`:** BullMQ requires Redis `maxmemory-policy noeviction` so job keys are never silently evicted under memory pressure.
- **Standalone Worker Bootstrap (`src/worker.ts`):** Use `await NestFactory.createApplicationContext(WorkerModule)` and `app.enableShutdownHooks()` so `WorkerHost` closes active BullMQ workers cleanly on `SIGTERM`/`SIGINT`.
- **Job ID Deduplication:** Note that BullMQ rejects custom `jobId` values containing `:` or consisting purely of digits; standard UUID v4 strings (`video.id`) are valid. When `removeOnComplete: true` is set, completed jobs are removed immediately, whereas failed jobs remain up to `removeOnFail: 100` preserving deduplication history.
