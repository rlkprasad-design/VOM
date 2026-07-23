// True/False mode: for each drawn term, present either its own meaning/
// scenario (a true claim) or a different entry's (a false claim, preferring
// one from the same difficulty tier so a "wrong" claim doesn't stand out
// just from reading harder or easier than the term's own tier), and the
// player judges which. Draws through the same shared draw-queue rotation
// and exposure caps as every other exercise type, via pool.js - only the
// impostor lookup for a false claim is unique to this mode.

import { sampleMixedEntries } from './pool.js';

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// An entry can carry `scenarios` (a non-empty array of alternate
// situational clues) instead of a single `scenario` string, when one term
// has several distinct real-world examples worth asking about rather than
// just one - picked at random each time the entry is drawn, so a term
// with a deep exposure cap still presents varied questions across its
// exposures instead of the exact same claim every time. Falls back to the
// singular `scenario`, then plain `meaning`, for entries that don't need
// the extra variety.
function claimTextFor(entry) {
  if (Array.isArray(entry.scenarios) && entry.scenarios.length > 0) {
    return entry.scenarios[randomInt(0, entry.scenarios.length - 1)];
  }
  return entry.scenario || entry.meaning;
}

// Draws `count` terms via the shared rotation and turns each into a
// true/false claim. The impostor entry borrowed for a false claim does
// NOT itself count as "asked" - it's only lending its text, not being
// tested on its own account.
export function sampleTrueFalseRound({ pool, weights, roundsCompleted = Infinity, exposure = {}, scopeKey = 'truefalse::general', count = 8 }) {
  const entries = sampleMixedEntries({ pool, scopeKey, totalCount: count, weights, exposure });
  return entries.map((entry) => {
    const isTrue = Math.random() < 0.5;
    if (isTrue) {
      return { entry, isTrue, claimText: claimTextFor(entry), found: false, earnedMark: false };
    }
    const sameTier = pool.filter((e) => e.word !== entry.word && e.difficulty === entry.difficulty);
    const impostorPool = sameTier.length ? sameTier : pool.filter((e) => e.word !== entry.word);
    const impostor = impostorPool[randomInt(0, impostorPool.length - 1)];
    return { entry, isTrue, claimText: claimTextFor(impostor), found: false, earnedMark: false };
  });
}
