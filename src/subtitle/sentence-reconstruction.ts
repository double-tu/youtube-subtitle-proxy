import type { SubtitleCue } from '../types/subtitle.js';
import type { SubtitleAtom } from './timeline.js';

export type SemanticBounds = {
  min: number;
  preferred: number;
  max: number;
  overflow: number;
};

type ReconstructionUtils = {
  buildCueFromAtoms: (atoms: SubtitleAtom[]) => SubtitleCue | null;
  getTextStats: (text: string) => { isCjk: boolean; length: number };
  getSemanticBounds: (isCjk: boolean) => SemanticBounds;
  normalizeCueText: (text: string) => string;
  isLikelyDanglingText: (text: string) => boolean;
  startsWithClauseStarter: (text: string) => boolean;
  startsWithLikelyContinuation: (text: string) => boolean;
  startsWithWeakFragment: (text: string) => boolean;
  strongSentenceEndPattern: RegExp;
  softSentenceEndPattern: RegExp;
  splitSemanticCue: (cue: SubtitleCue) => SubtitleCue[];
};

const WEAK_TRAILING_WORD_PATTERN = /\b(?:a|an|and|are|as|at|be|because|but|by|do|does|for|from|he|her|him|his|i|if|in|into|is|it|its|of|on|or|our|over|she|so|that|the|their|them|there|these|they|this|those|to|we|were|what|when|where|which|who|will|with|would|you|your|day|levels|right|go)$/i;
const WEAK_LEADING_WORD_PATTERN = /^(?:a|an|and|are|as|at|be|because|being|bit|do|for|from|he|if|in|into|is|it|of|on|or|our|over|really|she|so|that|the|their|them|there|these|they|this|those|to|trading|understanding|way|we|when|where|which|who|you)\b/i;

function shouldFlushCoarseSemanticChunk(
  atomBuffer: SubtitleAtom[],
  nextAtom: SubtitleAtom | undefined,
  utils: ReconstructionUtils
): boolean {
  if (atomBuffer.length === 0) {
    return false;
  }

  const currentCue = utils.buildCueFromAtoms(atomBuffer);
  if (!currentCue) {
    return true;
  }

  if (!nextAtom) {
    return true;
  }

  const currentText = currentCue.text;
  const currentStats = utils.getTextStats(currentText);
  const bounds = utils.getSemanticBounds(currentStats.isCjk);
  const duration = currentCue.endTime - currentCue.startTime;
  const gap = nextAtom.startTime - atomBuffer[atomBuffer.length - 1].endTime;
  const nextText = utils.normalizeCueText(nextAtom.text);
  const strongBoundary = utils.strongSentenceEndPattern.test(currentText);
  const softBoundary = utils.softSentenceEndPattern.test(currentText);
  const unsafeTrailingBoundary = utils.isLikelyDanglingText(currentText);
  const nextLooksContinuous = utils.startsWithLikelyContinuation(nextText);
  const coarsePreferred = Math.max(bounds.preferred + 12, Math.floor(bounds.preferred * 1.5));
  const coarseMax = Math.max(bounds.max + 16, Math.floor(bounds.max * 1.5));

  if (gap > 1400) {
    return true;
  }

  if (duration >= 18000) {
    return true;
  }

  if (strongBoundary && duration >= 1800) {
    return true;
  }

  if (
    softBoundary
    && currentStats.length >= bounds.min
    && duration >= 1800
    && !unsafeTrailingBoundary
  ) {
    return true;
  }

  if (
    currentStats.length >= coarsePreferred
    && duration >= 2200
    && !unsafeTrailingBoundary
    && utils.startsWithClauseStarter(nextText)
  ) {
    return true;
  }

  if (
    gap >= 450
    && duration >= 1800
    && !unsafeTrailingBoundary
    && !nextLooksContinuous
  ) {
    return true;
  }

  if (
    currentStats.length >= coarsePreferred
    && !unsafeTrailingBoundary
    && !nextLooksContinuous
    && gap >= 450
  ) {
    return true;
  }

  if (
    currentStats.length >= coarseMax
    && duration >= 2600
    && !unsafeTrailingBoundary
    && gap >= 200
    && !nextLooksContinuous
  ) {
    return true;
  }

  return false;
}

function rebalanceRecoveredCues(
  cues: SubtitleCue[],
  utils: ReconstructionUtils
): SubtitleCue[] {
  if (cues.length <= 1) {
    return cues;
  }

  const result = cues
    .map(cue => ({
      ...cue,
      text: utils.normalizeCueText(cue.text),
    }))
    .filter(cue => cue.text);

  for (let i = 1; i < result.length; i++) {
    const current = result[i];
    const previous = result[i - 1];
    const currentStats = utils.getTextStats(current.text);
    const previousStats = utils.getTextStats(previous.text);
    const bounds = utils.getSemanticBounds(previousStats.isCjk);
    const canMerge = previousStats.length + currentStats.length <= bounds.max + bounds.overflow;

    if (!canMerge) {
      continue;
    }

    if (utils.isLikelyDanglingText(previous.text) || utils.startsWithWeakFragment(current.text)) {
      result[i - 1] = {
        startTime: previous.startTime,
        endTime: current.endTime,
        text: `${previous.text} ${current.text}`.replace(/\s+/g, ' ').trim(),
      };
      result.splice(i, 1);
      i--;
    }
  }

  for (let i = 0; i < result.length - 1; i++) {
    const current = result[i];
    const next = result[i + 1];
    const currentStats = utils.getTextStats(current.text);
    const nextStats = utils.getTextStats(next.text);
    const bounds = utils.getSemanticBounds(currentStats.isCjk);
    const combinedFits = currentStats.length + nextStats.length <= bounds.max + bounds.overflow + 8;
    const currentLooksTail = utils.isLikelyDanglingText(current.text) || WEAK_TRAILING_WORD_PATTERN.test(current.text.trim());
    const nextLooksHead = utils.startsWithWeakFragment(next.text) || WEAK_LEADING_WORD_PATTERN.test(next.text.trim());

    if (!combinedFits) {
      continue;
    }

    if (currentLooksTail || nextLooksHead) {
      result[i] = {
        startTime: current.startTime,
        endTime: next.endTime,
        text: `${current.text} ${next.text}`.replace(/\s+/g, ' ').trim(),
      };
      result.splice(i + 1, 1);
      i--;
    }
  }

  for (let i = 0; i < result.length - 1; i++) {
    const current = result[i];
    const next = result[i + 1];
    const currentText = current.text.trim();
    const nextText = next.text.trim();

    if (!WEAK_TRAILING_WORD_PATTERN.test(currentText) || !WEAK_LEADING_WORD_PATTERN.test(nextText)) {
      continue;
    }

    const currentWords = currentText.split(/\s+/);
    if (currentWords.length < 6) {
      continue;
    }

    const moveCount = Math.min(3, Math.max(1, Math.floor(currentWords.length * 0.12)));
    const movedWords = currentWords.slice(-moveCount);
    const keptWords = currentWords.slice(0, -moveCount);
    if (keptWords.length < 6) {
      continue;
    }

    result[i] = {
      ...current,
      text: keptWords.join(' '),
    };
    result[i + 1] = {
      ...next,
      text: `${movedWords.join(' ')} ${nextText}`.replace(/\s+/g, ' ').trim(),
    };
  }

  return result;
}

function scoreSemanticSplit(
  left: SubtitleCue,
  right: SubtitleCue,
  utils: ReconstructionUtils
): number {
  const leftText = utils.normalizeCueText(left.text);
  const rightText = utils.normalizeCueText(right.text);

  if (!leftText || !rightText) {
    return Number.NEGATIVE_INFINITY;
  }

  if (utils.isLikelyDanglingText(leftText) || utils.startsWithWeakFragment(rightText)) {
    return Number.NEGATIVE_INFINITY;
  }

  const leftStats = utils.getTextStats(leftText);
  const bounds = utils.getSemanticBounds(leftStats.isCjk);
  if (leftStats.length < Math.max(6, bounds.min - 4)) {
    return Number.NEGATIVE_INFINITY;
  }

  const gap = right.startTime - left.endTime;
  let score = 0;

  if (utils.strongSentenceEndPattern.test(leftText)) {
    score += 120;
  } else if (utils.softSentenceEndPattern.test(leftText)) {
    score += 60;
  }

  if (utils.startsWithClauseStarter(rightText)) {
    score += 40;
  }

  if (gap >= 700) {
    score += 50;
  } else if (gap >= 350) {
    score += 30;
  } else if (gap >= 180) {
    score += 15;
  }

  score -= Math.min(40, Math.abs(leftStats.length - bounds.preferred));

  if (leftStats.length >= bounds.min && leftStats.length <= bounds.max + bounds.overflow) {
    score += 20;
  }

  return score;
}

function findBestSemanticSplit(
  atoms: SubtitleAtom[],
  utils: ReconstructionUtils
): { index: number; score: number } {
  if (atoms.length < 2) {
    return { index: -1, score: Number.NEGATIVE_INFINITY };
  }

  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let index = 1; index < atoms.length; index++) {
    const leftCue = utils.buildCueFromAtoms(atoms.slice(0, index));
    const rightCue = utils.buildCueFromAtoms(atoms.slice(index));
    if (!leftCue || !rightCue) {
      continue;
    }

    const score = scoreSemanticSplit(leftCue, rightCue, utils);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return {
    index: bestScore >= 5 ? bestIndex : -1,
    score: bestScore,
  };
}

function buildCoarseSemanticChunks(
  atoms: SubtitleAtom[],
  utils: ReconstructionUtils
): SubtitleAtom[][] {
  if (atoms.length === 0) {
    return [];
  }

  const chunks: SubtitleAtom[][] = [];
  const atomBuffer: SubtitleAtom[] = [];

  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    const nextAtom = atoms[i + 1];
    atomBuffer.push(atom);

    if (shouldFlushCoarseSemanticChunk(atomBuffer, nextAtom, utils)) {
      chunks.push([...atomBuffer]);
      atomBuffer.length = 0;
    }
  }

  if (atomBuffer.length > 0) {
    chunks.push([...atomBuffer]);
  }

  return chunks;
}

function recoverSemanticSentencesFromAtoms(
  atoms: SubtitleAtom[],
  utils: ReconstructionUtils
): SubtitleCue[] {
  const cue = utils.buildCueFromAtoms(atoms);
  if (!cue) {
    return [];
  }

  const normalizedCue = {
    ...cue,
    text: utils.normalizeCueText(cue.text),
  };
  const stats = utils.getTextStats(normalizedCue.text);
  const bounds = utils.getSemanticBounds(stats.isCjk);
  const hardOverflow = bounds.max + bounds.overflow;

  if (stats.length <= hardOverflow) {
    return [normalizedCue];
  }

  const { index: splitIndex, score } = findBestSemanticSplit(atoms, utils);
  if (splitIndex > 0) {
    const leftAtoms = atoms.slice(0, splitIndex);
    const rightAtoms = atoms.slice(splitIndex);
    const leftCue = utils.buildCueFromAtoms(leftAtoms);
    const rightCue = utils.buildCueFromAtoms(rightAtoms);

    if (leftCue && rightCue) {
      const leftStats = utils.getTextStats(leftCue.text);
      const rightStats = utils.getTextStats(rightCue.text);
      const leftOverflow = leftStats.length > hardOverflow;
      const rightOverflow = rightStats.length > hardOverflow;

      if (
        score >= 25
        || leftOverflow
        || rightOverflow
        || utils.startsWithClauseStarter(rightCue.text)
      ) {
        return [
          ...recoverSemanticSentencesFromAtoms(leftAtoms, utils),
          ...recoverSemanticSentencesFromAtoms(rightAtoms, utils),
        ];
      }
    }
  }

  return utils.splitSemanticCue(normalizedCue);
}

export function buildSemanticSourceSegments(
  atoms: SubtitleAtom[],
  utils: ReconstructionUtils
): SubtitleCue[] {
  const recovered = buildCoarseSemanticChunks(atoms, utils)
    .flatMap(chunk => recoverSemanticSentencesFromAtoms(chunk, utils));

  return rebalanceRecoveredCues(recovered, utils);
}
