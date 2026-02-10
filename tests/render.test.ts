import { describe, expect, it } from 'vitest';
import { parseYouTubeSrv3 } from '../src/subtitle/parse.js';
import { renderYouTubeSrv3, renderYouTubeTimedText } from '../src/subtitle/render.js';
import type { SubtitleCue } from '../src/types/subtitle.js';

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
