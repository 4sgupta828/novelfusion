import { describe, expect, it } from 'vitest';
import { assertPublicUrl, segmentDocument, extractReadable } from '../src/pipeline/ingest.js';

describe('assertPublicUrl (SSRF guard — security-critical)', () => {
  it('allows public http(s)', () => {
    expect(assertPublicUrl('https://example.com/page').hostname).toBe('example.com');
  });
  it('blocks non-web schemes', () => {
    expect(() => assertPublicUrl('file:///etc/passwd')).toThrow();
    expect(() => assertPublicUrl('ftp://host/x')).toThrow();
  });
  it('blocks localhost and loopback', () => {
    expect(() => assertPublicUrl('http://localhost:4780/api')).toThrow(/non-public/);
    expect(() => assertPublicUrl('http://127.0.0.1/')).toThrow(/non-public/);
  });
  it('blocks private and link-local ranges (rebinding / metadata)', () => {
    expect(() => assertPublicUrl('http://10.0.0.5/')).toThrow(/non-public/);
    expect(() => assertPublicUrl('http://192.168.1.1/')).toThrow(/non-public/);
    expect(() => assertPublicUrl('http://169.254.169.254/latest/meta-data')).toThrow(/non-public/);
    expect(() => assertPublicUrl('http://172.16.0.1/')).toThrow(/non-public/);
    expect(() => assertPublicUrl('http://box.internal/')).toThrow(/non-public/);
  });
  it('rejects malformed URLs', () => expect(() => assertPublicUrl('not a url')).toThrow());
});

describe('segmentDocument', () => {
  it('splits on headings and blank lines, carries the nearest heading', () => {
    const segs = segmentDocument('# Title\n\nFirst paragraph about the topic here.\n\n## Section Two\n\nSecond paragraph with enough content to keep.');
    expect(segs.length).toBe(2);
    expect(segs[0]).toMatchObject({ heading: 'Title' });
    expect(segs[1]!.heading).toBe('Section Two');
  });
  it('drops sub-24-char fragments', () => {
    expect(segmentDocument('# H\n\nshort').length).toBe(0);
  });
});

describe('extractReadable', () => {
  it('pulls a title and drops script/style', () => {
    const { title, blocks } = extractReadable(
      '<html><head><title>My Page</title></head><body><script>evil()</script><h2>Heading</h2><p>A paragraph of real readable content here.</p></body></html>',
    );
    expect(title).toBe('My Page');
    expect(blocks.some((b) => b.text.includes('readable content'))).toBe(true);
    expect(blocks.some((b) => b.text.includes('evil'))).toBe(false);
  });
});
