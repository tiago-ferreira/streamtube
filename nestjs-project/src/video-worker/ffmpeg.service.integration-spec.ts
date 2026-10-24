import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { generateSyntheticMp4Buffer } from '../test/video-fixture';
import { FfmpegService } from './ffmpeg.service';

describe('FfmpegService (Integration)', () => {
  let moduleRef: TestingModule;
  let storageService: StorageService;
  let ffmpegService: FfmpegService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
      providers: [FfmpegService],
    }).compile();

    storageService = moduleRef.get(StorageService);
    ffmpegService = moduleRef.get(FfmpegService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await moduleRef.close();
  });

  it('probes a 2s 320x240 MP4 over internal presigned URL and extracts a valid JPEG frame with width <= 1280', async () => {
    const videoId = randomUUID();
    const sourceKey = `videos/${videoId}/source`;
    const thumbKey = `videos/${videoId}/thumbnail.jpg`;
    createdKeys.push(sourceKey, thumbKey);

    const mp4Buffer = generateSyntheticMp4Buffer(2, 320, 240);
    await storageService.putObject(sourceKey, mp4Buffer, 'video/mp4');

    const internalUrl = await storageService.presignInternalGetObject(
      sourceKey,
      3600,
    );

    const probeResult = await ffmpegService.probe(internalUrl);
    expect(probeResult.duration_seconds).toBeCloseTo(2, 0);
    expect(probeResult.metadata.width).toBe(320);
    expect(probeResult.metadata.height).toBe(240);
    expect(probeResult.metadata.video_codec).toBe('h264');
    expect(probeResult.metadata.audio_codec).toBe('aac');

    const seekAt = Math.min(1, probeResult.duration_seconds * 0.1);
    const jpegBuffer = await ffmpegService.extractFrame(internalUrl, seekAt);

    // JPEG magic bytes 0xFFD8 ... 0xFFD9
    expect(jpegBuffer[0]).toBe(0xff);
    expect(jpegBuffer[1]).toBe(0xd8);

    // Upload JPEG to MinIO and verify dimensions via ffprobe
    await storageService.putObject(thumbKey, jpegBuffer, 'image/jpeg');
    const thumbUrl = await storageService.presignInternalGetObject(
      thumbKey,
      3600,
    );
    const thumbProbe = await ffmpegService.probe(thumbUrl);
    expect(thumbProbe.metadata.video_codec).toBe('mjpeg');
    expect(thumbProbe.metadata.width).toBe(320);
    expect(thumbProbe.metadata.width).toBeLessThanOrEqual(1280);
    expect(thumbProbe.metadata.height).toBe(240);
  });
});
