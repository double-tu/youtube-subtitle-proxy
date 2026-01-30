/**
 * HTTP Routes
 */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { getDatabase, getCacheStats } from '../db/sqlite.js';
import { getConfig } from '../config/env.js';
import { fetchYouTubeTimedText, generateCacheKey, generateSourceHash } from '../services/youtube.js';
import { getBilingualSubtitle, getCaptionJobByKey } from '../services/cache.js';
import {
  buildTranslationTaskKey,
  enqueueTranslation,
  getQueueStatus,
  isTranslationInFlight,
} from '../queue/queue.js';
import { parseWebVTT } from '../subtitle/parse.js';
import { renderYouTubeSrv3, renderYouTubeTimedText } from '../subtitle/render.js';
import type { SubtitleRequest, ErrorResponse, HealthCheckResponse } from '../types/subtitle.js';

const app = new Hono();
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

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

const buildOriginalTimedtextUrl = (c: Context): string => {
  const requestUrl = new URL(c.req.url);
  const baseUrl = new URL('https://www.youtube.com/api/timedtext');
  baseUrl.search = requestUrl.search;
  baseUrl.searchParams.delete('original_url');
  return baseUrl.toString();
};

const handleSubtitleRequest = async (c: Context) => {
  try {
    // Parse query parameters
    const query = c.req.query();
    const fmtParam = (query.fmt || query.format || 'json3').toString();
    const originalUrl = query.original_url || buildOriginalTimedtextUrl(c);
    const params: SubtitleRequest = {
      v: query.v || '',
      lang: query.lang || '',
      tlang: query.tlang || 'zh-CN',
      kind: query.kind || 'asr',
      fmt: fmtParam,
      original_url: originalUrl,
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

      const requestedFormat = params.fmt?.toLowerCase();
      if (requestedFormat === 'vtt') {
        // Return cached bilingual subtitle as WebVTT
        return c.text(cachedBilingual, 200, {
          'Content-Type': 'text/vtt; charset=utf-8',
          'X-Translation-Status': 'completed',
          'X-Cache-Status': 'HIT',
          'X-Video-Id': params.v,
        });
      }

      const cues = parseWebVTT(cachedBilingual);
      if (requestedFormat?.startsWith('srv')) {
        const config = getConfig();
        const srv3 = renderYouTubeSrv3(cues, {
          overlapGapMs: config.subtitle.srv3OverlapGapMs,
        });
        return c.text(srv3, 200, {
          'Content-Type': 'text/xml; charset=utf-8',
          'X-Translation-Status': 'completed',
          'X-Cache-Status': 'HIT',
          'X-Video-Id': params.v,
        });
      }

      // Return cached bilingual subtitle as YouTube timedtext JSON
      const timedtextJson = renderYouTubeTimedText(cues);
      return c.json(timedtextJson, 200, {
        'X-Translation-Status': 'completed',
        'X-Cache-Status': 'HIT',
        'X-Video-Id': params.v,
      });
    }

    console.log(`[API] Cache miss for ${params.v} (${params.lang} -> ${params.tlang})`);

    // Fetch original subtitle from YouTube
    let originalResult;
    try {
      originalResult = await fetchYouTubeTimedText(params);
    } catch (error) {
      console.error(`[API] Failed to fetch YouTube subtitle:`, error);

      const errorResponse: ErrorResponse = {
        error: 'youtube_api_error',
        message: error instanceof Error ? error.message : 'Failed to fetch subtitle from YouTube',
      };

      return c.json(errorResponse, 503);
    }

    // Generate source hash
    const sourceHash = generateSourceHash(JSON.stringify(originalResult.parsed));
    const taskKey = buildTranslationTaskKey(params, sourceHash);

    const existingJob = await getCaptionJobByKey({
      videoId: params.v,
      lang: params.lang,
      track: params.kind || 'asr',
      fmt: params.fmt || 'json3',
      sourceHash,
    });

    if (existingJob && (existingJob.status === 'pending' || existingJob.status === 'translating')) {
      console.log(`[Queue] Skip enqueue; existing job in progress: ${existingJob.id}`);
    } else if (isTranslationInFlight(taskKey)) {
      console.log(`[Queue] Skip enqueue; task already in flight: ${taskKey}`);
    } else {
      // Enqueue translation task (async, non-blocking)
      enqueueTranslation(params, originalResult.parsed, sourceHash).catch(error => {
        console.error(`[API] Failed to enqueue translation:`, error);
      });
    }

    // Return original subtitle immediately (keep original format)
    const responseContent = originalResult.rawText;
    const requestedFormat = params.fmt?.toLowerCase();
    const contentType = originalResult.contentType
      || (requestedFormat === 'vtt'
        ? 'text/vtt; charset=utf-8'
        : requestedFormat?.startsWith('srv')
          ? 'text/xml; charset=utf-8'
          : 'application/json; charset=utf-8');

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
};

app.get('/api/subtitle', handleSubtitleRequest);
app.get('/api/timedtext', handleSubtitleRequest);

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
