/**
 * SQLite Database Connection and Initialization
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database | null = null;

export interface DatabaseConfig {
  path: string;
  verbose?: boolean;
}

/**
 * Initialize SQLite database
 */
export function initDatabase(config: DatabaseConfig): Database.Database {
  if (db) {
    return db;
  }

  // Ensure data directory exists
  const dbDir = dirname(config.path);
  try {
    mkdirSync(dbDir, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }

  // Open database connection
  db = new Database(config.path, {
    verbose: config.verbose ? console.log : undefined,
  });

  // Enable WAL mode for better concurrent performance
  db.pragma('journal_mode = WAL');

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Set synchronous mode to NORMAL for better performance
  db.pragma('synchronous = NORMAL');

  // Initialize schema
  const schemaSQL = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schemaSQL);
  migrateCaptionJobsSchema(db);

  console.log(`[DB] SQLite database initialized at: ${config.path}`);

  return db;
}

function migrateCaptionJobsSchema(database: Database.Database): void {
  const columns = database.prepare(`
    SELECT name FROM pragma_table_info('caption_jobs')
  `).all() as Array<{ name: string }>;

  const hasTargetLanguageColumn = columns.some((column) => column.name === 'tlang');
  if (hasTargetLanguageColumn) {
    return;
  }

  console.log('[DB] Migrating caption_jobs schema to include target language dimensions');
  database.pragma('foreign_keys = OFF');

  try {
    const migrate = database.transaction(() => {
      database.exec(`
        CREATE TABLE caption_jobs_v2 (
          id TEXT PRIMARY KEY,
          video_id TEXT NOT NULL,
          lang TEXT NOT NULL,
          tlang TEXT NOT NULL,
          track TEXT NOT NULL,
          fmt TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'translating', 'done', 'failed')),
          retry_count INTEGER NOT NULL DEFAULT 0,
          next_retry_at INTEGER,
          error_code TEXT,
          error_message TEXT,
          bilingual_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          UNIQUE(video_id, lang, tlang, track, fmt, source_hash)
        );

        INSERT INTO caption_jobs_v2 (
          id, video_id, lang, tlang, track, fmt, source_hash, status,
          retry_count, next_retry_at, error_code, error_message,
          bilingual_json, created_at, updated_at, expires_at
        )
        SELECT
          id, video_id, lang, 'zh-CN', track, fmt, source_hash, status,
          retry_count, next_retry_at, error_code, error_message,
          bilingual_json, created_at, updated_at, expires_at
        FROM caption_jobs;

        DROP TABLE caption_jobs;
        ALTER TABLE caption_jobs_v2 RENAME TO caption_jobs;

        CREATE INDEX IF NOT EXISTS idx_caption_jobs_status
        ON caption_jobs(status, next_retry_at);

        CREATE INDEX IF NOT EXISTS idx_caption_jobs_expires
        ON caption_jobs(expires_at);

        CREATE INDEX IF NOT EXISTS idx_caption_jobs_video_id
        ON caption_jobs(video_id);
      `);
    });

    migrate();
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

/**
 * Get database instance
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[DB] Database connection closed');
  }
}

/**
 * Clean up expired jobs (TTL cleanup)
 */
export function cleanupExpiredJobs(): number {
  const db = getDatabase();
  const now = Date.now();

  const result = db.prepare(`
    DELETE FROM caption_jobs
    WHERE expires_at < ?
  `).run(now);

  const deletedCount = result.changes;
  if (deletedCount > 0) {
    console.log(`[DB] Cleaned up ${deletedCount} expired jobs`);
  }

  return deletedCount;
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  const db = getDatabase();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_jobs,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as completed_jobs,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_jobs,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_jobs
    FROM caption_jobs
  `).get() as {
    total_jobs: number;
    completed_jobs: number;
    pending_jobs: number;
    failed_jobs: number;
  };

  return stats;
}

/**
 * Update cache metadata counters
 */
export function updateCacheMetadata(key: string, increment: number = 1): void {
  const db = getDatabase();
  const now = Date.now();

  db.prepare(`
    INSERT INTO cache_metadata (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(CAST(value AS INTEGER) + ? AS TEXT),
      updated_at = ?
  `).run(key, increment.toString(), now, increment, now);
}

/**
 * Get cache metadata value
 */
export function getCacheMetadata(key: string): string | null {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT value FROM cache_metadata WHERE key = ?
  `).get(key) as { value: string } | undefined;

  return row?.value ?? null;
}

export default {
  initDatabase,
  getDatabase,
  closeDatabase,
  cleanupExpiredJobs,
  getCacheStats,
  updateCacheMetadata,
  getCacheMetadata,
};
