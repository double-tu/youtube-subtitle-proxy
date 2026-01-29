-- YouTube Subtitle Proxy Database Schema
-- SQLite 3.x

-- ========================================
-- Caption Jobs Table
-- ========================================
-- Tracks translation jobs and stores final bilingual subtitles
CREATE TABLE IF NOT EXISTS caption_jobs (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Video identification
  video_id TEXT NOT NULL,
  lang TEXT NOT NULL,              -- Original language (en, ja, ko)
  track TEXT NOT NULL,             -- Track name/ID
  fmt TEXT NOT NULL,               -- Format (vtt, srv3)
  source_hash TEXT NOT NULL,       -- SHA256 hash of original subtitle (detect changes)

  -- Job status
  status TEXT NOT NULL CHECK(status IN ('pending', 'translating', 'done', 'failed')),

  -- Retry mechanism
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,           -- Unix timestamp (ms)

  -- Error tracking
  error_code TEXT,
  error_message TEXT,

  -- Result storage
  bilingual_json TEXT,             -- Final bilingual subtitle JSON

  -- Metadata
  created_at INTEGER NOT NULL,     -- Unix timestamp (ms)
  updated_at INTEGER NOT NULL,     -- Unix timestamp (ms)
  expires_at INTEGER NOT NULL,     -- Unix timestamp (ms) - TTL cleanup

  -- Ensure unique combination for cache key
  UNIQUE(video_id, lang, track, fmt, source_hash)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_caption_jobs_status
ON caption_jobs(status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_caption_jobs_expires
ON caption_jobs(expires_at);

CREATE INDEX IF NOT EXISTS idx_caption_jobs_video_id
ON caption_jobs(video_id);

-- ========================================
-- Caption Segments Table
-- ========================================
-- Stores individual paragraph translations
CREATE TABLE IF NOT EXISTS caption_segments (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Foreign key to parent job
  job_id TEXT NOT NULL,

  -- Segment identification
  segment_index INTEGER NOT NULL,  -- 0-based index

  -- Timing
  start_ms INTEGER NOT NULL,       -- Start time in milliseconds
  end_ms INTEGER NOT NULL,         -- End time in milliseconds

  -- Content
  source_text TEXT NOT NULL,       -- Original text
  translated_text TEXT,            -- Translated text (null if not yet translated)

  -- Status
  status TEXT NOT NULL CHECK(status IN ('pending', 'done', 'failed')),

  -- Metadata
  created_at INTEGER NOT NULL,     -- Unix timestamp (ms)
  updated_at INTEGER NOT NULL,     -- Unix timestamp (ms)

  -- Foreign key constraint
  FOREIGN KEY(job_id) REFERENCES caption_jobs(id) ON DELETE CASCADE,

  -- Ensure unique segment per job
  UNIQUE(job_id, segment_index)
);

-- Index for querying segments by job
CREATE INDEX IF NOT EXISTS idx_caption_segments_job_id
ON caption_segments(job_id);

-- Index for querying pending segments
CREATE INDEX IF NOT EXISTS idx_caption_segments_status
ON caption_segments(status);

-- ========================================
-- Statistics Table (Optional)
-- ========================================
-- Track API usage and costs
CREATE TABLE IF NOT EXISTS api_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- API details
  provider TEXT NOT NULL,          -- 'openai', 'youtube'
  endpoint TEXT NOT NULL,          -- API endpoint

  -- Usage metrics
  request_count INTEGER DEFAULT 0,
  token_count INTEGER DEFAULT 0,   -- For LLM APIs
  cost_usd REAL DEFAULT 0.0,       -- Estimated cost in USD

  -- Timing
  avg_latency_ms INTEGER,          -- Average response time

  -- Time window
  date TEXT NOT NULL,              -- YYYY-MM-DD format

  UNIQUE(provider, endpoint, date)
);

-- ========================================
-- Cache Metadata Table
-- ========================================
-- Track cache statistics
CREATE TABLE IF NOT EXISTS cache_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Initialize cache metadata
INSERT OR IGNORE INTO cache_metadata (key, value, updated_at)
VALUES
  ('cache_version', '1.0', strftime('%s', 'now') * 1000),
  ('total_jobs', '0', strftime('%s', 'now') * 1000),
  ('cache_hits', '0', strftime('%s', 'now') * 1000),
  ('cache_misses', '0', strftime('%s', 'now') * 1000);
