import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import type { TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';

export const typeOrmModuleAsyncOptions: TypeOrmModuleAsyncOptions = {
  imports: [ConfigModule],
  inject: [databaseConfig.KEY],
  useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  }),
};
