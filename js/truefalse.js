// True/False mode: for each drawn term, present its own situational
// lead-in (`scenario`/`scenarios`) paired with either its own `label` (a
// true claim) or a different entry's label (a false claim, preferring one
// from the same difficulty tier so a "wrong" claim doesn't stand out just
// from reading harder or easier than the term's own tier), and the player
// judges whether the resulting statement is true or false. Draws through
// the same shared draw-queue rotation and exposure caps as every other
// exercise type, via pool.js - only the impostor lookup for a false claim
// is unique to this mode.
//
// The lead-in text never names its own answer, so swapping in a
// different entry's label produces a complete, grammatical, but false
// sentence rather than a mismatched question - see README.md's "Editing
// content" notes for how `label` is meant to read as the tail end of
// "<lead-in> This describes <label>."

import { sampleMixedEntries } from './pool.js';

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// An entry can carry `scenarios` (a non-empty array of alternate
// situational lead-ins) instead of a single `scenario` string, when one
// term has several distinct real-world examples worth asking about rather
// than just one - picked at random each time the entry is drawn, so a
// term with a deep exposure cap still presents varied statements across
// its exposures instead of the exact same claim every time. Falls back to
// the singular `scenario`, then plain `meaning`, for entries that don't
// need the extra variety.
function leadinFor(entry) {
  if (Array.isArray(entry.scenarios) && entry.scenarios.length > 0) {
    return entry.scenarios[randomInt(0, entry.scenarios.length - 1)];
  }
  return entry.scenario || entry.meaning;
}

function buildClaim(leadin, label) {
  return `${leadin} This describes ${label}.`;
}

// Draws `count` terms via the shared rotation and turns each into a
// true/false claim. The impostor entry borrowed for a false claim lends
// only its `label` - the lead-in always stays the tested entry's own, so
// the impostor itself does NOT count as "asked."
export function sampleTrueFalseRound({ pool, weights, roundsCompleted = Infinity, exposure = {}, scopeKey = 'truefalse::general', count = 8 }) {
  const entries = sampleMixedEntries({ pool, scopeKey, totalCount: count, weights, exposure });
  return entries.map((entry) => {
    const isTrue = Math.random() < 0.5;
    const leadin = leadinFor(entry);
    if (isTrue) {
      return { entry, isTrue, claimText: buildClaim(leadin, entry.label), found: false, earnedMark: false };
    }
    const sameTier = pool.filter((e) => e.word !== entry.word && e.difficulty === entry.difficulty);
    const impostorPool = sameTier.length ? sameTier : pool.filter((e) => e.word !== entry.word);
    const impostor = impostorPool[randomInt(0, impostorPool.length - 1)];
    return { entry, isTrue, claimText: buildClaim(leadin, impostor.label), found: false, earnedMark: false };
  });
}
