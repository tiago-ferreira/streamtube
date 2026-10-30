import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (Integration)', () => {
  let moduleRef: TestingModule;
  let storageService: StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT =
      process.env.S3_ENDPOINT || 'http://minio:9000';

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    storageService = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await moduleRef.close();
  });

  it('should execute a 2-part multipart upload (5 MiB + 1 MiB), headObject, presigned Range GET (206), Content-Disposition, and deleteObject against MinIO', async () => {
    const videoId = randomUUID();
    const key = `videos/${videoId}/source`;
    createdKeys.push(key);

    const part1Size = 5 * 1024 * 1024; // 5 MiB (S3 minimum for non-final part)
    const part2Size = 1 * 1024 * 1024; // 1 MiB
    const totalSize = part1Size + part2Size;

    const part1Buffer = Buffer.alloc(part1Size, 0x61); // 'a'
    const part2Buffer = Buffer.alloc(part2Size, 0x62); // 'b'

    // 1. Initiate multipart upload
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    expect(uploadId).toBeTruthy();

    // 2. Presign parts 1 and 2
    const presignedParts = await storageService.presignUploadParts(
      key,
      uploadId,
      [1, 2],
      3600,
    );
    expect(presignedParts).toHaveLength(2);
    expect(presignedParts[0].part_number).toBe(1);
    expect(presignedParts[1].part_number).toBe(2);

    // 3. PUT each part directly to MinIO using the presigned URLs
    const put1Res = await fetch(presignedParts[0].url, {
      method: 'PUT',
      body: part1Buffer,
    });
    expect(put1Res.status).toBe(200);
    const etag1 = put1Res.headers.get('etag');
    expect(etag1).toBeTruthy();

    const put2Res = await fetch(presignedParts[1].url, {
      method: 'PUT',
      body: part2Buffer,
    });
    expect(put2Res.status).toBe(200);
    const etag2 = put2Res.headers.get('etag');
    expect(etag2).toBeTruthy();

    // 4. Complete multipart upload (pass out of order to verify sorting)
    await storageService.completeMultipartUpload(key, uploadId, [
      { part_number: 2, etag: etag2! },
      { part_number: 1, etag: etag1! },
    ]);

    // 5. HeadObject verifies exact total size and Content-Type
    const head = await storageService.headObject(key);
    expect(head.sizeBytes).toBe(totalSize);
    expect(head.contentType).toBe('video/mp4');

    // 6. Presigned GET with Range header returns 206 Partial Content
    const streamUrl = await storageService.presignGetObject(key, 3600, {
      responseContentType: 'video/mp4',
    });
    const rangeRes = await fetch(streamUrl, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toBe(
      `bytes 0-1023/${totalSize}`,
    );
    expect(rangeRes.headers.get('content-type')).toBe('video/mp4');
    const rangeBytes = Buffer.from(await rangeRes.arrayBuffer());
    expect(rangeBytes.length).toBe(1024);
    expect(rangeBytes.equals(part1Buffer.subarray(0, 1024))).toBe(true);

    // 7. Presigned GET with ResponseContentDisposition returns attachment header
    const downloadUrl = await storageService.presignGetObject(key, 3600, {
      responseContentType: 'video/mp4',
      responseContentDisposition: 'attachment; filename="aula.mp4"',
    });
    const downloadRes = await fetch(downloadUrl);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );

    // 8. Delete object and confirm headObject rejects
    await storageService.deleteObject(key);
    await expect(storageService.headObject(key)).rejects.toThrow();
  }, 30_000);
});
