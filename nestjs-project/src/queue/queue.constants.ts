export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_MAINTENANCE_QUEUE = 'video-maintenance';

export const PROCESS_VIDEO_JOB = 'process-video';
export const UPLOAD_SWEEP_JOB = 'upload-sweep';

export const UPLOAD_SWEEP_SCHEDULER = 'upload-sweep-every';

export function processingJobId(videoId: string): string {
  return `video-${videoId}`;
}
