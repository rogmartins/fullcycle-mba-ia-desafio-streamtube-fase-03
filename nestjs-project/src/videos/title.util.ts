import { MEDIA_TYPE_ALLOWLIST } from './media-types';

const DEFAULT_TITLE = 'Untitled video';
const MAX_TITLE_LENGTH = 100;

export function deriveTitle(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  // lastDot === 0 means the filename is only an extension (e.g. ".mp4") — no stem.
  const stem =
    lastDot > 0 ? filename.slice(0, lastDot) : lastDot === 0 ? '' : filename;
  const collapsed = stem.trim().replace(/\s+/g, ' ');

  if (collapsed.length === 0) {
    return DEFAULT_TITLE;
  }

  return collapsed.slice(0, MAX_TITLE_LENGTH);
}

export function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) {
    return '';
  }
  return filename.slice(lastDot).toLowerCase();
}

export function isExtensionAllowedForContentType(
  filename: string,
  contentType: string,
): boolean {
  const allowedExtensions = MEDIA_TYPE_ALLOWLIST[contentType];
  if (!allowedExtensions) {
    return false;
  }
  return allowedExtensions.includes(getExtension(filename));
}
