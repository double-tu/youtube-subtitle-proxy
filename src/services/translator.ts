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
  summary?: string
): string {
  const summarySection = summary
    ? `\nContext summary (for reference only):\n${summary}\n`
    : '';

  return `Translate the following text to ${targetLanguage}. Use the context summary to keep terminology consistent if helpful, but do not include it in your output. Return only the translation without any explanation or additional text.${summarySection}
Text: ${text}`;
}

function buildSummaryPrompt(
  text: string,
  targetLanguage: string,
  mode: 'full' | 'chunk' | 'final'
): string {
  const instruction = mode === 'final'
    ? `Combine the following chunk summaries into a concise overall summary in ${targetLanguage}.`
    : mode === 'chunk'
      ? `Summarize this transcript chunk in ${targetLanguage}.`
      : `Summarize the following transcript in ${targetLanguage}.`;

  return `${instruction} Focus on tone/register, speaker relationships, key topics, names, and terminology. Keep it concise (3-6 bullet points). Return only the summary.

Text:
${text}`;
}

type ContextBatch = {
  preceding: Array<{ index: number; original: string; translation: string | null }>;
  current: Array<{ index: number; text: string }>;
  following: Array<{ index: number; text: string }>;
};

function buildContextualTranslationPrompt(
  batch: ContextBatch,
  targetLanguage: string,
  summary?: string
): string {
  const summarySection = summary
    ? `\n## Context Guide\n${summary}\n`
    : '\n## Context Guide\n(None)\n';

  return `You are a senior subtitle translator. You must preserve meaning and tone while producing natural, fluent ${targetLanguage} subtitles.

# Task
Translate the Current Subtitle Batch into ${targetLanguage}. Use the Context Guide and Context Stream to keep names, tone, and references consistent.

${summarySection}
## Context Stream
- Preceding Context (Translated):
${formatContextLines(batch.preceding)}

- Following Context (Preview):
${formatBatchLines(batch.following)}

## Current Subtitle Batch
${formatBatchLines(batch.current)}

# Translation Rules
1. Semantic fusion: join fragmented lines into complete sentences in your head, then split back to the original line IDs.
2. Use context to resolve pronouns and implied subjects.
3. Keep translation length close to the original to avoid readability issues.

# Output Requirements
Return only a JSON array with exactly ${batch.current.length} items.
Each item must be: {"id": <number>, "translation": "<text>"}
IDs must match the bracketed indices in Current Subtitle Batch.`;
}

function formatContextLines(lines: Array<{ index: number; original: string; translation: string | null }>): string {
  if (lines.length === 0) {
    return '(none)';
  }
  return lines
    .map(line => `[${line.index}] ${line.original}\n    -> ${line.translation ?? '(untranslated)'}`)
    .join('\n');
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

async function summarizeTranscript(
  cues: SubtitleCue[],
  targetLang: string
): Promise<string | null> {
  const config = getConfig();
  if (!config.translationSummary.enabled) {
    return null;
  }

  const transcriptText = buildTranscriptText(cues);
  if (!transcriptText) {
    return null;
  }

  const client = getOpenAIClient();
  const targetLanguage = resolveTargetLanguage(targetLang);
  const maxTokens = config.translationSummary.maxTokens;
  const chunks = splitTranscriptText(transcriptText, config.translationSummary.chunkChars);

  try {
    if (chunks.length === 1) {
      const summary = await requestSummary(
        client,
        buildSummaryPrompt(chunks[0], targetLanguage, 'full'),
        maxTokens
      );
      console.log(`[Translator] Summary generated:\n${summary}`);
      return summary;
    }

    const chunkSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkSummary = await requestSummary(
        client,
        buildSummaryPrompt(chunks[i], targetLanguage, 'chunk'),
        maxTokens
      );
      chunkSummaries.push(chunkSummary);
    }

    const summary = await requestSummary(
      client,
      buildSummaryPrompt(chunkSummaries.join('\n'), targetLanguage, 'final'),
      maxTokens
    );
    console.log(`[Translator] Summary generated:\n${summary}`);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Translator] Summary generation failed, proceeding without summary: ${message}`);
    return null;
  }
}

function buildContextBatch(
  cues: SubtitleCue[],
  translations: Array<string | null>,
  startIndex: number,
  endIndex: number,
  precedingLines: number,
  followingLines: number
): ContextBatch {
  const precedingStart = Math.max(0, startIndex - precedingLines);
  const preceding = cues.slice(precedingStart, startIndex).map((cue, offset) => ({
    index: precedingStart + offset,
    original: cue.text,
    translation: translations[precedingStart + offset] ?? null,
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
  const client = getOpenAIClient();
  const targetLanguage = resolveTargetLanguage(targetLang);
  const summary = await summarizeTranscript(cues, targetLang);

  const batchSize = Math.max(1, config.translationContext.batchSize);
  const precedingLines = Math.max(0, config.translationContext.precedingContextLines);
  const followingLines = Math.max(0, config.translationContext.followingContextLines);
  const maxTokens = config.translationContext.maxTokens;

  const translatedTexts: Array<string | null> = new Array(cues.length).fill(null);

  for (let start = 0; start < cues.length; start += batchSize) {
    const end = Math.min(start + batchSize, cues.length);
    const batch = buildContextBatch(
      cues,
      translatedTexts,
      start,
      end,
      precedingLines,
      followingLines
    );

    const prompt = buildContextualTranslationPrompt(batch, targetLanguage, summary || undefined);

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
  }

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
  summary?: string
): Promise<string> {
  const client = getOpenAIClient();
  const config = getConfig();

  const targetLanguage = resolveTargetLanguage(targetLang);
  const prompt = buildTranslationPrompt(text, targetLanguage, summary);

  try {
    const response = await client.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    });

    const translation = response.choices[0]?.message?.content?.trim();

    if (!translation) {
      throw new Error('Empty translation response from OpenAI');
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
  const summary = await summarizeTranscript(cues, targetLang);

  if (summary) {
    console.log(`[Translator] Using summary context (${summary.length} chars)`);
  }

  console.log(`[Translator] Starting translation: ${cues.length} segments, concurrency=${actualConcurrency}`);

  for (let i = 0; i < cues.length; i += actualConcurrency) {
    const batch = cues.slice(i, i + actualConcurrency);

    const promises = batch.map(async (cue) => {
      try {
        const translation = await translateText(cue.text, targetLang, summary || undefined);
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
  let translatedCues: SubtitleCue[];

  if (config.translationContext.enabled) {
    try {
      translatedCues = await translateBatchWithContext(originalCues, targetLang);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Translator] Context-aware translation failed, falling back to per-line translation: ${message}`);
      translatedCues = await translateBatch(originalCues, targetLang, concurrency);
    }
  } else {
    translatedCues = await translateBatch(originalCues, targetLang, concurrency);
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
