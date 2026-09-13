import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideosService } from './videos.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import {
  toOwnerView,
  toPublicView,
  OwnerVideoView,
  PublicVideoView,
} from './videos.presenter';

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

  @Post(':id/upload/parts/:partNumber/url')
  @HttpCode(HttpStatus.OK)
  async signPart(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
  ): Promise<{ part_number: number; url: string; expires_at: Date }> {
    return this.videosService.signPart(id, user.sub, partNumber);
  }

  @Get(':id/upload/parts')
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{
    parts: {
      part_number: number;
      etag: string;
      size_bytes: number;
      last_modified: Date | undefined;
    }[];
  }> {
    const parts = await this.videosService.listUploadedParts(id, user.sub);
    return { parts };
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<OwnerVideoView> {
    const video = await this.videosService.completeUpload(
      id,
      user.sub,
      dto.parts,
    );
    return toOwnerView(video);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.cancelUpload(id, user.sub);
  }

  @Public()
  @Get(':publicId')
  async findByPublicId(
    @Param('publicId') publicId: string,
  ): Promise<PublicVideoView> {
    const video = await this.videosService.findByPublicId(publicId);
    return toPublicView(video, this.videosService.getThumbnailUrl(video));
  }

  @Public()
  @Get(':publicId/playback')
  async getPlaybackUrl(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; expires_at: Date }> {
    return this.videosService.getPlaybackUrl(publicId);
  }

  @Public()
  @Get(':publicId/download')
  async getDownloadUrl(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; expires_at: Date; filename: string }> {
    return this.videosService.getDownloadUrl(publicId);
  }
}
