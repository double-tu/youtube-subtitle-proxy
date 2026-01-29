/**
 * Cache Service
 *
 * Two-layer caching: LRU (memory) + SQLite (persistent)
 */
import { LRUCache } from 'lru-cache';
import { getDatabase, updateCacheMetadata } from '../db/sqlite.js';
import { getConfig } from '../config/env.js';
import type { CaptionJob, JobStatus } from '../types/subtitle.js';

// LRU cache instance
let lruCache: LRUCache<string, string> | null = null;

/**
 * Get LRU cache instance
 */
function getLRUCache(): LRUCache<string, string> {
  if (!lruCache) {
    const config = getConfig();
    lruCache = new LRUCache<string, string>({
      max: config.cache.lruMaxItems,
      ttl: config.cache.ttlHours * 60 * 60 * 1000, // Convert hours to ms
    });
  }
  return lruCache;
}

/**
 * Get bilingual subtitle from cache
 */
export async function getBilingualSubtitle(cacheKey: string): Promise<string | null> {
  // Try LRU cache first
  const lru = getLRUCache();
  const cached = lru.get(cacheKey);

  if (cached) {
    console.log(`[Cache] LRU cache hit: ${cacheKey}`);
    updateCacheMetadata('cache_hits', 1);
    return cached;
  }

  // Try SQLite persistent cache
  const db = getDatabase();
  const [videoId, lang] = cacheKey.split('|');

  const row = db.prepare(`
    SELECT bilingual_json, status
    FROM caption_jobs
    WHERE video_id = ? AND lang = ? AND status = 'done'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(videoId, lang) as { bilingual_json: string; status: JobStatus } | undefined;

  if (row && row.bilingual_json) {
    console.log(`[Cache] SQLite cache hit: ${cacheKey}`);
    // Store in LRU for faster access next time
    lru.set(cacheKey, row.bilingual_json);
    updateCacheMetadata('cache_hits', 1);
    return row.bilingual_json;
  }

  console.log(`[Cache] Cache miss: ${cacheKey}`);
  updateCacheMetadata('cache_misses', 1);
  return null;
}

/**
 * Store bilingual subtitle in cache
 */
export async function setBilingualSubtitle(
  cacheKey: string,
  content: string
): Promise<void> {
  // Store in LRU cache
  const lru = getLRUCache();
  lru.set(cacheKey, content);

  console.log(`[Cache] Stored in cache: ${cacheKey} (${content.length} bytes)`);
}

/**
 * Create or update caption job
 */
export async function createCaptionJob(params: {
  id: string;
  videoId: string;
  lang: string;
  track: string;
  fmt: string;
  sourceHash: string;
  status: JobStatus;
  bilingualJson?: string;
}): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  const config = getConfig();
  const expiresAt = now + (config.cache.ttlHours * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO caption_jobs (
      id, video_id, lang, track, fmt, source_hash, status,
      bilingual_json, created_at, updated_at, expires_at, retry_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(video_id, lang, track, fmt, source_hash) DO UPDATE SET
      status = excluded.status,
      bilingual_json = excluded.bilingual_json,
      updated_at = excluded.updated_at
  `).run(
    params.id,
    params.videoId,
    params.lang,
    params.track,
    params.fmt,
    params.sourceHash,
    params.status,
    params.bilingualJson || null,
    now,
    now,
    expiresAt
  );

  console.log(`[Cache] Created/updated job: ${params.id} (status: ${params.status})`);
}

/**
 * Update caption job status
 */
export async function updateCaptionJobStatus(
  jobId: string,
  status: JobStatus,
  bilingualJson?: string,
  error?: { code: string; message: string }
): Promise<void> {
  const db = getDatabase();
  const now = Date.now();

  if (error) {
    db.prepare(`
      UPDATE caption_jobs
      SET status = ?, updated_at = ?, error_code = ?, error_message = ?
      WHERE id = ?
    `).run(status, now, error.code, error.message, jobId);
  } else {
    db.prepare(`
      UPDATE caption_jobs
      SET status = ?, bilingual_json = ?, updated_at = ?, error_code = NULL, error_message = NULL
      WHERE id = ?
    `).run(status, bilingualJson || null, now, jobId);
  }

  console.log(`[Cache] Updated job status: ${jobId} -> ${status}`);
}

/**
 * Get caption job by ID
 */
export async function getCaptionJob(jobId: string): Promise<CaptionJob | null> {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT * FROM caption_jobs WHERE id = ?
  `).get(jobId) as CaptionJob | undefined;

  return row || null;
}

/**
 * Get pending jobs for retry
 */
export async function getPendingJobs(limit: number = 10): Promise<CaptionJob[]> {
  const db = getDatabase();
  const now = Date.now();
  const config = getConfig();

  const rows = db.prepare(`
    SELECT * FROM caption_jobs
    WHERE status IN ('pending', 'failed')
      AND retry_count < ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY created_at ASC
    LIMIT ?
  `).all(config.queue.maxRetries, now, limit) as CaptionJob[];

  return rows;
}

/**
 * Increment job retry count
 */
export async function incrementJobRetry(jobId: string): Promise<void> {
  const db = getDatabase();
  const config = getConfig();
  const now = Date.now();

  const job = await getCaptionJob(jobId);
  if (!job) return;

  const retryCount = job.retry_count + 1;
  const delayMs = config.queue.retryBaseMs * Math.pow(2, retryCount - 1);
  const nextRetryAt = now + delayMs;

  db.prepare(`
    UPDATE caption_jobs
    SET retry_count = ?, next_retry_at = ?, updated_at = ?
    WHERE id = ?
  `).run(retryCount, nextRetryAt, now, jobId);

  console.log(`[Cache] Retry scheduled for job ${jobId}: retry ${retryCount} in ${delayMs}ms`);
}

/**
 * Clear all caches
 */
export async function clearAllCaches(): Promise<void> {
  // Clear LRU cache
  const lru = getLRUCache();
  lru.clear();

  console.log('[Cache] All caches cleared');
}

export default {
  getBilingualSubtitle,
  setBilingualSubtitle,
  createCaptionJob,
  updateCaptionJobStatus,
  getCaptionJob,
  getPendingJobs,
  incrementJobRetry,
  clearAllCaches,
};
