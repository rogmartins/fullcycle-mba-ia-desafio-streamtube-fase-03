import { NestFactory } from '@nestjs/core';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './queue/queue.constants';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(new ConsoleLogger());
  app.enableShutdownHooks();

  const logger = new Logger('Worker');
  logger.log(
    `Video worker started — consuming queues: ${VIDEO_PROCESSING_QUEUE}, ${VIDEO_MAINTENANCE_QUEUE}`,
  );
}
void bootstrap();
