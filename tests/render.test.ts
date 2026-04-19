import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../src/config/env.js';
import { parseYouTubeSrv3 } from '../src/subtitle/parse.js';
import {
  prepareCuesForRender,
  renderYouTubeSrv3,
  renderYouTubeTimedText,
} from '../src/subtitle/render.js';
import type { SubtitleCue } from '../src/types/subtitle.js';

const baseEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...baseEnv };
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
});

afterEach(() => {
  process.env = { ...baseEnv };
  resetConfigForTests();
});

describe('renderYouTubeSrv3', () => {
  it('clamps duration to avoid overlap with next cue', () => {
    process.env.SUBTITLE_OUTPUT_MODE = 'bilingual';
    const cues: SubtitleCue[] = [
      { startTime: 0, endTime: 5000, text: 'First line\n第一行' },
      { startTime: 3000, endTime: 8000, text: 'Second line\n第二行' },
    ];

    const xml = renderYouTubeSrv3(cues, { overlapGapMs: 100 });
    const parsed = parseYouTubeSrv3(xml);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].endTime).toBe(2900);
    expect(parsed[0].endTime).toBeLessThanOrEqual(parsed[1].startTime);
  });
});

describe('renderYouTubeTimedText', () => {
  it('prepends a window init event for json3 playback', () => {
    process.env.SUBTITLE_OUTPUT_MODE = 'bilingual';
    const cues: SubtitleCue[] = [
      { startTime: 1200, endTime: 3200, text: 'Hello\n你好' },
      { startTime: 4000, endTime: 6200, text: 'World\n世界' },
    ];

    const timedText = renderYouTubeTimedText(cues);

    expect(timedText.events).toHaveLength(cues.length + 1);
    const initEvent = timedText.events[0];
    expect(initEvent.tStartMs).toBe(0);
    expect(initEvent.id).toBe(1);
    expect(initEvent.wpWinPosId).toBe(1);
    expect(initEvent.wsWinStyleId).toBe(1);
    expect(initEvent.dDurationMs).toBeGreaterThanOrEqual(6200);
    expect(timedText.events[1].wWinId).toBe(1);
  });
});

describe('prepareCuesForRender', () => {
  it('keeps srv3 cues to two stable lines', () => {
    process.env.SUBTITLE_OUTPUT_MODE = 'bilingual';
    const cues: SubtitleCue[] = [
      {
        startTime: 0,
        endTime: 4000,
        text: 'This is a long original subtitle line that should be normalized for srv3 output\n这是一条很长的译文字幕，需要在 srv3 输出时保持稳定',
      },
    ];

    const prepared = prepareCuesForRender(cues, 'srv3');

    expect(prepared[0].text.split('\n')).toHaveLength(2);
  });

  it('allows json3 cues to preserve controlled multiline output', () => {
    process.env.SUBTITLE_OUTPUT_MODE = 'bilingual';
    const cues: SubtitleCue[] = [
      {
        startTime: 0,
        endTime: 4000,
        text: 'This is a long original subtitle line that should be normalized for json3 output with extra words for multiline rendering\n这是一条很长的译文字幕，需要在 json3 输出时进行受控换行，并且这里补充更多内容来确保产生多行',
      },
    ];

    const prepared = prepareCuesForRender(cues, 'json3');

    expect(prepared[0].text.split('\n').length).toBeGreaterThan(2);
  });

  it('defaults to translation-only output when not configured', () => {
    delete process.env.SUBTITLE_OUTPUT_MODE;
    resetConfigForTests();
    const cues: SubtitleCue[] = [
      {
        startTime: 0,
        endTime: 3000,
        text: 'Original subtitle line\n译文字幕',
      },
    ];

    const prepared = prepareCuesForRender(cues, 'srv3');

    expect(prepared[0].text).toBe('译文字幕');
  });

  it('compacts tiny translation-only cues before json3 rendering', () => {
    delete process.env.SUBTITLE_OUTPUT_MODE;
    process.env.SUBTITLE_RENDER_MAX_CHARS_CJK = '20';
    resetConfigForTests();
    const cues: SubtitleCue[] = [
      { startTime: 0, endTime: 500, text: 'First\n这' },
      { startTime: 500, endTime: 900, text: 'Second\n是一个' },
      { startTime: 900, endTime: 1400, text: 'Third\n测试' },
      { startTime: 1400, endTime: 2300, text: 'Fourth\n字幕' },
    ];

    const prepared = prepareCuesForRender(cues, 'json3');

    expect(prepared).toHaveLength(1);
    expect(prepared[0].text).toBe('这是一个测试字幕');
    expect(prepared[0].startTime).toBe(0);
    expect(prepared[0].endTime).toBe(2300);
  });

  it('splits CJK render lines at natural boundaries when possible', () => {
    delete process.env.SUBTITLE_OUTPUT_MODE;
    process.env.SUBTITLE_RENDER_MAX_CHARS_CJK = '20';
    resetConfigForTests();
    const cues: SubtitleCue[] = [
      {
        startTime: 0,
        endTime: 3000,
        text: 'Original\n交易策略所遵循的顺序。所以请务必点赞并收藏视频',
      },
    ];

    const prepared = prepareCuesForRender(cues, 'json3');

    expect(prepared[0].text).toBe('交易策略所遵循的顺序。\n所以请务必点赞并收藏视频');
  });

  it('does not split embedded English tokens across CJK render lines', () => {
    delete process.env.SUBTITLE_OUTPUT_MODE;
    process.env.SUBTITLE_RENDER_MAX_CHARS_CJK = '20';
    resetConfigForTests();
    const cues: SubtitleCue[] = [
      {
        startTime: 0,
        endTime: 5000,
        text: 'Original\n这个速成班分享给我的前夫 Mike Bagholder，没错，他真的非常需要。',
      },
    ];

    const prepared = prepareCuesForRender(cues, 'json3');

    expect(prepared[0].text.includes('Mike Ba\ngholder')).toBe(false);
  });

  it('moves dangling translation tails into the next cue when possible', () => {
    delete process.env.SUBTITLE_OUTPUT_MODE;
    process.env.SUBTITLE_RENDER_MAX_CHARS_CJK = '20';
    resetConfigForTests();
    const cues: SubtitleCue[] = [
      {
        startTime: 0,
        endTime: 5000,
        text: 'Original 1\n请记得把这个速成班分享给需要的人。就我而言，我会把',
      },
      {
        startTime: 5000,
        endTime: 8000,
        text: 'Original 2\n它分享给我的朋友。',
      },
    ];

    const prepared = prepareCuesForRender(cues, 'json3');

    expect(prepared.length).toBe(2);
    expect(prepared[0].text).toContain('请记得把这个速成班分享给需要的人。');
    expect(prepared[0].text.endsWith('我会把')).toBe(false);
    expect(prepared[1].text.includes('我会把')).toBe(true);
  });

  it('splits long translation-only cues into shorter readable cues before rendering', () => {
    delete process.env.SUBTITLE_OUTPUT_MODE;
    process.env.SUBTITLE_RENDER_MAX_CHARS_CJK = '20';
    resetConfigForTests();
    const cues: SubtitleCue[] = [
      {
        startTime: 0,
        endTime: 9000,
        text: 'Original\n这是第一句。这是第二句，现在继续讲第三句。',
      },
    ];

    const prepared = prepareCuesForRender(cues, 'json3');

    expect(prepared).toHaveLength(1);
    expect(prepared[0].text.split('\n').length).toBeGreaterThan(1);
    expect(prepared[0].startTime).toBe(0);
    expect(prepared[0].endTime).toBe(9000);
  });

  it('preserves translation-only opening text when splitting for two-line display', () => {
    delete process.env.SUBTITLE_OUTPUT_MODE;
    process.env.SUBTITLE_RENDER_MAX_CHARS_CJK = '20';
    resetConfigForTests();
    const cues: SubtitleCue[] = [
      {
        startTime: 0,
        endTime: 5324,
        text: "Original\n交易员们大家好，如果你是新来的，我叫 Shea，也就是 Humble Trader",
      },
    ];

    const prepared = prepareCuesForRender(cues, 'json3');
    const combinedText = prepared.map(cue => cue.text).join('');

    expect(prepared[0].startTime).toBe(0);
    expect(prepared.at(-1)?.endTime).toBe(5324);
    expect(prepared.every(cue => cue.text.split('\n').length <= 2)).toBe(true);
    expect(combinedText).toContain('交易员们大家好');
    expect(combinedText).toContain('Humble Trader');
  });
});
