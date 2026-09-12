import { IsIn, IsInt, IsString, Length, Max, Min } from 'class-validator';
import { MEDIA_TYPE_ALLOWLIST } from '../media-types';

// UPLOAD_MAX_SIZE_BYTES default (10 GiB). Documented as the schema limit — the
// runtime service re-validates against the configured value, which may differ.
const UPLOAD_MAX_SIZE_BYTES_DEFAULT = 10737418240;

export class CreateVideoDto {
  @IsString()
  @Length(1, 255)
  filename: string;

  @IsInt()
  @Min(1)
  @Max(UPLOAD_MAX_SIZE_BYTES_DEFAULT)
  size_bytes: number;

  @IsIn(Object.keys(MEDIA_TYPE_ALLOWLIST))
  content_type: string;
}
