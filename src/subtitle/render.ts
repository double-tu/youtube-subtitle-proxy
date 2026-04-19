/**
 * Subtitle Rendering Module
 *
 * Renders subtitle cues to WebVTT format
 */
import { getConfig } from '../config/env.js';
import type {
  SubtitleCue,
  SubtitleOutputMode,
  SubtitleRenderFormat,
  YouTubeTimedTextResponse,
} from '../types/subtitle.js';

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const STRONG_SENTENCE_END_PATTERN = /[.!?。！？…]$/;
const SYMBOL_START_PATTERN = /^[[(♪]/;
const LEADING_PUNCTUATION_PATTERN = /^[,.;:!?，。！？；：、]/;
const TRAILING_CONNECTOR_PATTERN = /(?:和|与|或|而|并|从|向|给|把|被|对|在|为|将|让|跟|比|及)$/;
const PUNCTUATION_ONLY_PATTERN = /^[\p{P}\p{S}\s]+$/u;
const RENDER_COMPACT_MAX_GAP_MS = 1000;
const RENDER_COMPACT_MIN_DURATION_MS = 1200;
const RENDER_COMPACT_MAX_DURATION_MS = 6500;
const RENDER_DANGLING_MAX_DURATION_MS = 9000;
const CJK_SOFT_BREAK_PATTERN = /[，。！？；：、…]/;
const TRANSLATION_REBALANCE_MAX_GAP_MS = 1000;
const MIN_REBALANCED_DURATION_MS = 700;
const MAX_TRANSLATION_ONLY_LINES = 2;
const MAX_TRANSLATION_ONLY_DURATION_MS = 7200;

function isCjkText(text: string): boolean {
  return CJK_PATTERN.test(text);
}

function textLength(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return isCjkText(trimmed)
    ? trimmed.length
    : trimmed.split(/\s+/).filter(Boolean).length;
}

function splitForRender(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed || textLength(trimmed) <= limit) {
    return trimmed ? [trimmed] : [];
  }

  const isCjk = isCjkText(trimmed);
  if (isCjk) {
    return splitCjkForRender(trimmed, limit);
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    const next = [...current, word].join(' ');
    if (current.length > 0 && textLength(next) > limit) {
      lines.push(current.join(' '));
      current = [word];
      continue;
    }
    current.push(word);
  }

  if (current.length > 0) {
    lines.push(current.join(' '));
  }

  return lines;
}

function splitCjkForRender(text: string, limit: number): string[] {
  const parts: string[] = [];
  let remaining = text.trim();

  while (textLength(remaining) > limit) {
    const splitIndex = findCjkSplitIndex(remaining, limit);
    const head = remaining.slice(0, splitIndex).trim();
    const tail = remaining.slice(splitIndex).trim();

    if (!head || !tail) {
      break;
    }

    parts.push(head);
    remaining = tail;
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

function cueWeight(text: string): number {
  return Math.max(1, text.replace(/\s+/g, '').length);
}

function findLastBoundaryIndex(text: string): number {
  for (let index = text.length - 1; index >= 0; index--) {
    if (/[。！？；，、：,.!?;:]/.test(text[index] ?? '')) {
      return index + 1;
    }
  }

  return -1;
}

function extractTrailingDanglingText(text: string): { head: string; tail: string } | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const boundaryIndex = findLastBoundaryIndex(normalized);
  if (boundaryIndex <= 0 || boundaryIndex >= normalized.length) {
    return null;
  }

  const head = normalized.slice(0, boundaryIndex).trim();
  const tail = normalized.slice(boundaryIndex).trim();
  if (!head || !tail) {
    return null;
  }

  if (!isLikelyDanglingCueText(tail) && cueWeight(tail) > 8) {
    return null;
  }

  return { head, tail };
}

function extractLeadingBridgeText(text: string): { prefix: string; suffix: string } | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const maxChars = Math.min(40, normalized.length - 1);

  let chosenIndex = -1;
  for (let index = 1; index <= maxChars; index++) {
    const prefix = normalized.slice(0, index).trim();
    const suffix = normalized.slice(index).trim();
    if (
      prefix
      && suffix
      && /[。！？；，、：,.!?;:]/.test(normalized[index - 1] ?? '')
      && !TRAILING_CONNECTOR_PATTERN.test(prefix)
      && !LEADING_PUNCTUATION_PATTERN.test(suffix)
    ) {
      chosenIndex = index;
    }
  }

  if (chosenIndex === -1) {
    return null;
  }

  return {
    prefix: normalized.slice(0, chosenIndex).trim(),
    suffix: normalized.slice(chosenIndex).trim(),
  };
}

function rebalanceCueTiming(left: SubtitleCue, right: SubtitleCue, leftText: string, rightText: string): {
  left: SubtitleCue;
  right: SubtitleCue;
} {
  const totalDuration = right.endTime - left.startTime;
  const leftWeight = cueWeight(leftText);
  const rightWeight = cueWeight(rightText);
  const boundary = Math.round(left.startTime + (leftWeight / (leftWeight + rightWeight)) * totalDuration);
  const safeBoundary = Math.min(
    right.endTime - MIN_REBALANCED_DURATION_MS,
    Math.max(left.startTime + MIN_REBALANCED_DURATION_MS, boundary)
  );

  return {
    left: {
      startTime: left.startTime,
      endTime: safeBoundary,
      text: leftText,
    },
    right: {
      startTime: safeBoundary,
      endTime: right.endTime,
      text: rightText,
    },
  };
}

function findCjkSplitIndex(text: string, limit: number): number {
  const hardLimit = Math.min(text.length, Math.max(1, limit));
  const minIndex = Math.max(1, Math.floor(limit * 0.55));

  for (let index = hardLimit; index >= minIndex; index--) {
    const left = text.slice(0, index).trim();
    if (CJK_SOFT_BREAK_PATTERN.test(text[index - 1] ?? '') && !TRAILING_CONNECTOR_PATTERN.test(left)) {
      return index;
    }
  }

  for (let index = hardLimit; index >= minIndex; index--) {
    const left = text.slice(0, index).trim();
    const right = text.slice(index).trim();
    if (
      left
      && right
      && !(/[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right))
      && !TRAILING_CONNECTOR_PATTERN.test(left)
      && !LEADING_PUNCTUATION_PATTERN.test(right)
    ) {
      return index;
    }
  }

  return hardLimit;
}

function getRenderBounds(text: string): { min: number; max: number } {
  const config = getConfig();
  const isCjk = isCjkText(text);
  const lineLimit = isCjk ? config.subtitle.renderMaxCharsCjk : config.subtitle.renderMaxWords;
  const min = isCjk
    ? Math.max(8, Math.floor(lineLimit * 0.65))
    : Math.max(5, Math.floor(lineLimit * 0.65));

  return {
    min,
    max: Math.max(min, lineLimit * 2),
  };
}

function normalizeMergedRenderText(text: string): string {
  return text
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+([，。！？；：])/g, '$1')
    .replace(new RegExp(`(${CJK_CHAR_PATTERN.source})\\s+(${CJK_CHAR_PATTERN.source})`, 'g'), '$1$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function combineRenderTexts(texts: string[]): string {
  const cleaned = texts
    .map(text => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (cleaned.length === 0) {
    return '';
  }

  const hasCjk = cleaned.some(isCjkText);
  return normalizeMergedRenderText(cleaned.join(hasCjk ? '' : ' '));
}

function isLikelyDanglingCueText(text: string): boolean {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed || SYMBOL_START_PATTERN.test(trimmed)) {
    return false;
  }

  if (PUNCTUATION_ONLY_PATTERN.test(trimmed) || LEADING_PUNCTUATION_PATTERN.test(trimmed)) {
    return true;
  }

  const length = textLength(trimmed);
  if (isCjkText(trimmed)) {
    if (length <= 6) {
      return true;
    }

    return TRAILING_CONNECTOR_PATTERN.test(trimmed);
  }

  return length <= 3 && !STRONG_SENTENCE_END_PATTERN.test(trimmed);
}

function repairTranslationOnlyBoundaries(cues: SubtitleCue[]): SubtitleCue[] {
  const repaired = cues.map(cue => ({
    ...cue,
    text: cue.text.replace(/\s+/g, ' ').trim(),
  }));

  for (let i = 0; i < repaired.length - 1; i++) {
    let current = repaired[i];
    let next = repaired[i + 1];

    if (next.startTime - current.endTime > TRANSLATION_REBALANCE_MAX_GAP_MS) {
      continue;
    }

    const trailing = extractTrailingDanglingText(current.text);
    if (trailing && next.text) {
      const nextText = combineRenderTexts([trailing.tail, next.text]);
      const rebalanced = rebalanceCueTiming(current, next, trailing.head, nextText);
      current = rebalanced.left;
      next = rebalanced.right;
    }

    if (TRAILING_CONNECTOR_PATTERN.test(current.text.trim())) {
      const leading = extractLeadingBridgeText(next.text);
      if (leading) {
        const currentText = combineRenderTexts([current.text, leading.prefix]);
        const rebalanced = rebalanceCueTiming(current, next, currentText, leading.suffix);
        current = rebalanced.left;
        next = rebalanced.right;
      }
    }

    repaired[i] = current;
    repaired[i + 1] = next;
  }

  return repaired.filter(cue => cue.text.trim());
}

function canCompactRenderCue(current: SubtitleCue, next: SubtitleCue): boolean {
  const gap = next.startTime - current.endTime;
  if (gap > RENDER_COMPACT_MAX_GAP_MS || SYMBOL_START_PATTERN.test(next.text.trim())) {
    return false;
  }

  const currentText = current.text.trim();
  const nextText = next.text.trim();
  const currentLength = textLength(currentText);
  const currentDuration = current.endTime - current.startTime;
  const bounds = getRenderBounds(currentText);
  const currentDangling = isLikelyDanglingCueText(currentText);
  const nextDangling = isLikelyDanglingCueText(nextText);

  if (
    STRONG_SENTENCE_END_PATTERN.test(currentText)
    && !currentDangling
    && currentDuration >= MIN_REBALANCED_DURATION_MS
  ) {
    return false;
  }

  const combinedText = combineRenderTexts([current.text, next.text]);
  const combinedLength = textLength(combinedText);
  const combinedDuration = next.endTime - current.startTime;
  const combinedBounds = getRenderBounds(combinedText);
  const combinedMaxLength = combinedBounds.max
    + ((currentDangling || nextDangling) ? (isCjkText(combinedText) ? 10 : 4) : 0);
  const combinedMaxDuration = (currentDangling || nextDangling)
    ? RENDER_DANGLING_MAX_DURATION_MS
    : RENDER_COMPACT_MAX_DURATION_MS;

  if (combinedLength > combinedMaxLength || combinedDuration > combinedMaxDuration) {
    return false;
  }

  if (
    currentLength >= bounds.min
    && currentDuration >= RENDER_COMPACT_MIN_DURATION_MS
    && !currentDangling
    && !nextDangling
  ) {
    return false;
  }

  return true;
}

function mergeRenderCuePair(left: SubtitleCue, right: SubtitleCue): SubtitleCue {
  return {
    startTime: left.startTime,
    endTime: right.endTime,
    text: combineRenderTexts([left.text, right.text]),
  };
}

function compactTranslationOnlyRenderCues(cues: SubtitleCue[]): SubtitleCue[] {
  if (cues.length <= 1) {
    return cues;
  }

  const normalized = cues
    .map(cue => ({
      ...cue,
      text: cue.text.replace(/\s+/g, ' ').trim(),
    }))
    .filter(cue => cue.text);

  const result: SubtitleCue[] = [];

  for (let i = 0; i < normalized.length; i++) {
    let current = { ...normalized[i] };

    while (i + 1 < normalized.length && canCompactRenderCue(current, normalized[i + 1])) {
      current = mergeRenderCuePair(current, normalized[i + 1]);
      i++;
    }

    result.push(current);
  }

  return result;
}

function balanceWrappedLines(chunks: string[], limit: number): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const balanced = [...chunks];
  const minTailLength = isCjkText(chunks.join(''))
    ? Math.max(4, Math.floor(limit * 0.35))
    : Math.max(2, Math.floor(limit * 0.35));

  for (let index = balanced.length - 1; index > 0; index--) {
    const current = balanced[index];
    if (textLength(current) >= minTailLength) {
      continue;
    }

    const previous = balanced[index - 1];
    const merged = isCjkText(current) || isCjkText(previous)
      ? `${previous}${current}`
      : `${previous} ${current}`;
    const redistributed = splitForRender(merged, limit);

    if (redistributed.length !== 2) {
      continue;
    }

    if (textLength(redistributed[1]) <= textLength(current)) {
      continue;
    }

    balanced[index - 1] = redistributed[0];
    balanced[index] = redistributed[1];
  }

  return balanced;
}

function normalizeRenderText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function getPrimaryRenderLimit(text: string): number {
  const config = getConfig();
  return isCjkText(text)
    ? config.subtitle.renderMaxCharsCjk
    : config.subtitle.renderMaxWords;
}

function countWrappedLines(text: string, limit: number): number {
  return balanceWrappedLines(splitForRender(text, limit), limit).length;
}

function splitTranslationSentenceParts(text: string): string[] {
  const normalized = normalizeRenderText(text);
  if (!normalized) {
    return [];
  }

  const isCjk = isCjkText(normalized);
  const strongPattern = isCjk
    ? /(?<=[。！？；：…])/
    : /(?<=[.!?;:])\s+/;
  const softPattern = isCjk
    ? /(?<=[，、])/
    : /(?<=[,])\s+/;

  const splitWithPattern = (pattern: RegExp) => normalized
    .split(pattern)
    .map(part => normalizeRenderText(part))
    .filter(Boolean);

  const strongParts = splitWithPattern(strongPattern);
  if (strongParts.length > 1) {
    return strongParts;
  }

  const softParts = splitWithPattern(softPattern);
  return softParts.length > 1 ? softParts : [normalized];
}

function groupTextByWrappedLines(text: string, limit: number): string[] {
  const wrappedLines = balanceWrappedLines(splitForRender(text, limit), limit);
  if (wrappedLines.length <= MAX_TRANSLATION_ONLY_LINES) {
    return [normalizeRenderText(text)];
  }

  const grouped: string[] = [];
  for (let i = 0; i < wrappedLines.length; i += MAX_TRANSLATION_ONLY_LINES) {
    grouped.push(combineRenderTexts(wrappedLines.slice(i, i + MAX_TRANSLATION_ONLY_LINES)));
  }

  return grouped.filter(Boolean);
}

function isShortTranslationOnlyText(text: string): boolean {
  const normalized = normalizeRenderText(text);
  if (!normalized || SYMBOL_START_PATTERN.test(normalized)) {
    return false;
  }

  const length = textLength(normalized);
  return isCjkText(normalized)
    ? length <= 8
    : length <= 3;
}

function shouldAttachShortTextToPrevious(previousText: string, currentText: string): boolean {
  const previous = normalizeRenderText(previousText);
  const current = normalizeRenderText(currentText);

  if (!previous || !current) {
    return false;
  }

  return /[，、,]$/.test(previous)
    || (
      !STRONG_SENTENCE_END_PATTERN.test(previous)
      && STRONG_SENTENCE_END_PATTERN.test(current)
    );
}

function rebalanceShortTextParts(parts: string[], limit: number): string[] {
  const result: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const current = normalizeRenderText(parts[i]);
    if (!current) {
      continue;
    }

    if (!isShortTranslationOnlyText(current)) {
      result.push(current);
      continue;
    }

    const previous = result.at(-1);
    const next = parts[i + 1] ? normalizeRenderText(parts[i + 1]) : '';

    if (
      previous
      && (!next || shouldAttachShortTextToPrevious(previous, current))
    ) {
      result[result.length - 1] = combineRenderTexts([previous, current]);
      continue;
    }

    if (next) {
      const combined = combineRenderTexts([current, next]);
      result.push(combined);
      i++;
      continue;
    }

    if (previous) {
      result[result.length - 1] = combineRenderTexts([previous, current]);
      continue;
    }

    result.push(current);
  }

  return result.flatMap(part => {
    if (countWrappedLines(part, limit) <= MAX_TRANSLATION_ONLY_LINES) {
      return [part];
    }

    return groupTextByWrappedLines(part, limit);
  });
}

function distributeTranslationOnlyDuration(cue: SubtitleCue, parts: string[]): SubtitleCue[] {
  if (parts.length <= 1) {
    return [{ ...cue, text: normalizeRenderText(cue.text) }];
  }

  const totalWeight = parts.reduce((sum, part) => sum + Math.max(1, cueWeight(part)), 0);
  const totalDuration = cue.endTime - cue.startTime;
  let cursor = cue.startTime;

  return parts.map((part, index) => {
    const weight = Math.max(1, cueWeight(part));
    const duration = index === parts.length - 1
      ? cue.endTime - cursor
      : Math.max(900, Math.round((weight / totalWeight) * totalDuration));
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

function splitTranslationOnlyCueForDisplay(cue: SubtitleCue): SubtitleCue[] {
  const normalizedText = normalizeRenderText(cue.text);
  if (!normalizedText) {
    return [];
  }

  const limit = getPrimaryRenderLimit(normalizedText);
  const wrappedLines = balanceWrappedLines(splitForRender(normalizedText, limit), limit);
  const duration = cue.endTime - cue.startTime;

  if (
    wrappedLines.length <= MAX_TRANSLATION_ONLY_LINES
    && duration <= MAX_TRANSLATION_ONLY_DURATION_MS
  ) {
    return [{ ...cue, text: normalizedText }];
  }

  const sentenceParts = splitTranslationSentenceParts(normalizedText);
  const groupedParts: string[] = [];
  let current = '';

  for (const part of sentenceParts) {
    const candidate = current ? combineRenderTexts([current, part]) : part;
    if (
      current
      && countWrappedLines(candidate, limit) > MAX_TRANSLATION_ONLY_LINES
    ) {
      groupedParts.push(current);
      current = part;
      continue;
    }

    current = candidate;
  }

  if (current) {
    groupedParts.push(current);
  }

  let finalParts = groupedParts.filter(Boolean);
  if (finalParts.length <= 1) {
    finalParts = groupTextByWrappedLines(normalizedText, limit);
  }

  finalParts = finalParts.flatMap(part => {
    if (countWrappedLines(part, limit) <= MAX_TRANSLATION_ONLY_LINES) {
      return [part];
    }

    return groupTextByWrappedLines(part, limit);
  }).filter(Boolean);
  finalParts = rebalanceShortTextParts(finalParts, limit);

  if (finalParts.length <= 1) {
    return [{ ...cue, text: normalizedText }];
  }

  return distributeTranslationOnlyDuration(cue, finalParts);
}

function canRebalanceAdjacentDisplayCues(left: SubtitleCue, right: SubtitleCue): boolean {
  return right.startTime - left.endTime <= RENDER_COMPACT_MAX_GAP_MS;
}

function rebalanceShortTranslationOnlyDisplayCues(cues: SubtitleCue[]): SubtitleCue[] {
  const normalized = cues
    .map(cue => ({
      ...cue,
      text: normalizeRenderText(cue.text),
    }))
    .filter(cue => cue.text);

  const result: SubtitleCue[] = [];

  for (let i = 0; i < normalized.length; i++) {
    const current = normalized[i];

    if (!isShortTranslationOnlyText(current.text)) {
      result.push(current);
      continue;
    }

    const previous = result.at(-1);
    const next = normalized[i + 1];

    if (
      previous
      && canRebalanceAdjacentDisplayCues(previous, current)
      && (!next || shouldAttachShortTextToPrevious(previous.text, current.text))
    ) {
      result.pop();
      result.push(...splitTranslationOnlyCueForDisplay({
        startTime: previous.startTime,
        endTime: current.endTime,
        text: combineRenderTexts([previous.text, current.text]),
      }));
      continue;
    }

    if (next && canRebalanceAdjacentDisplayCues(current, next)) {
      result.push(...splitTranslationOnlyCueForDisplay({
        startTime: current.startTime,
        endTime: next.endTime,
        text: combineRenderTexts([current.text, next.text]),
      }));
      i++;
      continue;
    }

    if (previous && canRebalanceAdjacentDisplayCues(previous, current)) {
      result.pop();
      result.push(...splitTranslationOnlyCueForDisplay({
        startTime: previous.startTime,
        endTime: current.endTime,
        text: combineRenderTexts([previous.text, current.text]),
      }));
      continue;
    }

    result.push(current);
  }

  return result;
}

function enforceTranslationOnlyLineLimit(cues: SubtitleCue[]): SubtitleCue[] {
  return cues.flatMap(cue => {
    const text = normalizeRenderText(cue.text);
    if (!text) {
      return [];
    }

    const limit = getPrimaryRenderLimit(text);
    if (countWrappedLines(text, limit) <= MAX_TRANSLATION_ONLY_LINES) {
      return [{ ...cue, text }];
    }

    return splitTranslationOnlyCueForDisplay({ ...cue, text });
  });
}

function shouldKeepTranslationOnlyCueAsSingleEvent(cue: SubtitleCue): boolean {
  const normalizedText = normalizeRenderText(cue.text);
  if (!normalizedText) {
    return true;
  }

  const limit = getPrimaryRenderLimit(normalizedText);
  const wrappedLines = balanceWrappedLines(splitForRender(normalizedText, limit), limit);
  const duration = cue.endTime - cue.startTime;
  const lineOverflow = wrappedLines.length - MAX_TRANSLATION_ONLY_LINES;

  return duration <= 5600 && lineOverflow <= 1;
}

function applyRenderLineLimits(
  cue: SubtitleCue,
  format: SubtitleRenderFormat,
  outputText: { primary: string; secondary: string }
): SubtitleCue {
  const config = getConfig();
  const cjkLimit = config.subtitle.renderMaxCharsCjk;
  const wordLimit = config.subtitle.renderMaxWords;
  const primaryLimit = isCjkText(outputText.primary) ? cjkLimit : wordLimit;
  const secondaryLimit = isCjkText(outputText.secondary) ? cjkLimit : wordLimit;
  const primaryChunks = balanceWrappedLines(splitForRender(outputText.primary, primaryLimit), primaryLimit);
  const secondaryChunks = balanceWrappedLines(splitForRender(outputText.secondary, secondaryLimit), secondaryLimit);

  if (!outputText.secondary) {
    return {
      ...cue,
      text: primaryChunks.join('\n'),
    };
  }

  if (format === 'srv3') {
    return {
      ...cue,
      text: `${primaryChunks[0] ?? outputText.primary}\n${secondaryChunks[0] ?? outputText.secondary}`,
    };
  }

  if (format === 'json3') {
    return {
      ...cue,
      text: [
        ...primaryChunks,
        ...secondaryChunks,
      ].filter(Boolean).join('\n'),
    };
  }

  return {
    ...cue,
    text: [
      ...primaryChunks,
      ...secondaryChunks,
    ].filter(Boolean).join('\n'),
  };
}

function normalizeCueForFormat(cue: SubtitleCue, format: SubtitleRenderFormat): SubtitleCue {
  const [originalLine = '', ...translationLines] = cue.text.split(/\r?\n/);
  const translationLine = translationLines.join(' ').trim();
  const outputMode = getConfig().subtitle.outputMode;
  const outputText = selectOutputText(originalLine, translationLine, outputMode);

  return applyRenderLineLimits(cue, format, outputText);
}

function selectOutputText(
  originalLine: string,
  translationLine: string,
  outputMode: SubtitleOutputMode
): { primary: string; secondary: string } {
  if (outputMode === 'bilingual') {
    return {
      primary: originalLine.trim(),
      secondary: translationLine.trim(),
    };
  }

  if (outputMode === 'original-only') {
    return {
      primary: originalLine.trim(),
      secondary: '',
    };
  }

  return {
    primary: translationLine.trim() || originalLine.trim(),
    secondary: '',
  };
}

export function prepareCuesForRender(
  cues: SubtitleCue[],
  format: SubtitleRenderFormat
): SubtitleCue[] {
  const outputMode = getConfig().subtitle.outputMode;
  if (outputMode === 'translation-only') {
    const translationOnlyCues = cues
      .map(cue => {
        const [originalLine = '', ...translationLines] = cue.text.split(/\r?\n/);
        const translationLine = translationLines.join(' ').trim();
        const outputText = selectOutputText(originalLine, translationLine, outputMode);

        return {
          ...cue,
          text: outputText.primary,
        };
      })
      .filter(cue => cue.text.trim());

    const repairedCues = repairTranslationOnlyBoundaries(translationOnlyCues);
    const compactedCues = compactTranslationOnlyRenderCues(repairedCues);
    const displayCues = compactedCues.flatMap(cue => (
      shouldKeepTranslationOnlyCueAsSingleEvent(cue)
        ? [{ ...cue, text: normalizeRenderText(cue.text) }]
        : splitTranslationOnlyCueForDisplay(cue)
    ));
    const rebalancedDisplayCues = rebalanceShortTranslationOnlyDisplayCues(displayCues);
    const lineLimitedDisplayCues = enforceTranslationOnlyLineLimit(rebalancedDisplayCues);

    return lineLimitedDisplayCues.map(cue => applyRenderLineLimits(cue, format, {
        primary: cue.text,
        secondary: '',
      }));
  }

  return cues.map(cue => normalizeCueForFormat(cue, format));
}

/**
 * Render subtitle cues to WebVTT format
 */
export function renderWebVTT(cues: SubtitleCue[], options?: {
  kind?: string;
  language?: string;
}): string {
  const kind = options?.kind || 'captions';
  const language = options?.language || 'zh-CN';
  const preparedCues = prepareCuesForRender(cues, 'vtt');

  let vtt = 'WEBVTT\n';
  vtt += `Kind: ${kind}\n`;
  vtt += `Language: ${language}\n\n`;
  vtt += 'NOTE\n';
  vtt += 'Generated by YouTube Subtitle Proxy\n\n';

  for (let i = 0; i < preparedCues.length; i++) {
    const cue = preparedCues[i];

    // Cue identifier
    vtt += `${i + 1}\n`;

    // Timestamp
    const startTime = formatTimestamp(cue.startTime);
    const endTime = formatTimestamp(cue.endTime);
    vtt += `${startTime} --> ${endTime}\n`;

    // Text (escape special characters)
    const text = escapeWebVTT(cue.text);
    vtt += `${text}\n\n`;
  }

  return vtt;
}

/**
 * Render subtitle cues to YouTube timedtext JSON format
 */
export function renderYouTubeTimedText(cues: SubtitleCue[]): YouTubeTimedTextResponse {
  const preparedCues = prepareCuesForRender(cues, 'json3');
  const maxEndTimeMs = preparedCues.reduce((max, cue) => (
    Math.max(max, Math.floor(cue.endTime))
  ), 0);
  const windowDurationMs = Math.max(maxEndTimeMs, 60 * 60 * 1000);
  const initEvent = {
    tStartMs: 0,
    dDurationMs: windowDurationMs,
    id: 1,
    wpWinPosId: 1,
    wsWinStyleId: 1,
  };

  const events = preparedCues.map(cue => ({
    tStartMs: Math.floor(cue.startTime),
    dDurationMs: Math.floor(cue.endTime - cue.startTime),
    wWinId: 1,
    segs: [{ utf8: cue.text }],
  }));

  return {
    wireMagic: 'pb3',
    pens: [{}],
    wsWinStyles: [{}, { mhModeHint: 2, juJustifCode: 0, sdScrollDir: 3 }],
    wpWinPositions: [{}, { apPoint: 6, ahHorPos: 20, avVerPos: 100, rcRows: 2, ccCols: 40 }],
    events: [initEvent, ...events],
  };
}

/**
 * Render subtitle cues to YouTube timedtext SRV3 XML format
 */
export function renderYouTubeSrv3(
  cues: SubtitleCue[],
  options?: {
    overlapGapMs?: number;
  }
): string {
  const preparedCues = prepareCuesForRender(cues, 'srv3');
  let xml = '<?xml version="1.0" encoding="utf-8" ?>\n';
  xml += '<timedtext format="3">\n';
  xml += '  <head>\n';
  xml += '    <pen id="0" />\n';
  xml += '    <ws id="0" />\n';
  xml += '    <ws id="1" mh="2" ju="0" sd="3" />\n';
  xml += '    <wp id="0" />\n';
  xml += '    <wp id="1" ap="6" ah="20" av="100" rc="2" cc="40" />\n';
  xml += '  </head>\n';
  xml += '  <body>\n';
  xml += '    <w t="0" id="1" wp="1" ws="1"/>\n';

  const overlapGapMs = Math.max(0, options?.overlapGapMs ?? 100);
  for (let i = 0; i < preparedCues.length; i++) {
    const cue = preparedCues[i];
    const nextCue = preparedCues[i + 1];
    const start = Math.floor(cue.startTime);
    let duration = Math.max(0, Math.floor(cue.endTime - cue.startTime));

    if (nextCue) {
      const nextStart = Math.floor(nextCue.startTime);
      const maxDuration = nextStart - overlapGapMs - start;
      if (Number.isFinite(maxDuration)) {
        duration = Math.min(duration, Math.max(0, maxDuration));
      }
    }

    const lines = cue.text.split(/\r?\n/);
    const primaryLine = lines[0] ?? '';
    const secondaryLine = lines.slice(1).join(' ').trim();
    const segments: string[] = [];

    if (primaryLine.trim()) {
      segments.push(`      <s t="0">${escapeXml(primaryLine)}</s>`);
    }

    if (secondaryLine) {
      segments.push('      <s t="0">&#x0A;</s>');
      segments.push(`      <s t="0">${escapeXml(secondaryLine)}</s>`);
    }

    const segmentXml = segments.join('\n');
    xml += `    <p t="${start}" d="${duration}" w="1">\n${segmentXml}\n    </p>\n`;
  }

  xml += '  </body>\n';
  xml += '</timedtext>';

  return xml;
}

/**
 * Format milliseconds to WebVTT timestamp
 */
function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor(ms % 1000);

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`;
}

/**
 * Pad number with leading zeros
 */
function pad(num: number, length: number): string {
  return num.toString().padStart(length, '0');
}

/**
 * Escape special characters for WebVTT
 */
function escapeWebVTT(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/-->/g, '--&gt;')
    .trim();
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .trim();
}

/**
 * Create bilingual subtitle cue
 */
export function createBilingualCue(
  startTime: number,
  endTime: number,
  originalText: string,
  translatedText: string
): SubtitleCue {
  return {
    startTime,
    endTime,
    text: `${originalText}\n${translatedText}`,
  };
}

/**
 * Merge original and translated cues
 */
export function mergeBilingualCues(
  originalCues: SubtitleCue[],
  translatedCues: SubtitleCue[]
): SubtitleCue[] {
  if (originalCues.length !== translatedCues.length) {
    throw new Error('Original and translated cues length mismatch');
  }

  const bilingualCues: SubtitleCue[] = [];

  for (let i = 0; i < originalCues.length; i++) {
    const original = originalCues[i];
    const translated = translatedCues[i];

    bilingualCues.push(
      createBilingualCue(
        original.startTime,
        original.endTime,
        original.text,
        translated.text
      )
    );
  }

  return bilingualCues;
}

export default {
  prepareCuesForRender,
  renderWebVTT,
  renderYouTubeTimedText,
  renderYouTubeSrv3,
  createBilingualCue,
  mergeBilingualCues,
};
