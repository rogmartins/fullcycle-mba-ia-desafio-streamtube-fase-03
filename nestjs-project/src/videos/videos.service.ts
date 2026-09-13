import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { QueryFailedError, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  StorageUnavailableException,
  UnsupportedMediaTypeException,
  UploadIncompleteException,
  UploadLimitReachedException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import storageConfig from '../config/storage.config';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.types';
import { CreateVideoDto } from './dto/create-video.dto';
import { PartDto } from './dto/complete-upload.dto';
import { generatePublicId, isValidPublicId } from './public-id.util';
import {
  deriveTitle,
  getExtension,
  isExtensionAllowedForContentType,
} from './title.util';
import { buildDownloadFilename } from './download-filename.util';
import {
  InvalidPartsError,
  StorageUnavailableError,
  UploadNotFoundError,
} from '../storage/storage.errors';
import { VideoQueueService } from '../queue/video-queue.service';

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
    private readonly videoQueueService: VideoQueueService,
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

  async getOwnedVideo(videoId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new VideoNotOwnedException();
    }
    return video;
  }

  assertStatus(video: Video, ...expected: VideoStatus[]): void {
    if (!expected.includes(video.status)) {
      throw new VideoInvalidStateException(video.status, expected);
    }
  }

  async signPart(
    videoId: string,
    userId: string,
    partNumber: number,
  ): Promise<{ part_number: number; url: string; expires_at: Date }> {
    const video = await this.getOwnedVideo(videoId, userId);
    this.assertStatus(video, VideoStatus.UPLOADING);

    if (partNumber < 1 || partNumber > video.part_count) {
      throw new BadRequestException(
        `partNumber must be between 1 and ${video.part_count}`,
      );
    }

    const { url, expiresAt } = await this.storageService.presignUploadPart(
      video.storage_key,
      video.upload_id!,
      partNumber,
      this.config.uploadPartUrlTtlSeconds,
    );

    return { part_number: partNumber, url, expires_at: expiresAt };
  }

  async listUploadedParts(
    videoId: string,
    userId: string,
  ): Promise<
    {
      part_number: number;
      etag: string;
      size_bytes: number;
      last_modified: Date | undefined;
    }[]
  > {
    const video = await this.getOwnedVideo(videoId, userId);
    this.assertStatus(video, VideoStatus.UPLOADING);

    try {
      const parts = await this.storageService.listParts(
        video.storage_key,
        video.upload_id!,
      );
      return parts
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({
          part_number: p.partNumber,
          etag: p.etag,
          size_bytes: p.sizeBytes,
          last_modified: p.lastModified,
        }));
    } catch (error) {
      if (error instanceof UploadNotFoundError) {
        throw new VideoInvalidStateException(
          video.status,
          [VideoStatus.UPLOADING],
          'The store no longer has this multipart upload — complete or delete it',
        );
      }
      throw error;
    }
  }

  async completeUpload(
    videoId: string,
    userId: string,
    parts: PartDto[],
  ): Promise<Video> {
    const video = await this.getOwnedVideo(videoId, userId);
    this.assertStatus(video, VideoStatus.UPLOADING);

    let storedParts: Awaited<ReturnType<StorageService['listParts']>>;
    try {
      storedParts = await this.storageService.listParts(
        video.storage_key,
        video.upload_id!,
      );
    } catch (error) {
      if (error instanceof UploadNotFoundError) {
        throw new UploadIncompleteException(
          'The store no longer has this multipart upload',
        );
      }
      throw error;
    }

    this.verifyPartsMatchExpectation(video, storedParts, parts);

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id!,
        parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
      );
    } catch (error) {
      if (error instanceof InvalidPartsError) {
        throw new UploadIncompleteException();
      }
      if (error instanceof StorageUnavailableError) {
        throw new StorageUnavailableException();
      }
      throw error;
    }

    const result = await this.videoRepository
      .createQueryBuilder()
      .update(Video)
      .set({ status: VideoStatus.PROCESSING, uploaded_at: new Date() })
      .where('id = :id AND status = :status', {
        id: videoId,
        status: VideoStatus.UPLOADING,
      })
      .execute();

    if (result.affected === 0) {
      throw new VideoInvalidStateException(video.status, [
        VideoStatus.UPLOADING,
      ]);
    }

    try {
      await this.videoQueueService.enqueueProcessing(videoId);
    } catch (error) {
      // The sweep re-enqueues stale `processing` rows (N-06b) — a publish failure
      // here is not fatal to the request.
      this.logger.error(
        `Failed to enqueue processing job for video ${videoId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    return this.getOwnedVideo(videoId, userId);
  }

  private verifyPartsMatchExpectation(
    video: Video,
    storedParts: { partNumber: number; etag: string; sizeBytes: number }[],
    declaredParts: PartDto[],
  ): void {
    const problems: string[] = [];
    const storedByNumber = new Map(storedParts.map((p) => [p.partNumber, p]));

    if (storedParts.length !== video.part_count) {
      problems.push(
        `expected ${video.part_count} parts, store has ${storedParts.length}`,
      );
    }

    const lastPartNumber = video.part_count;
    for (const stored of storedParts) {
      if (
        stored.partNumber !== lastPartNumber &&
        stored.sizeBytes !== video.part_size_bytes
      ) {
        problems.push(
          `part ${stored.partNumber} has size ${stored.sizeBytes}, expected ${video.part_size_bytes}`,
        );
      }
    }

    if (declaredParts.length !== video.part_count) {
      problems.push(
        `expected ${video.part_count} declared parts, got ${declaredParts.length}`,
      );
    }

    const declaredByNumber = new Map(
      declaredParts.map((p) => [p.part_number, p]),
    );
    for (let partNumber = 1; partNumber <= video.part_count; partNumber++) {
      const declared = declaredByNumber.get(partNumber);
      const stored = storedByNumber.get(partNumber);
      if (!declared) {
        problems.push(`part ${partNumber} was not declared`);
      } else if (!stored) {
        problems.push(`part ${partNumber} was not uploaded`);
      } else if (stored.etag !== declared.etag) {
        problems.push(`part ${partNumber} has a mismatched ETag`);
      }
    }

    if (problems.length > 0) {
      throw new UploadIncompleteException(
        `Uploaded parts do not match the expected upload: ${problems.join('; ')}`,
      );
    }
  }

  async cancelUpload(videoId: string, userId: string): Promise<void> {
    const video = await this.getOwnedVideo(videoId, userId);
    this.assertStatus(video, VideoStatus.UPLOADING, VideoStatus.FAILED);

    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id,
      );
    }

    await this.storageService.deleteByPrefix(
      this.config.videoBucket,
      `videos/${video.id}/`,
    );
    if (video.thumbnail_key) {
      await this.storageService
        .deleteByPrefix(this.config.thumbnailBucket, video.thumbnail_key)
        .catch(() => undefined);
    }

    await this.videoRepository.delete({ id: video.id });
    await this.videoQueueService.removeIfWaitingOrDelayed(video.id);
  }

  async findByPublicId(publicId: string): Promise<Video> {
    if (!isValidPublicId(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  getThumbnailUrl(video: Video): string | null {
    if (!video.thumbnail_key) {
      return null;
    }
    return this.storageService.getThumbnailPublicUrl(video.thumbnail_key);
  }

  async getPlaybackUrl(
    publicId: string,
  ): Promise<{ url: string; expires_at: Date }> {
    const video = await this.findByPublicId(publicId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const { url, expiresAt } = await this.storageService.presignGetObject(
      video.storage_key,
      this.config.playbackUrlTtlSeconds,
      { audience: 'public' },
    );
    return { url, expires_at: expiresAt };
  }

  async getDownloadUrl(
    publicId: string,
  ): Promise<{ url: string; expires_at: Date; filename: string }> {
    const video = await this.findByPublicId(publicId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const filename = buildDownloadFilename(
      video.title,
      video.storage_key,
      video.public_id,
    );

    const { url, expiresAt } = await this.storageService.presignGetObject(
      video.storage_key,
      this.config.downloadUrlTtlSeconds,
      {
        audience: 'public',
        responseContentDisposition: `attachment; filename="${filename}"`,
      },
    );
    return { url, expires_at: expiresAt, filename };
  }
}
