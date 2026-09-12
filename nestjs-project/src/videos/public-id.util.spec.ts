import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('returns a 12-character base64url string', () => {
    const id = generatePublicId();
    expect(id).toHaveLength(12);
    expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('generates 1000 ids without collision', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generatePublicId());
    }
    expect(ids.size).toBe(1000);
  });
});
