import { generateVideoSlug } from './slug.util';

describe('generateVideoSlug', () => {
  it('should generate an 11-character URL-safe base64url slug matching ^[A-Za-z0-9_-]{11}$', () => {
    for (let i = 0; i < 100; i++) {
      const slug = generateVideoSlug();
      expect(slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should generate distinct slugs across multiple invocations', () => {
    const slugs = new Set(Array.from({ length: 500 }, () => generateVideoSlug()));
    expect(slugs.size).toBe(500);
  });
});
