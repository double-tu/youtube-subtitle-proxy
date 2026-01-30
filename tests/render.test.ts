import { describe, expect, it } from 'vitest';
import { parseYouTubeSrv3 } from '../src/subtitle/parse.js';
import { renderYouTubeSrv3 } from '../src/subtitle/render.js';
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
