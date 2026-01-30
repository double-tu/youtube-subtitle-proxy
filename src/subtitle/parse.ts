/**
 * Subtitle Parsing Module
 *
 * Parses YouTube timedtext JSON format
 */
import type { YouTubeTimedTextResponse, SubtitleCue } from '../types/subtitle.js';

/**
 * Parse YouTube timedtext JSON to subtitle cues
 */
export function parseYouTubeTimedText(json: YouTubeTimedTextResponse): SubtitleCue[] {
  if (!json.events || !Array.isArray(json.events)) {
    throw new Error('Invalid timedtext JSON: missing events array');
  }

  const cues: SubtitleCue[] = [];

  for (const event of json.events) {
    // Skip events without segments
    if (!event.segs || event.segs.length === 0) {
      continue;
    }

    // Merge all segments into a single text
    const text = event.segs
      .map(seg => seg.utf8)
      .join('')
      .trim();

    // Skip empty text
    if (!text) {
      continue;
    }

    const cue: SubtitleCue = {
      startTime: event.tStartMs,
      endTime: event.tStartMs + event.dDurationMs,
      text: text,
    };

    cues.push(cue);
  }

  return cues;
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
