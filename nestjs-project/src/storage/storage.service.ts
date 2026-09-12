import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PUBLIC_CLIENT,
} from './storage.constants';
import {
  InvalidPartsError,
  StorageUnavailableError,
  UploadNotFoundError,
} from './storage.errors';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
  lastModified: Date | undefined;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface InProgressUpload {
  key: string;
  uploadId: string;
}

export interface SignedUrlResult {
  url: string;
  expiresAt: Date;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(STORAGE_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  private isConnectivityFailure(error: unknown): boolean {
    const err = error as {
      $metadata?: { httpStatusCode?: number };
      code?: string;
      name?: string;
    };
    if (err?.code === 'ECONNREFUSED' || err?.name === 'ECONNREFUSED') {
      return true;
    }
    const status = err?.$metadata?.httpStatusCode;
    if (status === undefined) {
      const logicalErrors = [
        'NoSuchUpload',
        'InvalidPart',
        'InvalidPartOrder',
        'NotFound',
        'NoSuchKey',
      ];
      return !logicalErrors.includes(err?.name ?? '');
    }
    return status >= 500;
  }

  private wrapUnavailable(error: unknown): never {
    if (this.isConnectivityFailure(error)) {
      throw new StorageUnavailableError(
        error instanceof Error
          ? error.message
          : 'Storage service is unavailable',
      );
    }
    throw error;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    try {
      const result = await this.internalClient.send(
        new CreateMultipartUploadCommand({
          Bucket: this.config.videoBucket,
          Key: key,
          ContentType: contentType,
        }),
      );
      if (!result.UploadId) {
        throw new Error('S3 did not return an UploadId');
      }
      return result.UploadId;
    } catch (error) {
      this.wrapUnavailable(error);
    }
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let partNumberMarker: string | undefined;
    try {
      do {
        const result = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.config.videoBucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: partNumberMarker,
          }),
        );
        for (const part of result.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber!,
            etag: part.ETag!,
            sizeBytes: part.Size!,
            lastModified: part.LastModified,
          });
        }
        partNumberMarker = result.IsTruncated
          ? result.NextPartNumberMarker
          : undefined;
      } while (partNumberMarker);
      return parts;
    } catch (error) {
      const err = error as { name?: string };
      if (err?.name === 'NoSuchUpload') {
        throw new UploadNotFoundError();
      }
      this.wrapUnavailable(error);
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.videoBucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sorted.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
            })),
          },
        }),
      );
    } catch (error) {
      const err = error as { name?: string };
      if (err?.name === 'InvalidPart' || err?.name === 'InvalidPartOrder') {
        throw new InvalidPartsError();
      }
      if (err?.name === 'NoSuchUpload') {
        throw new UploadNotFoundError();
      }
      this.wrapUnavailable(error);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.videoBucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      const err = error as { name?: string };
      if (err?.name === 'NoSuchUpload') {
        return;
      }
      this.wrapUnavailable(error);
    }
  }

  async listMultipartUploads(prefix: string): Promise<InProgressUpload[]> {
    // Prefix is filtered client-side rather than passed to the SDK: this MinIO build's
    // ListMultipartUploads only matches an exact full key against `Prefix`, not a real
    // prefix (verified directly — "a/" and "a" both return nothing for a key "a/b.bin",
    // while the exact key matches). Listing unfiltered and filtering here works
    // identically against real S3, where server-side prefix filtering is just redundant.
    const uploads: InProgressUpload[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    try {
      do {
        const result = await this.internalClient.send(
          new ListMultipartUploadsCommand({
            Bucket: this.config.videoBucket,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          }),
        );
        for (const upload of result.Uploads ?? []) {
          if (upload.Key?.startsWith(prefix)) {
            uploads.push({ key: upload.Key, uploadId: upload.UploadId! });
          }
        }
        if (result.IsTruncated) {
          keyMarker = result.NextKeyMarker;
          uploadIdMarker = result.NextUploadIdMarker;
        } else {
          keyMarker = undefined;
          uploadIdMarker = undefined;
        }
      } while (keyMarker);
      return uploads;
    } catch (error) {
      this.wrapUnavailable(error);
    }
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<SignedUrlResult> {
    try {
      const command = new UploadPartCommand({
        Bucket: this.config.videoBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(this.publicClient, command, {
        expiresIn: ttlSeconds,
      });
      return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
    } catch (error) {
      this.wrapUnavailable(error);
    }
  }

  async presignGetObject(
    key: string,
    ttlSeconds: number,
    options: {
      audience: 'public' | 'internal';
      responseContentDisposition?: string;
      bucket?: string;
    },
  ): Promise<SignedUrlResult> {
    try {
      const client =
        options.audience === 'public' ? this.publicClient : this.internalClient;
      const command = new GetObjectCommand({
        Bucket: options.bucket ?? this.config.videoBucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: ttlSeconds,
      });
      return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
    } catch (error) {
      this.wrapUnavailable(error);
    }
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl?: string,
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
        }),
      );
    } catch (error) {
      this.wrapUnavailable(error);
    }
  }

  async objectExists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.internalClient.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return true;
    } catch (error) {
      const err = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
        return false;
      }
      this.wrapUnavailable(error);
    }
  }

  async deleteByPrefix(bucket: string, prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    try {
      do {
        const listResult = await this.internalClient.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        const objects = (listResult.Contents ?? [])
          .filter((o) => o.Key)
          .map((o) => ({ Key: o.Key! }));
        if (objects.length > 0) {
          await this.internalClient.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects },
            }),
          );
        }
        continuationToken = listResult.IsTruncated
          ? listResult.NextContinuationToken
          : undefined;
      } while (continuationToken);
    } catch (error) {
      this.wrapUnavailable(error);
    }
  }

  getThumbnailPublicUrl(key: string): string {
    return `${this.config.publicEndpoint}/${this.config.thumbnailBucket}/${key}`;
  }
}
