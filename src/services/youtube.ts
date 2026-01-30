/**
 * YouTube Subtitle Service
 *
 * Fetches original subtitles from YouTube API
 */
import type { YouTubeTimedTextResponse, SubtitleRequest } from '../types/subtitle.js';
import { getConfig } from '../config/env.js';
import { parseWebVTT, parseYouTubeSrv3 } from '../subtitle/parse.js';
import { renderYouTubeTimedText } from '../subtitle/render.js';

export interface TimedTextFetchResult {
  rawText: string;
  contentType: string | null;
  parsed: YouTubeTimedTextResponse;
}

/**
 * Fetch subtitle from YouTube timedtext API
 */
export async function fetchYouTubeTimedText(
  params: SubtitleRequest
): Promise<TimedTextFetchResult> {
  const config = getConfig();

  // Use original_url if provided, otherwise construct
  let url: string;
  if (params.original_url) {
    url = params.original_url;
  } else {
    url = buildYouTubeTimedTextUrl(params);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      config.youtube.fetchTimeoutMs
    );

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`YouTube API returned ${response.status}: ${response.statusText}`);
    }

    const rawText = await response.text();
    const contentType = response.headers.get('content-type');
    const parsed = parseTimedTextResponse(rawText, contentType);

    if (!parsed.events || !Array.isArray(parsed.events)) {
      throw new Error('Invalid timedtext response: missing events array');
    }

    return { rawText, contentType, parsed };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error('YouTube API request timeout');
      }
      throw new Error(`Failed to fetch YouTube subtitle: ${error.message}`);
    }
    throw error;
  }
}

export async function fetchYouTubeSubtitle(
  params: SubtitleRequest
): Promise<YouTubeTimedTextResponse> {
  const result = await fetchYouTubeTimedText(params);
  return result.parsed;
}

function parseTimedTextResponse(
  rawText: string,
  contentType: string | null
): YouTubeTimedTextResponse {
  const trimmed = rawText.trim();
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  const isJsonContent = contentType?.includes('json');

  if (looksLikeJson || isJsonContent) {
    return JSON.parse(rawText) as YouTubeTimedTextResponse;
  }

  if (trimmed.startsWith('WEBVTT')) {
    const cues = parseWebVTT(rawText);
    return renderYouTubeTimedText(cues);
  }

  const cues = parseYouTubeSrv3(rawText);
  return renderYouTubeTimedText(cues);
}

/**
 * Build YouTube timedtext API URL
 */
function buildYouTubeTimedTextUrl(params: SubtitleRequest): string {
  const baseUrl = 'https://www.youtube.com/api/timedtext';
  const url = new URL(baseUrl);

  url.searchParams.set('v', params.v);
  url.searchParams.set('lang', params.lang);

  if (params.kind) {
    url.searchParams.set('kind', params.kind);
  }

  if (params.fmt) {
    url.searchParams.set('fmt', params.fmt);
  } else {
    url.searchParams.set('fmt', 'json3'); // Default to JSON format
  }

  return url.toString();
}

/**
 * Check if subtitle is available for video
 */
export async function checkSubtitleAvailability(
  videoId: string,
  lang: string
): Promise<boolean> {
  try {
    await fetchYouTubeSubtitle({
      v: videoId,
      lang: lang,
      fmt: 'json3',
    });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get available subtitle languages for video
 */
export async function getAvailableLanguages(videoId: string): Promise<string[]> {
  // Note: This would require accessing YouTube's video info API
  // For now, return common languages as fallback
  const commonLanguages = ['en', 'es', 'fr', 'de', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];

  const available: string[] = [];
  for (const lang of commonLanguages) {
    if (await checkSubtitleAvailability(videoId, lang)) {
      available.push(lang);
    }
  }

  return available;
}

/**
 * Generate cache key for subtitle request
 */
export function generateCacheKey(params: SubtitleRequest): string {
  const parts = [
    params.v,
    params.lang,
    params.tlang || 'zh-CN',
    params.kind || 'asr',
    params.fmt || 'json3',
  ];

  return parts.join('|');
}

/**
 * Generate source hash for subtitle content
 */
export function generateSourceHash(content: string): string {
  // Simple hash function (for production, use crypto.createHash)
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

export default {
  fetchYouTubeSubtitle,
  fetchYouTubeTimedText,
  checkSubtitleAvailability,
  getAvailableLanguages,
  generateCacheKey,
  generateSourceHash,
};
