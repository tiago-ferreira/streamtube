export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export type AllowedVideoMimeType = (typeof ALLOWED_VIDEO_MIME_TYPES)[number];

export const DEFAULT_MAX_UPLOAD_SIZE_BYTES = 10737418240; // 10 GiB
export const MAX_SLUG_RETRIES = 5;
export const MAX_PRESIGN_PARTS_PER_REQUEST = 100;
