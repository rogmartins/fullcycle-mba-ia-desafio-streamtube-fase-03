import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import { InvalidPartsError, UploadNotFoundError } from './storage.errors';

// STORAGE_PUBLIC_ENDPOINT (http://localhost:9000 by default) is the browser-facing
// address and is not reachable from inside this container's network namespace. This
// suite runs inside the nestjs-api container and fetches presigned URLs directly, so
// it points the "public" client at the Compose service name instead — this changes
// only where THIS test resolves the host, not the StorageService presigning logic
// under test.
process.env.STORAGE_PUBLIC_ENDPOINT = 'http://minio:9000';

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let service: StorageService;
  const runPrefix = `test-runs/${randomUUID()}`;
  const videoBucket = process.env.STORAGE_VIDEO_BUCKET || 'videos';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    service = module.get(StorageService);
  });

  afterAll(async () => {
    await service.deleteByPrefix(videoBucket, `${runPrefix}/`);
    await module.close();
  });

  it('creates, uploads, lists, and completes a multipart upload producing a readable object', async () => {
    const key = `${runPrefix}/complete-flow.bin`;
    const partBody = Buffer.alloc(5 * 1024 * 1024, 'a');

    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    expect(uploadId).toBeTruthy();

    const { url } = await service.presignUploadPart(key, uploadId, 1, 3600);
    const putResponse = await fetch(url, { method: 'PUT', body: partBody });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag')!;
    expect(etag).toBeTruthy();

    const parts = await service.listParts(key, uploadId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partNumber).toBe(1);
    expect(parts[0].etag).toBe(etag);

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);

    const exists = await service.objectExists(videoBucket, key);
    expect(exists).toBe(true);
  });

  it('aborts a multipart upload', async () => {
    const key = `${runPrefix}/abort-flow.bin`;
    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    await service.abortMultipartUpload(key, uploadId);

    await expect(service.listParts(key, uploadId)).rejects.toThrow(
      UploadNotFoundError,
    );
  });

  it('throws UploadNotFoundError for an unknown uploadId', async () => {
    const key = `${runPrefix}/unknown.bin`;
    await expect(
      service.listParts(key, 'nonexistent-upload-id'),
    ).rejects.toThrow(UploadNotFoundError);
  });

  it('throws InvalidPartsError when completing with a wrong ETag', async () => {
    const key = `${runPrefix}/wrong-etag.bin`;
    const partBody = Buffer.alloc(5 * 1024 * 1024, 'b');
    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    const { url } = await service.presignUploadPart(key, uploadId, 1, 3600);
    await fetch(url, { method: 'PUT', body: partBody });

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"deadbeefdeadbeefdeadbeefdeadbeef"' },
      ]),
    ).rejects.toThrow(InvalidPartsError);

    await service.abortMultipartUpload(key, uploadId);
  });

  it('presigned GET URL serves range requests with 206 and honours a response-content-disposition', async () => {
    const key = `${runPrefix}/object.txt`;
    const body = Buffer.from('0123456789abcdef');
    await service.putObject(videoBucket, key, body, 'text/plain');

    const { url: rangeUrl } = await service.presignGetObject(key, 3600, {
      audience: 'internal',
    });
    const rangeResponse = await fetch(rangeUrl, {
      headers: { Range: 'bytes=0-9' },
    });
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get('content-range')).toContain('bytes 0-9');

    const { url: dispositionUrl } = await service.presignGetObject(key, 3600, {
      audience: 'internal',
      responseContentDisposition: 'attachment; filename="x.mp4"',
    });
    const dispositionResponse = await fetch(dispositionUrl);
    expect(dispositionResponse.headers.get('content-disposition')).toBe(
      'attachment; filename="x.mp4"',
    );
  });

  it('deletes every object under a prefix', async () => {
    const prefix = `${runPrefix}/delete-me/`;
    await service.putObject(
      videoBucket,
      `${prefix}a.txt`,
      Buffer.from('a'),
      'text/plain',
    );
    await service.putObject(
      videoBucket,
      `${prefix}b.txt`,
      Buffer.from('b'),
      'text/plain',
    );

    await service.deleteByPrefix(videoBucket, prefix);

    expect(await service.objectExists(videoBucket, `${prefix}a.txt`)).toBe(
      false,
    );
    expect(await service.objectExists(videoBucket, `${prefix}b.txt`)).toBe(
      false,
    );
  });

  it('presigns upload-part and public GET URLs against the public endpoint, internal GET against the internal endpoint', async () => {
    const key = `${runPrefix}/audience.bin`;
    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    const { url: partUrl } = await service.presignUploadPart(
      key,
      uploadId,
      1,
      3600,
    );
    expect(partUrl.startsWith(process.env.STORAGE_PUBLIC_ENDPOINT!)).toBe(true);
    await service.abortMultipartUpload(key, uploadId);

    await service.putObject(videoBucket, key, Buffer.from('x'), 'text/plain');
    const { url: publicGetUrl } = await service.presignGetObject(key, 3600, {
      audience: 'public',
    });
    expect(publicGetUrl.startsWith(process.env.STORAGE_PUBLIC_ENDPOINT!)).toBe(
      true,
    );

    const { url: internalGetUrl } = await service.presignGetObject(key, 3600, {
      audience: 'internal',
    });
    expect(internalGetUrl.startsWith(process.env.STORAGE_ENDPOINT!)).toBe(true);
  });

  it('pages and filters in-progress multipart uploads by prefix', async () => {
    const prefix = `${runPrefix}/orphans/`;
    const keyA = `${prefix}a.bin`;
    const keyB = `${prefix}b.bin`;
    const uploadIdA = await service.createMultipartUpload(
      keyA,
      'application/octet-stream',
    );
    const uploadIdB = await service.createMultipartUpload(
      keyB,
      'application/octet-stream',
    );

    const uploads = await service.listMultipartUploads(prefix);
    const keys = uploads.map((u) => u.key).sort();
    expect(keys).toEqual([keyA, keyB].sort());

    await service.abortMultipartUpload(keyA, uploadIdA);
    await service.abortMultipartUpload(keyB, uploadIdB);
  });
});
