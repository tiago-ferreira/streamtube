import { UnrecoverableError } from 'bullmq';
import { parseFfprobeOutput } from './ffprobe-parser';

describe('parseFfprobeOutput', () => {
  it('parses duration and metadata for a video with audio', () => {
    const result = parseFfprobeOutput({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 320,
          height: 240,
          r_frame_rate: '25/1',
          avg_frame_rate: '25/1',
        },
        {
          codec_type: 'audio',
          codec_name: 'aac',
        },
      ],
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '2.040000',
        bit_rate: '185432',
      },
    });

    expect(result.duration_seconds).toBe(2.04);
    expect(result.metadata).toEqual({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrate: 185432,
      frame_rate: 25,
    });
  });

  it('sets audio_codec to null when no audio stream is present', () => {
    const result = parseFfprobeOutput({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'vp9',
          width: 1280,
          height: 720,
          r_frame_rate: '30000/1001',
        },
      ],
      format: {
        format_name: 'matroska,webm',
        duration: '10.5',
      },
    });

    expect(result.duration_seconds).toBe(10.5);
    expect(result.metadata.audio_codec).toBeNull();
    expect(result.metadata.video_codec).toBe('vp9');
    expect(result.metadata.frame_rate).toBe(29.97);
  });

  it('throws UnrecoverableError(NO_VIDEO_STREAM) when no video stream is present', () => {
    expect(() =>
      parseFfprobeOutput({
        streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
        format: { format_name: 'mp3', duration: '5.0' },
      }),
    ).toThrow(UnrecoverableError);

    expect(() => parseFfprobeOutput({ streams: [] })).toThrow(
      'NO_VIDEO_STREAM',
    );
  });
});
