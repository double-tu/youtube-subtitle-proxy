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
const RENDER_COMPACT_MAX_DURATION_MS = 4500;
const RENDER_DANGLING_MAX_DURATION_MS = 10000;

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
    const parts: string[] = [];
    let start = 0;
    while (start < trimmed.length) {
      parts.push(trimmed.slice(start, start + limit).trim());
      start += limit;
    }
    return parts.filter(Boolean);
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
    && currentLength >= bounds.min
    && currentDuration >= RENDER_COMPACT_MIN_DURATION_MS
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

  if (combinedLength > combinedMaxLength) {
    return false;
  }

  if (
    currentLength >= bounds.min
    && currentDuration >= RENDER_COMPACT_MIN_DURATION_MS
    && !currentDangling
    && !nextDangling
    && combinedDuration > combinedMaxDuration
  ) {
    return false;
  }

  if (combinedDuration > combinedMaxDuration) {
    return false;
  }

  return currentLength < bounds.min
    || currentDuration < RENDER_COMPACT_MIN_DURATION_MS
    || currentDangling
    || nextDangling;
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

  for (let i = result.length - 1; i > 0; i--) {
    const current = result[i];
    const previous = result[i - 1];
    const currentLength = textLength(current.text);
    const bounds = getRenderBounds(current.text);
    const merged = mergeRenderCuePair(previous, current);
    const mergedBounds = getRenderBounds(merged.text);

    if (
      (currentLength < bounds.min || isLikelyDanglingCueText(current.text))
      && current.startTime - previous.endTime <= RENDER_COMPACT_MAX_GAP_MS
      && !SYMBOL_START_PATTERN.test(current.text.trim())
      && textLength(merged.text) <= mergedBounds.max
      && merged.endTime - merged.startTime <= RENDER_DANGLING_MAX_DURATION_MS
    ) {
      result[i - 1] = merged;
      result.splice(i, 1);
    }
  }

  return result;
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
  const primaryChunks = splitForRender(outputText.primary, primaryLimit);
  const secondaryChunks = splitForRender(outputText.secondary, secondaryLimit);

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
    const selectedCues = cues
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

    return compactTranslationOnlyRenderCues(selectedCues)
      .map(cue => applyRenderLineLimits(cue, format, {
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
