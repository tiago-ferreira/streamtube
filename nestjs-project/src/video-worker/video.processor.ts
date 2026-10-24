import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import uploadConfig from '../config/upload.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { FfmpegService } from './ffmpeg.service';

export interface ProcessVideoJobPayload {
  videoId: string;
}

function isUnrecoverable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (
    error instanceof UnrecoverableError ||
    (error as { name?: string }).name === 'UnrecoverableError'
  );
}

@Processor(VIDEO_PROCESSING_QUEUE, {
  concurrency: Number(process.env.VIDEO_WORKER_CONCURRENCY || 2),
})
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(uploadConfig.KEY)
    private readonly uploadCfg: ConfigType<typeof uploadConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobPayload>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video || video.status !== VideoStatus.PROCESSING) {
      return;
    }

    try {
      const internalUrl = await this.storageService.presignInternalGetObject(
        video.storage_key,
        this.uploadCfg.downloadUrlTtlSeconds,
      );

      const { duration_seconds, metadata } =
        await this.ffmpegService.probe(internalUrl);

      const seekTimestamp = Math.min(1, duration_seconds * 0.1);
      const thumbnailBuffer = await this.ffmpegService.extractFrame(
        internalUrl,
        seekTimestamp,
      );

      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      await this.videoRepository
        .createQueryBuilder()
        .update(Video)
        .set({
          status: VideoStatus.READY,
          duration_seconds,
          metadata,
          thumbnail_key: thumbnailKey,
          processed_at: new Date(),
          failure_reason: null,
        })
        .where('id = :id AND status = :status', {
          id: video.id,
          status: VideoStatus.PROCESSING,
        })
        .execute();
    } catch (err) {
      if (isUnrecoverable(err)) {
        await this.markVideoFailed(video.id, err);
      }
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobPayload> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job?.data?.videoId) {
      return;
    }

    const maxAttempts = job.opts?.attempts ?? 1;
    const isTerminal =
      isUnrecoverable(error) || job.attemptsMade >= maxAttempts;

    if (isTerminal) {
      await this.markVideoFailed(job.data.videoId, error);
    } else {
      this.logger.warn(
        `Transient failure processing video ${job.data.videoId} (attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
      );
    }
  }

  private async markVideoFailed(
    videoId: string,
    error: unknown,
  ): Promise<void> {
    const rawReason =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown video processing failure';
    const failureReason = rawReason.slice(0, 500);

    await this.videoRepository
      .createQueryBuilder()
      .update(Video)
      .set({
        status: VideoStatus.FAILED,
        failure_reason: failureReason,
      })
      .where('id = :id AND status = :status', {
        id: videoId,
        status: VideoStatus.PROCESSING,
      })
      .execute();
  }
}
