// Card Grouping mode: sort word cards into their correct `source` category
// bucket. Categories come directly from each entry's existing `source` tag
// (already used purely for curator organization elsewhere) - no new
// content needed, just enough distinct categories with 2+ not-yet-capped
// members.
//
// Deliberately does NOT use pool.js's per-difficulty draw-queue rotation:
// that system cycles through one difficulty tier at a time, but grouping
// draws by CATEGORY, mixing difficulties freely within a category - the
// two don't compose cleanly, so this keeps its own, simpler selection
// logic. It still respects the same MAX_WORD_EXPOSURES cap so a word
// retiring from grouping means the same thing as it retiring anywhere else.

import { MAX_WORD_EXPOSURES } from './pool.js';

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Returns null when fewer than 2 categories have 2+ not-yet-capped
// members - either the pool is genuinely exhausted for this mode, or
// what's left is too thin to group meaningfully. Callers should show the
// "seen everything" screen in that case.
export function sampleGroupingRound({ pool, exposure = {}, categoryCount = 3, cardsPerCategory = 3 }) {
  const bySource = new Map();
  for (const entry of pool) {
    if ((exposure[entry.word] || 0) >= MAX_WORD_EXPOSURES) continue;
    if (!bySource.has(entry.source)) bySource.set(entry.source, []);
    bySource.get(entry.source).push(entry);
  }

  const eligibleSources = [...bySource.entries()].filter(([, list]) => list.length >= 2);
  if (eligibleSources.length < 2) return null;

  const chosen = shuffle(eligibleSources).slice(0, categoryCount);
  return chosen.map(([source, list]) => ({
    source,
    cards: shuffle(list).slice(0, Math.min(cardsPerCategory, list.length)),
  }));
}
