import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { existsSync } from 'node:fs';
import { utimes, writeFile } from 'node:fs/promises';

const HEARTBEAT_FILE = '/tmp/worker-heartbeat';
const HEARTBEAT_INTERVAL_MS = 15000;

@Injectable()
export class WorkerHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private timer: NodeJS.Timeout | undefined;

  onModuleInit(): void {
    this.touch();
    this.timer = setInterval(() => this.touch(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private touch(): void {
    const now = new Date();
    const write = existsSync(HEARTBEAT_FILE)
      ? utimes(HEARTBEAT_FILE, now, now)
      : writeFile(HEARTBEAT_FILE, '');
    write.catch((error: unknown) => {
      this.logger.error(
        'Failed to update worker heartbeat file',
        error instanceof Error ? error.stack : undefined,
      );
    });
  }
}
