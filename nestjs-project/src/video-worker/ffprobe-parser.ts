import { UnrecoverableError } from 'bullmq';
import { VideoMetadata } from '../videos/entities/video.entity';

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string | number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string | number;
}

export interface FfprobeFormat {
  format_name?: string;
  duration?: string | number;
  bit_rate?: string | number;
}

export interface FfprobeRawOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export interface ParsedProbeResult {
  duration_seconds: number;
  metadata: VideoMetadata;
}

function parseFrameRate(rateStr?: string): number | null {
  if (!rateStr || rateStr === '0/0') return null;
  const parts = rateStr.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Math.round((num / den) * 1000) / 1000;
    }
    return null;
  }
  const direct = Number(rateStr);
  return Number.isFinite(direct) && direct > 0 ? direct : null;
}

function parsePositiveNumber(value?: string | number): number | null {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

export function parseFfprobeOutput(raw: FfprobeRawOutput): ParsedProbeResult {
  const streams = Array.isArray(raw?.streams) ? raw.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');

  if (!videoStream || !videoStream.codec_name) {
    throw new UnrecoverableError('NO_VIDEO_STREAM');
  }

  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const formatDuration = parsePositiveNumber(raw.format?.duration);
  const streamDuration = parsePositiveNumber(videoStream.duration);
  const rawDuration = formatDuration ?? streamDuration ?? 0;
  const durationSeconds = Math.round(rawDuration * 1000) / 1000;

  const formatBitrate = parsePositiveNumber(raw.format?.bit_rate);
  const streamBitrate = parsePositiveNumber(videoStream.bit_rate);
  const bitrate =
    formatBitrate !== null
      ? Math.round(formatBitrate)
      : streamBitrate !== null
        ? Math.round(streamBitrate)
        : null;

  const frameRate =
    parseFrameRate(videoStream.avg_frame_rate) ??
    parseFrameRate(videoStream.r_frame_rate);

  return {
    duration_seconds: durationSeconds,
    metadata: {
      width: Number(videoStream.width ?? 0),
      height: Number(videoStream.height ?? 0),
      video_codec: videoStream.codec_name,
      audio_codec: audioStream?.codec_name ?? null,
      container: raw.format?.format_name ?? 'unknown',
      bitrate,
      frame_rate: frameRate,
    },
  };
}
