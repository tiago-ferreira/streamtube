import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { spawn } from 'node:child_process';
import {
  FfprobeRawOutput,
  ParsedProbeResult,
  parseFfprobeOutput,
} from './ffprobe-parser';

const DEFAULT_FFMPEG_TIMEOUT_MS = 120_000;

@Injectable()
export class FfmpegService {
  private readonly timeoutMs = Number(
    process.env.FFMPEG_TIMEOUT_MS || DEFAULT_FFMPEG_TIMEOUT_MS,
  );

  async probe(url: string): Promise<ParsedProbeResult> {
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ];

    let stdoutBuffer: Buffer;
    try {
      stdoutBuffer = await this.runProcess('ffprobe', args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('Invalid data found when processing input') ||
        msg.includes('moov atom not found')
      ) {
        throw new UnrecoverableError(`NO_VIDEO_STREAM: ${msg}`);
      }
      throw err;
    }

    let parsedJson: FfprobeRawOutput;
    try {
      parsedJson = JSON.parse(stdoutBuffer.toString('utf-8')) as FfprobeRawOutput;
    } catch {
      throw new Error('Failed to parse ffprobe JSON output');
    }

    return parseFfprobeOutput(parsedJson);
  }

  async extractFrame(url: string, timestampSeconds: number): Promise<Buffer> {
    const safeTimestamp = Math.max(0, Number(timestampSeconds) || 0).toFixed(3);
    const args = [
      '-v',
      'error',
      '-ss',
      safeTimestamp,
      '-i',
      url,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(1280,iw)':-2",
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ];

    const jpegBuffer = await this.runProcess('ffmpeg', args);
    if (jpegBuffer.length < 4 || jpegBuffer[0] !== 0xff || jpegBuffer[1] !== 0xd8) {
      throw new Error('FFmpeg did not produce a valid JPEG frame');
    }

    return jpegBuffer;
  }

  private runProcess(command: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${command} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(Buffer.concat(stdoutChunks));
        } else {
          const stderrText = Buffer.concat(stderrChunks).toString('utf-8').trim();
          reject(
            new Error(
              `${command} exited with code ${code}: ${stderrText || 'unknown error'}`,
            ),
          );
        }
      });
    });
  }
}
