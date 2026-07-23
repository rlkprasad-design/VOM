#!/usr/bin/env node
// Validates data/questions.json (the single content pool) and
// data/levels.json (the level ladder) against the schema the app actually
// reads (js/data.js + js/wordsearch.js + js/spelling.js). Run before any
// content PR merges - see README.md "Editing content". No dependencies.
//
// English-only content means plain string.length is the right measure of
// a word's size - no grapheme-cluster concerns the way a script like
// Telugu would have.
//
// Usage: node scripts/validate-content.js [dir]   (defaults to "data")

const fs = require('fs');
const path = require('path');

const MEANING_WARN_LENGTH = 120;
const DIFFICULTIES = ['easy', 'medium', 'difficult'];

const targetDir = process.argv[2] || 'data';
const QUESTIONS_FILE = 'questions.json';
const LEVELS_FILE = 'levels.json';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function isPositiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

// Validates the questions file. Returns entries (for cross-checks with
// levels.json) plus { errors, warnings }.
function validateQuestions(data) {
  const errors = [];
  const warnings = [];
  const entries = [];

  if (!Array.isArray(data.entries) || data.entries.length === 0) {
    errors.push('entries must be a non-empty array');
    return { entries, errors, warnings };
  }

  // word+difficulty -> count seen. Scoped to difficulty, not global: a
  // round only ever draws entries from a single difficulty tier at a time
  // (js/pool.js's sampleMixedEntries filters by difficulty), so the same
  // word can never be drawn twice into the same round unless the
  // duplicate is within one tier.
  const wordLocations = new Map();

  data.entries.forEach((entry, ei) => {
    const where = `entries[${ei}]`;

    if (!isNonEmptyString(entry.word)) {
      errors.push(`${where}: word must be a non-empty string`);
    } else {
      if (entry.word !== entry.word.toUpperCase()) {
        warnings.push(`${where}: word "${entry.word}" isn't uppercase - the grid and spelling tiles render whatever case is stored`);
      }
      const len = entry.word.length;
      if (len < 2) {
        errors.push(`${where}: word "${entry.word}" is only ${len} character(s) - looks like junk/empty content`);
      }
      if (/\s/.test(entry.word)) {
        errors.push(`${where}: word "${entry.word}" contains whitespace - word search and spelling tiles only support a single unbroken token`);
      }
      const key = `${entry.word}::${entry.difficulty}`;
      wordLocations.set(key, (wordLocations.get(key) || 0) + 1);
      entries.push({ word: entry.word, len, difficulty: entry.difficulty, source: entry.source });
    }

    if (!isNonEmptyString(entry.meaning)) {
      errors.push(`${where}: meaning must be a non-empty string`);
    } else if (entry.meaning.length > MEANING_WARN_LENGTH) {
      warnings.push(`${where}: meaning for "${entry.word}" is ${entry.meaning.length} chars - probably too long for the clue panel (soft limit ${MEANING_WARN_LENGTH})`);
    }

    if ('scenario' in entry && entry.scenario !== null && !isNonEmptyString(entry.scenario)) {
      errors.push(`${where}: scenario must be a non-empty string when present`);
    }

    if ('scenarios' in entry && entry.scenarios !== null) {
      if (!Array.isArray(entry.scenarios) || entry.scenarios.length === 0) {
        errors.push(`${where}: scenarios must be a non-empty array when present`);
      } else {
        entry.scenarios.forEach((s, si) => {
          if (!isNonEmptyString(s)) errors.push(`${where}.scenarios[${si}]: must be a non-empty string`);
        });
        if (entry.scenarios.length === 1) {
          warnings.push(`${where}: scenarios has only 1 entry - a single-element array behaves like plain "scenario" but is more to maintain; consider using "scenario" instead, or adding a second variant`);
        }
      }
    }

    // A scenario/scenarios lead-in must be a plain situational description,
    // not a question - js/truefalse.js glues it directly onto "This
    // describes <label>." to form the actual True/False claim, so a
    // trailing question mark here means the resulting sentence reads as
    // "<situation>? This describes <label>." - a leftover of the old
    // question-style format this schema replaced.
    const leadinTexts = entry.scenario ? [entry.scenario] : (Array.isArray(entry.scenarios) ? entry.scenarios : []);
    leadinTexts.forEach((text, ti) => {
      if (typeof text === 'string' && text.trim().endsWith('?')) {
        const suffix = entry.scenario ? '' : `[${ti}]`;
        errors.push(`${where}.scenario${suffix}: ends with "?" - True/False needs a plain situational lead-in (no question), since it's appended to "This describes <label>." to form the claim`);
      }
    });

    if ('label' in entry && entry.label !== null && !isNonEmptyString(entry.label)) {
      errors.push(`${where}: label must be a non-empty string when present`);
    } else if (!isNonEmptyString(entry.label)) {
      errors.push(`${where}: label is missing - True/False needs it to build "<lead-in> This describes <label>." for every entry it draws (see README.md)`);
    }

    if (!DIFFICULTIES.includes(entry.difficulty)) {
      errors.push(`${where}: difficulty must be one of ${DIFFICULTIES.join('/')}, got ${JSON.stringify(entry.difficulty)}`);
    }

    if ('source' in entry && entry.source !== null && typeof entry.source !== 'string') {
      errors.push(`${where}: source must be a string when present`);
    } else if (!isNonEmptyString(entry.source)) {
      warnings.push(`${where}: source is missing - it's curator-only metadata, but helps organize content by value/framework`);
    }
  });

  for (const [key, count] of wordLocations) {
    if (count > 1) {
      const [word, difficulty] = key.split('::');
      errors.push(`Duplicate word "${word}" appears ${count} times at difficulty "${difficulty}"`);
    }
  }

  return { entries, errors, warnings };
}

function validateLevels(levels) {
  const errors = [];
  if (!Array.isArray(levels) || levels.length === 0) {
    return ['levels.json must be a non-empty array'];
  }

  const seen = new Set();
  levels.forEach((level, li) => {
    const where = `levels[${li}]`;
    if (!isPositiveInt(level.levelNumber)) {
      errors.push(`${where}: levelNumber must be a positive integer`);
    } else if (seen.has(level.levelNumber)) {
      errors.push(`${where}: duplicate levelNumber ${level.levelNumber}`);
    } else {
      seen.add(level.levelNumber);
    }
    if (!isPositiveInt(level.gridSizeMin)) errors.push(`${where}: gridSizeMin must be a positive integer`);
    if (!isPositiveInt(level.gridSizeMax)) errors.push(`${where}: gridSizeMax must be a positive integer`);
    if (isPositiveInt(level.gridSizeMin) && isPositiveInt(level.gridSizeMax) && level.gridSizeMin > level.gridSizeMax) {
      errors.push(`${where}: gridSizeMin (${level.gridSizeMin}) must be <= gridSizeMax (${level.gridSizeMax})`);
    }
    if (level.fillerMode !== 'random' && level.fillerMode !== 'curated') {
      errors.push(`${where}: fillerMode must be "random" or "curated", got ${JSON.stringify(level.fillerMode)}`);
    }
    if (!isPositiveInt(level.roundSize)) errors.push(`${where}: roundSize must be a positive integer`);
  });
  return errors;
}

function parseJsonFile(full) {
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function main() {
  const dir = path.resolve(process.cwd(), targetDir);
  if (!fs.existsSync(dir)) {
    console.error(`No such directory: ${dir}`);
    process.exitCode = 1;
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) {
    console.error(`No .json files found in ${dir}`);
    process.exitCode = 1;
    return;
  }

  let anyFailed = false;
  let totalWarnings = 0;
  let poolEntries = null;
  let levels = null;

  for (const file of files) {
    const full = path.join(dir, file);
    let data;
    try {
      data = parseJsonFile(full);
    } catch (err) {
      console.log(`\n✗ ${file}`);
      console.log(`  ✗ invalid JSON: ${err.message}`);
      anyFailed = true;
      continue;
    }

    if (file === LEVELS_FILE) {
      const errors = validateLevels(data);
      if (errors.length === 0) {
        console.log(`\n✓ ${file}`);
        levels = data;
      } else {
        console.log(`\n✗ ${file}`);
        errors.forEach((e) => console.log(`  ✗ ${e}`));
        anyFailed = true;
      }
      continue;
    }

    if (file === QUESTIONS_FILE) {
      const { entries, errors, warnings } = validateQuestions(data);
      totalWarnings += warnings.length;
      if (errors.length === 0) {
        console.log(`\n✓ ${file}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`);
        poolEntries = entries;
      } else {
        console.log(`\n✗ ${file}`);
        anyFailed = true;
      }
      for (const e of errors) console.log(`  ✗ ${e}`);
      for (const w of warnings) console.log(`  ⚠ ${w}`);
      continue;
    }

    console.log(`\n· ${file} (unrecognized file, skipped - only questions.json and levels.json are validated)`);
  }

  if (levels && poolEntries) {
    const maxGridSizeOverall = Math.max(...levels.map((l) => l.gridSizeMax));

    const tooLong = poolEntries.filter((e) => e.len > maxGridSizeOverall);
    if (tooLong.length) {
      console.log(`\n✗ words too long for any level's largest possible grid`);
      tooLong.forEach((e) => console.log(`  ✗ "${e.word}" (${e.difficulty}, ${e.len} letters) can't fit any level's largest grid (max ${maxGridSizeOverall}x${maxGridSizeOverall}) - raise a level's gridSizeMax or shorten the word`));
      anyFailed = true;
    }

    // A round's actual entry count per difficulty is derived from
    // whatever size it rolls (entryCountForGridSize, split three ways)
    // and clamped to however many words are eligible at that size, so a
    // shortfall degrades gracefully - the only genuinely bad case is a
    // rolled size with fewer than 2 eligible words for some tier, which
    // would leave that tier essentially unrepresented in the mix.
    const poolWarnings = [];
    for (const level of levels) {
      for (let size = level.gridSizeMin; size <= level.gridSizeMax; size++) {
        for (const difficulty of DIFFICULTIES) {
          const eligible = poolEntries.filter((e) => e.difficulty === difficulty && e.len <= size).length;
          if (eligible < 2) {
            poolWarnings.push(`level ${level.levelNumber} at ${size}x${size}: only ${eligible} "${difficulty}" entries fit - that tier would be nearly absent from word search rounds at this size`);
          }
        }
      }
    }
    if (poolWarnings.length) {
      console.log(`\n⚠ pool size vs a level's possible rolled grid sizes`);
      poolWarnings.forEach((w) => { console.log(`  ⚠ ${w}`); totalWarnings += 1; });
    }

    // Spelling mode has no grid-size constraint, but still needs at least
    // 2 eligible words per tier to mix a round properly.
    const spellingWarnings = [];
    for (const difficulty of DIFFICULTIES) {
      const eligible = poolEntries.filter((e) => e.difficulty === difficulty).length;
      if (eligible < 2) {
        spellingWarnings.push(`spelling mode: only ${eligible} "${difficulty}" entries in the whole pool - that tier would be nearly absent from spelling rounds`);
      }
    }
    if (spellingWarnings.length) {
      console.log(`\n⚠ pool size vs spelling mode's tier mix`);
      spellingWarnings.forEach((w) => { console.log(`  ⚠ ${w}`); totalWarnings += 1; });
    }

    // Card Grouping mode draws its categories straight from `source`
    // (js/grouping.js) and needs at least 2 categories with 2+ members
    // each to build a round at all - fewer than that and every round
    // shows the "you've seen everything" screen regardless of how big the
    // rest of the pool is.
    const bySource = new Map();
    for (const e of poolEntries) {
      if (!e.source) continue;
      if (!bySource.has(e.source)) bySource.set(e.source, 0);
      bySource.set(e.source, bySource.get(e.source) + 1);
    }
    const eligibleCategories = [...bySource.values()].filter((count) => count >= 2).length;
    if (eligibleCategories < 2) {
      console.log(`\n⚠ pool size vs Card Grouping's category mix`);
      console.log(`  ⚠ only ${eligibleCategories} "source" categories have 2+ entries - Card Grouping needs at least 2 to build a round`);
      totalWarnings += 1;
    }
  }

  console.log(`\n${'-'.repeat(40)}`);
  console.log(anyFailed ? 'FAILED: fix the ✗ items above before merging.' : `PASSED${totalWarnings ? ` with ${totalWarnings} warning(s) to look at` : ''}.`);

  process.exitCode = anyFailed ? 1 : 0;
}

main();
