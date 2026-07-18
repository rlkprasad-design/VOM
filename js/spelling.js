// Spelling / jumbled-letters mode: the second exercise type, proving the
// pool.js engine is genuinely pluggable rather than hard-wired to assume a
// word-search grid is the only shape a question can take. Same content
// pool, same draw-queue rotation, same difficulty ramp - just a different
// interaction (tap the scrambled tiles back into the right order) instead
// of dragging through a grid.

import { sampleMixedEntries } from './pool.js';

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Shuffles a word's letters into a scrambled tile order, retrying until it
// differs from the original spelling (every word in the pool is at least 4
// letters, so a differing permutation always exists).
export function scrambleLetters(word) {
  const letters = word.split('');
  let attempt = letters;
  do {
    attempt = shuffle(letters);
  } while (attempt.join('') === word);
  return attempt;
}

// Draws one round's worth of entries (level.roundSize, default 8) from the
// pool via the shared draw-queue rotation, and pre-scrambles each word's
// tiles. `scopeKey` keeps spelling's rotation independent of word search's,
// even though both pull from the same underlying content pool - so
// switching modes never skips or repeats words in the other mode's queue.
export function sampleSpellingRound({ pool, level, weights, roundsCompleted = Infinity, exposure = {}, scopeKey = 'spelling::general' }) {
  const totalCount = level.roundSize || 8;
  const entries = sampleMixedEntries({ pool, scopeKey, totalCount, weights, exposure, fits: () => true });
  return entries.map((entry) => ({
    entry,
    letters: entry.word.split(''),
    scrambled: scrambleLetters(entry.word),
    typed: [],
    found: false,
    earnedMark: false,
  }));
}
