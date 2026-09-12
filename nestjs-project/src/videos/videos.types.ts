export enum VideoStatus {
  DRAFT = 'draft',
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export enum VideoErrorReason {
  INVALID_MEDIA = 'INVALID_MEDIA',
  PROCESSING_FAILED = 'PROCESSING_FAILED',
  UPLOAD_ABANDONED = 'UPLOAD_ABANDONED',
  THUMBNAIL_FAILED = 'THUMBNAIL_FAILED',
}
