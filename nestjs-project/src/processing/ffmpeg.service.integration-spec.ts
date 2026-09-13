import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import storageConfig from '../config/storage.config';
import processingConfig from '../config/processing.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { ProcessingModule } from './processing.module';
import { FfmpegService } from './ffmpeg.service';
import { InvalidMediaError } from './processing.errors';
import { getVideoFixtures } from '../test/video-fixture';

describe('FfmpegService (integration)', () => {
  let module: TestingModule;
  let service: FfmpegService;
  let storageService: StorageService;
  const runPrefix = `test-runs/${randomUUID()}`;
  const videoBucket = process.env.STORAGE_VIDEO_BUCKET || 'videos';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, processingConfig],
        }),
        StorageModule,
        ProcessingModule,
      ],
    }).compile();

    service = module.get(FfmpegService);
    storageService = module.get(StorageService);
  }, 60000);

  afterAll(async () => {
    await storageService.deleteByPrefix(videoBucket, `${runPrefix}/`);
    await module.close();
  });

  async function uploadFixtureAndSign(
    localPath: string,
    key: string,
    contentType: string,
  ): Promise<string> {
    await storageService.putObject(
      videoBucket,
      key,
      readFileSync(localPath),
      contentType,
    );
    const { url } = await storageService.presignGetObject(key, 3600, {
      audience: 'internal',
    });
    return url;
  }

  it('probes a 3-second MP4 fixture without faststart: duration ~3s, 320x240, h264, moovAtEnd true', async () => {
    const fixtures = getVideoFixtures();
    const key = `${runPrefix}/plain.mp4`;
    const url = await uploadFixtureAndSign(
      fixtures.plainMp4Path,
      key,
      'video/mp4',
    );

    const result = await service.probe(url);

    expect(result.durationSeconds).toBeCloseTo(3, 0);
    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    expect(result.codecName).toBe('h264');
    expect(result.containerFormat).toContain('mp4');
    expect(result.moovAtEnd).toBe(true);
    expect(result.raw).toBeTruthy();
  }, 30000);

  it('probes the faststart fixture with moovAtEnd false', async () => {
    const fixtures = getVideoFixtures();
    const key = `${runPrefix}/faststart.mp4`;
    const url = await uploadFixtureAndSign(
      fixtures.faststartMp4Path,
      key,
      'video/mp4',
    );

    const result = await service.probe(url);

    expect(result.moovAtEnd).toBe(false);
  }, 30000);

  it('throws InvalidMediaError when probing a non-media object', async () => {
    const fixtures = getVideoFixtures();
    const key = `${runPrefix}/not-media.txt`;
    const url = await uploadFixtureAndSign(
      fixtures.nonMediaPath,
      key,
      'text/plain',
    );

    await expect(service.probe(url)).rejects.toThrow(InvalidMediaError);
  }, 30000);

  it('extracts a JPEG frame at 0.3s no wider than the source', async () => {
    const fixtures = getVideoFixtures();
    const key = `${runPrefix}/plain-for-frame.mp4`;
    const url = await uploadFixtureAndSign(
      fixtures.plainMp4Path,
      key,
      'video/mp4',
    );

    const frame = await service.extractFrame(url, 0.3);

    expect(frame.length).toBeGreaterThan(0);
    expect(frame.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const framePath = join(tmpdir(), `frame-${randomUUID()}.jpg`);
    writeFileSync(framePath, frame);
    const frameProbe = await service.probe(framePath);
    expect(frameProbe.width).toBeLessThanOrEqual(320);
  }, 30000);
});
