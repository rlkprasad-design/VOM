// Mode-agnostic content-pool engine: draw-queue rotation, per-word exposure
// caps, and the beginner difficulty ramp. Shared by every exercise type
// (word search today, spelling, and whatever's added later) so a new mode
// never has to re-solve "how do I avoid repeating the same word" - it just
// calls sampleMixedEntries with its own scopeKey and however many entries
// it needs. Nothing here knows what a grid or a jumbled tile is.

export const DIFFICULTIES = ['easy', 'medium', 'difficult'];

// Once a word has been asked this many times, it's retired from the draw
// rotation for that player/scope - a modest content pool still feels fresh
// rather than becoming a slog through the same handful of words forever.
export const MAX_WORD_EXPOSURES = 10;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// True once every entry in `pool` has hit MAX_WORD_EXPOSURES - i.e. there's
// nothing left this player hasn't already seen its full allotment of
// times. Checked against the whole pool, not just whatever's eligible for
// one particular round, so it reflects real exhaustion rather than an
// unlucky roll.
export function isPoolExhausted(pool, exposure = {}, maxExposures = MAX_WORD_EXPOSURES) {
  return pool.length > 0 && pool.every((e) => (exposure[e.word] || 0) >= maxExposures);
}

const EVEN_WEIGHTS = { easy: 1 / 3, medium: 1 / 3, difficult: 1 / 3 };

// Ramps a beginner's mix from mostly-easy toward a settled, balanced blend
// by their 30th completed round - never gets harder than that plateau, so
// the game stays welcoming long after the "new player" stage too.
// `roundsCompleted` is a mode-agnostic count (word search puzzles and
// spelling rounds combined), same shape as Nama Nidhi's puzzlesCompleted.
export function difficultyWeightsForExperience(roundsCompleted) {
  const t = Math.min(1, Math.max(0, roundsCompleted) / 30);
  return {
    easy: 0.70 - 0.50 * t,
    medium: 0.30 + 0.10 * t,
    difficult: 0.40 * t,
  };
}

// Splits `total` across the three difficulty tiers proportional to
// `weights` (an even split by default), using largest-remainder
// apportionment so the counts always sum to exactly `total` while still
// respecting the requested proportions as closely as whole numbers allow.
export function splitAcrossDifficulties(total, weights = EVEN_WEIGHTS) {
  const raw = DIFFICULTIES.map((d) => [d, (weights[d] ?? 0) * total]);
  const floors = raw.map(([d, v]) => [d, Math.floor(v)]);
  const counts = Object.fromEntries(floors);
  let remainder = total - floors.reduce((sum, [, v]) => sum + v, 0);
  const byFraction = raw
    .map(([d, v], i) => [d, v - floors[i][1]])
    .sort((a, b) => b[1] - a[1]);
  for (let i = 0; remainder > 0 && i < byFraction.length; i++, remainder--) {
    counts[byFraction[i][0]] += 1;
  }
  return counts;
}

// Per-scope-per-difficulty draw queues, so a round cycles through every
// eligible word once before any word repeats, rather than independent
// random draws (which repeat far too often by chance in a modest pool).
// exportDrawQueues/importDrawQueues let storage.js persist this to
// localStorage so the "no repeat until the tier cycles" guarantee survives
// a page reload, not just one session.
const drawQueues = new Map();

export function exportDrawQueues() {
  return Object.fromEntries(drawQueues);
}

export function importDrawQueues(queues) {
  drawQueues.clear();
  for (const [key, entries] of Object.entries(queues || {})) drawQueues.set(key, entries);
}

// `queue` holds every tier word not yet drawn THIS cycle, in shuffled
// order. A fresh cycle only starts (reshuffling the whole tier back in)
// once the queue is completely empty - i.e. every word has been drawn
// once - never just because the words currently at the front happen not
// to fit this particular round's constraints (e.g. a grid too small for a
// long word). Topping up early on a too-small subset is the bug to avoid:
// it would treat already-drawn words as "unseen" again the moment the few
// still-queued words don't fit, letting a word resurface long before the
// rest of its tier had its turn.
function startNewCycleIfEmpty(queue, tierPool) {
  if (queue.length === 0) queue.push(...shuffle(tierPool));
  return queue;
}

// Draws the first `count` queued words that satisfy `fits`, leaving every
// other queued word - fitting or not - in place for a later draw instead
// of discarding or reshuffling it. Returns { drawn, remaining } - remaining
// becomes the new persisted queue. May return fewer than `count` if what's
// left this cycle doesn't have enough words that fit; callers tolerate a
// tier contributing fewer entries than asked for.
function drawFromQueue(queue, count, fits) {
  const drawn = [];
  const remaining = [];
  for (const entry of queue) {
    if (drawn.length < count && fits(entry)) drawn.push(entry);
    else remaining.push(entry);
  }
  return { drawn, remaining };
}

// Draws a mixed-difficulty set of entries from `pool` for one round of any
// exercise type. `scopeKey` namespaces the draw queue and should encode
// both the mode and the content pool (e.g. "wordsearch::general" or
// "spelling::general") so two modes drawing from the same underlying
// content pool never share - or corrupt - each other's rotation. `fits`
// is a per-entry predicate (e.g. "short enough for this grid roll"); a
// mode with no such constraint can just pass () => true.
export function sampleMixedEntries({ pool, scopeKey, totalCount, weights = EVEN_WEIGHTS, exposure = {}, fits = () => true }) {
  const targetCounts = splitAcrossDifficulties(totalCount, weights);
  const entries = [];

  for (const difficulty of DIFFICULTIES) {
    // The tier's full rotation pool - not filtered by this round's
    // constraints, only by whether the word is still within its exposure
    // cap. Filtering by `fits` here would mean a word briefly unusable for
    // one round's roll drops out of the persisted queue entirely, then
    // looks "unseen" again as soon as a later roll allows it back in -
    // letting it resurface well before the tier had actually cycled.
    const tierPool = pool.filter((e) => e.difficulty === difficulty && (exposure[e.word] || 0) < MAX_WORD_EXPOSURES);
    if (!tierPool.length) continue;

    const eligibleNow = tierPool.filter(fits);
    const count = Math.min(targetCounts[difficulty], eligibleNow.length);
    if (!count) continue;

    const tierWords = new Set(tierPool.map((e) => e.word));
    const key = `${scopeKey}::${difficulty}`;
    const queue = (drawQueues.get(key) || []).filter((e) => tierWords.has(e.word));
    startNewCycleIfEmpty(queue, tierPool);

    const { drawn, remaining } = drawFromQueue(queue, count, fits);
    entries.push(...drawn);
    drawQueues.set(key, remaining);
  }
  return entries;
}
