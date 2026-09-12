export class UploadNotFoundError extends Error {
  constructor(message = 'Multipart upload not found') {
    super(message);
    this.name = 'UploadNotFoundError';
  }
}

export class InvalidPartsError extends Error {
  constructor(message = 'Invalid parts') {
    super(message);
    this.name = 'InvalidPartsError';
  }
}

export class StorageUnavailableError extends Error {
  constructor(message = 'Storage service is unavailable') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}
