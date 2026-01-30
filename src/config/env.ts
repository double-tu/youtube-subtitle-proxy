/**
 * Environment Configuration
 *
 * Loads and validates environment variables
 */
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import type { AppConfig } from '../types/subtitle.js';

// Load .env file
dotenvConfig();

// Zod schema for environment validation
const envSchema = z.object({
  // Server
  PORT: z.string().default('3000').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  TRANSLATE_TIMEOUT_MS: z.string().default('20000').transform(Number),
  QUEUE_CONCURRENCY: z.string().default('2').transform(Number),

  // Database
  DB_PATH: z.string().default('./data/subtitles.db'),
  DB_VERBOSE: z.string().default('false').transform((v) => v === 'true'),

  // Cache
  CACHE_TTL_HOURS: z.string().default('720').transform(Number),
  LRU_MAX_ITEMS: z.string().default('1000').transform(Number),
  CLEANUP_INTERVAL_MS: z.string().default('3600000').transform(Number),

  // Retry
  MAX_RETRIES: z.string().default('3').transform(Number),
  RETRY_BASE_MS: z.string().default('5000').transform(Number),

  // YouTube
  YT_FETCH_TIMEOUT_MS: z.string().default('5000').transform(Number),

  // Subtitle processing
  SEGMENT_GAP_MS: z.string().default('1200').transform(Number),
  SEGMENT_MIN_DURATION_MS: z.string().default('3000').transform(Number),
  SEGMENT_MAX_DURATION_MS: z.string().default('7000').transform(Number),

  // Admin (optional)
  ADMIN_TOKEN: z.string().optional(),
});

/**
 * Load and validate environment variables
 */
function loadEnv(): AppConfig {
  // Parse environment variables
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('[Config] Environment validation failed:');
    console.error(result.error.format());
    process.exit(1);
  }

  const env = result.data;

  // Build config object
  const config: AppConfig = {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,

    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      timeout: env.TRANSLATE_TIMEOUT_MS,
    },

    database: {
      path: env.DB_PATH,
      verbose: env.DB_VERBOSE,
    },

    cache: {
      ttlHours: env.CACHE_TTL_HOURS,
      lruMaxItems: env.LRU_MAX_ITEMS,
      cleanupIntervalMs: env.CLEANUP_INTERVAL_MS,
    },

    queue: {
      concurrency: env.QUEUE_CONCURRENCY,
      maxRetries: env.MAX_RETRIES,
      retryBaseMs: env.RETRY_BASE_MS,
    },

    youtube: {
      fetchTimeoutMs: env.YT_FETCH_TIMEOUT_MS,
    },

    subtitle: {
      segmentGapMs: env.SEGMENT_GAP_MS,
      minDurationMs: env.SEGMENT_MIN_DURATION_MS,
      maxDurationMs: env.SEGMENT_MAX_DURATION_MS,
    },

    admin: {
      token: env.ADMIN_TOKEN || null,
    },
  };

  return config;
}

// Singleton config instance
let config: AppConfig | null = null;

/**
 * Get application configuration
 */
export function getConfig(): AppConfig {
  if (!config) {
    config = loadEnv();

    // Log configuration (mask sensitive values)
    console.log('[Config] Application configuration loaded:');
    console.log(JSON.stringify({
      ...config,
      openai: {
        ...config.openai,
        apiKey: '***' + config.openai.apiKey.slice(-4),
      },
      admin: {
        token: config.admin.token ? '***' : null,
      },
    }, null, 2));
  }

  return config;
}

export default {
  getConfig,
};
