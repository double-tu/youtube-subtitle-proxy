/**
 * Subtitle Segmentation Module
 *
 * Merges word-level subtitles into paragraph-level segments (3-7 seconds)
 */
import type { SubtitleCue } from '../types/subtitle.js';
import { getConfig } from '../config/env.js';

const SPEAKER_PREFIX_PATTERN = /^>>\s*/;
const REPEATED_CHEVRON_PATTERN = />>/g;
const SYMBOL_START_PATTERN = /^[[(♪]/;
const PAUSE_WORDS = new Set([
  'actually',
  'also',
  'although',
  'and',
  'anyway',
  'as',
  'basically',
  'because',
  'but',
  'eventually',
  'frankly',
  'honestly',
  'hopefully',
  'however',
  'if',
  'instead',
  'just',
  'like',
  'literally',
  'maybe',
  'meanwhile',
  'nevertheless',
  'nonetheless',
  'now',
  'okay',
  'or',
  'otherwise',
  'perhaps',
  'personally',
  'probably',
  'right',
  'since',
  'so',
  'suddenly',
  'then',
  'therefore',
  'though',
  'thus',
  'unless',
  'until',
  'well',
  'while',
]);
const STRONG_SENTENCE_END_PATTERN = /[.!?。！？…]$/;
const COMPACT_CUE_MAX_GAP_MS = 1000;

type TextStats = {
  isCjk: boolean;
  length: number;
};

function normalizeCueText(text: string): string {
  return text
    .replace(SPEAKER_PREFIX_PATTERN, '')
    .replace(REPEATED_CHEVRON_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCjkText(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(text);
}

function getTextStats(text: string): TextStats {
  const normalized = text.trim();
  const isCjk = isCjkText(normalized);
  return {
    isCjk,
    length: isCjk ? normalized.length : countWords(normalized),
  };
}

function getTargetBounds(isCjk: boolean) {
  const config = getConfig();
  return isCjk
    ? {
        min: config.subtitle.sourceTargetMinCjk,
        max: config.subtitle.sourceTargetMaxCjk,
      }
    : {
        min: config.subtitle.sourceTargetMinWords,
        max: config.subtitle.sourceTargetMaxWords,
      };
}

function getBilingualLimit(text: string): number {
  const config = getConfig();
  const stats = getTextStats(text);
  return stats.isCjk
    ? config.subtitle.bilingualMaxCharsCjk
    : config.subtitle.bilingualMaxWords;
}

function splitSentenceParts(text: string): string[] {
  const normalized = normalizeCueText(text);
  if (!normalized) {
    return [];
  }

  const isCjk = isCjkText(normalized);
  const pattern = isCjk
    ? /(?<=[。！？；：，、…])/
    : /(?<=[,.;:!?])\s+/;

  const parts = normalized
    .split(pattern)
    .map(part => part.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : [normalized];
}

function combineCueTexts(texts: string[]): string {
  const cleaned = texts.map(normalizeCueText).filter(Boolean);
  if (cleaned.length === 0) {
    return '';
  }

  const hasCjk = cleaned.some(isCjkText);
  return normalizeMergedText(cleaned.join(hasCjk ? '' : ' '));
}

function mergeCuePair(left: SubtitleCue, right: SubtitleCue): SubtitleCue {
  return {
    startTime: left.startTime,
    endTime: right.endTime,
    text: combineCueTexts([left.text, right.text]),
  };
}

function shouldKeepCompactBoundary(left: SubtitleCue, right: SubtitleCue): boolean {
  const gap = right.startTime - left.endTime;
  const leftText = left.text.trim();
  const rightText = right.text.trim();

  return gap > COMPACT_CUE_MAX_GAP_MS
    || STRONG_SENTENCE_END_PATTERN.test(leftText)
    || SYMBOL_START_PATTERN.test(rightText);
}

function shouldKeepBoundary(left: SubtitleCue, right: SubtitleCue): boolean {
  const gap = right.startTime - left.endTime;
  const rightText = right.text.trim();
  const rightFirstWord = rightText.toLowerCase().split(/\s+/)[0] || '';

  return gap > 1000
    || SYMBOL_START_PATTERN.test(rightText)
    || PAUSE_WORDS.has(rightFirstWord);
}

function splitCueAtNaturalBoundary(cue: SubtitleCue): SubtitleCue[] {
  const parts = splitSentenceParts(cue.text);
  if (parts.length <= 1) {
    return [cue];
  }

  const totalWeight = parts.reduce((sum, part) => sum + Math.max(1, getTextStats(part).length), 0);
  const totalDuration = cue.endTime - cue.startTime;
  let cursor = cue.startTime;

  return parts.map((part, index) => {
    const weight = Math.max(1, getTextStats(part).length);
    const duration = index === parts.length - 1
      ? cue.endTime - cursor
      : Math.max(400, Math.round((weight / totalWeight) * totalDuration));
    const startTime = cursor;
    const endTime = index === parts.length - 1
      ? cue.endTime
      : Math.min(cue.endTime, startTime + duration);

    cursor = endTime;
    return {
      startTime,
      endTime,
      text: part,
    };
  }).filter(item => item.endTime > item.startTime);
}

function rebalanceSourceCues(cues: SubtitleCue[]): SubtitleCue[] {
  if (cues.length <= 1) {
    return cues;
  }

  const result: SubtitleCue[] = [];

  for (let i = 0; i < cues.length; i++) {
    let current = { ...cues[i] };
    const currentStats = getTextStats(current.text);
    const bounds = getTargetBounds(currentStats.isCjk);
    let currentLength = currentStats.length;

    while (currentLength < bounds.min && i + 1 < cues.length) {
      const next = cues[i + 1];
      if (shouldKeepBoundary(current, next)) {
        break;
      }

      const nextStats = getTextStats(next.text);
      const combinedLength = currentLength + nextStats.length;
      if (combinedLength > bounds.max) {
        break;
      }

      current = mergeCuePair(current, next);
      currentLength = combinedLength;
      i++;
    }

    result.push(current);
  }

  return result;
}

function improveSourceCueQuality(cues: SubtitleCue[]): SubtitleCue[] {
  const expanded = cues.flatMap(cue => splitCueAtNaturalBoundary(cue));
  return rebalanceSourceCues(expanded);
}

function distributeCueDuration(
  startTime: number,
  endTime: number,
  parts: Array<{ original: string; translation: string }>
): SubtitleCue[] {
  const totalDuration = endTime - startTime;
  const totalWeight = parts.reduce((sum, part) => {
    return sum + Math.max(
      1,
      getTextStats(part.original).length + getTextStats(part.translation).length
    );
  }, 0);

  let cursor = startTime;

  return parts.map((part, index) => {
    const weight = Math.max(
      1,
      getTextStats(part.original).length + getTextStats(part.translation).length
    );
    const duration = index === parts.length - 1
      ? endTime - cursor
      : Math.max(500, Math.round((weight / totalWeight) * totalDuration));
    const nextEnd = index === parts.length - 1 ? endTime : Math.min(endTime, cursor + duration);
    const cue: SubtitleCue = {
      startTime: cursor,
      endTime: nextEnd,
      text: `${part.original}\n${part.translation}`,
    };
    cursor = nextEnd;
    return cue;
  }).filter(cue => cue.endTime > cue.startTime);
}

function splitBilingualParts(original: string, translation: string): Array<{ original: string; translation: string }> {
  const originalParts = splitSentenceParts(original);
  const translationParts = splitSentenceParts(translation);
  const targetCount = Math.max(originalParts.length, translationParts.length);

  if (targetCount <= 1) {
    return [{ original: normalizeCueText(original), translation: normalizeCueText(translation) }];
  }

  const normalizePartsToCount = (parts: string[], count: number) => {
    if (parts.length === count) {
      return parts;
    }

    if (parts.length > count) {
      const grouped: string[] = [];
      const chunkSize = Math.ceil(parts.length / count);
      for (let i = 0; i < parts.length; i += chunkSize) {
        grouped.push(combineCueTexts(parts.slice(i, i + chunkSize)));
      }
      while (grouped.length < count) {
        grouped.push('');
      }
      return grouped.slice(0, count);
    }

    const padded = [...parts];
    while (padded.length < count) {
      padded.push('');
    }
    return padded;
  };

  const alignedOriginal = normalizePartsToCount(originalParts, targetCount);
  const alignedTranslation = normalizePartsToCount(translationParts, targetCount);

  return Array.from({ length: targetCount }, (_, index) => ({
    original: alignedOriginal[index] || '',
    translation: alignedTranslation[index] || '',
  })).filter(part => part.original || part.translation);
}

function needsBilingualSplit(original: string, translation: string): boolean {
  return getTextStats(original).length > getBilingualLimit(original)
    || getTextStats(translation).length > getBilingualLimit(translation);
}

function splitBilingualCue(cue: SubtitleCue): SubtitleCue[] {
  const [originalLine = '', ...translationLines] = cue.text.split(/\r?\n/);
  const translationLine = translationLines.join(' ').trim();
  if (!translationLine) {
    return [cue];
  }

  if (!needsBilingualSplit(originalLine, translationLine)) {
    return [cue];
  }

  const config = getConfig();
  const duration = cue.endTime - cue.startTime;
  if (duration < config.subtitle.bilingualMinDurationMs * 2) {
    return [cue];
  }

  const parts = splitBilingualParts(originalLine, translationLine);
  if (parts.length <= 1) {
    return [cue];
  }

  return distributeCueDuration(cue.startTime, cue.endTime, parts);
}

export function optimizeSourceCues(
  cues: SubtitleCue[],
  options?: {
    preserveTiming?: boolean;
  }
): SubtitleCue[] {
  const normalized = cues
    .map(cue => ({
      ...cue,
      text: normalizeCueText(cue.text),
    }))
    .filter(cue => cue.text);

  if (options?.preserveTiming) {
    return normalized;
  }

  return improveSourceCueQuality(normalized);
}

export function compactShortCues(cues: SubtitleCue[]): SubtitleCue[] {
  if (cues.length <= 1) {
    return cues;
  }

  const normalized = cues
    .map(cue => ({
      ...cue,
      text: normalizeCueText(cue.text),
    }))
    .filter(cue => cue.text);

  if (normalized.length <= 1) {
    return normalized;
  }

  const result: SubtitleCue[] = [];

  for (let i = 0; i < normalized.length; i++) {
    let current = { ...normalized[i] };
    const currentStats = getTextStats(current.text);
    const bounds = getTargetBounds(currentStats.isCjk);
    let currentLength = currentStats.length;

    while (currentLength < bounds.min && i + 1 < normalized.length) {
      const next = normalized[i + 1];
      if (shouldKeepCompactBoundary(current, next)) {
        break;
      }

      const nextStats = getTextStats(next.text);
      const combinedLength = currentLength + nextStats.length;
      if (combinedLength > bounds.max) {
        break;
      }

      current = mergeCuePair(current, next);
      currentLength = combinedLength;
      i++;
    }

    result.push(current);
  }

  return result;
}

export function optimizeBilingualCues(cues: SubtitleCue[]): SubtitleCue[] {
  const result = cues.flatMap(cue => splitBilingualCue(cue));
  return optimizeSubtitleTiming(result);
}

/**
 * Merge subtitle cues into paragraphs based on time gaps
 */
export function mergeSubtitleCues(
  cues: SubtitleCue[],
  options?: {
    minDurationMs?: number;
    maxDurationMs?: number;
    gapThresholdMs?: number;
    maxChars?: number;
    maxWords?: number;
  }
): SubtitleCue[] {
  if (cues.length === 0) {
    return [];
  }

  const config = getConfig();
  const minDuration = options?.minDurationMs ?? config.subtitle.minDurationMs;
  const maxDuration = options?.maxDurationMs ?? config.subtitle.maxDurationMs;
  const gapThreshold = options?.gapThresholdMs ?? config.subtitle.segmentGapMs;
  const maxChars = options?.maxChars ?? config.subtitle.segmentMaxChars;
  const maxWords = options?.maxWords ?? config.subtitle.segmentMaxWords;

  const merged: SubtitleCue[] = [];
  let currentGroup: string[] = [];
  let groupStartTime: number | null = null;
  let groupEndTime: number | null = null;
  let lastEndTime: number | null = null;
  let currentChars = 0;
  let currentWords = 0;

  for (const cue of cues) {
    const normalizedText = cue.text.trim();
    if (!normalizedText) {
      continue;
    }

    if (groupStartTime === null) {
      // Start new paragraph
      groupStartTime = cue.startTime;
      groupEndTime = cue.endTime;
      currentGroup = [normalizedText];
      currentChars = normalizedText.length;
      currentWords = countWords(normalizedText);
      lastEndTime = cue.endTime;
      continue;
    }

    const gap = cue.startTime - lastEndTime!;
    const durationWithCue = cue.endTime - groupStartTime;
    const charsWithCue = currentChars + normalizedText.length + 1;
    const wordsWithCue = currentWords + countWords(normalizedText);

    const shouldHardBreak = durationWithCue >= maxDuration || gap > gapThreshold;
    if (shouldHardBreak) {
      merged.push({
        startTime: groupStartTime,
        endTime: groupEndTime!,
        text: normalizeMergedText(currentGroup.join(' ')),
      });

      groupStartTime = cue.startTime;
      groupEndTime = cue.endTime;
      currentGroup = [normalizedText];
      currentChars = normalizedText.length;
      currentWords = countWords(normalizedText);
      lastEndTime = cue.endTime;
      continue;
    }

    // Continue current paragraph
    groupEndTime = cue.endTime;
    currentGroup.push(normalizedText);
    lastEndTime = cue.endTime;
    currentChars = charsWithCue;
    currentWords = wordsWithCue;

    const exceedsMaxChars = maxChars > 0 && currentChars >= maxChars;
    const exceedsMaxWords = maxWords > 0 && currentWords >= maxWords;
    const shouldSoftBreak = durationWithCue >= minDuration
      && (shouldBreakOnPunctuation(normalizedText) || exceedsMaxChars || exceedsMaxWords);

    if (shouldSoftBreak) {
      merged.push({
        startTime: groupStartTime,
        endTime: groupEndTime!,
        text: normalizeMergedText(currentGroup.join(' ')),
      });

      groupStartTime = null;
      groupEndTime = null;
      lastEndTime = null;
      currentGroup = [];
      currentChars = 0;
      currentWords = 0;
    }
  }

  // Save last paragraph
  if (currentGroup.length > 0 && groupStartTime !== null && groupEndTime !== null) {
    const normalizedText = normalizeMergedText(currentGroup.join(' '));

    if (groupEndTime - groupStartTime < minDuration && merged.length > 0) {
      const lastMerged = merged[merged.length - 1];
      lastMerged.endTime = groupEndTime;
      lastMerged.text = normalizeMergedText(`${lastMerged.text} ${normalizedText}`);
    } else {
      merged.push({
        startTime: groupStartTime,
        endTime: groupEndTime,
        text: normalizedText,
      });
    }
  }

  return merged;
}

/**
 * Check if text ends with sentence-ending punctuation
 */
function shouldBreakOnPunctuation(text: string): boolean {
  if (!text) return false;

  const trimmed = text.trim();
  const lastChar = trimmed[trimmed.length - 1];

  // English punctuation
  if (['.', '!', '?', '…'].includes(lastChar)) {
    return true;
  }

  // Chinese/Japanese punctuation
  if (['。', '！', '？', '…'].includes(lastChar)) {
    return true;
  }

  return false;
}

function normalizeMergedText(text: string): string {
  return text
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+([，。！？；：])/g, '$1')
    .replace(/([([{“‘])\s+/g, '$1')
    .replace(/\s+([)\]}'"”’])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

/**
 * Split long paragraphs into sentences
 */
export function splitLongParagraphs(
  cues: SubtitleCue[],
  maxLength: number = 200
): SubtitleCue[] {
  const result: SubtitleCue[] = [];

  for (const cue of cues) {
    if (cue.text.length <= maxLength) {
      result.push(cue);
      continue;
    }

    // Split by sentence boundaries
    const sentences = splitIntoSentences(cue.text);
    if (sentences.length === 1) {
      // Can't split, keep as is
      result.push(cue);
      continue;
    }

    // Distribute time proportionally
    const duration = cue.endTime - cue.startTime;
    const totalLength = cue.text.length;
    let currentTime = cue.startTime;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const sentenceDuration = Math.floor((sentence.length / totalLength) * duration);
      const endTime = i === sentences.length - 1
        ? cue.endTime
        : currentTime + sentenceDuration;

      result.push({
        startTime: currentTime,
        endTime: endTime,
        text: sentence.trim(),
      });

      currentTime = endTime;
    }
  }

  return result;
}

/**
 * Split text into sentences
 */
function splitIntoSentences(text: string): string[] {
  // Split by sentence-ending punctuation followed by space
  const sentences = text.split(/([.!?。！？…]+\s+)/);
  const result: string[] = [];
  let current = '';

  for (let i = 0; i < sentences.length; i++) {
    if (i % 2 === 0) {
      current = sentences[i];
    } else {
      current += sentences[i];
      result.push(current);
      current = '';
    }
  }

  if (current.trim()) {
    result.push(current);
  }

  return result.filter(s => s.trim());
}

/**
 * Optimize subtitle timing for better readability
 */
export function optimizeSubtitleTiming(cues: SubtitleCue[]): SubtitleCue[] {
  const optimized: SubtitleCue[] = [];

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const nextCue = cues[i + 1];

    // Ensure minimum display time (1 second)
    const minDisplayTime = 1000;
    let endTime = cue.endTime;

    if (endTime - cue.startTime < minDisplayTime) {
      endTime = cue.startTime + minDisplayTime;

      // Don't overlap with next cue
      if (nextCue && endTime > nextCue.startTime) {
        endTime = nextCue.startTime - 100; // 100ms gap
      }
    }

    optimized.push({
      ...cue,
      endTime: Math.max(endTime, cue.startTime + 500), // Minimum 500ms
    });
  }

  return optimized;
}

/**
 * Remove duplicate cues
 */
export function deduplicateCues(cues: SubtitleCue[]): SubtitleCue[] {
  const seen = new Set<string>();
  const result: SubtitleCue[] = [];

  for (const cue of cues) {
    const key = `${cue.startTime}-${cue.endTime}-${cue.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cue);
    }
  }

  return result;
}

export default {
  mergeSubtitleCues,
  compactShortCues,
  optimizeSourceCues,
  optimizeBilingualCues,
  splitLongParagraphs,
  optimizeSubtitleTiming,
  deduplicateCues,
};
