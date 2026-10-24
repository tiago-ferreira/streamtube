import { UnrecoverableError } from 'bullmq';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessor } from './video.processor';

describe('VideoProcessor (Unit)', () => {
  const defaultUploadCfg = {
    maxSizeBytes: 10737418240,
    partSizeBytes: 67108864,
    uploadUrlTtlSeconds: 3600,
    downloadUrlTtlSeconds: 3600,
    workerConcurrency: 2,
  };

  function makeVideo(status: VideoStatus = VideoStatus.PROCESSING): Video {
    const v = new Video();
    v.id = 'video-1';
    v.channel_id = 'channel-1';
    v.slug = 'dQw4w9WgXcQ';
    v.title = 'Demo';
    v.status = status;
    v.original_filename = 'demo.mp4';
    v.mime_type = 'video/mp4';
    v.size_bytes = 2048;
    v.storage_key = 'videos/video-1/source';
    return v;
  }

  function buildHarness() {
    const executeMock = jest.fn().mockResolvedValue({ affected: 1 });
    const whereMock = jest.fn().mockReturnValue({ execute: executeMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    const updateMock = jest.fn().mockReturnValue({ set: setMock });

    const videoRepository = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue({ update: updateMock }),
    };

    const storageService = {
      presignInternalGetObject: jest
        .fn()
        .mockResolvedValue('http://minio:9000/internal-presigned'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };

    const ffmpegService = {
      probe: jest.fn().mockResolvedValue({
        duration_seconds: 20,
        metadata: {
          width: 1280,
          height: 720,
          video_codec: 'h264',
          audio_codec: 'aac',
          container: 'mov,mp4',
          bitrate: 500000,
          frame_rate: 30,
        },
      }),
      extractFrame: jest
        .fn()
        .mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    };

    const processor = new VideoProcessor(
      videoRepository as any,
      storageService as any,
      ffmpegService as any,
      defaultUploadCfg,
    );

    return {
      processor,
      videoRepository,
      storageService,
      ffmpegService,
      setMock,
      whereMock,
      executeMock,
    };
  }

  it('exits without side effects if video does not exist or status is not processing', async () => {
    const { processor, videoRepository, storageService, ffmpegService } =
      buildHarness();

    videoRepository.findOne.mockResolvedValueOnce(null);
    await processor.process({ data: { videoId: 'missing' } } as any);
    expect(storageService.presignInternalGetObject).not.toHaveBeenCalled();

    videoRepository.findOne.mockResolvedValueOnce(makeVideo(VideoStatus.READY));
    await processor.process({ data: { videoId: 'video-1' } } as any);
    expect(ffmpegService.probe).not.toHaveBeenCalled();
  });

  it('probes video, extracts frame at min(1, 10% duration), uploads thumbnail, and updates status to ready', async () => {
    const {
      processor,
      videoRepository,
      storageService,
      ffmpegService,
      setMock,
      whereMock,
    } = buildHarness();
    videoRepository.findOne.mockResolvedValue(
      makeVideo(VideoStatus.PROCESSING),
    );

    await processor.process({ data: { videoId: 'video-1' } } as any);

    expect(ffmpegService.probe).toHaveBeenCalledWith(
      'http://minio:9000/internal-presigned',
    );
    // 10% of 20s is 2s -> min(1, 2) = 1s
    expect(ffmpegService.extractFrame).toHaveBeenCalledWith(
      'http://minio:9000/internal-presigned',
      1,
    );
    expect(storageService.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.READY,
        duration_seconds: 20,
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
        processed_at: expect.any(Date),
      }),
    );
    expect(whereMock).toHaveBeenCalledWith('id = :id AND status = :status', {
      id: 'video-1',
      status: VideoStatus.PROCESSING,
    });
  });

  it('marks video failed immediately and rethrows when probe throws UnrecoverableError', async () => {
    const { processor, videoRepository, ffmpegService, setMock } =
      buildHarness();
    videoRepository.findOne.mockResolvedValue(
      makeVideo(VideoStatus.PROCESSING),
    );
    ffmpegService.probe.mockRejectedValueOnce(
      new UnrecoverableError('NO_VIDEO_STREAM'),
    );

    await expect(
      processor.process({ data: { videoId: 'video-1' } } as any),
    ).rejects.toThrow(UnrecoverableError);

    expect(setMock).toHaveBeenCalledWith({
      status: VideoStatus.FAILED,
      failure_reason: 'NO_VIDEO_STREAM',
    });
  });

  it('does not mark video failed on transient error before attempts are exhausted, and marks failed (truncated to 500 chars) when exhausted', async () => {
    const { processor, setMock } = buildHarness();
    const longMessage = 'Transient S3 network timeout '.repeat(30);

    // Attempt 1 of 3 -> not terminal yet
    await processor.onFailed(
      {
        data: { videoId: 'video-1' },
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as any,
      new Error(longMessage),
    );
    expect(setMock).not.toHaveBeenCalled();

    // Attempt 3 of 3 -> terminal
    await processor.onFailed(
      {
        data: { videoId: 'video-1' },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as any,
      new Error(longMessage),
    );
    expect(setMock).toHaveBeenCalledWith({
      status: VideoStatus.FAILED,
      failure_reason: longMessage.slice(0, 500),
    });
  });
});
