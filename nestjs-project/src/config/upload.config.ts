import { registerAs } from '@nestjs/config';

export default registerAs('upload', () => ({
  maxSizeBytes: parseInt(
    process.env.UPLOAD_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES || '67108864', 10),
  uploadUrlTtlSeconds: parseInt(
    process.env.UPLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  downloadUrlTtlSeconds: parseInt(
    process.env.DOWNLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  workerConcurrency: parseInt(process.env.VIDEO_WORKER_CONCURRENCY || '2', 10),
}));
