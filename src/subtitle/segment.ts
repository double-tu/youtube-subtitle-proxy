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
  }
): SubtitleCue[] {
  if (cues.length === 0) {
    return [];
  }

  const config = getConfig();
  const minDuration = options?.minDurationMs || config.subtitle.minDurationMs;
  const maxDuration = options?.maxDurationMs || config.subtitle.maxDurationMs;
  const gapThreshold = options?.gapThresholdMs || config.subtitle.segmentGapMs;

  const merged: SubtitleCue[] = [];
  let currentGroup: string[] = [];
  let groupStartTime: number | null = null;
  let groupEndTime: number | null = null;
  let lastEndTime: number | null = null;

  for (const cue of cues) {
    if (groupStartTime === null) {
      // Start new paragraph
      groupStartTime = cue.startTime;
      groupEndTime = cue.endTime;
      currentGroup.push(cue.text);
      lastEndTime = cue.endTime;
    } else {
      const currentDuration = cue.endTime - groupStartTime;
      const gap = cue.startTime - lastEndTime!;
      const endsWithPunctuation = shouldBreakOnPunctuation(currentGroup[currentGroup.length - 1]);

      // Check if we should start a new paragraph
      if (
        currentDuration > maxDuration ||
        gap > gapThreshold ||
        (endsWithPunctuation && currentDuration >= minDuration)
      ) {
        // Save current paragraph
        if (groupEndTime! - groupStartTime >= minDuration) {
          merged.push({
            startTime: groupStartTime,
            endTime: groupEndTime!,
            text: currentGroup.join(' ').trim(),
          });
        }

        // Start new paragraph
        groupStartTime = cue.startTime;
        groupEndTime = cue.endTime;
        currentGroup = [cue.text];
        lastEndTime = cue.endTime;
      } else {
        // Continue current paragraph
        groupEndTime = cue.endTime;
        currentGroup.push(cue.text);
        lastEndTime = cue.endTime;
      }
    }
  }

  // Save last paragraph
  if (currentGroup.length > 0 && groupStartTime !== null && groupEndTime !== null) {
    if (groupEndTime - groupStartTime >= minDuration) {
      merged.push({
        startTime: groupStartTime,
        endTime: groupEndTime,
        text: currentGroup.join(' ').trim(),
      });
    } else {
      // If last segment is too short, try to merge with previous
      if (merged.length > 0) {
        const lastMerged = merged[merged.length - 1];
        lastMerged.endTime = groupEndTime;
        lastMerged.text += ' ' + currentGroup.join(' ').trim();
      } else {
        // No previous segment, keep it anyway
        merged.push({
          startTime: groupStartTime,
          endTime: groupEndTime,
          text: currentGroup.join(' ').trim(),
        });
      }
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
