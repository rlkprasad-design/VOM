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
- **Spelling Challenge**: type each term correctly, using its jumbled
  letters (shown as a hint, not tapped) and clue as a guide.
- **True/False** *(currently hidden from the mode picker - see below)*:
  judge whether a statement is true or false - a term's own situational
  lead-in (`scenario`/`scenarios`) paired with either its own `label` or a
  different term's (borrowed for a false statement, preferring one from
  the same difficulty tier).
- **Card Grouping**: sort term cards into the category bucket each one
  belongs to, using each entry's existing `source` tag.

True/False is temporarily disabled while its content gets revised - the
`{ id: 'truefalse', ... }` entry in `MODES` (`js/app.js`) is commented out,
so players can't reach it, but the exercise code, its content fields
(`scenario`/`scenarios`/`label`), and its scoreboard column are all left
in place. Re-enable by uncommenting that one line once the content is
ready.

All four modes draw from the same content pool (`data/questions.json`)
but keep independent no-repeat rotations and exposure caps, so playing
one mode never uses up another's words. A fifth exercise type (mapping,
etc.) can be added later without touching any of these - see `js/pool.js`
for the shared, mode-agnostic sampling engine Word Search, Spelling, and
True/False plug into (Card Grouping draws by category instead of
difficulty tier, so it keeps its own simpler selection logic in
`js/grouping.js`, though it still respects the same exposure cap).

## Reward tiers

Every round mixes three difficulty tiers, grouped by Bloom's Taxonomy:

| Tier | Bloom's levels | Token | Marks |
|---|---|---|---|
| Easy | Remember, Understand | Bronze | 1 |
| Medium | Apply, Analyze | Silver | 3 |
| Difficult | Evaluate, Create | Gold | 6 |

Word Search and Card Grouping are worth **double** these marks per find -
hunting a word through a grid, or correctly recalling which category a
term belongs to among several options, is a harder recall task than
picking an already-isolated letter (Spelling) or making a binary guess
(True/False). See `MODE_MULTIPLIERS` in `js/app.js`.

A token and its marks are earned **only** for a term found by the player
themselves. "Show answer" completes the term but earns nothing, and is
always shown in a visually distinct color so a shown answer is never
mistaken for a genuine find.

## Time tracking

Active play time (from entering a gameplay screen to leaving it, capped
per screen-visit to guard against a forgotten idle tab) accumulates
locally per player and, when Supabase is configured, syncs as its own
append-only log - see `startPlayTimer`/`flushPlayTimer` in `js/app.js` and
the `time_log` table in `supabase/schema.sql`. Shown on the Scoreboard as
a sortable "Time" column.

## Setting up Supabase

1. Create a new Supabase project (a fresh one for this app - don't reuse
   another app's project).
2. In the SQL editor, run `supabase/schema.sql`.
3. Copy the project's URL and anon/publishable key into `js/config.js`.
4. Leave `js/config.js` blank to run local-only - the game works fully
   offline, but scores stay on that device only.

## Editing content

- `data/questions.json`: the single content pool (103 terms as of this
  writing). Each entry is
  `{ word, meaning, scenario, label, difficulty, source }`.
  - `word`: a single unbroken token (no spaces), uppercase, ≤ the largest
    grid size any level can roll (currently 14 characters).
  - `meaning`: a short definition/hint shown in Word Search's clue panel
    and above Spelling Challenge's answer field. Soft limit ~120 characters.
  - `scenario`: a situational lead-in, **not phrased as a question** (e.g.
    "A vendor offers a manager a gift to speed up an order." - not "...
    What value should guide their response?"). True/False glues this
    directly onto `label` to build the actual claim - see `label` below -
    so it must read as a plain description, never naming its own answer.
    Falls back to `meaning` when absent.
  - `scenarios` (optional, instead of `scenario`): a non-empty array of
    alternate situational lead-ins for one term, picked at random each
    time it's drawn - so a term with a deep exposure cap still presents
    varied statements across its exposures rather than the exact same one
    every time. A good place for a couple of different real-world framings
    of the same concept (a classic example alongside a more contemporary
    one), not required for every entry. Same "no question" rule as
    `scenario`.
  - `label`: a natural-language name for the term (e.g. `"First-Line
    Management"` for the word `FIRSTLINE`, `"Taylor's Scientific
    Management approach"` for `TAYLOR`) - required on every entry, since
    True/False can draw any of them. `js/truefalse.js` builds each round's
    claim as `"<scenario> This describes <label>."`; a true claim uses the
    term's own label, a false claim swaps in a different (same-tier where
    possible) entry's label instead, so the lead-in never changes but the
    asserted answer sometimes does. Write it so it reads naturally after
    "This describes " - the validator checks it's present and non-empty,
    but not that it reads well, so proofread new entries in-game.
  - `difficulty`: `"easy" | "medium" | "difficult"` - exactly three tiers,
    mixed together in every round.
  - `source`: a category tag - curator-only metadata for Word Search/
    Spelling/True-False (never shown to players there), but it's also the
    actual category bucket Card Grouping sorts cards into, so for that
    mode players *do* see it - `prettifySource` in `js/app.js` strips a
    `topicN-` prefix and title-cases the rest for display (e.g.
    `"topic3-neoclassical"` → "Neoclassical"), so the tag can stay a
    compact curator slug without looking raw on screen. Keep at least 2
    categories with 2+ entries each, or Card Grouping has nothing to build
    a round from - the validator warns if this thins out.
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
