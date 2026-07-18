// Local-device state: player identity (name-only, no login) and a local
// fallback tally so the app still works fully offline / before a Supabase
// project is configured.
//
// EVERY piece of local state here is scoped by player display name via
// playerScopedKey - draw queues, exposure counts, round totals, all of it.
// A shared classroom laptop switching names back and forth is the expected
// common case, not an edge case: without this scoping, one player's
// progress and difficulty ramp would silently leak into whoever's name is
// active next on the same device.

const PLAYER_NAME_KEY = 'vom.playerName';
const PLAYER_ID_KEY = 'vom.playerId';
const DRAW_QUEUES_KEY = 'vom.drawQueues';
const WORD_EXPOSURE_KEY = 'vom.wordExposure';
const ROUND_LOG_KEY = 'vom.roundLog';

export function playerScopedKey(baseKey, playerName) {
  return `${baseKey}.${playerName || '_default'}`;
}

export function getPlayerName() {
  return localStorage.getItem(PLAYER_NAME_KEY);
}

export function setPlayerName(name) {
  localStorage.setItem(PLAYER_NAME_KEY, name.trim());
}

export function getPlayerId() {
  return localStorage.getItem(PLAYER_ID_KEY);
}

export function setPlayerId(id) {
  if (id) localStorage.setItem(PLAYER_ID_KEY, id);
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch {
    return {};
  }
}

// The per-difficulty "shuffle then cycle through every word before
// repeating" draw queues (see pool.js) used to live only in memory, so a
// word that had just been shown could resurface right after any page
// reload. Persisting them here makes the "no repeat until the tier fully
// cycles" guarantee hold across reloads too, not just within one
// continuous session.
export function getPersistedDrawQueues(playerName) {
  return readJson(playerScopedKey(DRAW_QUEUES_KEY, playerName));
}

export function setPersistedDrawQueues(queues, playerName) {
  localStorage.setItem(playerScopedKey(DRAW_QUEUES_KEY, playerName), JSON.stringify(queues));
}

// How many times each word has been shown to this player, so a word can be
// retired from rotation once it's been asked MAX_WORD_EXPOSURES times (see
// pool.js). Scoped per player and further nested by `scopeKey` (e.g.
// "wordsearch::general" or "spelling::general") since each mode's rotation
// is tracked - and should be capped - independently, even when both modes
// draw from the same underlying content pool.
export function getWordExposureCounts(scopeKey, playerName) {
  const store = readJson(playerScopedKey(WORD_EXPOSURE_KEY, playerName));
  return store[scopeKey] || {};
}

export function recordWordExposures(words, scopeKey, playerName) {
  const store = readJson(playerScopedKey(WORD_EXPOSURE_KEY, playerName));
  const scoped = store[scopeKey] || {};
  for (const word of words) scoped[word] = (scoped[word] || 0) + 1;
  store[scopeKey] = scoped;
  localStorage.setItem(playerScopedKey(WORD_EXPOSURE_KEY, playerName), JSON.stringify(store));
}

function readLog(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
}

function appendLog(key, entry) {
  const list = readLog(key);
  list.push(entry);
  localStorage.setItem(key, JSON.stringify(list));
}

// One entry per completed round, either mode: { mode, entries_found,
// bronze_found, silver_found, gold_found, marks_earned }. A single log
// covers both exercise types so the "rounds completed" experience ramp
// (see pool.js's difficultyWeightsForExperience) reflects a player's
// overall experience, not just one mode's.
export function recordRoundProgressLocal(entry, playerName) {
  appendLog(playerScopedKey(ROUND_LOG_KEY, playerName), { ...entry, completed_at: new Date().toISOString() });
}

export function getLocalTotals(playerName) {
  const list = readLog(playerScopedKey(ROUND_LOG_KEY, playerName));
  return {
    entriesFound: list.reduce((sum, e) => sum + (e.entries_found || 0), 0),
    bronze: list.reduce((sum, e) => sum + (e.bronze_found || 0), 0),
    silver: list.reduce((sum, e) => sum + (e.silver_found || 0), 0),
    gold: list.reduce((sum, e) => sum + (e.gold_found || 0), 0),
    marksEarned: list.reduce((sum, e) => sum + (e.marks_earned || 0), 0),
    roundsCompleted: list.length,
  };
}
