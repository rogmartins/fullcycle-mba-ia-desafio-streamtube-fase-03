import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import processingConfig from '../config/processing.config';
import { FfmpegService } from './ffmpeg.service';
import { FfmpegExecutionError, InvalidMediaError } from './processing.errors';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

const mockSpawn = spawn as unknown as jest.Mock;

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function emitClose(
  child: FakeChild,
  code: number | null,
  stdout = '',
  stderr = '',
) {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', code);
}

describe('FfmpegService (unit)', () => {
  let service: FfmpegService;
  const config = {
    ffprobeTimeoutMs: 5000,
    ffmpegThumbnailTimeoutMs: 5000,
    thumbnailOffsetPercent: 10,
    thumbnailMaxWidth: 1280,
    thumbnailJpegQuality: 3,
  };

  beforeEach(async () => {
    mockSpawn.mockReset();
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FfmpegService,
        { provide: processingConfig.KEY, useValue: config },
      ],
    }).compile();

    service = module.get(FfmpegService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const CANNED_PROBE_JSON = JSON.stringify({
    format: { duration: '3.033000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 320,
        height: 240,
      },
    ],
  });

  describe('probe', () => {
    it('spawns ffprobe with the expected argument array and no shell', async () => {
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = service.probe('http://minio:9000/videos/x.mp4');
      emitClose(child, 0, CANNED_PROBE_JSON);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          'http://minio:9000/videos/x.mp4',
        ],
        expect.not.objectContaining({ shell: true }),
      );
    });

    it('parses a canned ffprobe JSON output into a ProbeResult', async () => {
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = service.probe('http://minio:9000/videos/x.mp4');
      emitClose(child, 0, CANNED_PROBE_JSON);
      const result = await promise;

      expect(result.durationSeconds).toBeCloseTo(3.033, 3);
      expect(result.width).toBe(320);
      expect(result.height).toBe(240);
      expect(result.codecName).toBe('h264');
      expect(result.containerFormat).toBe('mov,mp4,m4a,3gp,3g2,mj2');
      expect(result.raw).toEqual(JSON.parse(CANNED_PROBE_JSON));
    });

    it('kills the child and raises a timed-out FfmpegExecutionError', async () => {
      jest.useFakeTimers();
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = service.probe('http://minio:9000/videos/x.mp4');
      const assertion = expect(promise).rejects.toThrow(FfmpegExecutionError);
      jest.advanceTimersByTime(config.ffprobeTimeoutMs);
      child.emit('close', null);
      await assertion;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('maps "Invalid data found" stderr to InvalidMediaError', async () => {
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = service.probe('http://minio:9000/videos/x.mp4');
      emitClose(child, 1, '', 'Invalid data found when processing input');
      await expect(promise).rejects.toThrow(InvalidMediaError);
    });

    it('maps a missing video stream to InvalidMediaError', async () => {
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const audioOnlyJson = JSON.stringify({
        format: { duration: '3.0', format_name: 'mov,mp4' },
        streams: [{ codec_type: 'audio', codec_name: 'aac' }],
      });
      const promise = service.probe('http://minio:9000/videos/x.mp4');
      emitClose(child, 0, audioOnlyJson);
      await expect(promise).rejects.toThrow(InvalidMediaError);
    });

    it('throws a non-timed-out FfmpegExecutionError on other non-zero exits', async () => {
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = service.probe('http://minio:9000/videos/x.mp4');
      const assertion = expect(promise).rejects.toThrow(FfmpegExecutionError);
      emitClose(child, 1, '', 'some other transient failure');
      await assertion;
    });
  });

  describe('extractFrame', () => {
    it('spawns ffmpeg with the expected argument array', async () => {
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = service.extractFrame(
        'http://minio:9000/videos/x.mp4',
        0.3,
      );
      emitClose(child, 0, 'jpeg-bytes');
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          '0.3',
          '-i',
          'http://minio:9000/videos/x.mp4',
          '-frames:v',
          '1',
          '-vf',
          "scale='min(1280,iw)':-2",
          '-q:v',
          '3',
          '-f',
          'image2',
          'pipe:1',
        ],
        expect.anything(),
      );
    });

    it('returns the collected stdout buffer on success', async () => {
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = service.extractFrame(
        'http://minio:9000/videos/x.mp4',
        0.3,
      );
      emitClose(child, 0, 'jpeg-bytes');
      const buffer = await promise;

      expect(buffer.toString('utf8')).toBe('jpeg-bytes');
    });

    it('throws FfmpegExecutionError on empty output', async () => {
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = service.extractFrame(
        'http://minio:9000/videos/x.mp4',
        0.3,
      );
      emitClose(child, 0, '');
      await expect(promise).rejects.toThrow(FfmpegExecutionError);
    });

    it('throws FfmpegExecutionError on a non-zero exit', async () => {
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = service.extractFrame(
        'http://minio:9000/videos/x.mp4',
        0.3,
      );
      emitClose(child, 1, '', 'boom');
      await expect(promise).rejects.toThrow(FfmpegExecutionError);
    });

    it('kills the child and raises a timed-out FfmpegExecutionError', async () => {
      jest.useFakeTimers();
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = service.extractFrame(
        'http://minio:9000/videos/x.mp4',
        0.3,
      );
      const assertion = expect(promise).rejects.toThrow(FfmpegExecutionError);
      jest.advanceTimersByTime(config.ffmpegThumbnailTimeoutMs);
      child.emit('close', null);
      await assertion;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
  });
});
