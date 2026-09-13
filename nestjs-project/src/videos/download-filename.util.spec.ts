import { buildDownloadFilename } from './download-filename.util';

describe('buildDownloadFilename', () => {
  it('strips diacritics and replaces unsafe chars', () => {
    expect(
      buildDownloadFilename(
        'Férias 2026: praia!',
        'videos/abc/source.mp4',
        'pub123456789',
      ),
    ).toBe('Ferias-2026-praia.mp4');
  });

  it('collapses repeated unsafe chars into one dash', () => {
    expect(
      buildDownloadFilename(
        'a///b***c',
        'videos/abc/source.mp4',
        'pub123456789',
      ),
    ).toBe('a-b-c.mp4');
  });

  it('caps the sanitized stem at 80 characters', () => {
    const longTitle = 'a'.repeat(150);
    const filename = buildDownloadFilename(
      longTitle,
      'videos/abc/source.mp4',
      'pub123456789',
    );
    expect(filename).toBe(`${'a'.repeat(80)}.mp4`);
  });

  it('takes the extension from the storage key, not the title', () => {
    expect(
      buildDownloadFilename(
        'My Clip',
        'videos/abc/source.webm',
        'pub123456789',
      ),
    ).toBe('My-Clip.webm');
  });

  it('falls back to video-<publicId>.<ext> when the sanitized stem is empty', () => {
    expect(
      buildDownloadFilename('!!!', 'videos/abc/source.mp4', 'pub123456789'),
    ).toBe('video-pub123456789.mp4');
  });

  it('falls back when the title is only dots and dashes', () => {
    expect(
      buildDownloadFilename(
        '...---...',
        'videos/abc/source.mov',
        'pub123456789',
      ),
    ).toBe('video-pub123456789.mov');
  });

  it('trims leading and trailing dashes/dots after sanitizing', () => {
    expect(
      buildDownloadFilename(
        '-.My Title.-',
        'videos/abc/source.mp4',
        'pub123456789',
      ),
    ).toBe('My-Title.mp4');
  });
});
