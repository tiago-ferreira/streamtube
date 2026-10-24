import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateSyntheticMp4Buffer } from '../src/test/video-fixture';
import { WorkerModule } from '../src/video-worker/worker.module';
import { VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let videoQueue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let mp4Fixture: Buffer;
  const createdStorageKeys: string[] = [];

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT =
      process.env.S3_ENDPOINT || 'http://minio:9000';
    process.env.UPLOAD_PART_SIZE_BYTES = String(5 * 1024 * 1024); // 5 MiB

    mp4Fixture = generateSyntheticMp4Buffer(2, 320, 240);

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule, WorkerModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storageService = moduleFixture.get(StorageService);
    videoQueue = moduleFixture.get<Queue>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30_000);

  afterAll(async () => {
    for (const key of createdStorageKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await videoQueue.obliterate({ force: true }).catch(() => undefined);
    await videoQueue.resume().catch(() => undefined);
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await videoQueue.pause();
    await videoQueue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ access_token: string; refresh_token: string }> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken })
      .expect(204);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    return loginRes.body as { access_token: string; refresh_token: string };
  }

  async function waitForVideoStatus(
    slug: string,
    ownerToken: string,
    targetStatuses: VideoStatus[],
    timeoutMs = 15_000,
  ): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      if (
        res.status === 200 &&
        targetStatuses.includes(res.body.status as VideoStatus)
      ) {
        return res.body;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(
      `Timed out waiting for video ${slug} to reach status ${targetStatuses.join('|')}`,
    );
  }

  describe('Upload validation, authentication, and authorization', () => {
    it('rejects unauthenticated requests to upload endpoints with 401', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          filename: 'aula.mp4',
          size_bytes: 1024,
          mime_type: 'video/mp4',
        })
        .expect(401);

      await request(app.getHttpServer())
        .post('/videos/dQw4w9WgXcQ/upload/parts')
        .send({ part_numbers: [1] })
        .expect(401);

      await request(app.getHttpServer())
        .post('/videos/dQw4w9WgXcQ/upload/complete')
        .send({ parts: [{ part_number: 1, etag: '"abc"' }] })
        .expect(401);
    });

    it('rejects size_bytes > 10 GiB (10737418241) and unsupported mime_type (image/png) with 400 VALIDATION_ERROR', async () => {
      const { access_token } =
        await registerConfirmAndLogin('val@streamtube.com');

      const tooLargeRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'too-big.mp4',
          size_bytes: 10737418241,
          mime_type: 'video/mp4',
        })
        .expect(400);
      expect(tooLargeRes.body.error).toBe('VALIDATION_ERROR');

      const badMimeRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'image.png',
          size_bytes: 1024,
          mime_type: 'image/png',
        })
        .expect(400);
      expect(badMimeRes.body.error).toBe('VALIDATION_ERROR');
    });

    it('pre-registers draft video with derived title when title is omitted, refreshes part URLs, and enforces owner/range/status checks', async () => {
      const owner = await registerConfirmAndLogin('owner1@streamtube.com');
      const other = await registerConfirmAndLogin('other1@streamtube.com');

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({
          filename: 'minha-viagem.mov',
          size_bytes: 8 * 1024 * 1024, // 8 MiB -> 2 parts of 5 MiB
          mime_type: 'video/quicktime',
        })
        .expect(201);

      const { id, slug, title, status, upload } = createRes.body;
      createdStorageKeys.push(`videos/${id}/source`);

      expect(slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(title).toBe('minha-viagem');
      expect(status).toBe('draft');
      expect(upload.part_count).toBe(2);
      expect(upload.parts).toHaveLength(2);

      // Valid refresh of part 2
      const refreshRes = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/parts`)
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({ part_numbers: [2] })
        .expect(200);
      expect(refreshRes.body.parts).toHaveLength(1);
      expect(refreshRes.body.parts[0].part_number).toBe(2);

      // Out-of-range part number -> 400 INVALID_UPLOAD_PARTS
      const outOfRangeRes = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/parts`)
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({ part_numbers: [3] })
        .expect(400);
      expect(outOfRangeRes.body.error).toBe('INVALID_UPLOAD_PARTS');

      // Non-owner -> 404 VIDEO_NOT_FOUND
      const nonOwnerPartsRes = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/parts`)
        .set('Authorization', `Bearer ${other.access_token}`)
        .send({ part_numbers: [1] })
        .expect(404);
      expect(nonOwnerPartsRes.body.error).toBe('VIDEO_NOT_FOUND');

      const nonOwnerCompleteRes = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${other.access_token}`)
        .send({
          parts: [
            { part_number: 1, etag: '"e1"' },
            { part_number: 2, etag: '"e2"' },
          ],
        })
        .expect(404);
      expect(nonOwnerCompleteRes.body.error).toBe('VIDEO_NOT_FOUND');

      // Incomplete parts list on complete -> 400 INVALID_UPLOAD_PARTS
      const badCompleteRes = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({
          parts: [{ part_number: 1, etag: '"e1"' }],
        })
        .expect(400);
      expect(badCompleteRes.body.error).toBe('INVALID_UPLOAD_PARTS');
    });
  });

  describe('Full video lifecycle: upload -> processing -> ready -> metadata, stream (Range 206), download, thumbnail', () => {
    it('completes upload (202), restricts visibility while processing, processes to ready via worker, and serves metadata, Range stream (206), attachment download, and JPEG thumbnail', async () => {
      const owner = await registerConfirmAndLogin('creator@streamtube.com');
      const other = await registerConfirmAndLogin('viewer@streamtube.com');

      // 1. Initiate upload for real 2s 320x240 MP4 fixture
      const initRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({
          filename: 'aula.mp4',
          size_bytes: mp4Fixture.length,
          mime_type: 'video/mp4',
          title: 'Aula 1',
        })
        .expect(201);

      const { id, slug, upload } = initRes.body;
      createdStorageKeys.push(
        `videos/${id}/source`,
        `videos/${id}/thumbnail.jpg`,
      );
      expect(upload.part_count).toBe(1);

      // 2. Upload part 1 directly to MinIO
      const putRes = await fetch(upload.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(mp4Fixture),
      });
      expect(putRes.status).toBe(200);
      const etag = putRes.headers.get('etag')!;

      // 3. Complete upload (queue is paused so video stays in 'processing' until resumed)
      const completeRes = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({
          parts: [{ part_number: 1, etag }],
        })
        .expect(202);

      expect(completeRes.body).toEqual({
        id,
        slug,
        status: 'processing',
      });

      // 4. Duplicate complete returns 409 VIDEO_UPLOAD_NOT_IN_PROGRESS
      const dupCompleteRes = await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({
          parts: [{ part_number: 1, etag }],
        })
        .expect(409);
      expect(dupCompleteRes.body.error).toBe('VIDEO_UPLOAD_NOT_IN_PROGRESS');

      // 5. Refreshing parts on a 'processing' video returns 409
      await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/parts`)
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({ part_numbers: [1] })
        .expect(409);

      // 6. While 'processing': owner sees 200 without media URLs; anonymous & other user get 404
      const ownerProcessingRes = await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${owner.access_token}`)
        .expect(200);
      expect(ownerProcessingRes.body.status).toBe('processing');
      expect(ownerProcessingRes.body.stream_url).toBeUndefined();
      expect(ownerProcessingRes.body.download_url).toBeUndefined();
      expect(ownerProcessingRes.body.thumbnail_url).toBeUndefined();

      await request(app.getHttpServer()).get(`/videos/${slug}`).expect(404);
      await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${other.access_token}`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/videos/${slug}/thumbnail`)
        .expect(404);

      // 7. Resume queue so VideoProcessor processes the video to 'ready'
      await videoQueue.resume();
      await waitForVideoStatus(slug, owner.access_token, [VideoStatus.READY]);

      // 8. Anonymous GET /videos/:slug returns 200 with metadata and delivery URLs
      const anonReadyRes = await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .expect(200);

      expect(anonReadyRes.body).toMatchObject({
        id,
        slug,
        title: 'Aula 1',
        status: 'ready',
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: mp4Fixture.length,
        stream_url: `/videos/${slug}/stream`,
        download_url: `/videos/${slug}/download`,
        thumbnail_url: `/videos/${slug}/thumbnail`,
      });
      expect(anonReadyRes.body.duration_seconds).toBeCloseTo(2, 0);
      expect(anonReadyRes.body.metadata).toMatchObject({
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
      });
      expect(anonReadyRes.body.channel).toMatchObject({
        nickname: 'creator',
        name: 'creator',
      });

      // 9. Invalid Bearer token on public route is treated as anonymous (200)
      await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .set('Authorization', 'Bearer invalid.expired.token')
        .expect(200);

      // 10. GET /videos/:slug/stream returns 302 and supports Range: bytes=0-1023 -> 206 Partial Content
      const streamRedirect = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .expect(302);
      const streamLocation = streamRedirect.headers.location;
      expect(streamLocation).toBeTruthy();

      const rangeRes = await fetch(streamLocation, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBe(
        `bytes 0-1023/${mp4Fixture.length}`,
      );
      expect(rangeRes.headers.get('content-type')).toBe('video/mp4');
      const rangeBody = Buffer.from(await rangeRes.arrayBuffer());
      expect(rangeBody.length).toBe(1024);
      expect(rangeBody.equals(mp4Fixture.subarray(0, 1024))).toBe(true);

      // 11. GET /videos/:slug/download returns 302 with Content-Disposition: attachment; filename="aula.mp4"
      const downloadRedirect = await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .expect(302);
      const downloadLocation = downloadRedirect.headers.location;
      const downloadRes = await fetch(downloadLocation);
      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(downloadRes.headers.get('content-disposition')).toContain(
        'filename="aula.mp4"',
      );
      const downloadedBytes = Buffer.from(await downloadRes.arrayBuffer());
      expect(downloadedBytes.length).toBe(mp4Fixture.length);

      // 12. GET /videos/:slug/thumbnail returns 302 and serves image/jpeg
      const thumbRedirect = await request(app.getHttpServer())
        .get(`/videos/${slug}/thumbnail`)
        .expect(302);
      const thumbLocation = thumbRedirect.headers.location;
      const thumbRes = await fetch(thumbLocation);
      expect(thumbRes.status).toBe(200);
      expect(thumbRes.headers.get('content-type')).toBe('image/jpeg');
      const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
      expect(thumbBytes[0]).toBe(0xff);
      expect(thumbBytes[1]).toBe(0xd8);

      // 13. Expired presigned URL returns 403 from MinIO
      const shortTtlUrl = await storageService.presignGetObject(
        `videos/${id}/source`,
        1,
      );
      await new Promise((r) => setTimeout(r, 1500));
      const expiredRes = await fetch(shortTtlUrl);
      expect(expiredRes.status).toBe(403);
    }, 30_000);

    it('marks non-video upload as failed and exposes failure_reason only to the owner', async () => {
      const owner = await registerConfirmAndLogin('failowner@streamtube.com');
      const nonVideoBytes = Buffer.from('not a valid video file content');

      const initRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({
          filename: 'corrupt.mp4',
          size_bytes: nonVideoBytes.length,
          mime_type: 'video/mp4',
        })
        .expect(201);

      const { id, slug, upload } = initRes.body;
      createdStorageKeys.push(`videos/${id}/source`);

      const putRes = await fetch(upload.parts[0].url, {
        method: 'PUT',
        body: nonVideoBytes,
      });
      const etag = putRes.headers.get('etag')!;

      await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(202);

      await videoQueue.resume();
      const failedBody = await waitForVideoStatus(slug, owner.access_token, [
        VideoStatus.FAILED,
      ]);

      expect(failedBody.status).toBe('failed');
      expect(failedBody.failure_reason).toBeTruthy();

      // Anonymous viewer gets 404 for failed video
      await request(app.getHttpServer()).get(`/videos/${slug}`).expect(404);
    }, 20_000);
  });
});
