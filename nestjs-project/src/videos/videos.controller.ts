import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import {
  CompleteUploadResponseDto,
  InitiateUploadResponseDto,
  PresignPartsResponseDto,
  VideoDetailsResponseDto,
} from './dto/video-responses.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Throttle({ default: { ttl: 60000, limit: 60 } })
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate multipart video upload',
    description:
      'Pre-registers the video as a draft in the authenticated user channel and returns presigned S3 multipart PUT URLs.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft video created and multipart upload initiated',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (size_bytes > 10 GiB or invalid mime_type)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':slug/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'slug', description: 'Unique 11-character video slug' })
  @ApiOperation({
    summary: 'Refresh presigned URLs for multipart upload parts',
    description:
      'Generates fresh presigned PUT URLs for up to 100 part numbers of an in-progress draft upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs refreshed',
    type: PresignPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or out-of-range part numbers',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignParts(
    @Param('slug') slug: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: PresignPartsDto,
  ): Promise<PresignPartsResponseDto> {
    return this.videosService.presignParts(user.sub, slug, dto);
  }

  @Post(':slug/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'slug', description: 'Unique 11-character video slug' })
  @ApiOperation({
    summary: 'Complete multipart video upload and enqueue processing',
    description:
      'Completes S3 multipart assembly, verifies final object size, transitions status to processing, and enqueues the background job.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed and video queued for background processing',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Missing/duplicate parts or invalid S3 ETag',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Assembled object size does not match declared size_bytes',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @Param('slug') slug: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, slug, dto);
  }

  @Public()
  @Get(':slug')
  @ApiParam({ name: 'slug', description: 'Unique 11-character video slug' })
  @ApiOperation({
    summary: 'Get video metadata and delivery URLs',
    description:
      'Returns video metadata. Ready videos are public and include stream/download/thumbnail URLs. Non-ready videos are visible only to the authenticated owner.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata retrieved',
    type: VideoDetailsResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not accessible to caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideoBySlug(
    @Param('slug') slug: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<VideoDetailsResponseDto> {
    return this.videosService.findBySlugForViewer(slug, user?.sub);
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/stream')
  @Redirect()
  @ApiParam({ name: 'slug', description: 'Unique 11-character video slug' })
  @ApiOperation({
    summary: 'Redirect to presigned video streaming URL (supports HTTP Range)',
    description:
      'Redirects (302) to a temporary presigned object storage URL supporting HTTP Range (206 Partial Content).',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to presigned streaming URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @Param('slug') slug: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamRedirectUrl(slug);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/download')
  @Redirect()
  @ApiParam({ name: 'slug', description: 'Unique 11-character video slug' })
  @ApiOperation({
    summary: 'Redirect to presigned video download URL',
    description:
      'Redirects (302) to a temporary presigned object storage URL with Content-Disposition: attachment.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadVideo(
    @Param('slug') slug: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadRedirectUrl(slug);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/thumbnail')
  @Redirect()
  @ApiParam({ name: 'slug', description: 'Unique 11-character video slug' })
  @ApiOperation({
    summary: 'Redirect to presigned video thumbnail JPEG URL',
    description:
      'Redirects (302) to a temporary presigned object storage URL for the video thumbnail JPEG.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to presigned thumbnail URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or thumbnail not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getThumbnail(
    @Param('slug') slug: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getThumbnailRedirectUrl(slug);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
