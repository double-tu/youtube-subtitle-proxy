/**
 * Translation Service (OpenAI GPT-4o)
 *
 * Translates subtitle segments using OpenAI API
 */
import OpenAI from 'openai';
import type { SubtitleCue } from '../types/subtitle.js';
import { getConfig } from '../config/env.js';

let openaiClient: OpenAI | null = null;

const languageNames: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  'ja': 'Japanese',
  'ko': 'Korean',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'ru': 'Russian',
};

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CHINESE_FRAGMENT_START_PATTERN = /^(?:的|了|着|过|并|但|而|或|及|将|把|被|在|对|给|从|向|为|与|且|则|也|又)/;
const CHINESE_FRAGMENT_END_PATTERN = /(?:的|了|着|过|而|并|及|将|把|被|在|对|给|从|向|为|与)$/;
const ELLIPSIS_PATTERN = /(?:\.\.\.|…|⋯)/;

/**
 * Get OpenAI client instance
 */
function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const config = getConfig();
    openaiClient = new OpenAI({
      apiKey: config.openai.apiKey,
      baseURL: config.openai.baseUrl,
      timeout: config.openai.timeout,
    });
  }
  return openaiClient;
}

function resolveTargetLanguage(targetLang: string): string {
  return languageNames[targetLang] || targetLang;
}

function buildTranslationPrompt(
  text: string,
  targetLanguage: string,
  summary?: string,
  glossary?: string
): string {
  const summarySection = summary
    ? `\nContext summary (original language, for reference only):\n${summary}\n`
    : '';
  const glossarySection = glossary
    ? `\nGlossary (JSON, source -> ${targetLanguage}):\n${glossary}\n`
    : '';

  return `Translate the following text to ${targetLanguage}. Use the context summary and glossary to keep terminology consistent if helpful, but do not include them in your output. Return only the translation without any explanation or additional text.
Rules:
- Do not omit, summarize, or replace content with ellipsis.
- Do not output "...", "…", or similar placeholders unless the source itself contains them.${summarySection}${glossarySection}
Text: ${text}`;
}

function buildStrictTranslationPrompt(
  text: string,
  targetLanguage: string
): string {
  return `Translate the following subtitle text to ${targetLanguage}.

Hard rules:
- Return only the translation.
- Do not omit any content.
- Do not summarize.
- Do not use ellipsis or placeholders such as "...", "…", or "⋯" unless the source itself contains them.
- Keep proper nouns intact when appropriate.

Text: ${text}`;
}

function buildSummaryPrompt(
  text: string,
  mode: 'full' | 'chunk' | 'final'
): string {
  const instruction = mode === 'final'
    ? 'Combine the following chunk summaries into a concise overall summary in the same language as the input summaries. Do not translate.'
    : mode === 'chunk'
      ? 'Summarize this transcript chunk in the same language as the input text. Do not translate.'
      : 'Summarize the following transcript in the same language as the input text. Do not translate.';

  return `${instruction} Focus on tone/register, speaker relationships, key topics, names, and terminology. Keep it concise (3-6 bullet points). Return only the summary.

Text:
${text}`;
}

function buildGlossaryPrompt(
  text: string,
  targetLanguage: string,
  mode: 'full' | 'chunk' | 'final'
): string {
  const instruction = mode === 'final'
    ? `Combine and deduplicate the following partial glossaries into a single JSON array. Use ${targetLanguage} for translations. Return only JSON.`
    : mode === 'chunk'
      ? `Extract a glossary of key terms and entities from this transcript chunk. Translate each term into ${targetLanguage}. Return only JSON.`
      : `Extract a glossary of key terms and entities from the following transcript. Translate each term into ${targetLanguage}. Return only JSON.`;

  return `${instruction}

Requirements:
- Return a JSON array only. If no terms, return [].
- Each item: {"source": "<original term>", "target": "<${targetLanguage} translation>", "note": "<optional context>"}.
- Keep source text exactly as it appears.

Text:
${text}`;
}

type ContextBatch = {
  preceding: Array<{ index: number; text: string }>;
  current: Array<{ index: number; text: string }>;
  following: Array<{ index: number; text: string }>;
};

function buildContextualTranslationPrompt(
  batch: ContextBatch,
  targetLanguage: string,
  summary?: string,
  glossary?: string
): string {
  const summarySection = summary
    ? `\n## Summary (Original Language)\n${summary}\n`
    : '\n## Summary (Original Language)\n(None)\n';
  const glossarySection = glossary
    ? `\n## Glossary (JSON)\n${glossary}\n`
    : '\n## Glossary (JSON)\n(None)\n';

  return `You are a senior subtitle translator. You must preserve meaning and tone while producing natural, fluent ${targetLanguage} subtitles.

# Task
Translate each line in the Current Subtitle Batch into ${targetLanguage}. Use the Summary, Glossary, and Context Stream only to understand local context and keep names, tone, and references consistent.

${summarySection}${glossarySection}
## Context Stream
- Preceding Context (Original):
${formatBatchLines(batch.preceding)}

- Following Context (Preview):
${formatBatchLines(batch.following)}

## Current Subtitle Batch
${formatBatchLines(batch.current)}

# Translation Rules
1. Translate each Current Subtitle Batch ID independently. The translation for an ID must correspond only to that ID's source text.
2. Do not omit, merge, move, reorder, summarize, or redistribute meaning across IDs.
3. Use preceding and following context only to resolve pronouns, implied subjects, and terminology.
4. If a source line is a sentence fragment, translate it as a natural subtitle fragment for that same ID; do not complete it with text from neighboring IDs.
5. Keep translation length close to the source line to avoid readability issues.
6. Use the Glossary to keep proper nouns and key terms consistent.
7. Do not use ellipsis or placeholder omissions such as "...", "…", or "⋯" unless the source line itself contains them.

# Output Requirements
Return only a JSON array with exactly ${batch.current.length} items.
Each item must be: {"id": <number>, "translation": "<text>"}
IDs must match the bracketed indices in Current Subtitle Batch.
The output array must be in the same order as Current Subtitle Batch.`;
}

function formatBatchLines(lines: Array<{ index: number; text: string }>): string {
  if (lines.length === 0) {
    return '(none)';
  }
  return lines
    .map(line => `[${line.index}] ${line.text}`)
    .join('\n');
}

function buildTranscriptText(cues: SubtitleCue[]): string {
  return cues
    .map(cue => cue.text.trim())
    .filter(Boolean)
    .join('\n');
}

function splitTranscriptText(text: string, maxChunkChars: number): string[] {
  if (text.length <= maxChunkChars) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChunkChars, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf('\n', end);
      if (lastBreak > start + Math.floor(maxChunkChars * 0.5)) {
        end = lastBreak;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    start = end;
  }

  return chunks;
}

function extractJsonArray(text: string): unknown {
  const trimmed = text.trim();
  const withoutFences = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '');
  const start = withoutFences.indexOf('[');
  const end = withoutFences.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON array found in translation response');
  }
  const jsonSlice = withoutFences.slice(start, end + 1);
  return JSON.parse(jsonSlice);
}

type ParsedTranslation = {
  id: number;
  translation: string;
};

type ParsedSourceRewrite = {
  id: number;
  restored: string;
};

function parseTranslationBatch(text: string, expectedCount: number): ParsedTranslation[] {
  const parsed = extractJsonArray(text);
  if (!Array.isArray(parsed)) {
    throw new Error('Translation response is not a JSON array');
  }
  if (parsed.length !== expectedCount) {
    throw new Error(`Translation response count mismatch: expected ${expectedCount}, got ${parsed.length}`);
  }

  const translations: ParsedTranslation[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      throw new Error('Translation response contains invalid item');
    }

    const rawId = (item as { id?: number | string }).id;
    const id = typeof rawId === 'number' ? rawId : Number(rawId);
    if (!Number.isInteger(id)) {
      throw new Error('Translation response item missing valid id');
    }

    const translation =
      (item as { translation?: string }).translation
      ?? (item as { translated_text?: string }).translated_text
      ?? (item as { text?: string }).text
      ?? (item as { initial_translation?: string }).initial_translation;

    if (typeof translation !== 'string' || !translation.trim()) {
      throw new Error(`Translation response item missing translation for id ${id}`);
    }

    translations.push({
      id,
      translation: translation.trim(),
    });
  }

  return translations;
}

function buildSourceRestorePrompt(
  batch: ContextBatch
): string {
  return `You are reconstructing noisy ASR subtitle fragments into cleaner source-language subtitle lines before translation.

# Task
Rewrite each line in Current Subtitle Batch into a more complete, natural source-language subtitle line.

## Context Stream
- Preceding Context (Original):
${formatBatchLines(batch.preceding)}

- Following Context (Preview):
${formatBatchLines(batch.following)}

## Current Subtitle Batch
${formatBatchLines(batch.current)}

# Rules
1. Preserve the original language. Do not translate.
2. Keep each ID aligned to the same moment in the transcript.
3. You may repair punctuation, casing, and sentence completeness.
4. You may move a few boundary words conceptually so the line reads naturally, but do not summarize or omit meaning.
5. Do not invent new facts or terminology.
6. Keep each restored line reasonably close in length to the original subtitle timing window.

# Output
Return only a JSON array with exactly ${batch.current.length} items.
Each item must be: {"id": <number>, "restored": "<text>"}`;
}

function parseSourceRestoreBatch(text: string, expectedCount: number): ParsedSourceRewrite[] {
  const parsed = extractJsonArray(text);
  if (!Array.isArray(parsed)) {
    throw new Error('Source restore response is not a JSON array');
  }
  if (parsed.length !== expectedCount) {
    throw new Error(`Source restore response count mismatch: expected ${expectedCount}, got ${parsed.length}`);
  }

  return parsed.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('Source restore response contains invalid item');
    }

    const rawId = (item as { id?: number | string }).id;
    const id = typeof rawId === 'number' ? rawId : Number(rawId);
    if (!Number.isInteger(id)) {
      throw new Error('Source restore response item missing valid id');
    }

    const restored =
      (item as { restored?: string }).restored
      ?? (item as { text?: string }).text
      ?? (item as { rewrite?: string }).rewrite;

    if (typeof restored !== 'string' || !restored.trim()) {
      throw new Error(`Source restore response item missing restored text for id ${id}`);
    }

    return {
      id,
      restored: restored.trim(),
    };
  });
}

async function requestSummary(
  client: OpenAI,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const config = getConfig();
  const response = await client.chat.completions.create({
    model: config.openai.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: maxTokens,
  });

  const summary = response.choices[0]?.message?.content?.trim();
  if (!summary) {
    throw new Error('Empty summary response from OpenAI');
  }

  return summary;
}

async function requestGlossary(
  client: OpenAI,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const config = getConfig();
  const response = await client.chat.completions.create({
    model: config.openai.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: maxTokens,
  });

  const glossary = response.choices[0]?.message?.content?.trim();
  if (!glossary) {
    throw new Error('Empty glossary response from OpenAI');
  }

  return glossary;
}

async function summarizeTranscriptText(
  client: OpenAI,
  transcriptText: string,
  maxTokens: number,
  chunkChars: number
): Promise<string | null> {
  const chunks = splitTranscriptText(transcriptText, chunkChars);

  try {
    if (chunks.length === 1) {
      return await requestSummary(
        client,
        buildSummaryPrompt(chunks[0], 'full'),
        maxTokens
      );
    }

    const chunkSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkSummary = await requestSummary(
        client,
        buildSummaryPrompt(chunks[i], 'chunk'),
        maxTokens
      );
      chunkSummaries.push(chunkSummary);
    }

    return await requestSummary(
      client,
      buildSummaryPrompt(chunkSummaries.join('\n'), 'final'),
      maxTokens
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Translator] Summary generation failed, proceeding without summary: ${message}`);
    return null;
  }
}

async function extractGlossaryText(
  client: OpenAI,
  transcriptText: string,
  targetLanguage: string,
  maxTokens: number,
  chunkChars: number
): Promise<string | null> {
  const chunks = splitTranscriptText(transcriptText, chunkChars);

  try {
    if (chunks.length === 1) {
      return await requestGlossary(
        client,
        buildGlossaryPrompt(chunks[0], targetLanguage, 'full'),
        maxTokens
      );
    }

    const chunkGlossaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkGlossary = await requestGlossary(
        client,
        buildGlossaryPrompt(chunks[i], targetLanguage, 'chunk'),
        maxTokens
      );
      chunkGlossaries.push(chunkGlossary);
    }

    return await requestGlossary(
      client,
      buildGlossaryPrompt(chunkGlossaries.join('\n'), targetLanguage, 'final'),
      maxTokens
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Translator] Glossary extraction failed, proceeding without glossary: ${message}`);
    return null;
  }
}

type TranslationGuidance = {
  summary: string | null;
  glossary: string | null;
};

type TranslationRange = {
  start: number;
  end: number;
  label: string;
};

function estimateDynamicBatchChars(maxTokens: number): number {
  return Math.max(240, Math.min(2400, Math.floor(maxTokens * 1.8)));
}

function buildDynamicTranslationRanges(
  cues: SubtitleCue[],
  maxBatchItems: number,
  maxBatchChars: number
): TranslationRange[] {
  if (cues.length === 0) {
    return [];
  }

  const ranges: TranslationRange[] = [];
  let start = 0;
  let currentItems = 0;
  let currentChars = 0;

  for (let index = 0; index < cues.length; index++) {
    const cueChars = Math.max(1, cues[index].text.trim().length);
    const exceedsItems = currentItems >= maxBatchItems;
    const exceedsChars = currentItems > 0 && (currentChars + cueChars) > maxBatchChars;

    if (exceedsItems || exceedsChars) {
      ranges.push({
        start,
        end: index,
        label: '',
      });
      start = index;
      currentItems = 0;
      currentChars = 0;
    }

    currentItems++;
    currentChars += cueChars;
  }

  ranges.push({
    start,
    end: cues.length,
    label: '',
  });

  return ranges.map((range, index) => ({
    ...range,
    label: `${index + 1}/${ranges.length}`,
  }));
}

export function debugBuildDynamicTranslationRanges(
  cues: SubtitleCue[],
  maxBatchItems: number,
  maxBatchChars: number
): Array<{ start: number; end: number; label: string }> {
  return buildDynamicTranslationRanges(cues, maxBatchItems, maxBatchChars);
}

function visibleLength(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function isPunctuationOnly(text: string): boolean {
  return /^[\p{P}\p{S}\s]+$/u.test(text.trim());
}

function hasCjk(text: string): boolean {
  return CJK_PATTERN.test(text);
}

function isSuspiciousContextTranslation(sourceText: string, translation: string): boolean {
  const sourceLength = visibleLength(sourceText);
  const translationLength = visibleLength(translation);
  const trimmedTranslation = translation.trim();
  const sourceHasEllipsis = ELLIPSIS_PATTERN.test(sourceText);

  if (!trimmedTranslation || isPunctuationOnly(trimmedTranslation)) {
    return true;
  }

  if (!sourceHasEllipsis && ELLIPSIS_PATTERN.test(trimmedTranslation)) {
    return true;
  }

  if (sourceLength >= 12 && translationLength <= 2) {
    return true;
  }

  if (sourceLength >= 18 && translationLength <= 4) {
    return true;
  }

  if (sourceLength >= 28 && translationLength <= 6) {
    return true;
  }

  if (sourceLength >= 40 && translationLength <= 8) {
    return true;
  }

  if (hasCjk(trimmedTranslation)) {
    if (translationLength <= 8 && CHINESE_FRAGMENT_START_PATTERN.test(trimmedTranslation)) {
      return true;
    }

    if (sourceLength >= 14 && translationLength <= 10 && CHINESE_FRAGMENT_END_PATTERN.test(trimmedTranslation)) {
      return true;
    }
  }

  return false;
}

function isSuspiciousSingleTranslation(sourceText: string, translation: string): boolean {
  const trimmedTranslation = translation.trim();
  const sourceHasEllipsis = ELLIPSIS_PATTERN.test(sourceText);

  if (!trimmedTranslation || isPunctuationOnly(trimmedTranslation)) {
    return true;
  }

  if (!sourceHasEllipsis && ELLIPSIS_PATTERN.test(trimmedTranslation)) {
    return true;
  }

  return false;
}

async function buildTranslationGuidance(
  cues: SubtitleCue[],
  targetLang: string
): Promise<TranslationGuidance> {
  const config = getConfig();
  const summaryEnabled = config.translationSummary.enabled;
  const glossaryEnabled = config.translationGlossary.enabled;

  if (!summaryEnabled && !glossaryEnabled) {
    return { summary: null, glossary: null };
  }

  const transcriptText = buildTranscriptText(cues);
  if (!transcriptText) {
    return { summary: null, glossary: null };
  }

  const client = getOpenAIClient();
  const targetLanguage = resolveTargetLanguage(targetLang);

  const summaryPromise = summaryEnabled
    ? summarizeTranscriptText(
        client,
        transcriptText,
        config.translationSummary.maxTokens,
        config.translationSummary.chunkChars
      )
    : Promise.resolve(null);

  const glossaryPromise = glossaryEnabled
    ? extractGlossaryText(
        client,
        transcriptText,
        targetLanguage,
        config.translationGlossary.maxTokens,
        config.translationGlossary.chunkChars
      )
    : Promise.resolve(null);

  const [summary, glossary] = await Promise.all([summaryPromise, glossaryPromise]);

  if (summary) {
    console.log(`[Translator] Summary generated:\n${summary}`);
  }
  if (glossary) {
    console.log(`[Translator] Glossary generated (${glossary.length} chars)`);
  }

  return { summary, glossary };
}

export async function restoreSourceCues(
  cues: SubtitleCue[]
): Promise<SubtitleCue[]> {
  const config = getConfig();
  if (!config.translationSourceRestore.enabled || cues.length === 0) {
    return cues;
  }

  const client = getOpenAIClient();
  const batchSize = Math.max(1, Math.min(config.translationContext.batchSize, 12));
  const precedingLines = Math.max(0, Math.min(config.translationContext.precedingContextLines, 2));
  const followingLines = Math.max(0, Math.min(config.translationContext.followingContextLines, 2));
  const ranges = buildDynamicTranslationRanges(cues, batchSize, Math.max(600, Math.floor(config.translationContext.maxTokens * 1.5)));
  const restoredTexts: Array<string | null> = new Array(cues.length).fill(null);

  for (const range of ranges) {
    const batch = buildContextBatch(cues, range.start, range.end, precedingLines, followingLines);
    const prompt = buildSourceRestorePrompt(batch);

    try {
      const response = await client.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: Math.max(300, Math.min(1200, config.translationContext.maxTokens)),
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('Empty source restore response from OpenAI');
      }

      const parsed = parseSourceRestoreBatch(content, batch.current.length);
      for (const item of parsed) {
        restoredTexts[item.id] = item.restored;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Translator] Source restore failed for range ${range.label}, keeping original text: ${message}`);
      for (let index = range.start; index < range.end; index++) {
        restoredTexts[index] = cues[index].text;
      }
    }
  }

  return cues.map((cue, index) => ({
    ...cue,
    text: restoredTexts[index] ?? cue.text,
  }));
}

function buildContextBatch(
  cues: SubtitleCue[],
  startIndex: number,
  endIndex: number,
  precedingLines: number,
  followingLines: number
): ContextBatch {
  const precedingStart = Math.max(0, startIndex - precedingLines);
  const preceding = cues.slice(precedingStart, startIndex).map((cue, offset) => ({
    index: precedingStart + offset,
    text: cue.text,
  }));

  const current = cues.slice(startIndex, endIndex).map((cue, offset) => ({
    index: startIndex + offset,
    text: cue.text,
  }));

  const followingEnd = Math.min(cues.length, endIndex + followingLines);
  const following = cues.slice(endIndex, followingEnd).map((cue, offset) => ({
    index: endIndex + offset,
    text: cue.text,
  }));

  return { preceding, current, following };
}

export async function translateBatchWithContext(
  cues: SubtitleCue[],
  targetLang: string = 'zh-CN'
): Promise<SubtitleCue[]> {
  const config = getConfig();
  const targetLanguage = resolveTargetLanguage(targetLang);
  const client = getOpenAIClient();
  const { summary, glossary } = await buildTranslationGuidance(cues, targetLang);

  const batchSize = Math.max(1, config.translationContext.batchSize);
  const precedingLines = Math.max(0, config.translationContext.precedingContextLines);
  const followingLines = Math.max(0, config.translationContext.followingContextLines);
  const maxTokens = config.translationContext.maxTokens;
  const dynamicBatchChars = estimateDynamicBatchChars(maxTokens);
  const ranges = buildDynamicTranslationRanges(cues, batchSize, dynamicBatchChars);
  const totalBatches = Math.max(1, ranges.length);
  const batchConcurrency = Math.max(
    1,
    Math.min(config.translationContext.concurrency, totalBatches)
  );
  const batchRetries = Math.max(0, config.translationContext.batchRetries);
  const overallStart = Date.now();

  const translatedTexts: Array<string | null> = new Array(cues.length).fill(null);

  console.log(
    `[Translator] Context-aware translation started: ${cues.length} segments, batches=${totalBatches}, maxBatchItems=${batchSize}, dynamicBatchChars=${dynamicBatchChars}, concurrency=${batchConcurrency}, retries=${batchRetries}, preceding=${precedingLines}, following=${followingLines}`
  );

  try {
    let nextRangeIndex = 0;

    const fallbackSingleLineByIndex = async (
      index: number,
      reason: string
    ) => {
      const cue = cues[index];
      try {
        const translation = await translateText(cue.text, targetLang);
        translatedTexts[index] = translation;
        console.log(
          `[Translator] Single-line fallback completed for segment ${index}: ${reason}`
        );
      } catch (error) {
        console.error(
          `[Translator] Single-line fallback failed for segment ${index}:`,
          error
        );
        translatedTexts[index] = cue.text;
      }
    };

    const fallbackSingleLine = async (
      range: TranslationRange,
      reason: string
    ) => {
      await fallbackSingleLineByIndex(range.start, reason);
    };

    const runBatch = async (range: TranslationRange) => {
      const { start, end, label } = range;
      if (end - start <= 1) {
        await fallbackSingleLine(range, 'single-line range');
        return;
      }

      console.log(
        `[Translator] Context batch ${label} started: segments ${start}-${end - 1}`
      );

      for (let attempt = 0; attempt <= batchRetries; attempt++) {
        const batchStart = Date.now();

        try {
          const batch = buildContextBatch(
            cues,
            start,
            end,
            precedingLines,
            followingLines
          );

          const prompt = buildContextualTranslationPrompt(
            batch,
            targetLanguage,
            summary || undefined,
            glossary || undefined
          );

          const response = await client.chat.completions.create({
            model: config.openai.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: maxTokens,
          });

          const content = response.choices[0]?.message?.content?.trim();
          if (!content) {
            throw new Error('Empty translation response from OpenAI');
          }

          const parsed = parseTranslationBatch(content, batch.current.length);

          const expectedIds = new Set(batch.current.map(item => item.index));
          for (const item of parsed) {
            if (!expectedIds.has(item.id)) {
              throw new Error(`Unexpected translation id ${item.id} in batch ${start}-${end - 1}`);
            }
            translatedTexts[item.id] = item.translation;
          }

          for (const id of expectedIds) {
            if (!translatedTexts[id]) {
              throw new Error(`Missing translation for id ${id} in batch ${start}-${end - 1}`);
            }
          }

          const suspiciousIds = batch.current
            .filter(item => isSuspiciousContextTranslation(
              item.text,
              translatedTexts[item.index] ?? ''
            ))
            .map(item => item.index);

          if (suspiciousIds.length > 0) {
            console.warn(
              `[Translator] Context batch ${label} has suspicious translations for segments ${suspiciousIds.join(', ')}; falling back per-line`
            );
            await Promise.all(suspiciousIds.map(id => fallbackSingleLineByIndex(
              id,
              `suspicious context translation in batch ${label}`
            )));
          }

          console.log(
            `[Translator] Context batch ${label} completed in ${Date.now() - batchStart}ms (attempt ${attempt + 1}/${batchRetries + 1})`
          );
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[Translator] Context batch ${label} failed in ${Date.now() - batchStart}ms (attempt ${attempt + 1}/${batchRetries + 1}): ${message}`
          );

          if (attempt >= batchRetries) {
            if (end - start <= 1) {
              await fallbackSingleLine(range, message);
              return;
            }

            const midpoint = start + Math.ceil((end - start) / 2);
            console.warn(
              `[Translator] Splitting failed batch ${label} into ${start}-${midpoint - 1} and ${midpoint}-${end - 1}`
            );
            await runBatch({
              start,
              end: midpoint,
              label: `${label}a`,
            });
            await runBatch({
              start: midpoint,
              end,
              label: `${label}b`,
            });
            return;
          }
        }
      }
    };

    const workers = Array.from({ length: batchConcurrency }, async () => {
      while (true) {
        const rangeIndex = nextRangeIndex++;
        if (rangeIndex >= ranges.length) {
          break;
        }
        await runBatch(ranges[rangeIndex]);
      }
    });

    await Promise.all(workers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[Translator] Context-aware translation failed after ${Date.now() - overallStart}ms: ${message}`
    );
    throw error;
  }

  console.log(
    `[Translator] Context-aware translation completed in ${Date.now() - overallStart}ms`
  );

  return cues.map((cue, index) => ({
    ...cue,
    text: translatedTexts[index] ?? cue.text,
  }));
}

/**
 * Translate a single text segment
 */
export async function translateText(
  text: string,
  targetLang: string = 'zh-CN',
  summary?: string,
  glossary?: string
): Promise<string> {
  const client = getOpenAIClient();
  const config = getConfig();

  const targetLanguage = resolveTargetLanguage(targetLang);
  const prompt = buildTranslationPrompt(text, targetLanguage, summary, glossary);
  const maxTokens = Math.max(120, Math.min(240, Math.ceil(text.trim().length * 2)));

  try {
    const response = await client.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: maxTokens,
    });

    const translation = response.choices[0]?.message?.content?.trim();

    if (!translation) {
      throw new Error('Empty translation response from OpenAI');
    }

    if (isSuspiciousSingleTranslation(text, translation)) {
      const retryResponse = await client.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: 'user', content: buildStrictTranslationPrompt(text, targetLanguage) }],
        temperature: 0.1,
        max_tokens: maxTokens,
      });

      const retriedTranslation = retryResponse.choices[0]?.message?.content?.trim();
      if (!retriedTranslation) {
        throw new Error('Empty strict translation response from OpenAI');
      }

      if (isSuspiciousSingleTranslation(text, retriedTranslation)) {
        throw new Error('Suspicious translation persisted after strict retry');
      }

      return retriedTranslation;
    }

    return translation;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Translation failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Translate multiple segments with concurrency control
 */
export async function translateBatch(
  cues: SubtitleCue[],
  targetLang: string = 'zh-CN',
  concurrency: number = 2
): Promise<SubtitleCue[]> {
  const results: SubtitleCue[] = [];
  const config = getConfig();
  const actualConcurrency = Math.min(concurrency, config.queue.concurrency);
  const { summary, glossary } = await buildTranslationGuidance(cues, targetLang);

  if (summary) {
    console.log(`[Translator] Using summary context (${summary.length} chars)`);
  }
  if (glossary) {
    console.log(`[Translator] Using glossary context (${glossary.length} chars)`);
  }

  console.log(`[Translator] Starting translation: ${cues.length} segments, concurrency=${actualConcurrency}`);

  for (let i = 0; i < cues.length; i += actualConcurrency) {
    const batch = cues.slice(i, i + actualConcurrency);

    const promises = batch.map(async (cue) => {
      try {
        const translation = await translateText(
          cue.text,
          targetLang,
          summary || undefined,
          glossary || undefined
        );
        return {
          ...cue,
          text: translation,
        };
      } catch (error) {
        console.error(`[Translator] Failed to translate segment ${i}:`, error);
        // Return original text on error
        return cue;
      }
    });

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);

    // Progress logging
    const progress = Math.min(i + actualConcurrency, cues.length);
    const percentage = ((progress / cues.length) * 100).toFixed(1);
    console.log(`[Translator] Progress: ${progress}/${cues.length} (${percentage}%)`);

    // Small delay between batches to avoid rate limiting
    if (i + actualConcurrency < cues.length) {
      await sleep(200);
    }
  }

  console.log(`[Translator] Translation completed: ${results.length} segments`);
  return results;
}

/**
 * Translate segments and merge with original (bilingual)
 */
export async function translateToBilingual(
  originalCues: SubtitleCue[],
  targetLang: string = 'zh-CN',
  concurrency: number = 2
): Promise<SubtitleCue[]> {
  const config = getConfig();
  const sourceCues = config.translationSourceRestore.enabled
    ? await restoreSourceCues(originalCues)
    : originalCues;
  let translatedCues: SubtitleCue[];

  if (config.translationContext.enabled) {
    try {
      translatedCues = await translateBatchWithContext(sourceCues, targetLang);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Translator] Context-aware translation failed, falling back to per-line translation: ${message}`);
      translatedCues = await translateBatch(sourceCues, targetLang, concurrency);
    }
  } else {
    translatedCues = await translateBatch(sourceCues, targetLang, concurrency);
  }

  const bilingualCues: SubtitleCue[] = [];

  for (let i = 0; i < originalCues.length; i++) {
    const original = originalCues[i];
    const translated = translatedCues[i];

    bilingualCues.push({
      startTime: original.startTime,
      endTime: original.endTime,
      text: `${original.text}\n${translated.text}`,
    });
  }

  return bilingualCues;
}

/**
 * Estimate translation cost
 */
export function estimateTranslationCost(
  text: string,
  model: string = 'gpt-4o'
): number {
  // Rough token estimation (1 token ≈ 4 characters for English)
  const inputTokens = Math.ceil(text.length / 4);
  const outputTokens = inputTokens; // Assume similar length for translation

  // Pricing (as of 2024)
  const pricing: Record<string, { input: number; output: number }> = {
    'gpt-4o': { input: 2.5, output: 10 }, // per 1M tokens (USD)
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  };

  const modelPricing = pricing[model] || pricing['gpt-4o'];

  const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
  const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

  return inputCost + outputCost;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  translateText,
  translateBatch,
  translateBatchWithContext,
  translateToBilingual,
  estimateTranslationCost,
};
