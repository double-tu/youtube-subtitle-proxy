/**
 * Subtitle Parsing Module
 *
 * Parses YouTube timedtext JSON format
 */
import type { YouTubeTimedTextEvent, YouTubeTimedTextResponse, SubtitleCue } from '../types/subtitle.js';
import { buildScrollingAsrTimeline, type SubtitleAtom } from './timeline.js';

const SENTENCE_END_PATTERN = /[,.;!?，。！？；…]$/;
const MAX_SCROLLING_ASR_CJK_CHARS = 34;
const MAX_SCROLLING_ASR_WORDS = 20;
const MAX_SCROLLING_ASR_CJK_OVERFLOW = 8;
const MAX_SCROLLING_ASR_WORD_OVERFLOW = 5;
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const WHITESPACE_PATTERN = /\s+/g;
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

function getMaxScrollingAsrOverflow(text: string): number {
  return isCjkText(text) ? MAX_SCROLLING_ASR_CJK_OVERFLOW : MAX_SCROLLING_ASR_WORD_OVERFLOW;
}

function getLastWord(text: string): string {
  const match = normalizeText(text).match(/[A-Za-z][A-Za-z'-]*$/);
  return match ? match[0].toLowerCase() : '';
}

function hasUnsafeTrailingBoundary(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  if (isCjkText(normalized)) {
    return /(?:和|与|或|而|并|从|向|给|把|被|对|在|为|将|让|跟|比|及)$/.test(normalized);
  }

  const lastWord = getLastWord(normalized);
  return UNSAFE_TRAILING_WORDS.has(lastWord) || /-$/.test(lastWord);
}

function shouldSplitScrollingCue(text: string, reachedSentenceEnd: boolean): boolean {
  if (reachedSentenceEnd) {
    return true;
  }

  const length = getTextLength(text);
  const maxLength = getMaxScrollingAsrLength(text);
  if (length < maxLength) {
    return false;
  }

  if (!hasUnsafeTrailingBoundary(text)) {
    return true;
  }

  return length >= maxLength + getMaxScrollingAsrOverflow(text);
}

function pushCue(cues: SubtitleCue[], cue: SubtitleCue): void {
  const previous = cues.at(-1);
  if (previous && previous.endTime > cue.startTime) {
    previous.endTime = cue.startTime;
  }

  cues.push(cue);
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

  return normalizeText(combined);
}

function flushAtomBuffer(
  cues: SubtitleCue[],
  atomBuffer: SubtitleAtom[]
): void {
  if (atomBuffer.length === 0) {
    return;
  }

  const text = combineAtomTexts(atomBuffer);
  if (!text) {
    atomBuffer.length = 0;
    return;
  }

  pushCue(cues, {
    startTime: atomBuffer[0].startTime,
    endTime: atomBuffer[atomBuffer.length - 1].endTime,
    text,
  });

  atomBuffer.length = 0;
}

function parseScrollingAsrTimedText(events: YouTubeTimedTextEvent[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const atoms = buildScrollingAsrTimeline(events);
  const atomBuffer: SubtitleAtom[] = [];

  for (const atom of atoms) {
    atomBuffer.push(atom);

    const mergedText = combineAtomTexts(atomBuffer);
    const reachedSentenceEnd = SENTENCE_END_PATTERN.test(atom.text.trim());
    if (shouldSplitScrollingCue(mergedText, reachedSentenceEnd)) {
      flushAtomBuffer(cues, atomBuffer);
    }
  }

  flushAtomBuffer(cues, atomBuffer);
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
