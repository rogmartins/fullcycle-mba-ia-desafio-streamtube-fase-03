import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PUBLIC_CLIENT,
} from './storage.constants';

describe('StorageModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('resolves StorageService', () => {
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
  });

  it('resolves both S3 client providers from storageConfig', () => {
    expect(module.get(STORAGE_INTERNAL_CLIENT)).toBeInstanceOf(S3Client);
    expect(module.get(STORAGE_PUBLIC_CLIENT)).toBeInstanceOf(S3Client);
  });
});
