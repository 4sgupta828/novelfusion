import { describe, expect, it } from 'vitest';
import { parseTimestamp, parseTranscript } from '../src/pipeline/ingest.js';

describe('parseTimestamp', () => {
  it('parses hh:mm:ss', () => expect(parseTimestamp('01:02:03')).toBe(3723));
  it('parses mm:ss', () => expect(parseTimestamp('14:32')).toBe(872));
  it('parses fractional seconds', () => expect(parseTimestamp('00:00:12.500')).toBe(12.5));
  it('rejects garbage', () => expect(parseTimestamp('nonsense')).toBeNull());
});

describe('parseTranscript', () => {
  it('parses timestamped speaker lines', () => {
    const lines = parseTranscript('[00:00:12] Priya Sharma: Hello there.\n[00:01:05] Priya Sharma: Second point.');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ speaker: 'Priya Sharma', tStartSec: 12, text: 'Hello there.' });
  });

  it('parses plain speaker lines and merges continuations', () => {
    const lines = parseTranscript('Dev Okonkwo: First sentence.\nwhich continues here.\nPriya Sharma: Reply.');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toBe('First sentence. which continues here.');
    expect(lines[1]!.speaker).toBe('Priya Sharma');
  });

  it('parses WebVTT voice tags', () => {
    const vtt = 'WEBVTT\n\n1\n00:00:12.000 --> 00:00:15.000\n<v Priya Sharma>Hello from VTT</v>';
    const lines = parseTranscript(vtt);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ speaker: 'Priya Sharma', tStartSec: 12, text: 'Hello from VTT' });
  });

  it('falls back to default speaker for bare text', () => {
    const lines = parseTranscript('Just some untagged prose.', 'Host');
    expect(lines[0]).toMatchObject({ speaker: 'Host', text: 'Just some untagged prose.' });
  });
});
