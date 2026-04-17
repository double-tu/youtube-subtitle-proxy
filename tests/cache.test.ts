import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();
const mockRun = vi.fn();
const mockUpdateCacheMetadata = vi.fn();

let fakeDb: {
  prepare: ReturnType<typeof vi.fn>;
};

vi.mock('../src/db/sqlite.js', () => ({
  getDatabase: () => fakeDb,
  updateCacheMetadata: mockUpdateCacheMetadata,
}));

beforeEach(() => {
  mockGet.mockReset();
  mockRun.mockReset();
  mockUpdateCacheMetadata.mockReset();
  fakeDb = {
    prepare: vi.fn(() => ({
      get: mockGet,
      run: mockRun,
    })),
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('cache service', () => {
  it('queries persistent cache using the full cache key dimensions', async () => {
    mockGet.mockReturnValueOnce({ bilingual_json: 'cached-vtt', status: 'done' });

    const { getBilingualSubtitle } = await import('../src/services/cache.js');

    const result = await getBilingualSubtitle('video-1|en|ja|manual|srv3');

    expect(result).toBe('cached-vtt');
    expect(fakeDb.prepare).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('video-1', 'en', 'ja', 'manual', 'srv3');
  });

  it('writes target language into caption job upserts', async () => {
    const { createCaptionJob } = await import('../src/services/cache.js');

    await createCaptionJob({
      id: 'job-1',
      videoId: 'video-1',
      lang: 'en',
      tlang: 'zh-CN',
      track: 'asr',
      fmt: 'json3',
      sourceHash: 'hash-1',
      status: 'pending',
    });

    expect(fakeDb.prepare).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith(
      'job-1',
      'video-1',
      'en',
      'zh-CN',
      'asr',
      'json3',
      'hash-1',
      'pending',
      null,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    );
  });
});
