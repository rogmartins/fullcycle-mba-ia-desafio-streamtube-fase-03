import { registerAs } from '@nestjs/config';

export default registerAs('processing', () => ({
  ffprobeTimeoutMs: parseInt(process.env.FFPROBE_TIMEOUT_MS || '120000', 10),
  ffmpegThumbnailTimeoutMs: parseInt(
    process.env.FFMPEG_THUMBNAIL_TIMEOUT_MS || '300000',
    10,
  ),
  thumbnailOffsetPercent: parseInt(
    process.env.THUMBNAIL_OFFSET_PERCENT || '10',
    10,
  ),
  thumbnailMaxWidth: parseInt(process.env.THUMBNAIL_MAX_WIDTH || '1280', 10),
  thumbnailJpegQuality: parseInt(process.env.THUMBNAIL_JPEG_QUALITY || '3', 10),
}));
