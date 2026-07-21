// Word search puzzle engine: grid sizing/placement plus the beginner
// grid-size ramp. Draw-queue rotation and difficulty weighting live in
// pool.js (shared with every other exercise type) - this module only adds
// what's specific to "hide these words in a letter grid."
//
// English-only content means plain string.length is a safe substitute for
// Nama Nidhi's Intl.Segmenter grapheme counting (that app needed grapheme
// clusters for Telugu consonant+vowel-sign combinations; a Latin word has
// no such multi-codepoint concept).

import { sampleMixedEntries, randomInt, MAX_WORD_EXPOSURES } from './pool.js';

export const LATIN_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const DIRECTIONS = [
  [0, 1], [0, -1], [1, 0], [-1, 0],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// How many entries a round asks for, given the grid size that round
// happened to roll - bigger board, more words, without being tied to a
// single fixed count per level.
export function entryCountForGridSize(gridSize) {
  return Math.max(2, Math.round(gridSize * 0.7));
}

// Caps how large a grid a beginner can roll, ramping linearly up to the
// level's full gridSizeMax by their 50th completed round - a big board is
// intimidating on its own regardless of how easy the words on it are, so
// this runs independently of (and longer than) the difficulty-mix ramp in
// pool.js, which finishes by round 30. A brand-new player always gets
// gridSizeMin; from then on the ceiling grows until the full range opens up.
export function gridSizeCapForExperience(roundsCompleted, min, max) {
  const t = Math.min(1, Math.max(0, roundsCompleted) / 50);
  return Math.round(min + (max - min) * t);
}

// How many pool entries (any tier) would actually be eligible to draw at
// this grid size, given the player's current exposure - a pure count,
// with no draw-queue side effects, so callers can check "is this size
// worth trying" before committing to a real (queue-mutating) draw.
function eligibleCountAtSize(pool, exposure, size) {
  return pool.filter((e) => e.word.length <= size && (exposure[e.word] || 0) < MAX_WORD_EXPOSURES).length;
}

// A round needs at least this many eligible words across all tiers combined
// before a size is worth committing to - otherwise a round risks coming out
// as one word, or none at all.
const MIN_ELIGIBLE_FOR_ROUND = 4;

// Rolls a grid size (capped for newer players) and draws a mix of
// easy/medium/difficult entries sized to fit that roll, via pool.js's
// shared draw-queue rotation. `scopeKey` namespaces the rotation so word
// search's draws never interfere with spelling mode's, even when both
// pull from the same content pool.
//
// The rolled size's own eligible pool can run dry well before the pool as
// a whole does: a handful of short words at the level's minimum size will
// hit their exposure cap sooner than the many longer words that only fit
// larger grids - especially for a content curator regenerating puzzles
// during review without completing them (each regenerate still counts as
// "shown"). Rather than commit to a roll that's already thin, this
// escalates in two stages: first toward cappedMax (staying inside the
// beginner ramp), then - if even cappedMax's own eligible pool is thin -
// the rest of the way to the level's real gridSizeMax. That second stage
// matters: gridSizeCapForExperience only grows on COMPLETED rounds, so a
// player stuck with an empty roll at their current cap could never
// complete one to raise it, a deadlock that would trap them at
// gridSizeMin forever. Breaking past the beginner cap when it's
// genuinely got nothing left is better than that deadlock.
export function sampleWordSearchRound({ pool, level, weights, roundsCompleted = Infinity, exposure = {}, scopeKey = 'wordsearch::general' }) {
  const cappedMax = gridSizeCapForExperience(roundsCompleted, level.gridSizeMin, level.gridSizeMax);
  let gridSize = randomInt(level.gridSizeMin, cappedMax);
  while (gridSize < cappedMax && eligibleCountAtSize(pool, exposure, gridSize) < MIN_ELIGIBLE_FOR_ROUND) {
    gridSize += 1;
  }
  while (gridSize < level.gridSizeMax && eligibleCountAtSize(pool, exposure, gridSize) < MIN_ELIGIBLE_FOR_ROUND) {
    gridSize += 1;
  }
  const totalCount = entryCountForGridSize(gridSize);
  const entries = sampleMixedEntries({
    pool,
    scopeKey,
    totalCount,
    weights,
    exposure,
    fits: (e) => e.word.length <= gridSize,
  });
  return { gridSize, entries };
}

// A random layout occasionally can't fit every requested word on the
// first try, especially when the rolled size sits near the tight end for
// its longest word - retrying with a fresh shuffle almost always finds a
// layout that fits everything, so a round never silently shows fewer
// words than it asked for.
const GENERATE_RETRY_ATTEMPTS = 15;

export function generateGridReliable({ size, entries, fillerMode, fillerPool = LATIN_POOL }) {
  let result = { grid: [], placements: [] };
  for (let attempt = 0; attempt < GENERATE_RETRY_ATTEMPTS; attempt++) {
    result = generateGrid({ size, entries, fillerMode, fillerPool });
    if (result.placements.length === entries.length) break;
  }
  return result;
}

// Try every (direction, start) combo for a word, shuffled, and return the
// first one whose path is empty or matches existing letters (crossing OK).
function findPlacement(grid, size, letters) {
  const len = letters.length;
  const candidates = [];
  for (const [dr, dc] of DIRECTIONS) {
    const minRow = dr === 1 ? 0 : dr === -1 ? len - 1 : 0;
    const maxRow = dr === 1 ? size - len : dr === -1 ? size - 1 : size - 1;
    const minCol = dc === 1 ? 0 : dc === -1 ? len - 1 : 0;
    const maxCol = dc === 1 ? size - len : dc === -1 ? size - 1 : size - 1;
    if (minRow > maxRow || minCol > maxCol) continue;
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        candidates.push([r, c, dr, dc]);
      }
    }
  }

  for (const [r, c, dr, dc] of shuffle(candidates)) {
    let ok = true;
    const cells = [];
    for (let i = 0; i < len; i++) {
      const rr = r + dr * i;
      const cc = c + dc * i;
      const existing = grid[rr][cc];
      if (existing !== null && existing !== letters[i]) {
        ok = false;
        break;
      }
      cells.push([rr, cc]);
    }
    if (ok) return cells;
  }
  return null;
}

// Builds a size x size grid with every entry hidden in a straight line
// (any of 8 directions), allowing entries to legitimately cross/share a
// cell.
export function generateGrid({ size, entries, fillerMode, fillerPool = LATIN_POOL }) {
  const grid = Array.from({ length: size }, () => Array(size).fill(null));

  const withLetters = entries
    .map((entry) => ({ entry, letters: entry.word.split('') }))
    .sort((a, b) => b.letters.length - a.letters.length);

  const placements = [];
  const unplaced = [];

  for (const { entry, letters } of withLetters) {
    const cells = findPlacement(grid, size, letters);
    if (!cells) {
      unplaced.push(entry.word);
      continue;
    }
    cells.forEach(([r, c], i) => {
      grid[r][c] = letters[i];
    });
    placements.push({ entry, letters, cells });
  }

  if (unplaced.length) {
    // Should only happen if gridSize is too small for the given entries.
    console.warn('Could not place entries (grid too small):', unplaced);
  }

  fillEmptyCells(grid, size, fillerMode, fillerPool);

  return { grid, placements };
}

function fillEmptyCells(grid, size, fillerMode, fillerPool) {
  const used = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] !== null) used.push(grid[r][c]);
    }
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] !== null) continue;
      if (fillerMode === 'curated' && used.length && Math.random() < 0.7) {
        grid[r][c] = used[Math.floor(Math.random() * used.length)];
      } else {
        grid[r][c] = fillerPool[Math.floor(Math.random() * fillerPool.length)];
      }
    }
  }
}
