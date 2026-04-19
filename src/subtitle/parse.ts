/**
 * Subtitle Parsing Module
 *
 * Parses YouTube timedtext JSON format
 */
import type { YouTubeTimedTextEvent, YouTubeTimedTextResponse, SubtitleCue } from '../types/subtitle.js';

const SENTENCE_END_PATTERN = /[,.;!?，。！？；…]$/;
const ESTIMATED_SEG_DURATION_MS = 200;
const MAX_SCROLLING_ASR_CJK_CHARS = 30;
const MAX_SCROLLING_ASR_WORDS = 15;
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const WHITESPACE_PATTERN = /\s+/g;

function isScrollingAsrEventStream(events: YouTubeTimedTextEvent[]): boolean {
  return events.some(event => event.wWinId !== undefined && event.aAppend === 1);
}

function isCjkText(text: string): boolean {
  return CJK_PATTERN.test(text);
}

function normalizeText(text: string): string {
  return text
    .replace(WHITESPACE_PATTERN, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+([，。！？；：])/g, '$1')
    .trim();
}

function getTextLength(text: string): number {
  const normalized = normalizeText(text);
  if (!normalized) {
    return 0;
  }

  return isCjkText(normalized)
    ? normalized.length
    : normalized.split(/\s+/).filter(Boolean).length;
}

function getMaxScrollingAsrLength(text: string): number {
  return isCjkText(text) ? MAX_SCROLLING_ASR_CJK_CHARS : MAX_SCROLLING_ASR_WORDS;
}

function pushCue(cues: SubtitleCue[], cue: SubtitleCue): void {
  const previous = cues.at(-1);
  if (previous && previous.endTime > cue.startTime) {
    previous.endTime = cue.startTime;
  }

  cues.push(cue);
}

function flushScrollingCue(
  cues: SubtitleCue[],
  currentText: string,
  currentStart: number,
  currentEnd: number
): boolean {
  const text = normalizeText(currentText);
  if (!text) {
    return false;
  }

  pushCue(cues, {
    startTime: currentStart,
    endTime: currentEnd,
    text,
  });
  return true;
}

function parseScrollingAsrTimedText(events: YouTubeTimedTextEvent[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let currentText = '';
  let currentStart = 0;
  let currentEnd = 0;
  let isFirstSegment = true;
  let pendingSplit = false;

  for (const event of events) {
    if (event.aAppend === 1) {
      if (currentText) {
        currentEnd = event.tStartMs + (event.dDurationMs || 0);
        if (pendingSplit) {
          flushScrollingCue(cues, currentText, currentStart, currentEnd);
          currentText = '';
          currentEnd = 0;
          isFirstSegment = true;
          pendingSplit = false;
        }
      }
      continue;
    }

    if (!event.segs || event.segs.length === 0) {
      continue;
    }

    if (pendingSplit && currentText) {
      flushScrollingCue(cues, currentText, currentStart, currentEnd);
      currentText = '';
      currentEnd = 0;
      isFirstSegment = true;
      pendingSplit = false;
    }

    for (let i = 0; i < event.segs.length; i++) {
      const segment = event.segs[i];
      const text = segment.utf8 || '';
      const trimmed = text.trim();
      const segStart = event.tStartMs + (segment.tOffsetMs || 0);

      if (pendingSplit && currentText) {
        flushScrollingCue(cues, currentText, currentStart, currentEnd);
        currentText = '';
        currentEnd = 0;
        isFirstSegment = true;
        pendingSplit = false;
      }

      if (!trimmed) {
        continue;
      }

      if (isFirstSegment) {
        currentStart = segStart;
        isFirstSegment = false;
      }

      if (currentText && !isCjkText(currentText) && !currentText.endsWith(' ') && !text.startsWith(' ')) {
        currentText += ' ';
      }

      currentText += text;
      currentEnd = segStart + ESTIMATED_SEG_DURATION_MS;

      const mergedText = normalizeText(currentText);
      const reachedSentenceEnd = SENTENCE_END_PATTERN.test(trimmed);
      const reachedMaxLength = getTextLength(mergedText) >= getMaxScrollingAsrLength(mergedText);
      if (reachedSentenceEnd || reachedMaxLength) {
        pendingSplit = true;
      }
    }
  }

  flushScrollingCue(cues, currentText, currentStart, currentEnd);
  return cues;
}

function parseStandardTimedText(events: YouTubeTimedTextEvent[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];

  for (const event of events) {
    if (!event.segs || event.segs.length === 0) {
      continue;
    }

    const text = normalizeText(event.segs.map(seg => seg.utf8).join(''));
    if (!text) {
      continue;
    }

    cues.push({
      startTime: event.tStartMs,
      endTime: event.tStartMs + event.dDurationMs,
      text,
    });
  }

  return cues;
}

/**
 * Parse YouTube timedtext JSON to subtitle cues
 */
export function parseYouTubeTimedText(json: YouTubeTimedTextResponse): SubtitleCue[] {
  if (!json.events || !Array.isArray(json.events)) {
    throw new Error('Invalid timedtext JSON: missing events array');
  }

  return isScrollingAsrEventStream(json.events)
    ? parseScrollingAsrTimedText(json.events)
    : parseStandardTimedText(json.events);
}

/**
 * Parse YouTube timedtext SRV3 XML to subtitle cues
 */
export function parseYouTubeSrv3(xml: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const normalized = xml.replace(/\r\n/g, '\n');
  const paragraphRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;

  let match: RegExpExecArray | null;
  while ((match = paragraphRegex.exec(normalized)) !== null) {
    const attrs = match[1] || '';
    const body = match[2] || '';

    const startAttr = extractAttribute(attrs, 't');
    const durationAttr = extractAttribute(attrs, 'd');
    const startTime = startAttr ? parseInt(startAttr, 10) : NaN;
    const duration = durationAttr ? parseInt(durationAttr, 10) : NaN;

    if (!Number.isFinite(startTime) || !Number.isFinite(duration)) {
      continue;
    }

    const text = decodeXmlEntities(
      body
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim()
    );

    if (!text) {
      continue;
    }

    cues.push({
      startTime,
      endTime: startTime + duration,
      text,
    });
  }

  return cues;
}

function extractAttribute(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`, 'i').exec(attrs);
  return match ? match[1] : null;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x0a;/gi, '\n')
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * Parse WebVTT format to subtitle cues
 */
export function parseWebVTT(vtt: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];

  // Split by double newline to get cue blocks
  const blocks = vtt.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');

    // Skip header and notes
    if (lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE')) {
      continue;
    }

    // Find timestamp line
    let timestampLineIndex = 0;
    if (lines[0].match(/^\d+$/)) {
      timestampLineIndex = 1; // Has cue identifier
    }

    const timestampLine = lines[timestampLineIndex];
    if (!timestampLine || !timestampLine.includes('-->')) {
      continue;
    }

    // Parse timestamps
    const [startStr, endStr] = timestampLine.split('-->').map(s => s.trim());
    const startTime = parseTimestamp(startStr);
    const endTime = parseTimestamp(endStr);

    // Get text (everything after timestamp line)
    const text = lines.slice(timestampLineIndex + 1).join('\n').trim();

    if (text) {
      cues.push({ startTime, endTime, text });
    }
  }

  return cues;
}

/**
 * Parse WebVTT timestamp to milliseconds
 */
function parseTimestamp(timestamp: string): number {
  // Remove settings (e.g., "align:start position:0%")
  const timeStr = timestamp.split(/\s+/)[0];

  // Format: HH:MM:SS.mmm or MM:SS.mmm
  const parts = timeStr.split(':');
  let hours = 0, minutes = 0, seconds = 0;

  if (parts.length === 3) {
    hours = parseInt(parts[0]);
    minutes = parseInt(parts[1]);
    seconds = parseFloat(parts[2]);
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0]);
    seconds = parseFloat(parts[1]);
  } else {
    seconds = parseFloat(parts[0]);
  }

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * Validate subtitle cues
 */
export function validateCues(cues: SubtitleCue[]): boolean {
  if (!Array.isArray(cues) || cues.length === 0) {
    return false;
  }

  for (const cue of cues) {
    if (typeof cue.startTime !== 'number' ||
        typeof cue.endTime !== 'number' ||
        typeof cue.text !== 'string') {
      return false;
    }

    if (cue.startTime < 0 || cue.endTime < cue.startTime) {
      return false;
    }

    if (!cue.text.trim()) {
      return false;
    }
  }

  return true;
}

/**
 * Sort cues by start time
 */
export function sortCues(cues: SubtitleCue[]): SubtitleCue[] {
  return [...cues].sort((a, b) => a.startTime - b.startTime);
}

export default {
  parseYouTubeTimedText,
  parseYouTubeSrv3,
  parseWebVTT,
  validateCues,
  sortCues,
};
