/**
 * Translation Task Queue
 *
 * In-process queue with concurrency control and retry logic
 */
import { randomUUID } from 'crypto';
import { getConfig } from '../config/env.js';
import { parseYouTubeTimedText } from '../subtitle/parse.js';
import {
  buildSourceSegments,
  optimizeBilingualCues,
  optimizeSubtitleTiming,
} from '../subtitle/segment.js';
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
  taskKey: string;
}

// Task queue
const taskQueue: TranslationTask[] = [];
const inFlightTaskKeys = new Set<string>();
let isProcessing = false;
let workerInterval: NodeJS.Timeout | null = null;
let drainScheduled = false;

export function buildTranslationTaskKey(params: SubtitleRequest, sourceHash: string): string {
  return `${generateCacheKey(params)}|${sourceHash}`;
}

export function isTranslationInFlight(taskKey: string): boolean {
  return inFlightTaskKeys.has(taskKey);
}

/**
 * Enqueue translation task
 */
export async function enqueueTranslation(
  params: SubtitleRequest,
  originalJson: YouTubeTimedTextResponse,
  sourceHash: string
): Promise<string | null> {
  const taskKey = buildTranslationTaskKey(params, sourceHash);
  if (inFlightTaskKeys.has(taskKey)) {
    console.log(`[Queue] Translation already in progress: ${taskKey}`);
    return null;
  }

  inFlightTaskKeys.add(taskKey);
  const taskId = randomUUID();

  const task: TranslationTask = {
    id: taskId,
    params,
    originalJson,
    sourceHash,
    createdAt: Date.now(),
    taskKey,
  };

  try {
    taskQueue.push(task);

    // Create pending job in database
    await createCaptionJob({
      id: taskId,
      videoId: params.v,
      lang: params.lang,
      tlang: params.tlang || 'zh-CN',
      track: params.kind || 'asr',
      fmt: params.fmt || 'json3',
      sourceHash,
      status: 'pending',
    });
  } catch (error) {
    inFlightTaskKeys.delete(taskKey);
    throw error;
  }

  console.log(`[Queue] Enqueued task: ${taskId} (queue size: ${taskQueue.length})`);

  // Start worker if not already running
  startWorker();
  scheduleQueueDrain();

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

  workerInterval = setInterval(() => {
    scheduleQueueDrain();
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

function scheduleQueueDrain(): void {
  if (drainScheduled) {
    return;
  }

  drainScheduled = true;
  queueMicrotask(() => {
    drainScheduled = false;
    void drainQueue();
  });
}

async function drainQueue(): Promise<void> {
  if (isProcessing) {
    return;
  }

  try {
    isProcessing = true;
    await processQueue();
  } catch (error) {
    console.error('[Queue] Worker error:', error);
  } finally {
    isProcessing = false;
    if (taskQueue.length > 0) {
      scheduleQueueDrain();
    }
  }
}

/**
 * Process a single translation task
 */
async function processTask(task: TranslationTask): Promise<void> {
  const { id, params, originalJson } = task;

  try {
    console.log(`[Queue] Processing task: ${id}`);
    const config = getConfig();

    // Update status to translating
    await updateCaptionJobStatus(id, 'translating');

    // Parse original subtitles
    const originalCues = parseYouTubeTimedText(originalJson);
    const preserveTiming = config.subtitle.outputMode === 'translation-only';
    const optimizedSourceCues = buildSourceSegments(originalJson, originalCues, { preserveTiming });

    // Optimize timing
    const optimizedCues = optimizeSubtitleTiming(optimizedSourceCues);

    // Translate to bilingual
    const translatedBilingualCues = await translateToBilingual(
      optimizedCues,
      params.tlang || 'zh-CN',
      config.queue.concurrency
    );
    const bilingualCues = preserveTiming
      ? translatedBilingualCues
      : optimizeBilingualCues(translatedBilingualCues);

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
  } finally {
    inFlightTaskKeys.delete(task.taskKey);
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
  buildTranslationTaskKey,
  isTranslationInFlight,
};
