/**
 * HTTP Routes
 */
import { Hono } from 'hono';
import { getDatabase, getCacheStats } from '../db/sqlite.js';
import { getConfig } from '../config/env.js';
import { fetchYouTubeSubtitle, generateCacheKey, generateSourceHash } from '../services/youtube.js';
import { getBilingualSubtitle } from '../services/cache.js';
import { enqueueTranslation, getQueueStatus } from '../queue/queue.js';
import type { SubtitleRequest, ErrorResponse, HealthCheckResponse } from '../types/subtitle.js';

const app = new Hono();

// ========================================
// Health Check
// ========================================

app.get('/health', (c) => {
  try {
    const db = getDatabase();
    const stats = getCacheStats();
    const queueStatus = getQueueStatus();

    const cacheHitsRow = db.prepare(`
      SELECT value FROM cache_metadata WHERE key = 'cache_hits'
    `).get() as { value: string } | undefined;
    const cacheHits = parseInt(cacheHitsRow?.value || '0');

    const cacheMissesRow = db.prepare(`
      SELECT value FROM cache_metadata WHERE key = 'cache_misses'
    `).get() as { value: string } | undefined;
    const cacheMisses = parseInt(cacheMissesRow?.value || '0');

    const totalRequests = cacheHits + cacheMisses;
    const hitRate = totalRequests > 0 ? (cacheHits / totalRequests) : 0;

    const response: HealthCheckResponse = {
      status: 'ok',
      database: 'connected',
      cache: {
        hits: cacheHits,
        misses: cacheMisses,
        hitRate: parseFloat((hitRate * 100).toFixed(2)),
      },
      queue: {
        pending: stats.pending_jobs + queueStatus.queueSize,
        processing: queueStatus.isProcessing ? 1 : 0,
        failed: stats.failed_jobs,
      },
      uptime: process.uptime(),
    };

    return c.json(response);
  } catch (error) {
    const response: HealthCheckResponse = {
      status: 'error',
      database: 'disconnected',
      cache: { hits: 0, misses: 0, hitRate: 0 },
      queue: { pending: 0, processing: 0, failed: 0 },
      uptime: process.uptime(),
    };

    return c.json(response, 500);
  }
});

// ========================================
// Subtitle Proxy Endpoint
// ========================================

app.get('/api/subtitle', async (c) => {
  try {
    // Parse query parameters
    const query = c.req.query();
    const params: SubtitleRequest = {
      v: query.v || '',
      lang: query.lang || '',
      tlang: query.tlang || 'zh-CN',
      kind: query.kind || 'asr',
      fmt: query.fmt || 'json3',
      original_url: query.original_url,
    };

    // Validate required parameters
    if (!params.v || !/^[a-zA-Z0-9_-]{11}$/.test(params.v)) {
      const error: ErrorResponse = {
        error: 'invalid_video_id',
        message: 'Invalid or missing video ID',
      };
      return c.json(error, 400);
    }

    if (!params.lang || params.lang.length > 10) {
      const error: ErrorResponse = {
        error: 'invalid_language',
        message: 'Invalid or missing language code',
      };
      return c.json(error, 400);
    }

    // Generate cache key
    const cacheKey = generateCacheKey(params);

    // Check bilingual subtitle cache
    const cachedBilingual = await getBilingualSubtitle(cacheKey);

    if (cachedBilingual) {
      console.log(`[API] Cache hit for ${params.v} (${params.lang} -> ${params.tlang})`);

      // Return cached bilingual subtitle
      return c.text(cachedBilingual, 200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'X-Translation-Status': 'completed',
        'X-Cache-Status': 'HIT',
        'X-Video-Id': params.v,
      });
    }

    console.log(`[API] Cache miss for ${params.v} (${params.lang} -> ${params.tlang})`);

    // Fetch original subtitle from YouTube
    let originalJson;
    try {
      originalJson = await fetchYouTubeSubtitle(params);
    } catch (error) {
      console.error(`[API] Failed to fetch YouTube subtitle:`, error);

      const errorResponse: ErrorResponse = {
        error: 'youtube_api_error',
        message: error instanceof Error ? error.message : 'Failed to fetch subtitle from YouTube',
      };

      return c.json(errorResponse, 503);
    }

    // Generate source hash
    const sourceHash = generateSourceHash(JSON.stringify(originalJson));

    // Enqueue translation task (async, non-blocking)
    enqueueTranslation(params, originalJson, sourceHash).catch(error => {
      console.error(`[API] Failed to enqueue translation:`, error);
    });

    // Return original subtitle immediately
    // Convert format if needed
    let responseContent: string;
    let contentType: string;

    if (params.fmt === 'vtt') {
      // Convert JSON to WebVTT (simplified - would need full implementation)
      responseContent = 'WEBVTT\n\n[Original subtitle - translation in progress]';
      contentType = 'text/vtt; charset=utf-8';
    } else {
      // Return original JSON
      responseContent = JSON.stringify(originalJson);
      contentType = 'application/json; charset=utf-8';
    }

    return c.text(responseContent, 200, {
      'Content-Type': contentType,
      'X-Translation-Status': 'pending',
      'X-Cache-Status': 'MISS',
      'X-Video-Id': params.v,
      'X-Estimated-Time': '45',
    });

  } catch (error) {
    console.error('[API] Error in subtitle endpoint:', error);

    const errorResponse: ErrorResponse = {
      error: 'internal_error',
      message: 'An internal error occurred',
    };

    return c.json(errorResponse, 500);
  }
});

// ========================================
// Cache Statistics (Admin only)
// ========================================

app.get('/admin/stats', async (c) => {
  const config = getConfig();

  // Check admin token
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (config.admin.token && token !== config.admin.token) {
    const error: ErrorResponse = {
      error: 'unauthorized',
      message: 'Invalid or missing admin token',
    };
    return c.json(error, 401);
  }

  try {
    const stats = getCacheStats();
    const db = getDatabase();

    // Get recent jobs
    const recentJobs = db.prepare(`
      SELECT id, video_id, lang, status, created_at
      FROM caption_jobs
      ORDER BY created_at DESC
      LIMIT 10
    `).all();

    return c.json({
      statistics: stats,
      recentJobs,
    });
  } catch (error) {
    console.error('[Admin] Error fetching stats:', error);

    const errorResponse: ErrorResponse = {
      error: 'internal_error',
      message: 'Failed to fetch statistics',
    };

    return c.json(errorResponse, 500);
  }
});

// ========================================
// 404 Handler
// ========================================

app.notFound((c) => {
  const error: ErrorResponse = {
    error: 'not_found',
    message: 'Endpoint not found',
  };
  return c.json(error, 404);
});

// ========================================
// Error Handler
// ========================================

app.onError((err, c) => {
  console.error('[HTTP] Unhandled error:', err);

  const error: ErrorResponse = {
    error: 'internal_error',
    message: 'An unexpected error occurred',
  };

  return c.json(error, 500);
});

export default app;
