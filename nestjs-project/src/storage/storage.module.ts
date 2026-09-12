import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PUBLIC_CLIENT,
} from './storage.constants';

@Module({
  providers: [
    StorageService,
    {
      provide: STORAGE_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          forcePathStyle: true,
          credentials: {
            accessKeyId: config.accessKey,
            secretAccessKey: config.secretKey,
          },
        }),
    },
    {
      provide: STORAGE_PUBLIC_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        new S3Client({
          endpoint: config.publicEndpoint,
          region: config.region,
          forcePathStyle: true,
          credentials: {
            accessKeyId: config.accessKey,
            secretAccessKey: config.secretKey,
          },
        }),
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
