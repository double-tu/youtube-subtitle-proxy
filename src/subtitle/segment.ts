/**
 * Subtitle Segmentation Module
 *
 * Merges word-level subtitles into paragraph-level segments (3-7 seconds)
 */
import type { SubtitleCue } from '../types/subtitle.js';
import { getConfig } from '../config/env.js';
import { buildScrollingAsrTimeline, type SubtitleAtom } from './timeline.js';

const SPEAKER_PREFIX_PATTERN = /^>>\s*/;
const REPEATED_CHEVRON_PATTERN = />>/g;
const SYMBOL_START_PATTERN = /^[[(♪]/;
const LEADING_PUNCTUATION_PATTERN = /^[,.;:!?，。！？；：、]/;
const TRAILING_CONNECTOR_PATTERN = /(?:和|与|或|而|并|从|向|给|把|被|对|在|为|将|让|跟|比|及)$/;
const PUNCTUATION_ONLY_PATTERN = /^[\p{P}\p{S}\s]+$/u;
const UNSAFE_TRAILING_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'being',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'may',
  'might',
  'must',
  'of',
  'on',
  'or',
  'our',
  'over',
  'should',
  'so',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'this',
  'those',
  'to',
  'under',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
]);
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

function combineAtomTexts(atoms: SubtitleAtom[]): string {
  let combined = '';

  for (const atom of atoms) {
    if (
      combined
      && !isCjkText(combined)
      && !combined.endsWith(' ')
      && !atom.text.startsWith(' ')
    ) {
      combined += ' ';
    }

    combined += atom.text;
  }

  return normalizeCueText(combined);
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

function isLikelyDanglingText(text: string): boolean {
  const normalized = normalizeCueText(text);
  if (!normalized || SYMBOL_START_PATTERN.test(normalized)) {
    return false;
  }

  if (PUNCTUATION_ONLY_PATTERN.test(normalized) || LEADING_PUNCTUATION_PATTERN.test(normalized)) {
    return true;
  }

  const stats = getTextStats(normalized);
  if (stats.isCjk) {
    if (stats.length <= 6) {
      return true;
    }

    return TRAILING_CONNECTOR_PATTERN.test(normalized);
  }

  return stats.length <= 3 && !STRONG_SENTENCE_END_PATTERN.test(normalized);
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

function distributeMonolingualCueDuration(
  cue: SubtitleCue,
  parts: string[]
): SubtitleCue[] {
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
      : Math.max(500, Math.round((weight / totalWeight) * totalDuration));
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

function getLastEnglishWord(text: string): string {
  const match = normalizeCueText(text).match(/[A-Za-z][A-Za-z'-]*$/);
  return match ? match[0].toLowerCase() : '';
}

function isSafeEnglishChunkBoundary(words: string[], endExclusive: number): boolean {
  const left = words.slice(0, endExclusive).join(' ');
  const right = words.slice(endExclusive).join(' ');
  const lastWord = getLastEnglishWord(left);

  return Boolean(left.trim())
    && Boolean(right.trim())
    && !UNSAFE_TRAILING_WORDS.has(lastWord)
    && !/-$/.test(lastWord);
}

function splitEnglishCueByLength(text: string, maxWords: number): string[] {
  const words = normalizeCueText(text).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return [normalizeCueText(text)];
  }

  const overflowLimit = Math.max(maxWords + 3, Math.ceil(maxWords * 1.2));
  const minWords = Math.max(6, Math.floor(maxWords * 0.6));
  const parts: string[] = [];
  let start = 0;

  while (start < words.length) {
    const remaining = words.length - start;
    if (remaining <= maxWords) {
      parts.push(words.slice(start).join(' '));
      break;
    }

    let splitAt = -1;
    const preferredEnd = Math.min(start + maxWords, words.length - 1);
    const latestEnd = Math.min(start + overflowLimit, words.length - 1);

    for (let end = preferredEnd; end >= start + minWords; end--) {
      if (isSafeEnglishChunkBoundary(words.slice(start, latestEnd + 1), end - start)) {
        splitAt = end;
        break;
      }
    }

    if (splitAt === -1) {
      for (let end = preferredEnd + 1; end <= latestEnd; end++) {
        if (isSafeEnglishChunkBoundary(words.slice(start, latestEnd + 1), end - start)) {
          splitAt = end;
          break;
        }
      }
    }

    if (splitAt === -1) {
      splitAt = preferredEnd;
    }

    parts.push(words.slice(start, splitAt).join(' '));
    start = splitAt;
  }

  return parts.filter(Boolean);
}

function splitCjkCueByLength(text: string, maxChars: number): string[] {
  const normalized = normalizeCueText(text);
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const minChars = Math.max(10, Math.floor(maxChars * 0.6));
  const parts: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    let splitIndex = -1;

    for (let index = maxChars; index >= minChars; index--) {
      const left = remaining.slice(0, index).trim();
      const right = remaining.slice(index).trim();
      if (
        left
        && right
        && /[，。！？；：、…]$/.test(left)
        && !TRAILING_CONNECTOR_PATTERN.test(left)
        && !LEADING_PUNCTUATION_PATTERN.test(right)
      ) {
        splitIndex = index;
        break;
      }
    }

    if (splitIndex === -1) {
      for (let index = maxChars; index >= minChars; index--) {
        const left = remaining.slice(0, index).trim();
        const right = remaining.slice(index).trim();
        if (
          left
          && right
          && !TRAILING_CONNECTOR_PATTERN.test(left)
          && !LEADING_PUNCTUATION_PATTERN.test(right)
        ) {
          splitIndex = index;
          break;
        }
      }
    }

    if (splitIndex === -1) {
      splitIndex = maxChars;
    }

    parts.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts.filter(Boolean);
}

function splitReadableSourceCue(cue: SubtitleCue): SubtitleCue[] {
  const normalizedText = normalizeCueText(cue.text);
  const stats = getTextStats(normalizedText);
  const config = getConfig();
  const maxLength = stats.isCjk
    ? Math.max(config.subtitle.renderMaxCharsCjk + 6, 24)
    : Math.max(config.subtitle.renderMaxWords + 3, 15);

  if (stats.length <= maxLength) {
    return [{ ...cue, text: normalizedText }];
  }

  const parts = stats.isCjk
    ? splitCjkCueByLength(normalizedText, maxLength)
    : splitEnglishCueByLength(normalizedText, maxLength);

  return distributeMonolingualCueDuration({ ...cue, text: normalizedText }, parts);
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
  const leftDangling = isLikelyDanglingText(leftText);
  const rightDangling = isLikelyDanglingText(rightText);

  return gap > COMPACT_CUE_MAX_GAP_MS
    || (STRONG_SENTENCE_END_PATTERN.test(leftText) && !leftDangling)
    || (SYMBOL_START_PATTERN.test(rightText) && !rightDangling);
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

  for (let i = result.length - 1; i > 0; i--) {
    const current = result[i];
    const currentStats = getTextStats(current.text);
    const bounds = getTargetBounds(currentStats.isCjk);
    if (currentStats.length >= bounds.min) {
      continue;
    }

    const previous = result[i - 1];
    const previousStats = getTextStats(previous.text);
    const combinedLength = previousStats.length + currentStats.length;
    if (combinedLength > bounds.max || shouldKeepCompactBoundary(previous, current)) {
      continue;
    }

    result[i - 1] = mergeCuePair(previous, current);
    result.splice(i, 1);
  }

  return result;
}

function improveSourceCueQuality(cues: SubtitleCue[]): SubtitleCue[] {
  const expanded = cues.flatMap(cue => splitCueAtNaturalBoundary(cue));
  return rebalanceSourceCues(expanded);
}

function improvePreservedSourceCueQuality(cues: SubtitleCue[]): SubtitleCue[] {
  if (cues.length <= 1) {
    return cues;
  }

  const normalized = cues
    .map(cue => ({
      ...cue,
      text: normalizeCueText(cue.text),
    }))
    .filter(cue => cue.text);

  const compacted = compactShortCues(normalized);
  return rebalanceSourceCues(compacted);
}

function buildCueFromAtoms(atoms: SubtitleAtom[]): SubtitleCue | null {
  if (atoms.length === 0) {
    return null;
  }

  const text = combineAtomTexts(atoms);
  if (!text) {
    return null;
  }

  return {
    startTime: atoms[0].startTime,
    endTime: atoms[atoms.length - 1].endTime,
    text,
  };
}

function shouldFlushAtomSegment(
  atomBuffer: SubtitleAtom[],
  nextAtom: SubtitleAtom | undefined,
  preserveTiming: boolean
): boolean {
  if (atomBuffer.length === 0) {
    return false;
  }

  const currentCue = buildCueFromAtoms(atomBuffer);
  if (!currentCue) {
    return true;
  }

  const currentText = currentCue.text;
  const currentStats = getTextStats(currentText);
  const bounds = getTargetBounds(currentStats.isCjk);
  const duration = currentCue.endTime - currentCue.startTime;
  const gap = nextAtom ? (nextAtom.startTime - atomBuffer[atomBuffer.length - 1].endTime) : Number.POSITIVE_INFINITY;
  const reachedStrongBoundary = STRONG_SENTENCE_END_PATTERN.test(currentText);
  const reachedSoftBoundary = currentStats.isCjk
    ? /[，、；：。！？…]$/.test(currentText)
    : /[,.;:!?]$/.test(currentText);

  if (!nextAtom) {
    return true;
  }

  if (gap > 1000) {
    return true;
  }

  if (preserveTiming) {
    if (reachedStrongBoundary) {
      return true;
    }

    return currentStats.length >= bounds.max;
  }

  if (reachedStrongBoundary && duration >= 1800) {
    return true;
  }

  if (
    reachedSoftBoundary
    && currentStats.length >= bounds.min
    && duration >= 1500
  ) {
    return true;
  }

  return currentStats.length >= bounds.max;
}

function segmentAtoms(
  atoms: SubtitleAtom[],
  options?: {
    preserveTiming?: boolean;
  }
): SubtitleCue[] {
  if (atoms.length === 0) {
    return [];
  }

  const result: SubtitleCue[] = [];
  const atomBuffer: SubtitleAtom[] = [];

  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    const nextAtom = atoms[i + 1];
    atomBuffer.push(atom);

    if (shouldFlushAtomSegment(atomBuffer, nextAtom, Boolean(options?.preserveTiming))) {
      const cue = buildCueFromAtoms(atomBuffer);
      if (cue) {
        result.push(cue);
      }
      atomBuffer.length = 0;
    }
  }

  if (atomBuffer.length > 0) {
    const cue = buildCueFromAtoms(atomBuffer);
    if (cue) {
      result.push(cue);
    }
  }

  return result;
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
    return normalized.flatMap(cue => splitReadableSourceCue(cue));
  }

  return improveSourceCueQuality(normalized);
}

export function buildSourceSegments(
  originalJson: { events?: Array<any> },
  parsedCues: SubtitleCue[],
  options?: {
    preserveTiming?: boolean;
  }
): SubtitleCue[] {
  const events = Array.isArray(originalJson.events) ? originalJson.events : [];
  const atoms = buildScrollingAsrTimeline(events);

  if (atoms.length === 0) {
    const sourceCues = options?.preserveTiming
      ? compactShortCues(parsedCues)
      : mergeSubtitleCues(parsedCues);
    return optimizeSourceCues(sourceCues, options);
  }

  const segmented = segmentAtoms(atoms, options);
  return options?.preserveTiming
    ? improvePreservedSourceCueQuality(segmented)
    : improveSourceCueQuality(segmented);
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
      const allowOverflow = isLikelyDanglingText(current.text) || isLikelyDanglingText(next.text);
      const maxLength = allowOverflow
        ? bounds.max + (currentStats.isCjk ? 10 : 4)
        : bounds.max;
      if (combinedLength > maxLength) {
        break;
      }

      current = mergeCuePair(current, next);
      currentLength = combinedLength;
      i++;
    }

    result.push(current);
  }

  for (let i = result.length - 1; i > 0; i--) {
    const current = result[i];
    const currentStats = getTextStats(current.text);
    const bounds = getTargetBounds(currentStats.isCjk);
    if (currentStats.length >= bounds.min && !isLikelyDanglingText(current.text)) {
      continue;
    }

    const previous = result[i - 1];
    const previousStats = getTextStats(previous.text);
    const combinedLength = previousStats.length + currentStats.length;
    const allowOverflow = isLikelyDanglingText(previous.text) || isLikelyDanglingText(current.text);
    const maxLength = allowOverflow
      ? bounds.max + (currentStats.isCjk ? 10 : 4)
      : bounds.max;
    if (combinedLength > maxLength || shouldKeepCompactBoundary(previous, current)) {
      continue;
    }

    result[i - 1] = mergeCuePair(previous, current);
    result.splice(i, 1);
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
