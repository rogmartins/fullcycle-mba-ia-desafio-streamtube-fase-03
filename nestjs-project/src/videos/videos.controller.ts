import { Body, Controller, Post, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideosService } from './videos.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { toOwnerView, OwnerVideoView } from './videos.presenter';

@Controller('videos')
@SkipThrottle()
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OwnerVideoView> {
    const video = await this.videosService.createUpload(user.sub, dto);
    res.setHeader('Location', `/videos/${video.public_id}`);
    res.status(201);
    return toOwnerView(video);
  }
}
