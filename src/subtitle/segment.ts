/**
 * Subtitle Segmentation Module
 *
 * Merges word-level subtitles into paragraph-level segments (3-7 seconds)
 */
import type { SubtitleCue } from '../types/subtitle.js';
import { getConfig } from '../config/env.js';

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
  splitLongParagraphs,
  optimizeSubtitleTiming,
  deduplicateCues,
};
