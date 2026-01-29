/**
 * HTTP Server Entry Point
 */
import { serve } from '@hono/node-server';
import app from './routes.js';
import { getConfig } from '../config/env.js';
import { initDatabase, closeDatabase, cleanupExpiredJobs } from '../db/sqlite.js';

// ========================================
// Server Startup
// ========================================

async function startServer() {
  console.log('[Server] Starting YouTube Subtitle Proxy...');

  // Load configuration
  const config = getConfig();

  // Initialize database
  initDatabase({
    path: config.database.path,
    verbose: config.database.verbose,
  });

  // Setup cleanup interval
  const cleanupInterval = setInterval(() => {
    cleanupExpiredJobs();
  }, config.cache.cleanupIntervalMs);

  // Start HTTP server
  serve({
    fetch: app.fetch,
    port: config.port,
  });

  console.log(`[Server] ✅ Server running at http://localhost:${config.port}`);
  console.log(`[Server] Environment: ${config.nodeEnv}`);
  console.log(`[Server] Database: ${config.database.path}`);
  console.log(`[Server] Translation: ${config.openai.model}`);
  console.log(`[Server] Cache TTL: ${config.cache.ttlHours}h`);
  console.log('');
  console.log('[Server] Endpoints:');
  console.log(`  GET  /health           - Health check`);
  console.log(`  GET  /api/subtitle     - Subtitle proxy`);
  console.log(`  GET  /admin/stats      - Cache statistics (admin only)`);
  console.log('');

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Server] Shutting down gracefully...');
    clearInterval(cleanupInterval);
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ========================================
// Start Server
// ========================================

startServer().catch((error) => {
  console.error('[Server] Fatal error during startup:', error);
  process.exit(1);
});
