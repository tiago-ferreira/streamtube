import { QueryFailedError } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from './entities/video.entity';
import {
  InvalidUploadPartsException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoUploadNotInProgressException,
} from './exceptions/video.exceptions';
import {
  buildAttachmentDisposition,
  deriveVideoTitle,
  VideosService,
} from './videos.service';

describe('VideosService (Unit)', () => {
  const defaultUploadCfg = {
    maxSizeBytes: 10737418240,
    partSizeBytes: 67108864, // 64 MiB
    uploadUrlTtlSeconds: 3600,
    downloadUrlTtlSeconds: 3600,
    workerConcurrency: 2,
  };

  function makeChannel(userId = 'owner-id'): Channel {
    const ch = new Channel();
    ch.id = 'channel-uuid';
    ch.user_id = userId;
    ch.nickname = 'tiago';
    ch.name = 'Tiago Channel';
    return ch;
  }

  function makeVideo(overrides: Partial<Video> = {}): Video {
    const v = new Video();
    v.id = 'video-uuid';
    v.channel_id = 'channel-uuid';
    v.channel = makeChannel('owner-id');
    v.slug = 'dQw4w9WgXcQ';
    v.title = 'Aula 1';
    v.status = VideoStatus.DRAFT;
    v.original_filename = 'aula.mp4';
    v.mime_type = 'video/mp4';
    v.size_bytes = 157286400; // 150 MiB -> 3 parts at 64 MiB
    v.storage_key = 'videos/video-uuid/source';
    v.upload_id = 'upload-123';
    v.thumbnail_key = null;
    v.duration_seconds = null;
    v.metadata = null;
    v.failure_reason = null;
    v.uploaded_at = null;
    v.processed_at = null;
    v.created_at = new Date('2026-10-24T20:00:00.000Z');
    v.updated_at = new Date('2026-10-24T20:00:00.000Z');
    Object.assign(v, overrides);
    return v;
  }

  function buildHarness(
    overrides: {
      videoRepository?: any;
      dataSource?: any;
      channelsService?: any;
      storageService?: any;
      videoQueue?: any;
      affected?: number;
    } = {},
  ) {
    const affected = overrides.affected ?? 1;
    const executeMock = jest.fn().mockResolvedValue({ affected });
    const whereMock = jest.fn().mockReturnValue({ execute: executeMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    const updateMock = jest.fn().mockReturnValue({ set: setMock });

    const managerMock = {
      createQueryBuilder: jest.fn().mockReturnValue({ update: updateMock }),
    };

    const videoRepository = {
      findOne: jest.fn(),
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn((entity) => Promise.resolve(entity)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      ...overrides.videoRepository,
    };

    const dataSource = {
      transaction: jest.fn(async (cb: (mgr: any) => Promise<any>) =>
        cb(managerMock),
      ),
      ...overrides.dataSource,
    };

    const channelsService = {
      findByUserId: jest.fn().mockResolvedValue(makeChannel('owner-id')),
      ...overrides.channelsService,
    };

    const storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-123'),
      presignUploadParts: jest.fn(
        async (_key: string, _uid: string, nums: number[]) =>
          nums.map((n) => ({
            part_number: n,
            url: `http://localhost:9000/part-${n}`,
          })),
      ),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest
        .fn()
        .mockResolvedValue({ sizeBytes: 157286400, contentType: 'video/mp4' }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      presignGetObject: jest
        .fn()
        .mockResolvedValue('http://localhost:9000/signed-get'),
      ...overrides.storageService,
    };

    const videoQueue = {
      add: jest.fn().mockResolvedValue({ id: 'video-uuid' }),
      ...overrides.videoQueue,
    };

    const service = new VideosService(
      videoRepository,
      dataSource,
      channelsService,
      storageService,
      defaultUploadCfg,
      videoQueue,
    );

    return {
      service,
      videoRepository,
      dataSource,
      channelsService,
      storageService,
      videoQueue,
      executeMock,
    };
  }

  describe('deriveVideoTitle & computePartCount', () => {
    it('derives title from filename when title is omitted and truncates to 100 chars', () => {
      expect(deriveVideoTitle('minha-viagem.mov')).toBe('minha-viagem');
      expect(deriveVideoTitle('aula.mp4', 'Aula 1')).toBe('Aula 1');
      expect(deriveVideoTitle(`${'a'.repeat(120)}.mp4`)).toHaveLength(100);
    });

    it('calculates part_count accurately for 1 B, 64 MiB, and 10 GiB', () => {
      const { service } = buildHarness();
      expect(service.computePartCount(1)).toBe(1);
      expect(service.computePartCount(67108864)).toBe(1);
      expect(service.computePartCount(67108865)).toBe(2);
      expect(service.computePartCount(10737418240)).toBe(160);
    });
  });

  describe('initiateUpload', () => {
    it('pre-registers draft video and returns multipart session URLs', async () => {
      const { service, videoRepository, storageService } = buildHarness();
      videoRepository.findOne.mockResolvedValue(null);

      const res = await service.initiateUpload('owner-id', {
        filename: 'minha-viagem.mov',
        size_bytes: 157286400,
        mime_type: 'video/quicktime',
      });

      expect(res.title).toBe('minha-viagem');
      expect(res.status).toBe(VideoStatus.DRAFT);
      expect(res.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(res.upload.part_size).toBe(67108864);
      expect(res.upload.part_count).toBe(3);
      expect(res.upload.parts).toHaveLength(3);
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/[0-9a-f-]+\/source$/),
        'video/quicktime',
      );
    });

    it('retries slug generation on pre-check or unique constraint collision', async () => {
      const uniqueErr = new QueryFailedError('INSERT', [], new Error()) as any;
      uniqueErr.code = '23505';
      uniqueErr.detail = 'Key (slug)=(dup) already exists.';

      const { service, videoRepository } = buildHarness();
      videoRepository.findOne
        .mockResolvedValueOnce(makeVideo()) // 1st attempt: pre-check collision
        .mockResolvedValueOnce(null) // 2nd attempt: passes pre-check, hits DB 23505
        .mockResolvedValueOnce(null); // 3rd attempt: succeeds

      videoRepository.save
        .mockRejectedValueOnce(uniqueErr)
        .mockImplementationOnce((entity: any) => Promise.resolve(entity));

      const res = await service.initiateUpload('owner-id', {
        filename: 'aula.mp4',
        size_bytes: 1024,
        mime_type: 'video/mp4',
        title: 'Aula 1',
      });

      expect(res.status).toBe(VideoStatus.DRAFT);
      expect(videoRepository.findOne).toHaveBeenCalledTimes(3);
      expect(videoRepository.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('presignParts', () => {
    it('refreshes presigned URLs for owner draft video', async () => {
      const { service, videoRepository } = buildHarness();
      videoRepository.findOne.mockResolvedValue(makeVideo());

      const res = await service.presignParts('owner-id', 'dQw4w9WgXcQ', {
        part_numbers: [2, 3],
      });

      expect(res.parts).toHaveLength(2);
      expect(res.parts.map((p) => p.part_number)).toEqual([2, 3]);
    });

    it('throws 404 VIDEO_NOT_FOUND when user is not the owner', async () => {
      const { service, videoRepository } = buildHarness();
      videoRepository.findOne.mockResolvedValue(makeVideo());

      await expect(
        service.presignParts('other-user-id', 'dQw4w9WgXcQ', {
          part_numbers: [1],
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws 409 VIDEO_UPLOAD_NOT_IN_PROGRESS when video is not draft', async () => {
      const { service, videoRepository } = buildHarness();
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.presignParts('owner-id', 'dQw4w9WgXcQ', {
          part_numbers: [1],
        }),
      ).rejects.toThrow(VideoUploadNotInProgressException);
    });

    it('throws 400 INVALID_UPLOAD_PARTS when part number exceeds part_count', async () => {
      const { service, videoRepository } = buildHarness();
      videoRepository.findOne.mockResolvedValue(makeVideo()); // 3 parts

      await expect(
        service.presignParts('owner-id', 'dQw4w9WgXcQ', {
          part_numbers: [4],
        }),
      ).rejects.toThrow(InvalidUploadPartsException);
    });
  });

  describe('completeUpload', () => {
    const validParts = [
      { part_number: 1, etag: '"e1"' },
      { part_number: 2, etag: '"e2"' },
      { part_number: 3, etag: '"e3"' },
    ];

    it('completes multipart upload, transitions to processing, and enqueues BullMQ job', async () => {
      const { service, videoRepository, storageService, videoQueue } =
        buildHarness();
      videoRepository.findOne.mockResolvedValue(makeVideo());

      const res = await service.completeUpload('owner-id', 'dQw4w9WgXcQ', {
        parts: validParts,
      });

      expect(res.status).toBe(VideoStatus.PROCESSING);
      expect(storageService.completeMultipartUpload).toHaveBeenCalledTimes(1);
      expect(videoQueue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-uuid' },
        expect.objectContaining({
          jobId: 'video-uuid',
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        }),
      );
    });

    it('throws 400 INVALID_UPLOAD_PARTS on missing/duplicate parts or S3 error', async () => {
      const { service, videoRepository, storageService } = buildHarness();
      videoRepository.findOne.mockResolvedValue(makeVideo());

      await expect(
        service.completeUpload('owner-id', 'dQw4w9WgXcQ', {
          parts: [{ part_number: 1, etag: '"e1"' }],
        }),
      ).rejects.toThrow(InvalidUploadPartsException);

      storageService.completeMultipartUpload.mockRejectedValueOnce(
        new Error('InvalidPart'),
      );
      await expect(
        service.completeUpload('owner-id', 'dQw4w9WgXcQ', {
          parts: validParts,
        }),
      ).rejects.toThrow(InvalidUploadPartsException);
    });

    it('marks video failed, deletes object, and throws 422 UPLOAD_SIZE_MISMATCH when HeadObject size differs', async () => {
      const { service, videoRepository, storageService, videoQueue } =
        buildHarness();
      videoRepository.findOne.mockResolvedValue(makeVideo());
      storageService.headObject.mockResolvedValueOnce({
        sizeBytes: 999,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload('owner-id', 'dQw4w9WgXcQ', {
          parts: validParts,
        }),
      ).rejects.toThrow(UploadSizeMismatchException);

      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos/video-uuid/source',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-uuid' },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          upload_id: null,
        }),
      );
      expect(videoQueue.add).not.toHaveBeenCalled();
    });

    it('propagates error if queue.add fails so transaction rolls back', async () => {
      const { service, videoRepository, videoQueue } = buildHarness();
      videoRepository.findOne.mockResolvedValue(makeVideo());
      videoQueue.add.mockRejectedValueOnce(new Error('Redis connection down'));

      await expect(
        service.completeUpload('owner-id', 'dQw4w9WgXcQ', {
          parts: validParts,
        }),
      ).rejects.toThrow('Redis connection down');
    });
  });

  describe('findBySlugForViewer & redirect resolvers', () => {
    it('returns ready video with stream_url, download_url, thumbnail_url for anonymous viewer', async () => {
      const { service, videoRepository } = buildHarness();
      videoRepository.findOne.mockResolvedValue(
        makeVideo({
          status: VideoStatus.READY,
          duration_seconds: 120.5,
          thumbnail_key: 'videos/video-uuid/thumbnail.jpg',
        }),
      );

      const res = await service.findBySlugForViewer('dQw4w9WgXcQ', undefined);
      expect(res.status).toBe(VideoStatus.READY);
      expect(res.stream_url).toBe('/videos/dQw4w9WgXcQ/stream');
      expect(res.download_url).toBe('/videos/dQw4w9WgXcQ/download');
      expect(res.thumbnail_url).toBe('/videos/dQw4w9WgXcQ/thumbnail');
    });

    it('enforces visibility matrix for non-ready videos (owner gets 200, non-owner and anonymous get 404)', async () => {
      const { service, videoRepository } = buildHarness();

      for (const status of [
        VideoStatus.DRAFT,
        VideoStatus.PROCESSING,
        VideoStatus.FAILED,
      ]) {
        videoRepository.findOne.mockResolvedValue(
          makeVideo({
            status,
            failure_reason:
              status === VideoStatus.FAILED ? 'NO_VIDEO_STREAM' : null,
          }),
        );

        const ownerView = await service.findBySlugForViewer(
          'dQw4w9WgXcQ',
          'owner-id',
        );
        expect(ownerView.status).toBe(status);
        expect(ownerView.stream_url).toBeUndefined();
        if (status === VideoStatus.FAILED) {
          expect(ownerView.failure_reason).toBe('NO_VIDEO_STREAM');
        }

        await expect(
          service.findBySlugForViewer('dQw4w9WgXcQ', undefined),
        ).rejects.toThrow(VideoNotFoundException);

        await expect(
          service.findBySlugForViewer('dQw4w9WgXcQ', 'other-user-id'),
        ).rejects.toThrow(VideoNotFoundException);
      }
    });

    it('resolves stream, download, and thumbnail redirect URLs when ready and throws 404 when not ready', async () => {
      const { service, videoRepository, storageService } = buildHarness();
      videoRepository.findOne.mockResolvedValue(
        makeVideo({
          status: VideoStatus.READY,
          thumbnail_key: 'videos/video-uuid/thumbnail.jpg',
        }),
      );

      await service.getStreamRedirectUrl('dQw4w9WgXcQ');
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-uuid/source',
        3600,
        { responseContentType: 'video/mp4' },
      );

      await service.getDownloadRedirectUrl('dQw4w9WgXcQ');
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-uuid/source',
        3600,
        {
          responseContentType: 'video/mp4',
          responseContentDisposition: buildAttachmentDisposition('aula.mp4'),
        },
      );

      await service.getThumbnailRedirectUrl('dQw4w9WgXcQ');
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-uuid/thumbnail.jpg',
        3600,
        { responseContentType: 'image/jpeg' },
      );

      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );
      await expect(service.getStreamRedirectUrl('dQw4w9WgXcQ')).rejects.toThrow(
        VideoNotFoundException,
      );
      await expect(
        service.getDownloadRedirectUrl('dQw4w9WgXcQ'),
      ).rejects.toThrow(VideoNotFoundException);
      await expect(
        service.getThumbnailRedirectUrl('dQw4w9WgXcQ'),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });
});
