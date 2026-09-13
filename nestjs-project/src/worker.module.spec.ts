import { Test } from '@nestjs/testing';
import { WorkerModule } from './worker.module';
import { VideoProcessor } from './processing/video.processor';
import { UploadSweepProcessor } from './processing/upload-sweep.processor';
import { UploadSweepService } from './processing/upload-sweep.service';
import { UploadSweepScheduler } from './processing/upload-sweep.scheduler';
import { WorkerHeartbeatService } from './worker/worker-heartbeat.service';
import { AuthService } from './auth/auth.service';

describe('WorkerModule', () => {
  it('compiles with all processors and services resolvable', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(UploadSweepProcessor)).toBeInstanceOf(
      UploadSweepProcessor,
    );
    expect(module.get(UploadSweepService)).toBeInstanceOf(UploadSweepService);
    expect(module.get(UploadSweepScheduler)).toBeInstanceOf(
      UploadSweepScheduler,
    );
    expect(module.get(WorkerHeartbeatService)).toBeInstanceOf(
      WorkerHeartbeatService,
    );

    await module.close();
  }, 30000);

  it('does not expose AuthModule providers', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(() => module.get(AuthService)).toThrow();

    await module.close();
  }, 30000);
});
