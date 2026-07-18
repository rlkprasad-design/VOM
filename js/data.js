// Loads and caches the two content files. Fetched once per page load -
// content doesn't change while a session is running, so there's no need to
// re-fetch on every round.

let poolPromise = null;
let levelsPromise = null;

export function loadEntryPool() {
  if (!poolPromise) {
    poolPromise = fetch('data/questions.json')
      .then((res) => res.json())
      .then((data) => data.entries);
  }
  return poolPromise;
}

export function loadLevels() {
  if (!levelsPromise) {
    levelsPromise = fetch('data/levels.json').then((res) => res.json());
  }
  return levelsPromise;
}
