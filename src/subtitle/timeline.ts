import type { SubtitleCue, YouTubeTimedTextEvent } from '../types/subtitle.js';

const ESTIMATED_ATOM_DURATION_MS = 220;
const MAX_ATOM_DURATION_MS = 1600;
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

export interface SubtitleAtom {
  text: string;
  startTime: number;
  endTime: number;
  eventIndex: number;
  segmentIndex: number;
}

type AtomSeed = {
  text: string;
  startTime: number;
  eventIndex: number;
  segmentIndex: number;
  eventEndHint: number;
};

function isAppendEvent(event: YouTubeTimedTextEvent): boolean {
  return event.aAppend === 1;
}

function isCjkText(text: string): boolean {
  return CJK_PATTERN.test(text);
}

function normalizeCombinedText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+([，。！？；：])/g, '$1')
    .trim();
}

function combineAtomTexts(atoms: SubtitleAtom[]): string {
  let combined = '';

  for (const atom of atoms) {
    if (
      combined
      && !isCjkText(combined)
      && !combined.endsWith(' ')
      && !atom.text.startsWith(' ')
    ) {
      combined += ' ';
    }

    combined += atom.text;
  }

  return normalizeCombinedText(combined);
}

function getEventEndHint(
  events: YouTubeTimedTextEvent[],
  eventIndex: number,
  event: YouTubeTimedTextEvent
): number {
  const eventDurationEnd = event.tStartMs + (event.dDurationMs || 0);

  for (let i = eventIndex + 1; i < events.length; i++) {
    const nextEvent = events[i];
    if (isAppendEvent(nextEvent)) {
      return nextEvent.tStartMs + (nextEvent.dDurationMs || 0);
    }

    if (nextEvent.segs && nextEvent.segs.length > 0) {
      return nextEvent.tStartMs;
    }
  }

  return eventDurationEnd || (event.tStartMs + ESTIMATED_ATOM_DURATION_MS);
}

function buildAtomSeeds(events: YouTubeTimedTextEvent[]): AtomSeed[] {
  const seeds: AtomSeed[] = [];

  events.forEach((event, eventIndex) => {
    if (isAppendEvent(event) || !event.segs || event.segs.length === 0) {
      return;
    }

    const eventEndHint = getEventEndHint(events, eventIndex, event);

    event.segs.forEach((segment, segmentIndex) => {
      const text = segment.utf8 || '';
      if (!text.trim()) {
        return;
      }

      seeds.push({
        text,
        startTime: event.tStartMs + (segment.tOffsetMs || 0),
        eventIndex,
        segmentIndex,
        eventEndHint,
      });
    });
  });

  return seeds.sort((left, right) => {
    if (left.startTime !== right.startTime) {
      return left.startTime - right.startTime;
    }

    if (left.eventIndex !== right.eventIndex) {
      return left.eventIndex - right.eventIndex;
    }

    return left.segmentIndex - right.segmentIndex;
  });
}

function resolveAtomEnd(seed: AtomSeed, nextSeed: AtomSeed | undefined): number {
  const nextStart = nextSeed?.startTime ?? seed.eventEndHint;
  const fallbackEnd = seed.startTime + ESTIMATED_ATOM_DURATION_MS;
  const isLastSeedInEvent = !nextSeed || nextSeed.eventIndex !== seed.eventIndex;
  const maxEnd = isLastSeedInEvent
    ? seed.eventEndHint
    : Math.min(nextStart, seed.startTime + MAX_ATOM_DURATION_MS);

  if (maxEnd > seed.startTime) {
    return Math.max(fallbackEnd, maxEnd);
  }

  return fallbackEnd;
}

export function buildScrollingAsrTimeline(events: YouTubeTimedTextEvent[]): SubtitleAtom[] {
  const seeds = buildAtomSeeds(events);

  return seeds.map((seed, index) => ({
    text: seed.text,
    startTime: seed.startTime,
    endTime: resolveAtomEnd(seed, seeds[index + 1]),
    eventIndex: seed.eventIndex,
    segmentIndex: seed.segmentIndex,
  })).filter(atom => atom.endTime > atom.startTime);
}

export function buildScrollingAsrRows(events: YouTubeTimedTextEvent[]): SubtitleCue[] {
  const atoms = buildScrollingAsrTimeline(events);
  if (atoms.length === 0) {
    return [];
  }

  const atomsByEventIndex = new Map<number, SubtitleAtom[]>();
  for (const atom of atoms) {
    const eventAtoms = atomsByEventIndex.get(atom.eventIndex);
    if (eventAtoms) {
      eventAtoms.push(atom);
    } else {
      atomsByEventIndex.set(atom.eventIndex, [atom]);
    }
  }

  const rows: SubtitleCue[] = [];

  events.forEach((event, eventIndex) => {
    if (isAppendEvent(event) || !event.segs || event.segs.length === 0) {
      return;
    }

    const eventAtoms = atomsByEventIndex.get(eventIndex) ?? [];
    const text = combineAtomTexts(eventAtoms);
    if (!text) {
      return;
    }

    const startTime = eventAtoms[0]?.startTime ?? event.tStartMs;
    const lastAtomEnd = eventAtoms.at(-1)?.endTime ?? startTime;
    const eventEnd = event.tStartMs + (event.dDurationMs || 0);
    const endTime = Math.max(lastAtomEnd, eventEnd || (startTime + ESTIMATED_ATOM_DURATION_MS));

    if (endTime <= startTime) {
      return;
    }

    rows.push({
      startTime,
      endTime,
      text,
    });
  });

  return rows;
}
