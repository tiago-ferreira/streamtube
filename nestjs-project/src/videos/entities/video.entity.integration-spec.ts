import { DataSource, Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { Video, VideoStatus } from './video.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';

describe('Video Entity (Integration)', () => {
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  async function seedChannel(suffix = '1'): Promise<Channel> {
    const user = await userRepo.save(
      userRepo.create({
        email: `owner${suffix}@streamtube.com`,
        password: 'hashed-password',
        is_confirmed: true,
      }),
    );

    return channelRepo.save(
      channelRepo.create({
        name: `Channel ${suffix}`,
        nickname: `channel_${suffix}`,
        user_id: user.id,
      }),
    );
  }

  it('should persist a video and return size_bytes (10 GiB) and duration_seconds as exact JavaScript numbers', async () => {
    const channel = await seedChannel('1');
    const tenGiB = 10737418240;

    const saved = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        slug: 'AbCdEfGhIj1',
        title: '10GiB Lecture',
        status: VideoStatus.READY,
        original_filename: 'lecture.mp4',
        mime_type: 'video/mp4',
        size_bytes: tenGiB,
        storage_key: 'videos/test/source',
        duration_seconds: 123.456,
        metadata: {
          width: 1920,
          height: 1080,
          video_codec: 'h264',
          audio_codec: 'aac',
          container: 'mov,mp4,m4a,3gp,3g2,mj2',
          bitrate: 2500000,
          frame_rate: 30,
        },
      }),
    );

    const loaded = await videoRepo.findOneByOrFail({ id: saved.id });
    expect(typeof loaded.size_bytes).toBe('number');
    expect(loaded.size_bytes).toBe(tenGiB);
    expect(typeof loaded.duration_seconds).toBe('number');
    expect(loaded.duration_seconds).toBe(123.456);
    expect(loaded.metadata?.width).toBe(1920);
    expect(loaded.status).toBe(VideoStatus.READY);
  });

  it('should reject duplicate slug with unique constraint violation', async () => {
    const channel = await seedChannel('2');

    await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        slug: 'DupSlug1234',
        title: 'First Video',
        original_filename: 'v1.mp4',
        mime_type: 'video/mp4',
        size_bytes: 1024,
        storage_key: 'videos/1/source',
      }),
    );

    await expect(
      videoRepo.save(
        videoRepo.create({
          channel_id: channel.id,
          slug: 'DupSlug1234',
          title: 'Second Video',
          original_filename: 'v2.mp4',
          mime_type: 'video/mp4',
          size_bytes: 2048,
          storage_key: 'videos/2/source',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject an invalid video_status enum value', async () => {
    const channel = await seedChannel('3');

    await expect(
      videoRepo.save(
        videoRepo.create({
          channel_id: channel.id,
          slug: 'BadEnum1234',
          title: 'Invalid Status',
          status: 'archived' as VideoStatus,
          original_filename: 'v.mp4',
          mime_type: 'video/mp4',
          size_bytes: 1024,
          storage_key: 'videos/3/source',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should cascade delete videos when the parent channel is deleted', async () => {
    const channel = await seedChannel('4');

    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        slug: 'Cascade1234',
        title: 'Cascade Video',
        original_filename: 'v.mp4',
        mime_type: 'video/mp4',
        size_bytes: 1024,
        storage_key: 'videos/4/source',
      }),
    );

    await channelRepo.delete({ id: channel.id });

    const found = await videoRepo.findOneBy({ id: video.id });
    expect(found).toBeNull();
  });
});
