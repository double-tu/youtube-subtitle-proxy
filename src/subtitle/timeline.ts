import type { YouTubeTimedTextEvent } from '../types/subtitle.js';

const ESTIMATED_ATOM_DURATION_MS = 220;
const MAX_ATOM_DURATION_MS = 1600;

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
