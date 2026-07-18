# Management Quest

A calm, laptop-first recall game for Values-Oriented Management. Students
find and spell terms - core values, ethical leadership, corporate
governance, and more - to reinforce what they've learned in class.

Vanilla JS, ES modules, no build step, deployed as a static site from
GitHub Pages. Optionally backed by Supabase for a shared class scoreboard;
without it, the game still runs fully offline with a local-only tally.

## Exercise types

- **Word Search** (flagship mode): drag through a grid to find each hidden
  term, in any of 8 directions.
- **Spelling Challenge**: tap scrambled letter tiles back into the right
  order to spell each term.

Both modes draw from the same content pool (`data/questions.json`) but
keep independent no-repeat rotations and exposure caps, so playing one
mode never uses up the other's words. More exercise types (true/false,
card grouping, mapping) can be added later without touching either of
these - see `js/pool.js` for the shared, mode-agnostic sampling engine
both currently plug into.

## Reward tiers

Every round mixes three difficulty tiers, grouped by Bloom's Taxonomy:

| Tier | Bloom's levels | Token | Marks |
|---|---|---|---|
| Easy | Remember, Understand | Bronze | 1 |
| Medium | Apply, Analyze | Silver | 3 |
| Difficult | Evaluate, Create | Gold | 6 |

A token and its marks are earned **only** for a term found or spelled by
the player themselves. "Show answer" completes the term but earns
nothing, and is always shown in a visually distinct color so a shown
answer is never mistaken for a genuine find.

## Setting up Supabase

1. Create a new Supabase project (a fresh one for this app - don't reuse
   another app's project).
2. In the SQL editor, run `supabase/schema.sql`.
3. Copy the project's URL and anon/publishable key into `js/config.js`.
4. Leave `js/config.js` blank to run local-only - the game works fully
   offline, but scores stay on that device only.

## Editing content

- `data/questions.json`: the single content pool. Each entry is
  `{ word, meaning, scenario, difficulty, source }`.
  - `word`: a single unbroken token (no spaces), uppercase, ≤ the largest
    grid size any level can roll (currently 12 characters).
  - `meaning`: a short definition/hint shown in Word Search's clue panel
    and above Spelling Challenge's tiles. Soft limit ~120 characters.
  - `scenario`: a short situational description (e.g. "A vendor offers a
    manager a gift to speed up an order. What value should guide their
    response?") for a future "recognize this value in context" exercise
    type. Not yet used by the UI - carried in the schema now so that
    feature is additive later, not a data migration.
  - `difficulty`: `"easy" | "medium" | "difficult"` - exactly three tiers,
    mixed together in every round.
  - `source`: a free-text category tag (e.g. `"core-values"`,
    `"ethical-theories"`) - curator-only metadata, never shown to players.
- `data/levels.json`: grid size range, filler mode, and spelling round
  size. Currently one level; the concept exists for future expansion.
- Run `node scripts/validate-content.js` before opening a content PR - it
  checks for duplicates, words too long for the grid cap, thin difficulty
  tiers at some grid size, and more. A GitHub Action runs it automatically
  on any PR touching `data/**`.

## Deployment workflow

- Develop on a feature branch, one focused pull request per change,
  squash-merged to `main` (which GitHub Pages deploys from). Even small
  content fixes go through this, not direct commits to `main`.
- Before pushing, resync with `origin/main` rather than pushing on top of
  a stale base - a squash-merge produces a new commit SHA even when the
  content is identical, which can look like a spurious conflict.
- Test against a local static server (e.g. `npx serve` or
  `python3 -m http.server`) and a real browser before shipping. Check
  actual rendered state (bounding boxes, computed styles), not just that
  an element exists in the DOM - a feature can be wired up correctly and
  still be invisible to a real user.

## Content flagging

Players can flag a term or meaning that looks wrong from the clue panel
(Word Search) or the round screen (Spelling Challenge). Flags are recorded
to Supabase's `flagged_entries` table and surfaced on the Scoreboard
screen so a curator can review them without opening Supabase directly.
The flag itself only surfaces *what* needs fixing - editing
`data/questions.json` (via GitHub's web UI, or a coding assistant) is the
actual fix.
