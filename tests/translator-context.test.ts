import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: mockCreate } };
  }
  return { default: OpenAI };
});

const baseEnv = { ...process.env };
const requiredEnv = {
  OPENAI_API_KEY: 'test-key',
  QUEUE_CONCURRENCY: '2',
};

let activeEnvKeys: string[] = [];

function applyEnv(overrides: Record<string, string>) {
  const env = { ...requiredEnv, ...overrides };
  activeEnvKeys = Object.keys(env);
  for (const key of activeEnvKeys) {
    process.env[key] = env[key];
  }
}

function restoreEnv() {
  for (const key of activeEnvKeys) {
    if (baseEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = baseEnv[key];
    }
  }
  activeEnvKeys = [];
}

async function loadTranslator(overrides: Record<string, string>) {
  applyEnv(overrides);
  vi.resetModules();
  return await import('../src/services/translator.js');
}

beforeEach(() => {
  mockCreate.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

describe('translator context batching', () => {
  it('uses preceding context for later batches', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '[{"id":0,"translation":"这是第零句的正常翻译结果"},{"id":1,"translation":"这是第一句的正常翻译结果"}]',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '[{"id":2,"translation":"这是第二句的正常翻译结果"},{"id":3,"translation":"这是第三句的正常翻译结果"}]',
            },
          },
        ],
      });

    const { translateToBilingual } = await loadTranslator({
      TRANSLATION_CONTEXT_ENABLED: 'true',
      TRANSLATION_CONTEXT_BATCH_SIZE: '2',
      TRANSLATION_CONTEXT_PRECEDING_LINES: '1',
      TRANSLATION_CONTEXT_FOLLOWING_LINES: '1',
      TRANSLATION_CONTEXT_CONCURRENCY: '1',
      TRANSLATION_SUMMARY_ENABLED: 'false',
      TRANSLATION_GLOSSARY_ENABLED: 'false',
    });

    const cues = [
      { startTime: 0, endTime: 1000, text: 'Hello world, this is the first longer source line for context translation.' },
      { startTime: 1000, endTime: 2000, text: 'This is a test, and this is the second longer source line for batching.' },
      { startTime: 2000, endTime: 3000, text: 'Final line, but still long enough to avoid suspicious short-translation fallback.' },
      { startTime: 3000, endTime: 4000, text: 'Wrap it up with one more longer sentence so the fallback heuristic stays quiet.' },
    ];

    const results = await translateToBilingual(cues, 'zh-CN', 2);

    expect(results.map(cue => cue.text)).toEqual([
      `${cues[0].text}\n这是第零句的正常翻译结果`,
      `${cues[1].text}\n这是第一句的正常翻译结果`,
      `${cues[2].text}\n这是第二句的正常翻译结果`,
      `${cues[3].text}\n这是第三句的正常翻译结果`,
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(2);

    const secondPrompt = mockCreate.mock.calls[1][0].messages[0].content as string;
    expect(secondPrompt).toContain('Preceding Context (Original)');
    expect(secondPrompt).toContain('[3] Wrap it up with one more longer sentence');
    expect(secondPrompt).toContain('[2] Final line, but still long enough');
    expect(secondPrompt).toContain('must correspond only to that ID');
    expect(secondPrompt).toContain('Do not omit, merge, move, reorder, summarize, or redistribute');
  });

  it('falls back per-line for suspiciously short context translations', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '[{"id":0,"translation":"。"},{"id":1,"translation":"正常翻译"}]',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ choices: [{ message: { content: '单行回退翻译' } }] });

    const { translateToBilingual } = await loadTranslator({
      TRANSLATION_CONTEXT_ENABLED: 'true',
      TRANSLATION_CONTEXT_BATCH_SIZE: '2',
      TRANSLATION_CONTEXT_PRECEDING_LINES: '0',
      TRANSLATION_CONTEXT_FOLLOWING_LINES: '0',
      TRANSLATION_CONTEXT_CONCURRENCY: '1',
      TRANSLATION_CONTEXT_BATCH_RETRIES: '0',
      TRANSLATION_SUMMARY_ENABLED: 'false',
      TRANSLATION_GLOSSARY_ENABLED: 'false',
    });

    const cues = [
      {
        startTime: 0,
        endTime: 1000,
        text: 'This source line is long enough that punctuation-only output is suspicious.',
      },
      { startTime: 1000, endTime: 2000, text: 'Second source line.' },
    ];

    const results = await translateToBilingual(cues, 'zh-CN', 2);

    expect(results.map(cue => cue.text)).toEqual([
      `${cues[0].text}\n单行回退翻译`,
      'Second source line.\n正常翻译',
    ]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('retries failed batches, splits them, then falls back to per-line translation', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '[{"id":0,"translation":"T0"},{"id":1,"translation":"T1"}]',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '[{"id":2,"translation":"T2"}]',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '[{"id":2,"translation":"T2"}]',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'FB2' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'FB3' } }] });

    const { translateToBilingual } = await loadTranslator({
      TRANSLATION_CONTEXT_ENABLED: 'true',
      TRANSLATION_CONTEXT_BATCH_SIZE: '2',
      TRANSLATION_CONTEXT_PRECEDING_LINES: '0',
      TRANSLATION_CONTEXT_FOLLOWING_LINES: '0',
      TRANSLATION_CONTEXT_CONCURRENCY: '1',
      TRANSLATION_CONTEXT_BATCH_RETRIES: '1',
      TRANSLATION_SUMMARY_ENABLED: 'false',
      TRANSLATION_GLOSSARY_ENABLED: 'false',
    });

    const cues = [
      { startTime: 0, endTime: 1000, text: 'First.' },
      { startTime: 1000, endTime: 2000, text: 'Second.' },
      { startTime: 2000, endTime: 3000, text: 'Third.' },
      { startTime: 3000, endTime: 4000, text: 'Fourth.' },
    ];

    const results = await translateToBilingual(cues, 'zh-CN', 2);

    expect(results.map(cue => cue.text)).toEqual([
      'First.\nT0',
      'Second.\nT1',
      'Third.\nFB2',
      'Fourth.\nFB3',
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(5);
  });

  it('builds smaller dynamic context batches for long source lines', async () => {
    const { debugBuildDynamicTranslationRanges } = await loadTranslator({
      TRANSLATION_CONTEXT_ENABLED: 'true',
      TRANSLATION_CONTEXT_BATCH_SIZE: '24',
      TRANSLATION_CONTEXT_MAX_TOKENS: '160',
      TRANSLATION_SUMMARY_ENABLED: 'false',
      TRANSLATION_GLOSSARY_ENABLED: 'false',
    });

    const cues = [
      {
        startTime: 0,
        endTime: 1000,
        text: 'This is a deliberately long source subtitle line that should force the dynamic batch builder to stop early.',
      },
      {
        startTime: 1000,
        endTime: 2000,
        text: 'This is another deliberately long source subtitle line that should remain in the same first batch only if budget allows.',
      },
      {
        startTime: 2000,
        endTime: 3000,
        text: 'This third line should be pushed into the next batch once the character budget is exhausted.',
      },
    ];

    const ranges = debugBuildDynamicTranslationRanges(cues, 24, 288);

    expect(ranges).toEqual([
      { start: 0, end: 2, label: '1/2' },
      { start: 2, end: 3, label: '2/2' },
    ]);
  });
});
