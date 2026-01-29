/**
 * Translation Task Queue
 *
 * In-process queue with concurrency control and retry logic
 */
import { randomUUID } from 'crypto';
import { getConfig } from '../config/env.js';
import { parseYouTubeTimedText } from '../subtitle/parse.js';
import { mergeSubtitleCues, optimizeSubtitleTiming } from '../subtitle/segment.js';
import { renderWebVTT } from '../subtitle/render.js';
import { translateToBilingual } from '../services/translator.js';
import {
  createCaptionJob,
  updateCaptionJobStatus,
  getPendingJobs,
  incrementJobRetry,
  setBilingualSubtitle,
} from '../services/cache.js';
import { generateCacheKey } from '../services/youtube.js';
import type { YouTubeTimedTextResponse, SubtitleRequest } from '../types/subtitle.js';

interface TranslationTask {
  id: string;
  params: SubtitleRequest;
  originalJson: YouTubeTimedTextResponse;
  sourceHash: string;
  createdAt: number;
}

// Task queue
const taskQueue: TranslationTask[] = [];
let isProcessing = false;
let workerInterval: NodeJS.Timeout | null = null;

/**
 * Enqueue translation task
 */
export async function enqueueTranslation(
  params: SubtitleRequest,
  originalJson: YouTubeTimedTextResponse,
  sourceHash: string
): Promise<string> {
  const taskId = randomUUID();

  const task: TranslationTask = {
    id: taskId,
    params,
    originalJson,
    sourceHash,
    createdAt: Date.now(),
  };

  taskQueue.push(task);

  // Create pending job in database
  await createCaptionJob({
    id: taskId,
    videoId: params.v,
    lang: params.lang,
    track: params.kind || 'asr',
    fmt: params.fmt || 'json3',
    sourceHash,
    status: 'pending',
  });

  console.log(`[Queue] Enqueued task: ${taskId} (queue size: ${taskQueue.length})`);

  // Start worker if not already running
  if (!isProcessing) {
    startWorker();
  }

  return taskId;
}

/**
 * Start background worker
 */
export function startWorker(): void {
  if (workerInterval) {
    return; // Already running
  }

  console.log('[Queue] Starting translation worker...');

  workerInterval = setInterval(async () => {
    if (isProcessing) {
      return; // Already processing
    }

    try {
      isProcessing = true;
      await processQueue();
    } catch (error) {
      console.error('[Queue] Worker error:', error);
    } finally {
      isProcessing = false;
    }
  }, 5000); // Check queue every 5 seconds
}

/**
 * Stop background worker
 */
export function stopWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[Queue] Worker stopped');
  }
}

/**
 * Process translation queue
 */
async function processQueue(): Promise<void> {
  const config = getConfig();

  // Get tasks to process (limit by concurrency)
  const tasksToProcess = taskQueue.splice(0, config.queue.concurrency);

  if (tasksToProcess.length === 0) {
    // Check for pending jobs from database (retry failed jobs)
    const pendingJobs = await getPendingJobs(config.queue.concurrency);

    if (pendingJobs.length === 0) {
      return; // Nothing to do
    }

    console.log(`[Queue] Found ${pendingJobs.length} pending jobs for retry`);
    // Note: Retry logic would need original subtitle data, which we don't store
    // For simplicity, we'll skip retries for now
    return;
  }

  console.log(`[Queue] Processing ${tasksToProcess.length} tasks...`);

  // Process tasks in parallel
  const promises = tasksToProcess.map(task => processTask(task));
  await Promise.allSettled(promises);
}

/**
 * Process a single translation task
 */
async function processTask(task: TranslationTask): Promise<void> {
  const { id, params, originalJson } = task;

  try {
    console.log(`[Queue] Processing task: ${id}`);

    // Update status to translating
    await updateCaptionJobStatus(id, 'translating');

    // Parse original subtitles
    const originalCues = parseYouTubeTimedText(originalJson);

    // Merge into paragraphs (3-7 seconds)
    const paragraphs = mergeSubtitleCues(originalCues);

    // Optimize timing
    const optimizedCues = optimizeSubtitleTiming(paragraphs);

    // Translate to bilingual
    const config = getConfig();
    const bilingualCues = await translateToBilingual(
      optimizedCues,
      params.tlang || 'zh-CN',
      config.queue.concurrency
    );

    // Render to WebVTT
    const webvtt = renderWebVTT(bilingualCues, {
      kind: params.kind || 'captions',
      language: params.tlang || 'zh-CN',
    });

    // Store in cache
    const cacheKey = generateCacheKey(params);
    await setBilingualSubtitle(cacheKey, webvtt);

    // Update job status to done
    await updateCaptionJobStatus(id, 'done', webvtt);

    console.log(`[Queue] Task completed: ${id} (${bilingualCues.length} segments)`);

  } catch (error) {
    console.error(`[Queue] Task failed: ${id}`, error);

    // Update job status to failed
    await updateCaptionJobStatus(id, 'failed', undefined, {
      code: 'translation_error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });

    // Schedule retry
    await incrementJobRetry(id);
  }
}

/**
 * Get queue status
 */
export function getQueueStatus() {
  return {
    queueSize: taskQueue.length,
    isProcessing,
    workerRunning: workerInterval !== null,
  };
}

/**
 * Clear queue
 */
export function clearQueue(): void {
  taskQueue.length = 0;
  console.log('[Queue] Queue cleared');
}

export default {
  enqueueTranslation,
  startWorker,
  stopWorker,
  getQueueStatus,
  clearQueue,
};
