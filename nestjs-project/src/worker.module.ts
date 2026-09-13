import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configModuleOptions } from './config/config.module-options';
import { typeOrmModuleAsyncOptions } from './database/typeorm.module-options';
import { Video } from './videos/entities/video.entity';
import { Channel } from './channels/entities/channel.entity';
import { User } from './users/entities/user.entity';
import { StorageModule } from './storage/storage.module';
import { QueueModule } from './queue/queue.module';
import { ProcessingModule } from './processing/processing.module';
import { VideoProcessor } from './processing/video.processor';
import { UploadSweepProcessor } from './processing/upload-sweep.processor';
import { UploadSweepService } from './processing/upload-sweep.service';
import { UploadSweepScheduler } from './processing/upload-sweep.scheduler';
import { WorkerHeartbeatService } from './worker/worker-heartbeat.service';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmModuleAsyncOptions),
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    QueueModule,
    ProcessingModule,
  ],
  providers: [
    VideoProcessor,
    UploadSweepProcessor,
    UploadSweepService,
    UploadSweepScheduler,
    WorkerHeartbeatService,
  ],
})
export class WorkerModule {}
