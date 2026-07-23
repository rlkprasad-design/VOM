import {
  entryCountForGridSize, gridSizeCapForExperience, sampleWordSearchRound,
  generateGridReliable, LATIN_POOL,
} from './wordsearch.js';
import { sampleSpellingRound } from './spelling.js';
import { sampleTrueFalseRound } from './truefalse.js';
import { sampleGroupingRound } from './grouping.js';
import {
  difficultyWeightsForExperience, exportDrawQueues, importDrawQueues,
  isPoolExhausted,
} from './pool.js';
import { attachTracer, pathToStrings } from './trace.js';
import { loadEntryPool, loadLevels } from './data.js';
import {
  getPlayerName, setPlayerName, getPlayerId, setPlayerId,
  recordRoundProgressLocal, getLocalTotals,
  getPersistedDrawQueues, setPersistedDrawQueues,
  getWordExposureCounts, recordWordExposures,
  recordTimeSpent,
} from './storage.js';
import {
  isBackendConfigured, ensurePlayer, syncQuestProgress,
  fetchQuestLeaderboard, flagEntry, fetchFlaggedEntries, syncTimeSpent,
} from './supabase-client.js';

const root = document.getElementById('app');

const state = {
  playerName: null,
  playerId: null,
};

function syncsToBackend() {
  return isBackendConfigured();
}

// Escapes text pulled from anywhere a player (not this codebase) could
// have typed it - a display name, a Supabase leaderboard row - before it's
// interpolated into an HTML template string and handed to el()'s
// innerHTML. A player's display_name in particular is stored in the
// shared Supabase table and re-rendered on the Scoreboard for every other
// player who opens it, so an unescaped '<' or '"' there is a stored-XSS
// hole affecting the whole class, not just whoever typed it.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// Active-play-time tracking: a "tracked" screen (the four gameplay modes)
// starts a timer when it's shown; the very next setScreen call - to
// anywhere, tracked or not - flushes the elapsed time before swapping in
// the new content. A "New puzzle"/"Next round" re-render of the same mode
// still goes through setScreen with tracked:true again, which correctly
// banks the finished round's time and starts a fresh timer for the next
// one, so time accumulates continuously across an unbroken play session.
// Capped per flush so a forgotten idle tab can't inflate the total.
const MAX_TRACKED_SESSION_SECONDS = 30 * 60;
let playTimerStartedAt = null;

function startPlayTimer() {
  playTimerStartedAt = Date.now();
}

function flushPlayTimer() {
  if (playTimerStartedAt == null) return;
  const elapsed = Math.round((Date.now() - playTimerStartedAt) / 1000);
  playTimerStartedAt = null;
  if (elapsed <= 0) return;
  const capped = Math.min(elapsed, MAX_TRACKED_SESSION_SECONDS);
  recordTimeSpent(capped, state.playerName);
  if (state.playerId && syncsToBackend()) syncTimeSpent(state.playerId, capped);
}

function setScreen(node, { tracked = false } = {}) {
  flushPlayTimer();
  root.innerHTML = '';
  root.appendChild(node);
  if (tracked) startPlayTimer();
}

function topBar({ backAction } = {}) {
  const bar = el(`
    <div class="top-bar">
      <div>${backAction ? `<button type="button" class="btn btn-link" data-back>Back</button>` : ''}</div>
      <div class="player">${state.playerName ? `${escapeHtml(state.playerName)} · <button type="button" class="btn-link" data-change-name style="min-height:auto;padding:0;">Change</button>` : ''}</div>
    </div>
  `);
  if (backAction) bar.querySelector('[data-back]').addEventListener('click', backAction);
  const changeBtn = bar.querySelector('[data-change-name]');
  if (changeBtn) changeBtn.addEventListener('click', showNameGate);
  return bar;
}

// ---------------------------------------------------------------------
// Reward tiers: Bloom's Taxonomy grouped into three tiers (easy =
// Remember+Understand, medium = Apply+Analyze, difficult =
// Evaluate+Create), each worth an increasing marks value rather than just
// a different-colored badge - higher-order recall is visibly worth more.
// ---------------------------------------------------------------------

const MARKS = { easy: 1, medium: 3, difficult: 6 };

// Word Search and Card Grouping take more effort per find than Spelling
// or True/False - hunting a word through a grid, or correctly recalling
// which category a term belongs to among several options, is a harder
// recall task than picking already-isolated letters or making a binary
// guess - so they're worth double the base tier value, not just an equal
// flat mark across every mode.
const MODE_MULTIPLIERS = { wordsearch: 2, spelling: 1, truefalse: 1, grouping: 2 };

function marksForFind(difficulty, mode) {
  return MARKS[difficulty] * MODE_MULTIPLIERS[mode];
}

const MODE_LABELS = { wordsearch: 'Word Search', spelling: 'Spelling', truefalse: 'True/False', grouping: 'Grouping' };

const TOKEN_LABELS = { easy: 'Bronze', medium: 'Silver', difficult: 'Gold' };

const TOKEN_ICONS = {
  easy: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="currentColor" stroke="#3a2b12" stroke-width="0.6"/><circle cx="8" cy="8" r="4" fill="none" stroke="#3a2b12" stroke-width="0.5" opacity="0.5"/></svg>`,
  medium: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="currentColor" stroke="#3a3a3a" stroke-width="0.6"/><circle cx="8" cy="8" r="4" fill="none" stroke="#3a3a3a" stroke-width="0.5" opacity="0.5"/></svg>`,
  difficult: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="currentColor" stroke="#5a4308" stroke-width="0.6"/><circle cx="8" cy="8" r="4" fill="none" stroke="#5a4308" stroke-width="0.5" opacity="0.5"/></svg>`,
};

function tokenBadge(difficulty) {
  const label = `${TOKEN_LABELS[difficulty]} · ${MARKS[difficulty]} mark${MARKS[difficulty] > 1 ? 's' : ''}`;
  return `<span class="token-icon token-${difficulty}" role="img" aria-label="${label}" title="${label}">${TOKEN_ICONS[difficulty] || ''}</span>`;
}

// A celebratory burst of the earned token, growing from the found word out
// to roughly the size of the whole puzzle before fading - only for a
// genuinely self-found/self-spelled entry (earnedMark), never for a "Show
// answer" reveal, so the animation always means the same thing: a mark was
// actually earned.
//
// Appended to `containerEl` itself (never to the found cell/tile), and
// positioned with the anchor element's own offset - a word-search .cell
// needs overflow:hidden (so a long word can't spill into its neighbor),
// which would otherwise clip this animation to invisibility the instant it
// grew past the cell's edge. `containerEl` must have position:relative and
// no overflow clipping of its own.
function popMarkFeedback(containerEl, anchorEl, difficulty) {
  if (!anchorEl) return;
  const pop = document.createElement('div');
  pop.className = `mark-pop mark-pop-${difficulty}`;
  pop.innerHTML = TOKEN_ICONS[difficulty] || '';
  pop.style.left = `${anchorEl.offsetLeft + anchorEl.offsetWidth / 2}px`;
  pop.style.top = `${anchorEl.offsetTop + anchorEl.offsetHeight / 2}px`;
  containerEl.appendChild(pop);
  pop.addEventListener('animationend', () => pop.remove());
}

const FLAG_ICON = `<svg viewBox="0 0 16 16"><path d="M3 1v14M3 1h9l-2 3 2 3H3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

function flagButtonHtml(idx) {
  if (!syncsToBackend()) return '';
  return `<button type="button" class="flag-btn" data-flag="${idx}" title="Report a problem with this term" aria-label="Report a problem with this term">${FLAG_ICON}</button>`;
}

// Wires up every flag button just rendered inside `hintsEl` - called after
// each re-render of the clue list (which rebuilds the panel from scratch,
// so listeners need reattaching every time). `entries` is index-aligned
// with the data-flag index in the markup; `sourceMode` is 'wordsearch' or
// 'spelling', so a curator reviewing flags later knows which mode surfaced
// each one.
function wireFlagButtons(hintsEl, entries, sourceMode) {
  if (!syncsToBackend()) return;
  hintsEl.querySelectorAll('[data-flag]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const entry = entries[Number(btn.dataset.flag)];
      const { ok } = await flagEntry({
        word: entry.word,
        meaning: entry.meaning,
        difficulty: entry.difficulty,
        source_mode: sourceMode,
        flagged_by: state.playerName,
      });
      if (ok) {
        btn.classList.add('flagged');
        btn.title = 'Reported - thank you';
      } else {
        btn.disabled = false; // let them retry
      }
    });
  });
}

// ---------------------------------------------------------------------
// Boot + identity
// ---------------------------------------------------------------------

function loadDrawQueuesForCurrentPlayer() {
  importDrawQueues(getPersistedDrawQueues(state.playerName));
}

async function boot() {
  state.playerName = getPlayerName();
  state.playerId = getPlayerId();
  if (!state.playerName) {
    showNameGate();
    return;
  }
  loadDrawQueuesForCurrentPlayer();
  if (!state.playerId && syncsToBackend()) {
    const result = await ensurePlayer(state.playerName);
    if (result.id) {
      state.playerId = result.id;
      setPlayerId(result.id);
    }
  }
  showHome();
}

function showNameGate() {
  const screen = el(`
    <div class="name-gate">
      <img src="icons/icon.svg" alt="" class="home-logo" width="88" height="88" />
      <h1 class="display">Management Quest</h1>
      <p class="tagline">Recall the values and frameworks from Values-Oriented Management.</p>
      <p>Enter a display name to begin. No password, no account.</p>
      <input type="text" class="text-input" maxlength="40" placeholder="Your name" data-name-input />
      <div class="btn-row" data-begin-row>
        <button type="button" class="btn btn-primary" data-begin>Begin</button>
      </div>
      <div class="resume-notice" data-resume-notice style="display:none;"></div>
    </div>
  `);
  const input = screen.querySelector('[data-name-input]');
  const beginBtn = screen.querySelector('[data-begin]');
  const beginRow = screen.querySelector('[data-begin-row]');
  const noticeEl = screen.querySelector('[data-resume-notice]');
  if (state.playerName) input.value = state.playerName;

  const finish = (name, playerId) => {
    setPlayerName(name);
    state.playerName = name;
    state.playerId = playerId;
    setPlayerId(playerId);
    loadDrawQueuesForCurrentPlayer();
    showHome();
  };

  // Picking up a name that already has history is fine if it's genuinely
  // the same student returning (the common case on a shared classroom
  // laptop), but it's also the one moment a real collision between two
  // different students would be silent otherwise - this pauses to make it
  // visible instead of blocking it, only when the name actually changed.
  const showResumeNotice = (name, playerId) => {
    beginRow.style.display = 'none';
    noticeEl.style.display = 'block';
    noticeEl.innerHTML = `
      <p class="resume-notice-text">"${escapeHtml(name)}" already has scores saved. If that's you, continue - if not, your scores will merge with theirs.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" data-resume-confirm>It's me, continue</button>
        <button type="button" class="btn btn-secondary" data-resume-cancel>Not me, pick another name</button>
      </div>
    `;
    noticeEl.querySelector('[data-resume-confirm]').addEventListener('click', () => finish(name, playerId));
    noticeEl.querySelector('[data-resume-cancel]').addEventListener('click', () => {
      noticeEl.style.display = 'none';
      noticeEl.innerHTML = '';
      beginRow.style.display = 'flex';
      beginBtn.disabled = false;
      input.value = '';
      input.focus();
    });
  };

  const submit = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    beginBtn.disabled = true;
    let playerId = null;
    if (syncsToBackend()) {
      const result = await ensurePlayer(name);
      if (result.status === 'ok' && result.resumed && name !== state.playerName) {
        showResumeNotice(name, result.id);
        return;
      }
      playerId = result.id;
    }
    beginBtn.disabled = false;
    finish(name, playerId);
  };
  beginBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  setScreen(screen);
  input.focus();
}

// ---------------------------------------------------------------------
// Home - exercise-type picker. Each mode is a small self-contained
// descriptor (title/sub/start), so adding a third exercise type later is
// additive here, not a rewrite of this screen.
// ---------------------------------------------------------------------

const MODES = [
  { id: 'wordsearch', title: 'Word Search', sub: 'Drag through the grid to find each hidden term.', start: () => startWordSearch() },
  { id: 'spelling', title: 'Spelling Challenge', sub: 'Unscramble the jumbled letters to spell each term.', start: () => startSpelling() },
  { id: 'truefalse', title: 'True / False', sub: 'Judge whether each claim about a term is true or false.', start: () => startTrueFalse() },
  { id: 'grouping', title: 'Card Grouping', sub: 'Sort terms into the category each one belongs to.', start: () => startGrouping() },
];

function showHome() {
  const screen = el(`
    <div>
      <div class="title-block">
        <img src="icons/icon.svg" alt="" class="home-logo" width="72" height="72" />
        <h1 class="display">Management Quest</h1>
        <p class="tagline">Values-Oriented Management, one recall round at a time.</p>
      </div>
      <p class="tagline" style="text-align:center;">Choose an exercise</p>
      <div class="mode-choice">
        ${MODES.map((m) => `
          <button type="button" class="mode-btn" data-mode="${m.id}">
            <div class="display">${m.title}</div>
            <div class="sub">${m.sub}</div>
          </button>
        `).join('')}
      </div>
      <div class="btn-row" style="margin-top:28px;">
        <button type="button" class="btn btn-secondary" data-scoreboard>Scoreboard</button>
        <button type="button" class="btn btn-secondary" data-about>About</button>
      </div>
    </div>
  `);
  screen.prepend(topBar());
  MODES.forEach((m) => {
    screen.querySelector(`[data-mode="${m.id}"]`).addEventListener('click', m.start);
  });
  screen.querySelector('[data-scoreboard]').addEventListener('click', showScoreboard);
  screen.querySelector('[data-about]').addEventListener('click', showAbout);
  setScreen(screen);
}

function showAbout() {
  const screen = el(`
    <div class="intro-screen">
      <h1 class="display" style="text-align:center;">About Management Quest</h1>
      <p>Management Quest is a recall game built to reinforce what you've learned in class about Values-Oriented Management - core values, ethical frameworks, corporate governance, and more.</p>
      <p>Four exercises draw from the same term list: Word Search, Spelling Challenge, True/False, and Card Grouping.</p>
      <p>Every round mixes easy, medium, and difficult terms. Easy terms are worth 1 mark, medium terms 3 marks, and difficult terms 6 marks - so recognizing a harder concept is worth visibly more than an easy one. Word Search and Card Grouping are worth double these marks per find, since hunting a word through a grid or correctly recalling its category takes more effort than picking an already-visible letter or making a binary guess.</p>
      <p>Find a term yourself to earn its token and marks. Using "Show answer" completes the term but earns nothing, and is always shown in a different color so you can tell a genuine find from a reveal.</p>
      <p>Scores, and time spent playing, sync to a shared class scoreboard. No login is required - just a display name.</p>
      <div class="btn-row" style="margin-top:24px;">
        <button type="button" class="btn btn-primary" data-back>Back</button>
      </div>
    </div>
  `);
  screen.querySelector('[data-back]').addEventListener('click', showHome);
  setScreen(screen);
}

// ---------------------------------------------------------------------
// Word search
// ---------------------------------------------------------------------

const WORDSEARCH_SCOPE = 'wordsearch::general';

function pointerAngleDeg(dr, dc) {
  return (Math.atan2(dr, dc) * 180) / Math.PI;
}

// Smaller grids have more room per cell - scale the letter up to use it,
// instead of a flat size that leaves a small grid's big cells half-empty.
function cellFontSize(gridSize) {
  const rem = Math.min(2.2, Math.max(0.7, 10.5 / gridSize));
  return `${rem.toFixed(2)}rem`;
}

async function startWordSearch() {
  const content = await loadGameContent();
  if (!content) { showContentLoadError(); return; }
  renderWordSearchSession(content.levels[0], content.pool);
}

function renderWordSearchSession(level, pool) {
  const exposure = getWordExposureCounts(WORDSEARCH_SCOPE, state.playerName);
  if (isPoolExhausted(pool, exposure)) {
    showPoolExhausted({
      backAction: showHome,
      switchLabel: 'Try the Spelling Challenge instead',
      onSwitch: startSpelling,
    });
    return;
  }
  const session = buildWordSearchSession(level, pool);
  // The rolled size's eligible words can still come out thin even after
  // sampleWordSearchRound's own escalation attempt - most commonly a
  // beginner stuck at the level's minimum size (which only grows as
  // rounds are actually completed) whose few short words got exposure-
  // capped from repeated regeneration. Rather than render a near-empty
  // grid, point at Spelling Challenge, which has no size constraint.
  if (session.placements.length < 2) {
    showWordSearchTooThin();
    return;
  }
  renderWordSearchGame(session);
}

function buildWordSearchSession(level, pool) {
  const roundsCompleted = getLocalTotals(state.playerName).roundsCompleted;
  const weights = difficultyWeightsForExperience(roundsCompleted);
  const exposure = getWordExposureCounts(WORDSEARCH_SCOPE, state.playerName);
  const { gridSize, entries } = sampleWordSearchRound({
    pool, level, weights, roundsCompleted, exposure, scopeKey: WORDSEARCH_SCOPE,
  });
  setPersistedDrawQueues(exportDrawQueues(), state.playerName);
  recordWordExposures(entries.map((e) => e.word), WORDSEARCH_SCOPE, state.playerName);
  const { grid, placements } = generateGridReliable({
    size: gridSize,
    entries,
    fillerMode: level.fillerMode,
    fillerPool: LATIN_POOL,
  });
  return {
    level,
    pool,
    gridSize,
    grid,
    placements: placements.map((p) => ({ ...p, found: false, earnedMark: false })),
  };
}

function renderWordSearchGame(session) {
  const { gridSize } = session;
  const screen = el(`
    <div>
      <h2 style="text-align:center;">Word Search · ${gridSize}×${gridSize}</h2>
      <p class="tagline" style="text-align:center;">Drag across letters - any of the 8 directions - to find each term below.</p>
      <div class="grid-frame">
        <div class="grid" data-grid style="grid-template-columns:repeat(${gridSize}, 1fr); --cell-font-size:${cellFontSize(gridSize)};"></div>
      </div>
      <div class="game-toolbar">
        <button type="button" class="btn btn-secondary" data-new-puzzle>New puzzle</button>
        <button type="button" class="btn btn-secondary" data-show-answer>Show answer</button>
      </div>
      <div class="hints-panel">
        <h3>Clues</h3>
        ${syncsToBackend() ? `<p class="flag-hint-note">See a wrong or confusing clue? Tap the flag to report it.</p>` : ''}
        <div data-hints></div>
      </div>
    </div>
  `);
  screen.prepend(topBar({ backAction: showHome }));

  const gridEl = screen.querySelector('[data-grid]');
  const hintsEl = screen.querySelector('[data-hints]');
  const toolbarEl = screen.querySelector('.game-toolbar');
  const cellEls = [];

  for (let r = 0; r < gridSize; r++) {
    const row = [];
    for (let c = 0; c < gridSize; c++) {
      const cellEl = el(`<div class="cell" data-r="${r}" data-c="${c}">${session.grid[r][c]}</div>`);
      gridEl.appendChild(cellEl);
      row.push(cellEl);
    }
    cellEls.push(row);
  }

  function renderHints() {
    hintsEl.innerHTML = '';
    session.placements.forEach((p, idx) => {
      const item = el(`
        <div class="hint-item ${p.found ? 'found' : 'pending'}">
          <span class="hint-word">${p.letters.join('')}</span>
          ${tokenBadge(p.entry.difficulty)}
          <span class="hint-meaning">${escapeHtml(p.entry.meaning)} <span class="hint-count">${p.letters.length} letters</span></span>
          ${flagButtonHtml(idx)}
        </div>
      `);
      hintsEl.appendChild(item);
    });
    wireFlagButtons(hintsEl, session.placements.map((p) => p.entry), 'wordsearch');
  }
  renderHints();

  let lastSelected = [];
  function highlightSelection(path) {
    lastSelected.forEach(({ r, c }) => cellEls[r][c].classList.remove('selected'));
    path.forEach(({ r, c }) => cellEls[r][c].classList.add('selected'));
    lastSelected = path;
  }

  // A small arrow on the last-selected cell showing which way the drag is
  // currently heading - purely the geometry of the drag, not a hint toward
  // any answer.
  let pointerCell = null;
  function updateDirectionPointer(path) {
    if (pointerCell) {
      pointerCell.classList.remove('direction-pointer');
      pointerCell.style.removeProperty('--pointer-angle');
      pointerCell = null;
    }
    if (path.length < 2) return;
    const [a, b] = path;
    const dr = Math.sign(b.r - a.r);
    const dc = Math.sign(b.c - a.c);
    const last = path[path.length - 1];
    pointerCell = cellEls[last.r][last.c];
    pointerCell.style.setProperty('--pointer-angle', `${pointerAngleDeg(dr, dc)}deg`);
    pointerCell.classList.add('direction-pointer');
  }

  function markFound(placement, viaHint) {
    placement.found = true;
    placement.earnedMark = !viaHint;
    placement.cells.forEach(([r, c]) => {
      cellEls[r][c].classList.add('found');
      if (viaHint) cellEls[r][c].classList.add('via-hint');
    });
    if (placement.earnedMark) {
      const [mr, mc] = placement.cells[Math.floor(placement.cells.length / 2)];
      popMarkFeedback(gridEl, cellEls[mr]?.[mc], placement.entry.difficulty);
    }
    renderHints();
    checkRoundComplete();
  }

  function flashWrong(path) {
    path.forEach(({ r, c }) => cellEls[r][c].classList.add('wrong'));
    setTimeout(() => {
      path.forEach(({ r, c }) => cellEls[r][c].classList.remove('wrong'));
    }, 400);
  }

  function checkRoundComplete() {
    if (!session.placements.every((p) => p.found)) return;
    recordWordSearchProgress(session);
    toolbarEl.innerHTML = '';
    const continueBtn = el(`<button type="button" class="btn btn-primary" data-round-continue>Continue</button>`);
    continueBtn.addEventListener('click', () => showRoundComplete({ onContinue: () => renderWordSearchSession(session.level, session.pool) }));
    toolbarEl.appendChild(continueBtn);
  }

  attachTracer(gridEl, {
    onDragStart: (path) => { highlightSelection(path); updateDirectionPointer(path); },
    onDragUpdate: (path) => { highlightSelection(path); updateDirectionPointer(path); },
    onDragEnd: (path) => {
      highlightSelection([]);
      updateDirectionPointer([]);
      if (path.length < 2) return;
      const { forward, reversed } = pathToStrings(path, session.grid);
      const match = session.placements.find((p) => {
        if (p.found) return false;
        const word = p.letters.join('');
        return word === forward || word === reversed;
      });
      if (match) {
        markFound(match);
      } else {
        flashWrong(path);
      }
    },
  });

  screen.querySelector('[data-new-puzzle]').addEventListener('click', () => {
    renderWordSearchSession(session.level, session.pool);
  });
  screen.querySelector('[data-show-answer]').addEventListener('click', () => {
    const target = session.placements.find((p) => !p.found);
    if (target) markFound(target, true);
  });

  setScreen(screen, { tracked: true });
}

function tallyRound(items, mode) {
  const tokenCounts = { easy: 0, medium: 0, difficult: 0 };
  let marksEarned = 0;
  for (const item of items) {
    if (item.earnedMark) {
      tokenCounts[item.entry.difficulty] += 1;
      marksEarned += marksForFind(item.entry.difficulty, mode);
    }
  }
  return {
    entries_found: items.length,
    bronze_found: tokenCounts.easy,
    silver_found: tokenCounts.medium,
    gold_found: tokenCounts.difficult,
    marks_earned: marksEarned,
  };
}

function recordWordSearchProgress(session) {
  const progress = { mode: 'wordsearch', ...tallyRound(session.placements, 'wordsearch') };
  recordRoundProgressLocal(progress, state.playerName);
  if (state.playerId && syncsToBackend()) syncQuestProgress(state.playerId, progress);
}

// ---------------------------------------------------------------------
// Spelling challenge
// ---------------------------------------------------------------------

const SPELLING_SCOPE = 'spelling::general';

async function startSpelling() {
  const content = await loadGameContent();
  if (!content) { showContentLoadError(); return; }
  renderSpellingSession(content.levels[0], content.pool);
}

function renderSpellingSession(level, pool) {
  const exposure = getWordExposureCounts(SPELLING_SCOPE, state.playerName);
  if (isPoolExhausted(pool, exposure)) {
    showPoolExhausted({
      backAction: showHome,
      switchLabel: 'Try the Word Search instead',
      onSwitch: startWordSearch,
    });
    return;
  }
  renderSpellingGame(buildSpellingSession(level, pool));
}

function buildSpellingSession(level, pool) {
  const roundsCompleted = getLocalTotals(state.playerName).roundsCompleted;
  const weights = difficultyWeightsForExperience(roundsCompleted);
  const exposure = getWordExposureCounts(SPELLING_SCOPE, state.playerName);
  const items = sampleSpellingRound({
    pool, level, weights, roundsCompleted, exposure, scopeKey: SPELLING_SCOPE,
  });
  setPersistedDrawQueues(exportDrawQueues(), state.playerName);
  recordWordExposures(items.map((i) => i.entry.word), SPELLING_SCOPE, state.playerName);
  return { level, pool, items, current: 0 };
}

function renderSpellingGame(session) {
  const screen = el(`
    <div>
      <h2 style="text-align:center;">Spelling Challenge</h2>
      <p class="tagline" style="text-align:center;" data-progress></p>
      <div class="spelling-frame">
        <p class="spelling-meaning" data-meaning></p>
        <div class="spelling-answer" data-answer></div>
        <div class="spelling-tiles" data-tiles></div>
      </div>
      <div class="game-toolbar">
        <button type="button" class="btn btn-secondary" data-undo>Undo letter</button>
        <button type="button" class="btn btn-secondary" data-show-answer>Show answer</button>
      </div>
      ${syncsToBackend() ? `<p class="flag-hint-note" style="text-align:center;">See a wrong or confusing clue? <button type="button" class="btn-link" data-flag-current style="min-height:auto;padding:0;">Report it</button></p>` : ''}
    </div>
  `);
  screen.prepend(topBar({ backAction: showHome }));

  const progressEl = screen.querySelector('[data-progress]');
  const meaningEl = screen.querySelector('[data-meaning]');
  const answerEl = screen.querySelector('[data-answer]');
  const tilesEl = screen.querySelector('[data-tiles]');
  const flagBtn = screen.querySelector('[data-flag-current]');
  const undoBtn = screen.querySelector('[data-undo]');

  let typed = []; // indices into item.scrambled, in chosen order
  let locked = false; // true briefly while showing a correct/wrong/revealed result

  function currentItem() {
    return session.items[session.current];
  }

  function renderProgress() {
    progressEl.textContent = `Term ${session.current + 1} of ${session.items.length}`;
  }

  function renderMeaning() {
    const item = currentItem();
    meaningEl.textContent = item.entry.meaning;
  }

  function renderAnswer() {
    const item = currentItem();
    const cells = item.letters.map((_, i) => {
      const tileIdx = typed[i];
      const letter = tileIdx !== undefined ? item.scrambled[tileIdx] : '';
      const revealedClass = item.found && !item.earnedMark ? ' via-hint' : '';
      const filledClass = letter ? ' filled' : '';
      return `<span class="answer-slot${filledClass}${revealedClass}">${letter}</span>`;
    }).join('');
    answerEl.innerHTML = cells;
  }

  function renderTiles() {
    const item = currentItem();
    tilesEl.innerHTML = '';
    item.scrambled.forEach((letter, idx) => {
      const used = typed.includes(idx);
      const btn = el(`<button type="button" class="letter-tile${used ? ' used' : ''}" data-tile="${idx}" ${used || locked ? 'disabled' : ''}>${letter}</button>`);
      if (!used && !locked) {
        btn.addEventListener('click', () => onTileTap(idx));
      }
      tilesEl.appendChild(btn);
    });
  }

  function renderAll() {
    renderProgress();
    renderMeaning();
    renderAnswer();
    renderTiles();
  }

  function onTileTap(idx) {
    if (locked) return;
    typed.push(idx);
    renderAnswer();
    renderTiles();
    const item = currentItem();
    if (typed.length === item.letters.length) {
      checkAnswer();
    }
  }

  undoBtn.addEventListener('click', () => {
    if (locked || !typed.length) return;
    typed.pop();
    renderAnswer();
    renderTiles();
  });

  function checkAnswer() {
    const item = currentItem();
    const built = typed.map((i) => item.scrambled[i]).join('');
    if (built === item.entry.word) {
      markFound(false);
    } else {
      locked = true;
      answerEl.classList.add('wrong');
      setTimeout(() => {
        answerEl.classList.remove('wrong');
        typed = [];
        locked = false;
        renderAnswer();
        renderTiles();
      }, 500);
    }
  }

  function markFound(viaHint) {
    const item = currentItem();
    item.found = true;
    item.earnedMark = !viaHint;
    if (viaHint) {
      // Rebuild typed as the scrambled tile indices, in an order that
      // spells the target word - tracked by tile identity (index), not by
      // letter value, since a word like MERITOCRACY repeats letters.
      typed = [];
      const usedIdx = new Set();
      for (const letter of item.letters) {
        const idx = item.scrambled.findIndex((l, i) => l === letter && !usedIdx.has(i));
        usedIdx.add(idx);
        typed.push(idx);
      }
    }
    locked = true;
    renderAnswer();
    renderTiles();
    if (item.earnedMark) {
      const answerBox = answerEl;
      popMarkFeedback(answerBox.parentElement, answerBox, item.entry.difficulty);
    }
    setTimeout(advance, 900);
  }

  function advance() {
    if (session.current + 1 < session.items.length) {
      session.current += 1;
      typed = [];
      locked = false;
      renderAll();
    } else {
      recordSpellingProgress(session);
      showRoundComplete({ onContinue: () => renderSpellingSession(session.level, session.pool) });
    }
  }

  screen.querySelector('[data-show-answer]').addEventListener('click', () => {
    if (locked) return;
    markFound(true);
  });

  if (flagBtn) {
    flagBtn.addEventListener('click', async () => {
      if (flagBtn.disabled) return;
      flagBtn.disabled = true;
      const item = currentItem();
      const { ok } = await flagEntry({
        word: item.entry.word,
        meaning: item.entry.meaning,
        difficulty: item.entry.difficulty,
        source_mode: 'spelling',
        flagged_by: state.playerName,
      });
      flagBtn.textContent = ok ? 'Reported - thank you' : 'Report it';
      if (!ok) flagBtn.disabled = false;
    });
  }

  renderAll();
  setScreen(screen, { tracked: true });
}

function recordSpellingProgress(session) {
  const progress = { mode: 'spelling', ...tallyRound(session.items, 'spelling') };
  recordRoundProgressLocal(progress, state.playerName);
  if (state.playerId && syncsToBackend()) syncQuestProgress(state.playerId, progress);
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------
// True / False
// ---------------------------------------------------------------------

const TRUEFALSE_SCOPE = 'truefalse::general';
const TRUEFALSE_ROUND_SIZE = 8;

async function startTrueFalse() {
  const content = await loadGameContent();
  if (!content) { showContentLoadError(); return; }
  renderTrueFalseSession(content.pool);
}

function renderTrueFalseSession(pool) {
  const exposure = getWordExposureCounts(TRUEFALSE_SCOPE, state.playerName);
  if (isPoolExhausted(pool, exposure)) {
    showPoolExhausted({
      backAction: showHome,
      switchLabel: 'Try Word Search instead',
      onSwitch: startWordSearch,
    });
    return;
  }
  renderTrueFalseGame(buildTrueFalseSession(pool));
}

function buildTrueFalseSession(pool) {
  const roundsCompleted = getLocalTotals(state.playerName).roundsCompleted;
  const weights = difficultyWeightsForExperience(roundsCompleted);
  const exposure = getWordExposureCounts(TRUEFALSE_SCOPE, state.playerName);
  const claims = sampleTrueFalseRound({
    pool, weights, roundsCompleted, exposure, scopeKey: TRUEFALSE_SCOPE, count: TRUEFALSE_ROUND_SIZE,
  });
  setPersistedDrawQueues(exportDrawQueues(), state.playerName);
  recordWordExposures(claims.map((c) => c.entry.word), TRUEFALSE_SCOPE, state.playerName);
  return { pool, claims };
}

function renderTrueFalseGame(session) {
  const screen = el(`
    <div>
      <h2 style="text-align:center;">True / False</h2>
      <p class="tagline" style="text-align:center;">Read each claim and decide: true or false?</p>
      <div data-cards></div>
      <div class="game-toolbar" data-toolbar></div>
    </div>
  `);
  screen.prepend(topBar({ backAction: showHome }));

  const cardsEl = screen.querySelector('[data-cards]');
  const toolbarEl = screen.querySelector('[data-toolbar]');
  const answered = new Map(); // index -> 'self' | 'wrong' | 'shown'

  session.claims.forEach((claim, idx) => {
    const card = el(`
      <div class="tf-card" data-card="${idx}">
        <p class="tf-term">Term: <strong>${escapeHtml(claim.entry.word)}</strong> ${tokenBadge(claim.entry.difficulty)}</p>
        <p class="tf-claim">${escapeHtml(claim.claimText)}</p>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" data-answer="true">True</button>
          <button type="button" class="btn btn-primary" data-answer="false">False</button>
          <button type="button" class="btn btn-secondary" data-show>Show answer</button>
          ${flagButtonHtml(0)}
        </div>
        <p class="tf-feedback" data-feedback></p>
      </div>
    `);
    cardsEl.appendChild(card);

    function lock() {
      card.querySelectorAll('button:not(.flag-btn)').forEach((b) => { b.disabled = true; });
    }

    function settle(outcome, message) {
      if (answered.has(idx)) return;
      answered.set(idx, outcome);
      lock();
      card.querySelector('[data-feedback]').textContent = message;
      card.classList.add(outcome === 'self' ? 'tf-correct' : outcome === 'wrong' ? 'tf-wrong' : 'tf-shown');
      if (outcome === 'self') {
        claim.found = true;
        claim.earnedMark = true;
        popMarkFeedback(cardsEl, card, claim.entry.difficulty);
      } else if (outcome === 'shown') {
        claim.found = true;
        claim.earnedMark = false;
      }
      checkRoundComplete();
    }

    card.querySelector('[data-answer="true"]').addEventListener('click', () => {
      const correct = claim.isTrue === true;
      settle(correct ? 'self' : 'wrong', correct ? 'Correct - this claim is true.' : 'Not quite - this claim is actually false.');
    });
    card.querySelector('[data-answer="false"]').addEventListener('click', () => {
      const correct = claim.isTrue === false;
      settle(correct ? 'self' : 'wrong', correct ? 'Correct - this claim is false.' : 'Not quite - this claim is actually true.');
    });
    card.querySelector('[data-show]').addEventListener('click', () => {
      settle('shown', `Shown - this claim is actually ${claim.isTrue ? 'true' : 'false'}. No marks earned.`);
    });

    wireFlagButtons(card, [claim.entry], 'truefalse');
  });

  function checkRoundComplete() {
    if (answered.size < session.claims.length) return;
    recordTrueFalseProgress(session);
    toolbarEl.innerHTML = '';
    const continueBtn = el(`<button type="button" class="btn btn-primary" data-round-continue>Continue</button>`);
    continueBtn.addEventListener('click', () => showRoundComplete({ onContinue: () => renderTrueFalseSession(session.pool) }));
    toolbarEl.appendChild(continueBtn);
  }

  setScreen(screen, { tracked: true });
}

function recordTrueFalseProgress(session) {
  const progress = { mode: 'truefalse', ...tallyRound(session.claims, 'truefalse') };
  recordRoundProgressLocal(progress, state.playerName);
  if (state.playerId && syncsToBackend()) syncQuestProgress(state.playerId, progress);
}

// ---------------------------------------------------------------------
// Card Grouping
// ---------------------------------------------------------------------

const GROUPING_SCOPE = 'grouping::general';

// `source` is curator-only metadata everywhere else (never shown to
// players), but Card Grouping's categories ARE that field, shown directly
// as bucket titles - so a curator's compact tag doubles as a player-facing
// label here. This content's convention is "topicN-slug" (e.g.
// "topic3-neoclassical"); stripping that prefix and title-casing what's
// left turns it into a presentable label without hardcoding this course's
// specific topic names - any source that doesn't match the pattern just
// gets title-cased as a whole, a reasonable fallback either way. Only
// affects the DISPLAYED title; matching logic still uses the raw source.
function prettifySource(source) {
  return source
    .replace(/^topic\d+-/, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function startGrouping() {
  const content = await loadGameContent();
  if (!content) { showContentLoadError(); return; }
  renderGroupingSession(content.pool);
}

function renderGroupingSession(pool) {
  const exposure = getWordExposureCounts(GROUPING_SCOPE, state.playerName);
  const categories = sampleGroupingRound({ pool, exposure });
  if (!categories) {
    showPoolExhausted({
      backAction: showHome,
      switchLabel: 'Try Word Search instead',
      onSwitch: startWordSearch,
    });
    return;
  }
  const allWords = categories.flatMap((cat) => cat.cards.map((e) => e.word));
  recordWordExposures(allWords, GROUPING_SCOPE, state.playerName);
  renderGroupingGame({ pool, categories });
}

function renderGroupingGame(session) {
  const { categories } = session;
  const screen = el(`
    <div>
      <h2 style="text-align:center;">Card Grouping</h2>
      <p class="tagline" style="text-align:center;">Tap a term, then tap the category it belongs to.</p>
      <div class="grouping-buckets" data-buckets>
        ${categories.map((cat) => `
          <div class="bucket" data-bucket="${escapeHtml(cat.source)}">
            <h4 class="bucket-title">${escapeHtml(prettifySource(cat.source))}</h4>
            <div class="bucket-slot" data-slot="${escapeHtml(cat.source)}"></div>
          </div>
        `).join('')}
      </div>
      <div class="card-tray" data-tray></div>
      <div class="game-toolbar" data-toolbar>
        <button type="button" class="btn btn-secondary" data-show-answer>Show answer</button>
      </div>
    </div>
  `);
  screen.prepend(topBar({ backAction: showHome }));

  const bucketsEl = screen.querySelector('[data-buckets]');
  const trayEl = screen.querySelector('[data-tray]');
  const toolbarEl = screen.querySelector('[data-toolbar]');

  const cardMeta = new Map(); // word -> { entry, correctSource, earnedMark }
  for (const cat of categories) {
    for (const entry of cat.cards) {
      cardMeta.set(entry.word, { entry, correctSource: cat.source, earnedMark: false });
    }
  }

  shuffleArray([...cardMeta.keys()]).forEach((word) => {
    const btn = el(`<button type="button" class="card" data-word="${escapeHtml(word)}">${escapeHtml(word)}</button>`);
    trayEl.appendChild(btn);
  });

  let selectedWord = null;
  const placed = new Set();

  function setSelected(word) {
    selectedWord = word;
    trayEl.querySelectorAll('.card').forEach((btn) => btn.classList.toggle('selected', btn.dataset.word === word));
  }

  trayEl.querySelectorAll('.card').forEach((btn) => {
    btn.addEventListener('click', () => setSelected(btn.dataset.word === selectedWord ? null : btn.dataset.word));
  });

  bucketsEl.querySelectorAll('.bucket').forEach((bucketEl) => {
    bucketEl.addEventListener('click', () => attemptPlacement(bucketEl.dataset.bucket));
  });

  function placeCard(word, { viaHint }) {
    const meta = cardMeta.get(word);
    const cardBtn = trayEl.querySelector(`[data-word="${word}"]`);
    const slotEl = bucketsEl.querySelector(`[data-slot="${meta.correctSource}"]`);
    placed.add(word);
    cardBtn?.remove();
    const chip = el(`<div class="placed-chip${viaHint ? ' placed-chip--shown' : ''}">${escapeHtml(word)}</div>`);
    slotEl.appendChild(chip);
    meta.earnedMark = !viaHint;
    if (!viaHint) popMarkFeedback(bucketsEl, slotEl, meta.entry.difficulty);
    if (selectedWord === word) selectedWord = null;
    checkRoundComplete();
  }

  function attemptPlacement(bucketSource) {
    if (!selectedWord) return;
    const meta = cardMeta.get(selectedWord);
    if (meta.correctSource === bucketSource) {
      placeCard(selectedWord, { viaHint: false });
    } else {
      const bucketEl = bucketsEl.querySelector(`[data-bucket="${bucketSource}"]`);
      bucketEl.classList.add('bucket-wrong');
      setTimeout(() => bucketEl.classList.remove('bucket-wrong'), 400);
    }
  }

  toolbarEl.querySelector('[data-show-answer]').addEventListener('click', () => {
    const remaining = [...cardMeta.keys()].find((w) => !placed.has(w));
    if (remaining) placeCard(remaining, { viaHint: true });
  });

  function checkRoundComplete() {
    if (placed.size < cardMeta.size) return;
    recordGroupingProgress(cardMeta);
    toolbarEl.innerHTML = '';
    const continueBtn = el(`<button type="button" class="btn btn-primary" data-round-continue>Continue</button>`);
    continueBtn.addEventListener('click', () => showRoundComplete({ onContinue: () => renderGroupingSession(session.pool) }));
    toolbarEl.appendChild(continueBtn);
  }

  setScreen(screen, { tracked: true });
}

function recordGroupingProgress(cardMeta) {
  const items = [...cardMeta.values()].map((meta) => ({ entry: meta.entry, earnedMark: meta.earnedMark }));
  const progress = { mode: 'grouping', ...tallyRound(items, 'grouping') };
  recordRoundProgressLocal(progress, state.playerName);
  if (state.playerId && syncsToBackend()) syncQuestProgress(state.playerId, progress);
}

// ---------------------------------------------------------------------
// Content loading
// ---------------------------------------------------------------------

// Fetches the level ladder and content pool for either exercise type,
// returning null (rather than throwing or silently proceeding) if either
// request fails or comes back empty. Building a round from an empty pool
// used to fail silently - a grid of pure filler letters with an empty
// clue panel, which looks like broken content rather than a network
// error. Surfacing it as showContentLoadError() instead means a real
// fetch failure is never mistaken for "there's nothing to find here."
async function loadGameContent() {
  try {
    const [levels, pool] = await Promise.all([loadLevels(), loadEntryPool()]);
    if (!pool || !pool.length || !levels || !levels.length) {
      console.warn('Content loaded but empty:', { pool, levels });
      return null;
    }
    return { levels, pool };
  } catch (err) {
    console.warn('Failed to load content:', err);
    return null;
  }
}

function showContentLoadError() {
  const screen = el(`
    <div class="complete-screen">
      <div class="glow">⚠️</div>
      <h2>Couldn't load the term list</h2>
      <p>Something prevented the content from loading - usually a temporary network hiccup. Try refreshing the page.</p>
      <div class="btn-row" style="margin-top:24px;">
        <button type="button" class="btn btn-primary" data-retry>Refresh</button>
      </div>
    </div>
  `);
  screen.querySelector('[data-retry]').addEventListener('click', () => location.reload());
  setScreen(screen);
}

// ---------------------------------------------------------------------
// Shared round-complete / pool-exhausted screens
// ---------------------------------------------------------------------

function showRoundComplete({ onContinue }) {
  const screen = el(`
    <div class="complete-screen">
      <div class="glow">🎯</div>
      <h2>Round complete</h2>
      <p>Every term found. Ready for another round?</p>
      <div class="btn-row" style="margin-top:24px;">
        <button type="button" class="btn btn-primary" data-continue>Next round</button>
        <button type="button" class="btn btn-secondary" data-home>Home</button>
      </div>
    </div>
  `);
  screen.querySelector('[data-continue]').addEventListener('click', onContinue);
  screen.querySelector('[data-home]').addEventListener('click', showHome);
  setScreen(screen);
}

// Shared "you've run out of not-yet-maxed words" screen for both exercise
// types.
function showPoolExhausted({ backAction, switchLabel, onSwitch }) {
  const screen = el(`
    <div class="complete-screen">
      <div class="glow">🌱</div>
      <h2>You've seen everything here</h2>
      <p>You've been asked every term in this exercise enough times for now. Try switching to the other exercise, or come back later once more content is added.</p>
      <div class="btn-row" style="margin-top:24px;">
        <button type="button" class="btn btn-primary" data-switch>${switchLabel}</button>
        <button type="button" class="btn btn-secondary" data-back>Back</button>
      </div>
    </div>
  `);
  screen.querySelector('[data-switch]').addEventListener('click', onSwitch);
  screen.querySelector('[data-back]').addEventListener('click', backAction);
  setScreen(screen);
}

// Distinct from showPoolExhausted (the whole pool is used up): this fires
// when the rolled grid size's eligible words came out thin even after
// sampleWordSearchRound's own escalation attempt - typically a beginner
// stuck at the level's minimum size (which only grows as rounds are
// actually completed) whose few short words got exposure-capped from
// repeated regeneration. Points at Spelling Challenge, which has no size
// constraint, rather than leaving them stuck regenerating an ever-emptier
// grid.
function showWordSearchTooThin() {
  const screen = el(`
    <div class="complete-screen">
      <div class="glow">🧩</div>
      <h2>Running low on short terms right now</h2>
      <p>The terms that fit the current grid size have been asked a lot already. Try the Spelling Challenge instead - it isn't limited by grid size - or complete a round or two here first so the grid can grow.</p>
      <div class="btn-row" style="margin-top:24px;">
        <button type="button" class="btn btn-primary" data-switch>Try the Spelling Challenge</button>
        <button type="button" class="btn btn-secondary" data-back>Back</button>
      </div>
    </div>
  `);
  screen.querySelector('[data-switch]').addEventListener('click', startSpelling);
  screen.querySelector('[data-back]').addEventListener('click', showHome);
  setScreen(screen);
}

// ---------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------

// Renders a whole number of seconds as a compact "1h 24m" / "12m 05s" /
// "43s" string - matches marks/tokens in being a plain read at a glance,
// not a precise stopwatch reading.
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function showScoreboard() {
  const screen = el(`
    <div>
      <h2 style="text-align:center;">Scoreboard</h2>
      <p class="tagline" style="text-align:center;">The whole class's progress, updated live.</p>
      <div class="score-section">
        <p class="token-legend">${tokenBadge('easy')} = 1 mark &nbsp; ${tokenBadge('medium')} = 3 marks &nbsp; ${tokenBadge('difficult')} = 6 marks. Word Search and Card Grouping earn double these marks per find; Spelling and True/False earn the base value. "Show answer" earns neither a token nor marks. Click a column heading to sort by it.</p>
        <div data-quest-board>Loading…</div>
      </div>
      ${syncsToBackend() ? `
      <div class="score-section">
        <h3>Flagged terms</h3>
        <p class="tagline">Reported by players - review and fix the content, then this list clears on its own next time it's re-fetched from a fixed pool.</p>
        <div data-flagged-board>Loading…</div>
      </div>` : `<p class="score-note">No Supabase project is configured, so this scoreboard is offline. Scores are still tracked on this device.</p>`}
    </div>
  `);
  screen.prepend(topBar({ backAction: showHome }));
  setScreen(screen);

  const questBoardEl = screen.querySelector('[data-quest-board]');
  const flaggedBoardEl = screen.querySelector('[data-flagged-board]');

  if (syncsToBackend()) {
    const [rows, flaggedRows] = await Promise.all([fetchQuestLeaderboard(), fetchFlaggedEntries()]);
    const activeRows = (rows || []).filter((row) => (row.total_marks ?? 0) > 0 || (row.rounds_completed ?? 0) > 0);
    questBoardEl.replaceWith(renderLeaderboardTable(
      activeRows,
      [
        { key: 'display_name', label: 'Name', numeric: false },
        { key: 'total_bronze', label: `${tokenBadge('easy')} Bronze` },
        { key: 'total_silver', label: `${tokenBadge('medium')} Silver` },
        { key: 'total_gold', label: `${tokenBadge('difficult')} Gold` },
        { key: 'wordsearch_marks', label: 'Word Search' },
        { key: 'spelling_marks', label: 'Spelling' },
        { key: 'truefalse_marks', label: 'True/False' },
        { key: 'grouping_marks', label: 'Grouping' },
        { key: 'total_marks', label: 'Marks' },
        { key: 'rounds_completed', label: 'Rounds' },
        { key: 'total_time_seconds', label: 'Time', format: formatDuration },
      ],
      'data-quest-board',
      { defaultSortKey: 'total_marks' }
    ));
    if (flaggedBoardEl) {
      const flaggedFormatted = (flaggedRows || []).map((row) => ({
        ...row,
        source_label: MODE_LABELS[row.source_mode] || row.source_mode,
        flagged_at: new Date(row.created_at).toLocaleString(),
      }));
      flaggedBoardEl.replaceWith(renderLeaderboardTable(
        flaggedFormatted,
        [
          { key: 'word', label: 'Term', numeric: false },
          { key: 'meaning', label: 'Meaning', numeric: false },
          { key: 'source_label', label: 'Mode', numeric: false },
          { key: 'flagged_by', label: 'Flagged by', numeric: false },
          { key: 'flagged_at', label: 'When', numeric: false },
        ],
        'data-flagged-board',
        { limit: 10, emptyMessage: 'No flagged terms - nice.', defaultSortKey: 'flagged_at' }
      ));
    }
  }
}

// `columns`: [{ key, label, numeric = true, sortable = true, format }].
// Sorting is entirely client-side over whatever page of rows was already
// fetched - fine at classroom scale, and keeps the Supabase side to one
// simple view rather than needing a sortable query API.
function renderLeaderboardTable(rows, columns, dataAttr, { limit = 10, emptyMessage = 'No scores yet - be the first!', defaultSortKey = null, defaultSortDir = 'desc' } = {}) {
  if (!rows || !rows.length) {
    return el(`<div ${dataAttr}><p class="score-note">${emptyMessage}</p></div>`);
  }
  let expanded = false;
  let sortKey = defaultSortKey || columns[0].key;
  let sortDir = defaultSortDir;
  const wrap = el(`<div ${dataAttr}></div>`);

  function sortedRows() {
    const col = columns.find((c) => c.key === sortKey);
    const numeric = col?.numeric !== false;
    const sorted = rows.slice().sort((a, b) => {
      const av = a[sortKey] ?? (numeric ? 0 : '');
      const bv = b[sortKey] ?? (numeric ? 0 : '');
      return numeric ? (av - bv) : String(av).localeCompare(String(bv));
    });
    if (sortDir === 'desc') sorted.reverse();
    return sorted;
  }

  const renderInner = () => {
    const visibleRows = sortedRows().slice(0, expanded ? rows.length : limit);
    const header = columns.map((c) => {
      if (c.sortable === false) return `<th>${c.label}</th>`;
      const isSorted = c.key === sortKey;
      const arrow = isSorted ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';
      return `<th class="sortable${isSorted ? ' sorted' : ''}" data-sort-key="${c.key}">${c.label}${arrow}</th>`;
    }).join('');
    // Rows come straight from the shared Supabase leaderboard views - any
    // player's own chosen display_name ends up here, so it must be escaped
    // like any other untrusted input before going into innerHTML.
    const body = visibleRows.map((row) => `<tr>${columns.map((c) => {
      const raw = row[c.key] ?? (c.numeric === false ? '' : 0);
      return `<td>${escapeHtml(c.format ? c.format(raw) : raw)}</td>`;
    }).join('')}</tr>`).join('');
    const toggle = rows.length > limit
      ? `<p class="score-toggle"><button type="button" class="btn-link" data-toggle>${expanded ? 'Show less' : 'Show more'}</button></p>`
      : '';
    wrap.innerHTML = `
      <div class="table-scroll">
        <table class="score-table">
          <thead><tr>${header}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${toggle}
    `;
    wrap.querySelectorAll('[data-sort-key]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortKey;
        if (sortKey === key) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
        else { sortKey = key; sortDir = 'desc'; }
        renderInner();
      });
    });
    const toggleBtn = wrap.querySelector('[data-toggle]');
    if (toggleBtn) toggleBtn.addEventListener('click', () => { expanded = !expanded; renderInner(); });
  };
  renderInner();
  return wrap;
}

// ---------------------------------------------------------------------

// Best-effort: a closed tab can't guarantee an async Supabase write
// completes, but the local tally (a synchronous localStorage write) is
// always safe, and the sync attempt costs nothing to try.
window.addEventListener('beforeunload', flushPlayTimer);

boot();
