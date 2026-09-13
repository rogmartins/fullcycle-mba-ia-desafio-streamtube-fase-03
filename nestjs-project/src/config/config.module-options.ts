import type { ConfigModuleOptions } from '@nestjs/config';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import mailConfig from './mail.config';
import queueConfig from './queue.config';
import storageConfig from './storage.config';
import processingConfig from './processing.config';
import { envValidationSchema } from './env.validation';

export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  load: [
    appConfig,
    authConfig,
    databaseConfig,
    mailConfig,
    queueConfig,
    storageConfig,
    processingConfig,
  ],
  validationSchema: envValidationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
};
