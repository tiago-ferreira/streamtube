import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  DEFAULT_MAX_UPLOAD_SIZE_BYTES,
} from '../videos.constants';

export class CreateVideoDto {
  @ApiProperty({
    description: 'Original video filename with extension',
    example: 'aula.mp4',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @Length(1, 255)
  filename: string;

  @ApiProperty({
    description: 'Exact file size in bytes (1 byte up to 10 GiB)',
    example: 157286400,
    minimum: 1,
    maximum: DEFAULT_MAX_UPLOAD_SIZE_BYTES,
  })
  @IsInt()
  @Min(1)
  @Max(
    Number(process.env.UPLOAD_MAX_SIZE_BYTES) || DEFAULT_MAX_UPLOAD_SIZE_BYTES,
  )
  size_bytes: number;

  @ApiProperty({
    description: 'Video MIME type',
    enum: ALLOWED_VIDEO_MIME_TYPES,
    example: 'video/mp4',
  })
  @IsString()
  @IsIn(ALLOWED_VIDEO_MIME_TYPES)
  mime_type: string;

  @ApiPropertyOptional({
    description:
      'Optional video title (1..100 chars). Defaults to filename without extension.',
    example: 'Aula 1',
    minLength: 1,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;
}
