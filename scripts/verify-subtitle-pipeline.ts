import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config/env.js';
import { translateToBilingual } from '../src/services/translator.js';
import { parseYouTubeTimedText, parseWebVTT } from '../src/subtitle/parse.js';
import { renderWebVTT, renderYouTubeTimedText } from '../src/subtitle/render.js';
import {
  buildSourceSegments,
  compactShortCues,
  mergeSubtitleCues,
  optimizeBilingualCues,
  optimizeSourceCues,
  optimizeSubtitleTiming,
} from '../src/subtitle/segment.js';
import type { SubtitleCue, YouTubeTimedTextResponse } from '../src/types/subtitle.js';

type PipelineMetrics = {
  input: string;
  outputDir: string;
  config: {
    model: string;
    baseUrl: string | null;
    queueConcurrency: number;
    contextEnabled: boolean;
    contextBatchSize: number;
    contextConcurrency: number;
    contextRetries: number;
    contextMaxTokens: number;
    outputMode: string;
    renderMaxCharsCjk: number;
    renderMaxWords: number;
  };
  counts: {
    parsed: number;
    source: number;
    optimizedSource: number;
    optimizedTiming: number;
    translatedBilingual: number;
    finalBilingual: number;
    renderedVtt: number;
    renderedJson3Events: number;
  };
  quality: Record<string, CueQualityMetrics>;
  suspiciousExamples: SuspiciousCueExample[];
  elapsedMs: number;
};

type CueQualityMetrics = {
  cues: number;
  shortCjk: number;
  shortWords: number;
  punctuationOnly: number;
  leadingPunctuation: number;
  trailingConnector: number;
  tooLongCjk: number;
  tooLongWords: number;
  tooShortDuration: number;
  tooLongDuration: number;
  overlaps: number;
  maxCjkChars: number;
  maxWords: number;
};

type SuspiciousCueExample = {
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  reason: string;
  text: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const defaultInputPath = path.join(projectRoot, 'example', 'subtitle - origin.json');
const defaultOutputDir = path.join(projectRoot, 'tmp', 'subtitle-verify');

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const PUNCTUATION_ONLY_PATTERN = /^[\p{P}\p{S}\s]+$/u;
const LEADING_PUNCTUATION_PATTERN = /^[,.;:!?，。！？；：、]/;
const TRAILING_CONNECTOR_PATTERN = /(?:和|与|或|而|并|从|向|给|把|被|对|在|为|将|让|跟|比|及)$/;

function getArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasCjk(text: string): boolean {
  return CJK_PATTERN.test(text);
}

function visibleText(text: string): string {
  return text.replace(/\s+/g, '').trim();
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function compactPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function analyzeCueQuality(cues: SubtitleCue[]): CueQualityMetrics {
  const metrics: CueQualityMetrics = {
    cues: cues.length,
    shortCjk: 0,
    shortWords: 0,
    punctuationOnly: 0,
    leadingPunctuation: 0,
    trailingConnector: 0,
    tooLongCjk: 0,
    tooLongWords: 0,
    tooShortDuration: 0,
    tooLongDuration: 0,
    overlaps: 0,
    maxCjkChars: 0,
    maxWords: 0,
  };

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const text = cue.text.trim();
    const compact = visibleText(text);
    const isCjk = hasCjk(text);
    const words = wordCount(text);
    const duration = cue.endTime - cue.startTime;

    if (isCjk) {
      metrics.maxCjkChars = Math.max(metrics.maxCjkChars, compact.length);
      if (compact.length > 0 && compact.length <= 6) metrics.shortCjk++;
      if (compact.length > 28) metrics.tooLongCjk++;
      if (TRAILING_CONNECTOR_PATTERN.test(text)) metrics.trailingConnector++;
    } else {
      metrics.maxWords = Math.max(metrics.maxWords, words);
      if (words > 0 && words <= 3) metrics.shortWords++;
      if (words > 16) metrics.tooLongWords++;
    }

    if (PUNCTUATION_ONLY_PATTERN.test(text)) metrics.punctuationOnly++;
    if (LEADING_PUNCTUATION_PATTERN.test(text)) metrics.leadingPunctuation++;
    if (duration < 900) metrics.tooShortDuration++;
    if (duration > 8000) metrics.tooLongDuration++;
    if (i > 0 && cue.startTime < cues[i - 1].endTime) metrics.overlaps++;
  }

  return metrics;
}

function collectSuspiciousExamples(cues: SubtitleCue[], limit = 30): SuspiciousCueExample[] {
  const examples: SuspiciousCueExample[] = [];

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const text = cue.text.trim();
    const compact = visibleText(text);
    const duration = cue.endTime - cue.startTime;
    const reasons: string[] = [];

    if (PUNCTUATION_ONLY_PATTERN.test(text)) reasons.push('punctuation-only');
    if (LEADING_PUNCTUATION_PATTERN.test(text)) reasons.push('leading-punctuation');
    if (hasCjk(text) && compact.length > 0 && compact.length <= 6) reasons.push('short-cjk');
    if (hasCjk(text) && TRAILING_CONNECTOR_PATTERN.test(text)) reasons.push('trailing-connector');
    if (!hasCjk(text) && wordCount(text) > 0 && wordCount(text) <= 3) reasons.push('short-words');
    if (duration < 900) reasons.push('short-duration');
    if (i > 0 && cue.startTime < cues[i - 1].endTime) reasons.push('overlap');

    if (reasons.length > 0) {
      examples.push({
        index: i,
        startMs: Math.round(cue.startTime),
        endMs: Math.round(cue.endTime),
        durationMs: Math.round(duration),
        reason: reasons.join(','),
        text: compactPreview(text),
      });
    }

    if (examples.length >= limit) {
      break;
    }
  }

  return examples;
}

function summarizeConfig() {
  const config = getConfig();
  return {
    model: config.openai.model,
    baseUrl: config.openai.baseUrl ?? null,
    queueConcurrency: config.queue.concurrency,
    contextEnabled: config.translationContext.enabled,
    contextBatchSize: config.translationContext.batchSize,
    contextConcurrency: config.translationContext.concurrency,
    contextRetries: config.translationContext.batchRetries,
    contextMaxTokens: config.translationContext.maxTokens,
    outputMode: config.subtitle.outputMode,
    renderMaxCharsCjk: config.subtitle.renderMaxCharsCjk,
    renderMaxWords: config.subtitle.renderMaxWords,
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const inputPath = path.resolve(projectRoot, getArg('input', defaultInputPath));
  const outputDir = path.resolve(projectRoot, getArg('out', defaultOutputDir));
  const targetLang = getArg('target', 'zh-CN');
  const config = getConfig();

  console.log('[Verify] Subtitle pipeline verification started');
  console.log(`[Verify] Input: ${inputPath}`);
  console.log(`[Verify] Output directory: ${outputDir}`);
  console.log('[Verify] Effective config:', JSON.stringify(summarizeConfig(), null, 2));

  const rawJson = await readFile(inputPath, 'utf8');
  const originalJson = JSON.parse(rawJson) as YouTubeTimedTextResponse;
  const originalCues = parseYouTubeTimedText(originalJson);
  const preserveTiming = config.subtitle.outputMode === 'translation-only';
  const sourceCues = buildSourceSegments(originalJson, originalCues, { preserveTiming });
  const optimizedSourceCues = sourceCues;
  const optimizedCues = optimizeSubtitleTiming(optimizedSourceCues);

  console.log(
    `[Verify] Parsed ${originalCues.length} cues -> source ${sourceCues.length} -> optimized ${optimizedCues.length}`
  );
  console.log('[Verify] Calling translator with live API. API key will not be printed.');

  const translatedBilingualCues = await translateToBilingual(
    optimizedCues,
    targetLang,
    config.queue.concurrency
  );
  const finalBilingualCues = preserveTiming
    ? translatedBilingualCues
    : optimizeBilingualCues(translatedBilingualCues);

  const webvtt = renderWebVTT(finalBilingualCues, {
    kind: 'asr',
    language: targetLang,
  });
  const renderedVttCues = parseWebVTT(webvtt);
  const renderedJson3 = renderYouTubeTimedText(finalBilingualCues);

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'translated.vtt'), webvtt);
  await writeFile(path.join(outputDir, 'translated.json'), JSON.stringify(renderedJson3, null, 2));
  await writeFile(path.join(outputDir, 'pipeline-cues.json'), JSON.stringify({
    originalCues,
    sourceCues,
    optimizedCues,
    translatedBilingualCues,
    finalBilingualCues,
    renderedVttCues,
  }, null, 2));

  const metrics: PipelineMetrics = {
    input: inputPath,
    outputDir,
    config: summarizeConfig(),
    counts: {
      parsed: originalCues.length,
      source: sourceCues.length,
      optimizedSource: optimizedSourceCues.length,
      optimizedTiming: optimizedCues.length,
      translatedBilingual: translatedBilingualCues.length,
      finalBilingual: finalBilingualCues.length,
      renderedVtt: renderedVttCues.length,
      renderedJson3Events: renderedJson3.events.length,
    },
    quality: {
      originalParsed: analyzeCueQuality(originalCues),
      optimizedSource: analyzeCueQuality(optimizedCues),
      renderedVtt: analyzeCueQuality(renderedVttCues),
    },
    suspiciousExamples: collectSuspiciousExamples(renderedVttCues),
    elapsedMs: Date.now() - startedAt,
  };

  await writeFile(path.join(outputDir, 'metrics.json'), JSON.stringify(metrics, null, 2));

  console.log('[Verify] Completed');
  console.log('[Verify] Counts:', JSON.stringify(metrics.counts, null, 2));
  console.log('[Verify] Render quality:', JSON.stringify(metrics.quality.renderedVtt, null, 2));
  if (metrics.suspiciousExamples.length > 0) {
    console.log('[Verify] Suspicious rendered examples:');
    for (const item of metrics.suspiciousExamples.slice(0, 10)) {
      console.log(
        `  #${item.index} ${item.startMs}-${item.endMs}ms [${item.reason}] ${item.text}`
      );
    }
  }
  console.log(`[Verify] Artifacts written to ${outputDir}`);
}

main().catch(error => {
  console.error('[Verify] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
