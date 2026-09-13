import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import processingConfig from '../config/processing.config';
import { ProcessingModule } from './processing.module';
import { FfmpegService } from './ffmpeg.service';

describe('ProcessingModule', () => {
  it('compiles with processingConfig resolved', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [processingConfig] }),
        ProcessingModule,
      ],
    }).compile();

    expect(module.get(FfmpegService)).toBeInstanceOf(FfmpegService);
  });
});
