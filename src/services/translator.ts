/**
 * Translation Service (OpenAI GPT-4o)
 *
 * Translates subtitle segments using OpenAI API
 */
import OpenAI from 'openai';
import type { SubtitleCue } from '../types/subtitle.js';
import { getConfig } from '../config/env.js';

let openaiClient: OpenAI | null = null;

/**
 * Get OpenAI client instance
 */
function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const config = getConfig();
    openaiClient = new OpenAI({
      apiKey: config.openai.apiKey,
      timeout: config.openai.timeout,
    });
  }
  return openaiClient;
}

/**
 * Translate a single text segment
 */
export async function translateText(
  text: string,
  targetLang: string = 'zh-CN'
): Promise<string> {
  const client = getOpenAIClient();
  const config = getConfig();

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

  const targetLanguage = languageNames[targetLang] || targetLang;

  const prompt = `Translate the following text to ${targetLanguage}. Return only the translation without any explanation or additional text.

Text: ${text}`;

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

  for (let i = 0; i < cues.length; i += actualConcurrency) {
    const batch = cues.slice(i, i + actualConcurrency);

    const promises = batch.map(async (cue) => {
      try {
        const translation = await translateText(cue.text, targetLang);
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

    // Small delay between batches to avoid rate limiting
    if (i + actualConcurrency < cues.length) {
      await sleep(200);
    }
  }

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
  const translatedCues = await translateBatch(originalCues, targetLang, concurrency);

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
  translateToBilingual,
  estimateTranslationCost,
};
