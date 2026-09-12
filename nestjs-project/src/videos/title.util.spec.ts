import {
  deriveTitle,
  getExtension,
  isExtensionAllowedForContentType,
} from './title.util';

describe('deriveTitle', () => {
  it('strips the extension', () => {
    expect(deriveTitle('trip.mp4')).toBe('trip');
  });

  it('collapses internal whitespace and trims', () => {
    expect(deriveTitle('  my   video  .mp4')).toBe('my video');
  });

  it('truncates to 100 characters', () => {
    const longStem = 'a'.repeat(150);
    expect(deriveTitle(`${longStem}.mp4`)).toHaveLength(100);
  });

  it('falls back to "Untitled video" when the stem is empty', () => {
    expect(deriveTitle('.mp4')).toBe('Untitled video');
    expect(deriveTitle('   .mp4')).toBe('Untitled video');
  });

  it('falls back when there is no extension and no content', () => {
    expect(deriveTitle('')).toBe('Untitled video');
  });
});

describe('getExtension', () => {
  it('returns the lower-cased extension', () => {
    expect(getExtension('trip.MOV')).toBe('.mov');
  });

  it('returns empty string when there is no extension', () => {
    expect(getExtension('noext')).toBe('');
  });
});

describe('isExtensionAllowedForContentType', () => {
  it('accepts .MOV for video/quicktime (case-insensitive)', () => {
    expect(
      isExtensionAllowedForContentType('trip.MOV', 'video/quicktime'),
    ).toBe(true);
  });

  it('rejects .mkv for any allowlisted content type', () => {
    expect(isExtensionAllowedForContentType('movie.mkv', 'video/mp4')).toBe(
      false,
    );
  });

  it('accepts .mp4 and .m4v for video/mp4', () => {
    expect(isExtensionAllowedForContentType('a.mp4', 'video/mp4')).toBe(true);
    expect(isExtensionAllowedForContentType('a.m4v', 'video/mp4')).toBe(true);
  });

  it('accepts .webm for video/webm', () => {
    expect(isExtensionAllowedForContentType('a.webm', 'video/webm')).toBe(true);
  });

  it('rejects an unknown content type', () => {
    expect(isExtensionAllowedForContentType('a.mkv', 'video/x-matroska')).toBe(
      false,
    );
  });
});
