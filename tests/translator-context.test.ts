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
      });

    const { translateToBilingual } = await loadTranslator({
      TRANSLATION_CONTEXT_ENABLED: 'true',
      TRANSLATION_CONTEXT_BATCH_SIZE: '2',
      TRANSLATION_CONTEXT_PRECEDING_LINES: '1',
      TRANSLATION_CONTEXT_FOLLOWING_LINES: '1',
      TRANSLATION_SUMMARY_ENABLED: 'false',
      TRANSLATION_GLOSSARY_ENABLED: 'false',
    });

    const cues = [
      { startTime: 0, endTime: 1000, text: 'Hello world.' },
      { startTime: 1000, endTime: 2000, text: 'This is a test.' },
      { startTime: 2000, endTime: 3000, text: 'Final line.' },
    ];

    const results = await translateToBilingual(cues, 'zh-CN', 2);

    expect(results.map(cue => cue.text)).toEqual([
      'Hello world.\nT0',
      'This is a test.\nT1',
      'Final line.\nT2',
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(2);

    const secondPrompt = mockCreate.mock.calls[1][0].messages[0].content as string;
    expect(secondPrompt).toContain('Preceding Context (Original)');
    expect(secondPrompt).toContain('[1] This is a test.');
    expect(secondPrompt).toContain('[2] Final line.');
  });
});
