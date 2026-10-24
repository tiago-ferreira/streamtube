import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { generateSyntheticMp4Buffer } from '../test/video-fixture';
import { VideoProcessor } from './video.processor';

describe('VideoProcessor (Integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let processor: VideoProcessor;
  let storageService: StorageService;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;
  const createdStorageKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, uploadConfig],
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'db',
          port: Number(process.env.DB_PORT ?? 5432),
          username: process.env.DB_USERNAME ?? 'streamtube',
          password: process.env.DB_PASSWORD ?? 'streamtube',
          database: process.env.DB_NAME ?? 'streamtube',
          entities: [User, Channel, RefreshToken, VerificationToken, Video],
          synchronize: false,
        }),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessor],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    processor = moduleRef.get(VideoProcessor);
    storageService = moduleRef.get(StorageService);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterAll(async () => {
    for (const key of createdStorageKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  async function seedChannel(): Promise<Channel> {
    const user = await userRepo.save(
      userRepo.create({
        email: 'worker-owner@streamtube.com',
        password: 'hashed-password',
        is_confirmed: true,
      }),
    );
    return channelRepo.save(
      channelRepo.create({
        name: 'Worker Owner',
        nickname: 'worker_owner',
        user_id: user.id,
      }),
    );
  }

  it('processes a valid MP4 video from processing to ready with metadata and thumbnail in MinIO, and ignores redelivered jobs once ready', async () => {
    const channel = await seedChannel();
    const mp4Buffer = generateSyntheticMp4Buffer(2, 320, 240);

    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        slug: 'ValidVid123',
        title: 'Valid Video',
        status: VideoStatus.PROCESSING,
        original_filename: 'valid.mp4',
        mime_type: 'video/mp4',
        size_bytes: mp4Buffer.length,
        storage_key: 'videos/placeholder/source',
        uploaded_at: new Date(),
      }),
    );

    const sourceKey = `videos/${video.id}/source`;
    const thumbKey = `videos/${video.id}/thumbnail.jpg`;
    await videoRepo.update({ id: video.id }, { storage_key: sourceKey });
    createdStorageKeys.push(sourceKey, thumbKey);

    await storageService.putObject(sourceKey, mp4Buffer, 'video/mp4');

    // Run processor
    await processor.process({
      data: { videoId: video.id },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any);

    const readyVideo = await videoRepo.findOneByOrFail({ id: video.id });
    expect(readyVideo.status).toBe(VideoStatus.READY);
    expect(readyVideo.duration_seconds).toBeCloseTo(2, 0);
    expect(readyVideo.metadata?.width).toBe(320);
    expect(readyVideo.metadata?.height).toBe(240);
    expect(readyVideo.metadata?.video_codec).toBe('h264');
    expect(readyVideo.thumbnail_key).toBe(thumbKey);
    expect(readyVideo.processed_at).toBeInstanceOf(Date);

    // Thumbnail object exists in MinIO
    const thumbHead = await storageService.headObject(thumbKey);
    expect(thumbHead.sizeBytes).toBeGreaterThan(0);
    expect(thumbHead.contentType).toBe('image/jpeg');

    // Redelivered job for a ready video is a no-op
    const firstProcessedAt = readyVideo.processed_at;
    await processor.process({
      data: { videoId: video.id },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as any);

    const afterRedelivery = await videoRepo.findOneByOrFail({ id: video.id });
    expect(afterRedelivery.status).toBe(VideoStatus.READY);
    expect(afterRedelivery.processed_at?.getTime()).toBe(
      firstProcessedAt?.getTime(),
    );
  });

  it('transitions a non-video file to failed with failure_reason and throws UnrecoverableError without creating a thumbnail', async () => {
    const channel = await seedChannel();
    const invalidBuffer = Buffer.from('this is plain text, not a video stream');

    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        slug: 'BadVideo123',
        title: 'Not A Video',
        status: VideoStatus.PROCESSING,
        original_filename: 'fake.mp4',
        mime_type: 'video/mp4',
        size_bytes: invalidBuffer.length,
        storage_key: 'videos/placeholder/source',
        uploaded_at: new Date(),
      }),
    );

    const sourceKey = `videos/${video.id}/source`;
    const thumbKey = `videos/${video.id}/thumbnail.jpg`;
    await videoRepo.update({ id: video.id }, { storage_key: sourceKey });
    createdStorageKeys.push(sourceKey);

    await storageService.putObject(sourceKey, invalidBuffer, 'video/mp4');

    await expect(
      processor.process({
        data: { videoId: video.id },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any),
    ).rejects.toThrow(UnrecoverableError);

    const failedVideo = await videoRepo.findOneByOrFail({ id: video.id });
    expect(failedVideo.status).toBe(VideoStatus.FAILED);
    expect(failedVideo.failure_reason).toBeTruthy();
    expect(failedVideo.thumbnail_key).toBeNull();

    await expect(storageService.headObject(thumbKey)).rejects.toThrow();
  });
});
