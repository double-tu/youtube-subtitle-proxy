import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});

describe('renderYouTubeSrv3', () => {
  it('clamps duration to avoid overlap with next cue', () => {
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
        text: 'This is a long original subtitle line that should be normalized for json3 output\n这是一条很长的译文字幕，需要在 json3 输出时进行受控换行',
      },
    ];

    const prepared = prepareCuesForRender(cues, 'json3');

    expect(prepared[0].text.split('\n').length).toBeGreaterThan(2);
  });

  it('defaults to translation-only output when not configured', () => {
    delete process.env.SUBTITLE_OUTPUT_MODE;
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
});
