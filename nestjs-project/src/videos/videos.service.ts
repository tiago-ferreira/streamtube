import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import uploadConfig from '../config/upload.config';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import {
  CompleteUploadResponseDto,
  InitiateUploadResponseDto,
  PresignPartsResponseDto,
  VideoDetailsResponseDto,
} from './dto/video-responses.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  InvalidUploadPartsException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoUploadNotInProgressException,
} from './exceptions/video.exceptions';
import { generateVideoSlug } from './slug.util';
import {
  MAX_SLUG_RETRIES,
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';

function isSlugUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes('slug')
  );
}

export function deriveVideoTitle(
  filename: string,
  providedTitle?: string,
): string {
  if (providedTitle !== undefined && providedTitle.trim().length > 0) {
    return providedTitle.trim().slice(0, 100);
  }
  const lastDot = filename.lastIndexOf('.');
  const withoutExt = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const trimmed = withoutExt.trim().slice(0, 100);
  return trimmed.length > 0 ? trimmed : 'Untitled';
}

export function buildAttachmentDisposition(originalFilename: string): string {
  const asciiFallback =
    originalFilename
      .replace(/["\\\r\n]/g, '_')
      .replace(/[^\x20-\x7E]/g, '_')
      .trim() || 'video';
  const encoded = encodeURIComponent(originalFilename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(uploadConfig.KEY)
    private readonly uploadCfg: ConfigType<typeof uploadConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue,
  ) {}

  computePartCount(sizeBytes: number): number {
    return Math.max(1, Math.ceil(sizeBytes / this.uploadCfg.partSizeBytes));
  }

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException('Channel not found for user');
    }

    const videoId = randomUUID();
    const storageKey = `videos/${videoId}/source`;
    const title = deriveVideoTitle(dto.filename, dto.title);

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.mime_type,
    );

    let savedVideo: Video | null = null;
    try {
      for (let attempt = 0; attempt <= MAX_SLUG_RETRIES; attempt++) {
        const slug = generateVideoSlug();
        const existing = await this.videoRepository.findOne({
          where: { slug },
        });
        if (existing) {
          continue;
        }

        try {
          const entity = this.videoRepository.create({
            id: videoId,
            channel_id: channel.id,
            slug,
            title,
            status: VideoStatus.DRAFT,
            original_filename: dto.filename,
            mime_type: dto.mime_type,
            size_bytes: dto.size_bytes,
            storage_key: storageKey,
            upload_id: uploadId,
          });
          savedVideo = await this.videoRepository.save(entity);
          break;
        } catch (err) {
          if (isSlugUniqueViolation(err)) {
            continue;
          }
          throw err;
        }
      }

      if (!savedVideo) {
        throw new Error('Slug conflict could not be resolved after max retries');
      }
    } catch (err) {
      await this.storageService
        .abortMultipartUpload(storageKey, uploadId)
        .catch(() => undefined);
      throw err;
    }

    const partSize = this.uploadCfg.partSizeBytes;
    const partCount = this.computePartCount(dto.size_bytes);
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const ttlSeconds = this.uploadCfg.uploadUrlTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const parts = await this.storageService.presignUploadParts(
      storageKey,
      uploadId,
      partNumbers,
      ttlSeconds,
    );

    return {
      id: savedVideo.id,
      slug: savedVideo.slug,
      title: savedVideo.title,
      status: savedVideo.status,
      upload: {
        part_size: partSize,
        part_count: partCount,
        expires_at: expiresAt,
        parts,
      },
    };
  }

  async presignParts(
    userId: string,
    slug: string,
    dto: PresignPartsDto,
  ): Promise<PresignPartsResponseDto> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: ['channel'],
    });

    if (!video || !video.channel || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }

    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoUploadNotInProgressException();
    }

    const partCount = this.computePartCount(Number(video.size_bytes));
    const uniqueParts = new Set(dto.part_numbers);
    if (uniqueParts.size !== dto.part_numbers.length) {
      throw new InvalidUploadPartsException('Duplicate part numbers are not allowed');
    }

    for (const partNumber of dto.part_numbers) {
      if (
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > partCount
      ) {
        throw new InvalidUploadPartsException(
          `Part number ${partNumber} is out of valid range 1..${partCount}`,
        );
      }
    }

    const ttlSeconds = this.uploadCfg.uploadUrlTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const parts = await this.storageService.presignUploadParts(
      video.storage_key,
      video.upload_id,
      dto.part_numbers,
      ttlSeconds,
    );

    return {
      expires_at: expiresAt,
      parts,
    };
  }

  async completeUpload(
    userId: string,
    slug: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: ['channel'],
    });

    if (!video || !video.channel || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }

    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoUploadNotInProgressException();
    }

    const partCount = this.computePartCount(Number(video.size_bytes));
    if (!Array.isArray(dto.parts) || dto.parts.length !== partCount) {
      throw new InvalidUploadPartsException(
        `Expected ${partCount} parts, received ${dto.parts?.length ?? 0}`,
      );
    }

    const seenPartNumbers = new Set<number>();
    for (const part of dto.parts) {
      if (
        !Number.isInteger(part.part_number) ||
        part.part_number < 1 ||
        part.part_number > partCount ||
        seenPartNumbers.has(part.part_number) ||
        typeof part.etag !== 'string' ||
        part.etag.trim().length === 0
      ) {
        throw new InvalidUploadPartsException();
      }
      seenPartNumbers.add(part.part_number);
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id,
        dto.parts,
      );
    } catch {
      throw new InvalidUploadPartsException(
        'Storage rejected multipart completion (invalid ETag or part size)',
      );
    }

    const head = await this.storageService.headObject(video.storage_key);
    const expectedSize = Number(video.size_bytes);
    if (head.sizeBytes !== expectedSize) {
      await this.storageService
        .deleteObject(video.storage_key)
        .catch(() => undefined);
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          upload_id: null,
          failure_reason: `Uploaded size (${head.sizeBytes}) does not match declared size_bytes (${expectedSize})`,
        },
      );
      throw new UploadSizeMismatchException();
    }

    await this.dataSource.transaction(async (manager) => {
      const updateResult = await manager
        .createQueryBuilder()
        .update(Video)
        .set({
          status: VideoStatus.PROCESSING,
          uploaded_at: new Date(),
          upload_id: null,
        })
        .where('id = :id AND status = :status', {
          id: video.id,
          status: VideoStatus.DRAFT,
        })
        .execute();

      if (!updateResult.affected || updateResult.affected === 0) {
        throw new VideoUploadNotInProgressException();
      }

      await this.videoQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId: video.id },
        {
          jobId: video.id,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    });

    return {
      id: video.id,
      slug: video.slug,
      status: VideoStatus.PROCESSING,
    };
  }

  async findBySlugForViewer(
    slug: string,
    viewerUserId?: string,
  ): Promise<VideoDetailsResponseDto> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: ['channel'],
    });

    if (!video || !video.channel) {
      throw new VideoNotFoundException();
    }

    const isOwner = Boolean(
      viewerUserId && video.channel.user_id === viewerUserId,
    );

    if (video.status !== VideoStatus.READY && !isOwner) {
      throw new VideoNotFoundException();
    }

    const response: VideoDetailsResponseDto = {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      original_filename: video.original_filename,
      mime_type: video.mime_type,
      size_bytes: Number(video.size_bytes),
      duration_seconds:
        video.duration_seconds === null ? null : Number(video.duration_seconds),
      metadata: video.metadata,
      channel: {
        id: video.channel.id,
        nickname: video.channel.nickname,
        name: video.channel.name,
      },
      created_at: video.created_at,
      processed_at: video.processed_at,
    };

    if (video.status === VideoStatus.READY) {
      response.stream_url = `/videos/${video.slug}/stream`;
      response.download_url = `/videos/${video.slug}/download`;
      response.thumbnail_url = `/videos/${video.slug}/thumbnail`;
    }

    if (video.status === VideoStatus.FAILED && isOwner) {
      response.failure_reason = video.failure_reason;
    }

    return response;
  }

  async getStreamRedirectUrl(slug: string): Promise<string> {
    const video = await this.videoRepository.findOne({ where: { slug } });
    if (!video || video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }

    return this.storageService.presignGetObject(
      video.storage_key,
      this.uploadCfg.downloadUrlTtlSeconds,
      {
        responseContentType: video.mime_type,
      },
    );
  }

  async getDownloadRedirectUrl(slug: string): Promise<string> {
    const video = await this.videoRepository.findOne({ where: { slug } });
    if (!video || video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }

    return this.storageService.presignGetObject(
      video.storage_key,
      this.uploadCfg.downloadUrlTtlSeconds,
      {
        responseContentType: video.mime_type,
        responseContentDisposition: buildAttachmentDisposition(
          video.original_filename,
        ),
      },
    );
  }

  async getThumbnailRedirectUrl(slug: string): Promise<string> {
    const video = await this.videoRepository.findOne({ where: { slug } });
    if (!video || video.status !== VideoStatus.READY || !video.thumbnail_key) {
      throw new VideoNotFoundException();
    }

    return this.storageService.presignGetObject(
      video.thumbnail_key,
      this.uploadCfg.downloadUrlTtlSeconds,
      {
        responseContentType: 'image/jpeg',
      },
    );
  }
}
