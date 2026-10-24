import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';
import type { VideoMetadata } from '../entities/video.entity';

export class PresignedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 'http://localhost:9000/streamtube-media/...' })
  url: string;
}

export class UploadSessionDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;

  @ApiProperty({ example: '2026-10-24T21:00:00.000Z' })
  expires_at: string;

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];
}

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty({ example: 'Aula 1' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ type: UploadSessionDto })
  upload: UploadSessionDto;
}

export class PresignPartsResponseDto {
  @ApiProperty({ example: '2026-10-24T21:00:00.000Z' })
  expires_at: string;

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];
}

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;
}

export class VideoChannelSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'tiago' })
  nickname: string;

  @ApiProperty({ example: 'tiago' })
  name: string;
}

export class VideoDetailsResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty({ example: 'Aula 1' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ example: 'aula.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ example: 157286400 })
  size_bytes: number;

  @ApiProperty({ nullable: true, example: 120.5 })
  duration_seconds: number | null;

  @ApiProperty({ nullable: true })
  metadata: VideoMetadata | null;

  @ApiProperty({ type: VideoChannelSummaryDto })
  channel: VideoChannelSummaryDto;

  @ApiProperty()
  created_at: Date;

  @ApiProperty({ nullable: true })
  processed_at: Date | null;

  @ApiPropertyOptional({ example: '/videos/dQw4w9WgXcQ/stream' })
  stream_url?: string;

  @ApiPropertyOptional({ example: '/videos/dQw4w9WgXcQ/download' })
  download_url?: string;

  @ApiPropertyOptional({ example: '/videos/dQw4w9WgXcQ/thumbnail' })
  thumbnail_url?: string;

  @ApiPropertyOptional({ example: 'NO_VIDEO_STREAM' })
  failure_reason?: string | null;
}
