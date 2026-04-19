import { beforeAll, describe, expect, it } from 'vitest';
import {
  compactShortCues,
  mergeSubtitleCues,
  optimizeBilingualCues,
  optimizeSourceCues,
} from '../src/subtitle/segment.js';

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

describe('optimizeSourceCues', () => {
  it('rebalances short english cues into a more readable target range', () => {
    const cues = [
      { startTime: 0, endTime: 500, text: 'I agree.' },
      { startTime: 500, endTime: 1000, text: 'It is true.' },
      { startTime: 1000, endTime: 1500, text: 'We can do this.' },
      { startTime: 1500, endTime: 2000, text: 'Lets ship now.' },
    ];

    const optimized = optimizeSourceCues(cues);

    expect(optimized).toHaveLength(1);
    expect(optimized[0].text).toBe('I agree. It is true. We can do this. Lets ship now.');
  });

  it('splits long source cues at natural boundaries before translation', () => {
    const cues = [
      {
        startTime: 0,
        endTime: 4000,
        text: 'This is the first complete sentence, and it ends here. This is the second complete sentence, and it also ends here.',
      },
    ];

    const optimized = optimizeSourceCues(cues);

    expect(optimized.length).toBeGreaterThan(1);
    expect(optimized[0].text).toContain('This is the first complete sentence');
    expect(optimized[1].text).toContain('This is the second complete sentence');
  });
});

describe('compactShortCues', () => {
  it('merges very short neighboring cues for translation-only mode', () => {
    const cues = [
      { startTime: 0, endTime: 300, text: 'I' },
      { startTime: 300, endTime: 600, text: 'really' },
      { startTime: 600, endTime: 900, text: 'do' },
      { startTime: 900, endTime: 1200, text: 'not' },
      { startTime: 1200, endTime: 1500, text: 'know' },
    ];

    const compacted = compactShortCues(cues);

    expect(compacted).toHaveLength(1);
    expect(compacted[0].text).toBe('I really do not know');
  });

  it('keeps strong sentence boundaries when compacting', () => {
    const cues = [
      { startTime: 0, endTime: 500, text: 'Stop.' },
      { startTime: 500, endTime: 900, text: 'Now' },
      { startTime: 900, endTime: 1200, text: 'go' },
    ];

    const compacted = compactShortCues(cues);

    expect(compacted).toHaveLength(2);
    expect(compacted[0].text).toBe('Stop.');
    expect(compacted[1].text).toBe('Now go');
  });

  it('rebalances a short trailing cue into the previous cue', () => {
    const cues = [
      { startTime: 0, endTime: 800, text: 'This is a complete compact line' },
      { startTime: 800, endTime: 1200, text: 'for now' },
    ];

    const compacted = compactShortCues(cues);

    expect(compacted).toHaveLength(1);
    expect(compacted[0].text).toBe('This is a complete compact line for now');
  });
});

describe('optimizeBilingualCues', () => {
  it('splits oversized bilingual cues into multiple timed cues', () => {
    const cues = [
      {
        startTime: 0,
        endTime: 6000,
        text: 'This is the first complete sentence, and it ends here. This is the second complete sentence, and it also ends here.\n这是第一句完整的话，到这里结束。这是第二句完整的话，也在这里结束。',
      },
    ];

    const optimized = optimizeBilingualCues(cues);

    expect(optimized.length).toBeGreaterThan(1);
    expect(optimized[0].endTime).toBeLessThanOrEqual(optimized[1].startTime);
    expect(optimized[0].text).toContain('\n');
  });
});
