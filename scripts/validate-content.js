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
      entries.push({ word: entry.word, len, difficulty: entry.difficulty });
    }

    if (!isNonEmptyString(entry.meaning)) {
      errors.push(`${where}: meaning must be a non-empty string`);
    } else if (entry.meaning.length > MEANING_WARN_LENGTH) {
      warnings.push(`${where}: meaning for "${entry.word}" is ${entry.meaning.length} chars - probably too long for the clue panel (soft limit ${MEANING_WARN_LENGTH})`);
    }

    if ('scenario' in entry && entry.scenario !== null && !isNonEmptyString(entry.scenario)) {
      errors.push(`${where}: scenario must be a non-empty string when present`);
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
  }

  console.log(`\n${'-'.repeat(40)}`);
  console.log(anyFailed ? 'FAILED: fix the ✗ items above before merging.' : `PASSED${totalWarnings ? ` with ${totalWarnings} warning(s) to look at` : ''}.`);

  process.exitCode = anyFailed ? 1 : 0;
}

main();
