import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { spawn } from 'node:child_process';
import processingConfig from '../config/processing.config';
import { FfmpegExecutionError, InvalidMediaError } from './processing.errors';
import { detectMoovPlacementFromHeadChunk } from './moov.util';

const MOOV_PROBE_RANGE_BYTES = 65536;

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  codecName: string;
  containerFormat: string;
  moovAtEnd: boolean | null;
  raw: unknown;
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code,
        timedOut,
      });
    });
  });
}

@Injectable()
export class FfmpegService {
  constructor(
    @Inject(processingConfig.KEY)
    private readonly config: ConfigType<typeof processingConfig>,
  ) {}

  async probe(sourceUrl: string): Promise<ProbeResult> {
    const result = await runProcess(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        sourceUrl,
      ],
      this.config.ffprobeTimeoutMs,
    );

    if (result.timedOut) {
      throw new FfmpegExecutionError(result.stderr, true);
    }

    if (result.code !== 0) {
      if (result.stderr.includes('Invalid data found')) {
        throw new InvalidMediaError(result.stderr);
      }
      throw new FfmpegExecutionError(result.stderr, false);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout.toString('utf8'));
    } catch {
      throw new InvalidMediaError('Unparsable ffprobe output');
    }

    const parsed = raw as {
      format?: { duration?: string; format_name?: string };
      streams?: {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
      }[];
    };

    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    if (!videoStream) {
      throw new InvalidMediaError('No video stream found');
    }

    const durationSeconds = parseFloat(parsed.format?.duration ?? 'NaN');
    if (Number.isNaN(durationSeconds)) {
      throw new InvalidMediaError('Unparsable ffprobe output');
    }

    const moovAtEnd = await this.detectMoovPlacement(sourceUrl);

    return {
      durationSeconds,
      width: videoStream.width!,
      height: videoStream.height!,
      codecName: videoStream.codec_name!,
      containerFormat: parsed.format?.format_name ?? '',
      moovAtEnd,
      raw,
    };
  }

  async detectMoovPlacement(sourceUrl: string): Promise<boolean | null> {
    let response: Response;
    try {
      response = await fetch(sourceUrl, {
        headers: { Range: `bytes=0-${MOOV_PROBE_RANGE_BYTES - 1}` },
      });
    } catch {
      return null;
    }
    if (!response.ok && response.status !== 206) {
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    return detectMoovPlacementFromHeadChunk(Buffer.from(arrayBuffer));
  }

  async extractFrame(
    sourceUrl: string,
    offsetSeconds: number,
  ): Promise<Buffer> {
    const result = await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(offsetSeconds),
        '-i',
        sourceUrl,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${this.config.thumbnailMaxWidth},iw)':-2`,
        '-q:v',
        String(this.config.thumbnailJpegQuality),
        '-f',
        'image2',
        'pipe:1',
      ],
      this.config.ffmpegThumbnailTimeoutMs,
    );

    if (result.timedOut) {
      throw new FfmpegExecutionError(result.stderr, true);
    }
    if (result.code !== 0 || result.stdout.length === 0) {
      throw new FfmpegExecutionError(result.stderr, false);
    }

    return result.stdout;
  }
}
