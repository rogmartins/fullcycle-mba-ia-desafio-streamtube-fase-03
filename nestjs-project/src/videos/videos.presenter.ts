import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.types';

export interface OwnerVideoView {
  id: string;
  public_id: string;
  status: VideoStatus;
  title: string;
  size_bytes: number;
  content_type: string;
  created_at: Date;
  uploaded_at?: Date;
  upload?: {
    upload_id: string;
    part_size_bytes: number;
    part_count: number;
  };
}

export interface PublicVideoView {
  public_id: string;
  title: string;
  status: VideoStatus;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number;
  thumbnail_url: string | null;
  created_at: Date;
}

export function toOwnerView(video: Video): OwnerVideoView {
  const view: OwnerVideoView = {
    id: video.id,
    public_id: video.public_id,
    status: video.status,
    title: video.title,
    size_bytes: Number(video.size_bytes),
    content_type: video.content_type,
    created_at: video.created_at,
  };

  if (video.uploaded_at) {
    view.uploaded_at = video.uploaded_at;
  }

  if (video.status === VideoStatus.UPLOADING && video.upload_id) {
    view.upload = {
      upload_id: video.upload_id,
      part_size_bytes: video.part_size_bytes,
      part_count: video.part_count,
    };
  }

  return view;
}

export function toPublicView(
  video: Video,
  thumbnailUrl: string | null,
): PublicVideoView {
  return {
    public_id: video.public_id,
    title: video.title,
    status: video.status,
    duration_seconds:
      video.duration_seconds !== null ? Number(video.duration_seconds) : null,
    width: video.width,
    height: video.height,
    size_bytes: Number(video.size_bytes),
    thumbnail_url: thumbnailUrl,
    created_at: video.created_at,
  };
}
