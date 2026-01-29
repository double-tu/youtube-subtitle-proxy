/**
 * HTTP Routes
 */
import { Hono } from 'hono';
import { getDatabase, getCacheStats } from '../db/sqlite.js';
import { getConfig } from '../config/env.js';
import type { SubtitleRequest, ErrorResponse, HealthCheckResponse } from '../types/subtitle.js';

const app = new Hono();

// ========================================
// Health Check
// ========================================

app.get('/health', (c) => {
  try {
    const db = getDatabase();
    const stats = getCacheStats();

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
        pending: stats.pending_jobs,
        processing: 0,  // Will be implemented with queue
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
      fmt: query.fmt || 'vtt',
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

    // TODO: Implement cache check
    // TODO: Implement YouTube fetch
    // TODO: Implement translation queue

    // Temporary response
    return c.text('WEBVTT\n\nWIP: Subtitle proxy implementation in progress', 200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'X-Translation-Status': 'pending',
      'X-Cache-Status': 'MISS',
      'X-Video-Id': params.v,
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
