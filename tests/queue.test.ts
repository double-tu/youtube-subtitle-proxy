import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockTranslateToBilingual = vi.fn();
const mockCreateCaptionJob = vi.fn();
const mockUpdateCaptionJobStatus = vi.fn();
const mockSetBilingualSubtitle = vi.fn();
const mockIncrementJobRetry = vi.fn();

vi.mock('../src/config/env.js', () => ({
  getConfig: () => ({
    queue: {
      concurrency: 2,
      maxRetries: 3,
      retryBaseMs: 5000,
    },
    subtitle: {
      segmentGapMs: 1200,
      minDurationMs: 3000,
      maxDurationMs: 7000,
      srv3OverlapGapMs: 100,
      segmentMaxChars: 160,
      segmentMaxWords: 30,
      sourceTargetMinCjk: 15,
      sourceTargetMaxCjk: 25,
      sourceTargetMinWords: 11,
      sourceTargetMaxWords: 20,
      bilingualMaxCharsCjk: 22,
      bilingualMaxWords: 14,
      bilingualMinDurationMs: 1200,
    },
  }),
}));

vi.mock('../src/subtitle/parse.js', () => ({
  parseYouTubeTimedText: vi.fn(() => [
    { startTime: 0, endTime: 1000, text: 'Hello world.' },
  ]),
}));

vi.mock('../src/subtitle/segment.js', () => ({
  mergeSubtitleCues: vi.fn((cues) => cues),
  optimizeSourceCues: vi.fn((cues) => cues),
  optimizeSubtitleTiming: vi.fn((cues) => cues),
  optimizeBilingualCues: vi.fn((cues) => cues),
}));

vi.mock('../src/subtitle/render.js', () => ({
  renderWebVTT: vi.fn(() => 'WEBVTT\n\ntranslated'),
}));

vi.mock('../src/services/translator.js', () => ({
  translateToBilingual: mockTranslateToBilingual,
}));

vi.mock('../src/services/cache.js', () => ({
  createCaptionJob: mockCreateCaptionJob,
  updateCaptionJobStatus: mockUpdateCaptionJobStatus,
  getPendingJobs: vi.fn(async () => []),
  incrementJobRetry: mockIncrementJobRetry,
  setBilingualSubtitle: mockSetBilingualSubtitle,
}));

vi.mock('../src/services/youtube.js', () => ({
  generateCacheKey: vi.fn(() => 'video-1|en|zh-CN|asr|json3'),
}));

beforeEach(() => {
  mockTranslateToBilingual.mockReset().mockResolvedValue([
    { startTime: 0, endTime: 1000, text: 'Hello world.\n你好，世界。' },
  ]);
  mockCreateCaptionJob.mockReset().mockResolvedValue(undefined);
  mockUpdateCaptionJobStatus.mockReset().mockResolvedValue(undefined);
  mockSetBilingualSubtitle.mockReset().mockResolvedValue(undefined);
  mockIncrementJobRetry.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  const queue = await import('../src/queue/queue.js');
  queue.stopWorker();
  queue.clearQueue();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('translation queue', () => {
  it('starts processing immediately after enqueueing a task', async () => {
    const { enqueueTranslation } = await import('../src/queue/queue.js');

    await enqueueTranslation(
      {
        v: 'video-1',
        lang: 'en',
        tlang: 'zh-CN',
        kind: 'asr',
        fmt: 'json3',
      },
      {
        events: [],
      },
      'hash-1'
    );

    await vi.waitFor(() => {
      expect(mockSetBilingualSubtitle).toHaveBeenCalledWith(
        'video-1|en|zh-CN|asr|json3',
        'WEBVTT\n\ntranslated'
      );
    });

    expect(mockUpdateCaptionJobStatus).toHaveBeenCalledWith(
      expect.any(String),
      'translating'
    );
    expect(mockIncrementJobRetry).not.toHaveBeenCalled();
  });
});
