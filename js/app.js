import {
  entryCountForGridSize, gridSizeCapForExperience, sampleWordSearchRound,
  generateGridReliable, LATIN_POOL,
} from './wordsearch.js';
import { sampleSpellingRound } from './spelling.js';
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
} from './storage.js';
import {
  isBackendConfigured, ensurePlayer, syncQuestProgress,
  fetchQuestLeaderboard, flagEntry, fetchFlaggedEntries,
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

function setScreen(node) {
  root.innerHTML = '';
  root.appendChild(node);
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
];

function showHome() {
  const screen = el(`
    <div>
      <div class="title-block">
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
      <p>Every round mixes easy, medium, and difficult terms. Easy terms are worth 1 mark, medium terms 3 marks, and difficult terms 6 marks - so recognizing a harder concept is worth visibly more than an easy one.</p>
      <p>Find a term yourself by dragging or spelling it to earn its token and marks. Using "Show answer" completes the term but earns nothing, and is always shown in a different color so you can tell a genuine find from a reveal.</p>
      <p>Scores sync to a shared class scoreboard. No login is required - just a display name.</p>
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
  const [levels, pool] = await Promise.all([loadLevels(), loadEntryPool()]);
  renderWordSearchSession(levels[0], pool);
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
  renderWordSearchGame(buildWordSearchSession(level, pool));
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

  setScreen(screen);
}

function tallyRound(items) {
  const tokenCounts = { easy: 0, medium: 0, difficult: 0 };
  let marksEarned = 0;
  for (const item of items) {
    if (item.earnedMark) {
      tokenCounts[item.entry.difficulty] += 1;
      marksEarned += MARKS[item.entry.difficulty];
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
  const progress = { mode: 'wordsearch', ...tallyRound(session.placements) };
  recordRoundProgressLocal(progress, state.playerName);
  if (state.playerId && syncsToBackend()) syncQuestProgress(state.playerId, progress);
}

// ---------------------------------------------------------------------
// Spelling challenge
// ---------------------------------------------------------------------

const SPELLING_SCOPE = 'spelling::general';

async function startSpelling() {
  const [levels, pool] = await Promise.all([loadLevels(), loadEntryPool()]);
  renderSpellingSession(levels[0], pool);
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
  setScreen(screen);
}

function recordSpellingProgress(session) {
  const progress = { mode: 'spelling', ...tallyRound(session.items) };
  recordRoundProgressLocal(progress, state.playerName);
  if (state.playerId && syncsToBackend()) syncQuestProgress(state.playerId, progress);
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

// ---------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------

async function showScoreboard() {
  const screen = el(`
    <div>
      <h2 style="text-align:center;">Scoreboard</h2>
      <p class="tagline" style="text-align:center;">The whole class's progress, updated live.</p>
      <div class="score-section">
        <p class="token-legend">${tokenBadge('easy')} = 1 mark &nbsp; ${tokenBadge('medium')} = 3 marks &nbsp; ${tokenBadge('difficult')} = 6 marks. "Show answer" earns neither a token nor marks.</p>
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
      ['display_name', 'total_bronze', 'total_silver', 'total_gold', 'total_marks', 'rounds_completed'],
      ['Name', `${tokenBadge('easy')} Bronze`, `${tokenBadge('medium')} Silver`, `${tokenBadge('difficult')} Gold`, 'Marks', 'Rounds'],
      'data-quest-board'
    ));
    if (flaggedBoardEl) {
      const flaggedFormatted = (flaggedRows || []).map((row) => ({
        ...row,
        source_label: row.source_mode === 'wordsearch' ? 'Word Search' : 'Spelling',
        flagged_at: new Date(row.created_at).toLocaleString(),
      }));
      flaggedBoardEl.replaceWith(renderLeaderboardTable(
        flaggedFormatted,
        ['word', 'meaning', 'source_label', 'flagged_by', 'flagged_at'],
        ['Term', 'Meaning', 'Mode', 'Flagged by', 'When'],
        'data-flagged-board',
        10,
        'No flagged terms - nice.'
      ));
    }
  }
}

function renderLeaderboardTable(rows, keys, labels, dataAttr, limit = 10, emptyMessage = 'No scores yet - be the first!') {
  if (!rows || !rows.length) {
    return el(`<div ${dataAttr}><p class="score-note">${emptyMessage}</p></div>`);
  }
  let expanded = false;
  const wrap = el(`<div ${dataAttr}></div>`);
  const header = labels.map((l) => `<th>${l}</th>`).join('');
  const renderInner = () => {
    const visibleRows = expanded ? rows : rows.slice(0, limit);
    // Rows come straight from the shared Supabase leaderboard views - any
    // player's own chosen display_name ends up here, so it must be escaped
    // like any other untrusted input before going into innerHTML.
    const body = visibleRows.map((row) => `<tr>${keys.map((k) => `<td>${escapeHtml(row[k] ?? 0)}</td>`).join('')}</tr>`).join('');
    const toggle = rows.length > limit
      ? `<p class="score-toggle"><button type="button" class="btn-link" data-toggle>${expanded ? 'Show less' : 'Show more'}</button></p>`
      : '';
    wrap.innerHTML = `
      <table class="score-table">
        <thead><tr>${header}</tr></thead>
        <tbody>${body}</tbody>
      </table>
      ${toggle}
    `;
    const toggleBtn = wrap.querySelector('[data-toggle]');
    if (toggleBtn) toggleBtn.addEventListener('click', () => { expanded = !expanded; renderInner(); });
  };
  renderInner();
  return wrap;
}

// ---------------------------------------------------------------------

boot();
