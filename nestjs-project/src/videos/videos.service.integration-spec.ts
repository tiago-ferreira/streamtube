import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import uploadConfig from '../config/upload.config';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoUploadNotInProgressException } from './exceptions/video.exceptions';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

describe('VideosService (Integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let videoQueue: Queue;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;
  const createdStorageKeys: string[] = [];

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT =
      process.env.S3_ENDPOINT || 'http://minio:9000';
    process.env.UPLOAD_PART_SIZE_BYTES = String(5 * 1024 * 1024); // 5 MiB

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig, uploadConfig],
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
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        BullModule.registerQueue({
          name: VIDEO_PROCESSING_QUEUE,
        }),
        ChannelsModule,
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    videoQueue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);
  });

  beforeEach(async () => {
    await videoQueue.pause();
    await cleanAllTables(dataSource);
    await videoQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    for (const key of createdStorageKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await videoQueue.obliterate({ force: true });
    await videoQueue.resume();
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  it('should initiate upload, complete multipart upload in MinIO, transition to processing in Postgres, and enqueue deduplicated job in Redis (rejecting duplicate complete with 409)', async () => {
    const user = await userRepo.save(
      userRepo.create({
        email: 'uploader@streamtube.com',
        password: 'hashed-password',
        is_confirmed: true,
      }),
    );
    await channelRepo.save(
      channelRepo.create({
        name: 'Uploader',
        nickname: 'uploader',
        user_id: user.id,
      }),
    );

    const payloadBytes = Buffer.alloc(1024, 0x55);
    const initiated = await videosService.initiateUpload(user.id, {
      filename: 'demo.mp4',
      size_bytes: payloadBytes.length,
      mime_type: 'video/mp4',
      title: 'Demo Video',
    });

    createdStorageKeys.push(`videos/${initiated.id}/source`);
    expect(initiated.status).toBe(VideoStatus.DRAFT);
    expect(initiated.upload.part_count).toBe(1);

    // Upload part 1 to MinIO
    const putRes = await fetch(initiated.upload.parts[0].url, {
      method: 'PUT',
      body: payloadBytes,
    });
    expect(putRes.status).toBe(200);
    const etag = putRes.headers.get('etag')!;

    // Complete upload
    const completed = await videosService.completeUpload(
      user.id,
      initiated.slug,
      {
        parts: [{ part_number: 1, etag }],
      },
    );
    expect(completed.status).toBe(VideoStatus.PROCESSING);

    // Verify DB row is in 'processing' and upload_id is cleared
    const dbVideo = await videoRepo.findOneByOrFail({ id: initiated.id });
    expect(dbVideo.status).toBe(VideoStatus.PROCESSING);
    expect(dbVideo.upload_id).toBeNull();
    expect(dbVideo.uploaded_at).toBeInstanceOf(Date);

    // Verify job exists in BullMQ with jobId === video.id
    const job = await videoQueue.getJob(initiated.id);
    expect(job).toBeDefined();
    expect(job!.name).toBe('process-video');
    expect(job!.data).toEqual({ videoId: initiated.id });

    // Calling completeUpload again throws 409 and does not create another job
    await expect(
      videosService.completeUpload(user.id, initiated.slug, {
        parts: [{ part_number: 1, etag }],
      }),
    ).rejects.toThrow(VideoUploadNotInProgressException);

    const waitingCount = await videoQueue.getWaitingCount();
    expect(waitingCount).toBe(1);
  });
});
