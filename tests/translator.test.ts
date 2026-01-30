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

describe('translator summary context', () => {
  it('includes transcript summary and glossary in translation prompts', async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '- Summary line' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '[{"source":"ACME","target":"ACME","note":"brand"}]' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Translated one' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Translated two' } }] });

    const { translateBatch } = await loadTranslator({
      TRANSLATION_SUMMARY_ENABLED: 'true',
      TRANSLATION_SUMMARY_MAX_TOKENS: '120',
      TRANSLATION_SUMMARY_CHUNK_CHARS: '1000',
      TRANSLATION_GLOSSARY_ENABLED: 'true',
      TRANSLATION_GLOSSARY_MAX_TOKENS: '120',
      TRANSLATION_GLOSSARY_CHUNK_CHARS: '1000',
    });

    const cues = [
      { startTime: 0, endTime: 1000, text: 'Hello world.' },
      { startTime: 1000, endTime: 2000, text: 'This is a test.' },
    ];

    const results = await translateBatch(cues, 'zh-CN', 2);

    expect(results.map(cue => cue.text)).toEqual(['Translated one', 'Translated two']);
    expect(mockCreate).toHaveBeenCalledTimes(4);

    const summaryPrompt = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(summaryPrompt).toContain('same language');
    expect(summaryPrompt).toContain('Do not translate');

    const glossaryPrompt = mockCreate.mock.calls[1][0].messages[0].content as string;
    expect(glossaryPrompt.toLowerCase()).toContain('glossary');

    const translationPrompts = mockCreate.mock.calls.slice(2).map(call => {
      return call[0].messages[0].content as string;
    });

    for (const prompt of translationPrompts) {
      expect(prompt).toContain('Context summary');
      expect(prompt).toContain('- Summary line');
      expect(prompt).toContain('Glossary');
      expect(prompt).toContain('ACME');
    }
  });

  it('skips guidance generation when disabled', async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Translated one' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Translated two' } }] });

    const { translateBatch } = await loadTranslator({
      TRANSLATION_SUMMARY_ENABLED: 'false',
      TRANSLATION_GLOSSARY_ENABLED: 'false',
    });

    const cues = [
      { startTime: 0, endTime: 1000, text: 'Hello world.' },
      { startTime: 1000, endTime: 2000, text: 'This is a test.' },
    ];

    await translateBatch(cues, 'zh-CN', 2);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    for (const call of mockCreate.mock.calls) {
      const prompt = call[0].messages[0].content as string;
      expect(prompt).not.toContain('Context summary');
      expect(prompt).not.toContain('Glossary');
    }
  });

  it('falls back to translation when summary fails', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('summary failed'))
      .mockResolvedValueOnce({ choices: [{ message: { content: '[{"source":"ACME","target":"ACME"}]' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Translated one' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Translated two' } }] });

    const { translateBatch } = await loadTranslator({
      TRANSLATION_SUMMARY_ENABLED: 'true',
      TRANSLATION_SUMMARY_MAX_TOKENS: '120',
      TRANSLATION_SUMMARY_CHUNK_CHARS: '1000',
      TRANSLATION_GLOSSARY_ENABLED: 'true',
    });

    const cues = [
      { startTime: 0, endTime: 1000, text: 'Hello world.' },
      { startTime: 1000, endTime: 2000, text: 'This is a test.' },
    ];

    const results = await translateBatch(cues, 'zh-CN', 2);

    expect(results.map(cue => cue.text)).toEqual(['Translated one', 'Translated two']);
    expect(mockCreate).toHaveBeenCalledTimes(4);

    const translationPrompts = mockCreate.mock.calls.slice(2).map(call => {
      return call[0].messages[0].content as string;
    });

    for (const prompt of translationPrompts) {
      expect(prompt).not.toContain('Context summary');
      expect(prompt).toContain('Glossary');
    }
  });
});
