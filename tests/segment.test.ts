import { beforeAll, describe, expect, it } from 'vitest';
import { mergeSubtitleCues } from '../src/subtitle/segment.js';

beforeAll(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
});

describe('mergeSubtitleCues', () => {
  it('merges word-level cues into paragraphs and respects gaps', () => {
    const cues = [
      { startTime: 0, endTime: 500, text: 'I' },
      { startTime: 500, endTime: 1000, text: 'have' },
      { startTime: 1000, endTime: 1500, text: 'a' },
      { startTime: 1500, endTime: 2000, text: 'dream.' },
      { startTime: 4000, endTime: 4500, text: 'Next' },
      { startTime: 4500, endTime: 5000, text: 'line' },
    ];

    const merged = mergeSubtitleCues(cues, {
      minDurationMs: 0,
      maxDurationMs: 10000,
      gapThresholdMs: 1000,
      maxChars: 0,
      maxWords: 0,
    });

    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe('I have a dream.');
    expect(merged[1].text).toBe('Next line');
  });

  it('normalizes spacing around punctuation', () => {
    const cues = [
      { startTime: 0, endTime: 400, text: 'Hello' },
      { startTime: 400, endTime: 800, text: ',' },
      { startTime: 800, endTime: 1200, text: 'world' },
      { startTime: 1200, endTime: 1600, text: '!' },
    ];

    const merged = mergeSubtitleCues(cues, {
      minDurationMs: 0,
      maxDurationMs: 10000,
      gapThresholdMs: 10000,
      maxChars: 0,
      maxWords: 0,
    });

    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('Hello, world!');
  });

  it('splits on maxWords once minimum duration is met', () => {
    const cues = [
      { startTime: 0, endTime: 400, text: 'one' },
      { startTime: 400, endTime: 800, text: 'two' },
      { startTime: 800, endTime: 1200, text: 'three' },
      { startTime: 1200, endTime: 1600, text: 'four' },
      { startTime: 1600, endTime: 2000, text: 'five' },
      { startTime: 2000, endTime: 2400, text: 'six' },
    ];

    const merged = mergeSubtitleCues(cues, {
      minDurationMs: 0,
      maxDurationMs: 10000,
      gapThresholdMs: 10000,
      maxWords: 3,
    });

    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe('one two three');
    expect(merged[1].text).toBe('four five six');
  });
});
