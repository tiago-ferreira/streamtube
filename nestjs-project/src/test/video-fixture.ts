import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function generateSyntheticMp4Buffer(
  durationSeconds = 2,
  width = 320,
  height = 240,
): Buffer {
  const tmpFile = join(tmpdir(), `fixture-${randomUUID()}.mp4`);
  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=25`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${durationSeconds}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        tmpFile,
      ],
      { stdio: 'pipe' },
    );
    return readFileSync(tmpFile);
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore cleanup error
    }
  }
}
