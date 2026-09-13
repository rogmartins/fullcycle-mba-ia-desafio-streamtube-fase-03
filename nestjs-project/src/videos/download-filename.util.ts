const MAX_STEM_LENGTH = 80;

function getExtensionFromKey(storageKey: string): string {
  const lastDot = storageKey.lastIndexOf('.');
  if (lastDot <= 0) {
    return '';
  }
  return storageKey.slice(lastDot).toLowerCase();
}

export function buildDownloadFilename(
  title: string,
  storageKey: string,
  publicId: string,
): string {
  const extension = getExtensionFromKey(storageKey);

  const sanitizedStem = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_STEM_LENGTH);

  if (sanitizedStem.length === 0) {
    return `video-${publicId}${extension}`;
  }

  return `${sanitizedStem}${extension}`;
}
