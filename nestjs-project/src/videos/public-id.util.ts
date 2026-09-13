import { randomBytes } from 'node:crypto';

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{12}$/;

export function generatePublicId(): string {
  return randomBytes(9).toString('base64url').slice(0, 12);
}

export function isValidPublicId(publicId: string): boolean {
  return PUBLIC_ID_PATTERN.test(publicId);
}
