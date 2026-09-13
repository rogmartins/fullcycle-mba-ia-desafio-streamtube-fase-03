export class InvalidMediaError extends Error {
  constructor(message = 'The source is not a valid media file') {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

export class FfmpegExecutionError extends Error {
  constructor(
    public readonly stderr: string,
    public readonly timedOut: boolean,
  ) {
    super(
      timedOut
        ? 'ffmpeg/ffprobe process timed out'
        : 'ffmpeg/ffprobe process exited with a non-zero status',
    );
    this.name = 'FfmpegExecutionError';
  }
}
