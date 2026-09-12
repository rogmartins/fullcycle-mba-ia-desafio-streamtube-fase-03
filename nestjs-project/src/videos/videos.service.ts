import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { QueryFailedError, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  StorageUnavailableException,
  UnsupportedMediaTypeException,
  UploadLimitReachedException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import storageConfig from '../config/storage.config';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.types';
import { CreateVideoDto } from './dto/create-video.dto';
import { generatePublicId } from './public-id.util';
import {
  deriveTitle,
  getExtension,
  isExtensionAllowedForContentType,
} from './title.util';
import { StorageUnavailableError } from '../storage/storage.errors';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';
const MAX_PUBLIC_ID_RETRIES = 5;

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as unknown as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async createUpload(userId: string, dto: CreateVideoDto): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    // A confirmed user always has a channel (Phase 02) — channel is non-null here.
    const channelId = channel!.id;

    if (!isExtensionAllowedForContentType(dto.filename, dto.content_type)) {
      throw new UnsupportedMediaTypeException();
    }

    const openUploadsCount = await this.videoRepository.count({
      where: { channel_id: channelId, status: VideoStatus.UPLOADING },
    });
    if (openUploadsCount >= this.config.uploadMaxOpenPerChannel) {
      throw new UploadLimitReachedException(
        this.config.uploadMaxOpenPerChannel,
      );
    }

    const partSizeBytes = this.config.uploadPartSizeBytes;
    const partCount = Math.ceil(dto.size_bytes / partSizeBytes);
    const extension = getExtension(dto.filename);
    const internalId = randomUUID();
    const storageKey = `videos/${internalId}/source${extension}`;

    let uploadId: string;
    try {
      uploadId = await this.storageService.createMultipartUpload(
        storageKey,
        dto.content_type,
      );
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw new StorageUnavailableException();
      }
      throw error;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_PUBLIC_ID_RETRIES; attempt++) {
      const publicId = generatePublicId();
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            id: internalId,
            public_id: publicId,
            channel_id: channelId,
            title: deriveTitle(dto.filename),
            original_filename: dto.filename,
            content_type: dto.content_type,
            size_bytes: String(dto.size_bytes),
            status: VideoStatus.UPLOADING,
            storage_key: storageKey,
            upload_id: uploadId,
            part_size_bytes: partSizeBytes,
            part_count: partCount,
          }),
        );
      } catch (error) {
        lastError = error;
        if (!isPgUniqueViolationOnColumn(error, PUBLIC_ID_COLUMN)) {
          break;
        }
      }
    }

    // Insert never succeeded — abort the multipart upload we already opened on the
    // store before surfacing the failure, so no orphaned upload is left behind.
    try {
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
    } catch (abortError) {
      this.logger.error(
        `Failed to abort orphaned multipart upload for ${storageKey}`,
        abortError instanceof Error ? abortError.stack : undefined,
      );
    }
    throw lastError;
  }
}
