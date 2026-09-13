import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VideoFixtures {
  plainMp4Path: string;
  faststartMp4Path: string;
  nonMediaPath: string;
}

const FIXTURE_DIR = join(tmpdir(), 'streamtube-video-fixtures');

let cached: VideoFixtures | null = null;

function generateFixture(path: string, extraArgs: string[]): void {
  if (existsSync(path)) return;
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=3:size=320x240:rate=10',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      ...extraArgs,
      path,
    ],
    { stdio: 'ignore' },
  );
}

export function getVideoFixtures(): VideoFixtures {
  if (cached) return cached;

  mkdirSync(FIXTURE_DIR, { recursive: true });
  const plainMp4Path = join(FIXTURE_DIR, 'plain.mp4');
  const faststartMp4Path = join(FIXTURE_DIR, 'faststart.mp4');
  const nonMediaPath = join(FIXTURE_DIR, 'not-media.txt');

  generateFixture(plainMp4Path, []);
  generateFixture(faststartMp4Path, ['-movflags', '+faststart']);
  if (!existsSync(nonMediaPath)) {
    writeFileSync(nonMediaPath, 'this is not a media file\n');
  }

  cached = { plainMp4Path, faststartMp4Path, nonMediaPath };
  return cached;
}
