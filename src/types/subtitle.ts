/**
 * Type Definitions for YouTube Subtitle Proxy
 */

// ========================================
// Subtitle Types
// ========================================

export interface SubtitleCue {
  startTime: number;  // milliseconds
  endTime: number;    // milliseconds
  text: string;
}

export interface YouTubeTimedTextEvent {
  tStartMs: number;
  dDurationMs: number;
  wWinId?: number;
  wsWinStyleId?: number;
  wpWinPosId?: number;
  aAppend?: number;
  id?: number;
  segs?: Array<{
    utf8: string;
    acAsrConf?: number;
  }>;
}

export interface YouTubeTimedTextResponse {
  events: YouTubeTimedTextEvent[];
  wireMagic?: string;
  pens?: Array<Record<string, number | string | boolean>>;
  wsWinStyles?: Array<Record<string, number | string | boolean>>;
  wpWinPositions?: Array<Record<string, number | string | boolean>>;
}

// ========================================
// Database Types
// ========================================

export type JobStatus = 'pending' | 'translating' | 'done' | 'failed';
export type SegmentStatus = 'pending' | 'done' | 'failed';

export interface CaptionJob {
  id: string;
  video_id: string;
  lang: string;
  track: string;
  fmt: string;
  source_hash: string;
  status: JobStatus;
  retry_count: number;
  next_retry_at: number | null;
  error_code: string | null;
  error_message: string | null;
  bilingual_json: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface CaptionSegment {
  id: string;
  job_id: string;
  segment_index: number;
  start_ms: number;
  end_ms: number;
  source_text: string;
  translated_text: string | null;
  status: SegmentStatus;
  created_at: number;
  updated_at: number;
}

// ========================================
// API Types
// ========================================

export interface SubtitleRequest {
  v: string;        // video_id
  lang: string;     // source language
  tlang?: string;   // target language (default: zh-CN)
  kind?: string;    // asr | manual
  fmt?: string;     // vtt | srv3
  original_url?: string;
}

export interface SubtitleResponse {
  content: string;  // WebVTT or YouTube JSON
  headers: {
    'Content-Type': string;
    'X-Translation-Status': 'pending' | 'completed' | 'failed';
    'X-Cache-Status': 'HIT' | 'MISS';
    'X-Estimated-Time'?: string;
    'X-Video-Id'?: string;
  };
}

// ========================================
// Service Types
// ========================================

export interface TranslationTask {
  jobId: string;
  videoId: string;
  segments: SubtitleCue[];
  targetLang: string;
}

export interface CacheEntry {
  key: string;
  value: string;
  expiresAt: number;
}

// ========================================
// Configuration Types
// ========================================

export interface AppConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';

  openai: {
    apiKey: string;
    baseUrl?: string;
    model: string;
    timeout: number;
  };

  translationSummary: {
    enabled: boolean;
    maxTokens: number;
    chunkChars: number;
  };

  database: {
    path: string;
    verbose: boolean;
  };

  cache: {
    ttlHours: number;
    lruMaxItems: number;
    cleanupIntervalMs: number;
  };

  queue: {
    concurrency: number;
    maxRetries: number;
    retryBaseMs: number;
  };

  youtube: {
    fetchTimeoutMs: number;
  };

  subtitle: {
    segmentGapMs: number;
    minDurationMs: number;
    maxDurationMs: number;
  };

  admin: {
    token: string | null;
  };
}

// ========================================
// Utility Types
// ========================================

export interface ErrorResponse {
  error: string;
  message: string;
  retryAfter?: number;
  fallback?: any;
}

export interface HealthCheckResponse {
  status: 'ok' | 'degraded' | 'error';
  database: 'connected' | 'disconnected';
  cache: {
    hits: number;
    misses: number;
    hitRate: number;
  };
  queue: {
    pending: number;
    processing: number;
    failed: number;
  };
  uptime: number;
}
