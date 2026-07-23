-- Management Quest Supabase schema
-- Run this in the SQL editor of a NEW Supabase project created just for
-- this app - do not reuse another app's project.

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  display_name text not null unique,
  created_at timestamptz not null default now()
);

-- One row per completed round, any exercise type - see js/storage.js's
-- recordRoundProgressLocal/js/app.js's tallyRound for how these numbers
-- are computed client-side. bronze/silver/gold map to the easy/medium/
-- difficult Bloom's-grouped tiers; marks_earned is the round's total,
-- already scaled by that mode's marksForFind multiplier (see js/app.js),
-- so the scoreboard can rank on accumulated marks, not just raw counts.
create table if not exists quest_progress (
  id bigint generated always as identity primary key,
  player_id uuid not null references players(id) on delete cascade,
  mode text not null check (mode in ('wordsearch', 'spelling')),
  entries_found int not null default 0,
  bronze_found int not null default 0,
  silver_found int not null default 0,
  gold_found int not null default 0,
  marks_earned int not null default 0,
  completed_at timestamptz not null default now()
);

-- Widens the mode check constraint to also allow 'truefalse' and
-- 'grouping', added after this table's initial release. Looked up by
-- pg_constraint rather than assumed by name (e.g.
-- "quest_progress_mode_check") so this migration is safe to run against a
-- project however its original constraint actually got named, and safe to
-- re-run - it just drops and recreates the same constraint every time.
do $$
declare
  con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'quest_progress'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%mode%'
  loop
    execute format('alter table quest_progress drop constraint %I', con.conname);
  end loop;
end $$;

alter table quest_progress add constraint quest_progress_mode_check
  check (mode in ('wordsearch', 'spelling', 'truefalse', 'grouping'));

-- One row per chunk of active play time, flushed on every screen
-- transition away from a gameplay screen (see js/app.js's
-- startPlayTimer/flushPlayTimer) and best-effort on tab close. An
-- append-only log, same shape as quest_progress, rather than a running
-- total column updated in place - a plain insert can't race with itself
-- the way a read-modify-write "increment this player's total" could if a
-- player had two tabs open.
create table if not exists time_log (
  id bigint generated always as identity primary key,
  player_id uuid not null references players(id) on delete cascade,
  seconds int not null check (seconds > 0),
  logged_at timestamptz not null default now()
);

-- A player-flagged content entry (an off-beat term or meaning noticed
-- during a round), so whoever curates data/questions.json can review and
-- fix them without needing anyone to email a screenshot. No foreign key
-- to players - flagged_by is just the display name at flag time, same
-- trust-based identity model as everywhere else in this schema.
create table if not exists flagged_entries (
  id bigint generated always as identity primary key,
  word text not null,
  meaning text not null,
  difficulty text,
  source_mode text not null, -- 'wordsearch' or 'spelling'
  flagged_by text,
  created_at timestamptz not null default now()
);

-- Row Level Security --------------------------------------------------
-- Identity here is name-only (no Supabase Auth session), matching the
-- app's "no login" design for a classroom setting. That means RLS cannot
-- truly restrict "a player writing their own rows" without an auth
-- session - these policies are intentionally permissive (a shared class
-- tally, not sensitive data). If this ever opens up beyond a trusted
-- group and impersonation becomes a real concern, add Supabase Auth (e.g.
-- anonymous sign-in) and tighten these policies then - not before.

alter table players enable row level security;
alter table quest_progress enable row level security;
alter table flagged_entries enable row level security;
alter table time_log enable row level security;

-- `create policy` has no `if not exists` form, unlike the table/column
-- statements above - re-running this file against an already-set-up
-- project would otherwise fail with "policy already exists" the moment it
-- reached these. `drop policy if exists` immediately before each one makes
-- the whole file safely re-runnable end to end.
drop policy if exists "players readable by anyone" on players;
create policy "players readable by anyone"
  on players for select using (true);
drop policy if exists "quest_progress readable by anyone" on quest_progress;
create policy "quest_progress readable by anyone"
  on quest_progress for select using (true);
drop policy if exists "flagged_entries readable by anyone" on flagged_entries;
create policy "flagged_entries readable by anyone"
  on flagged_entries for select using (true);
drop policy if exists "time_log readable by anyone" on time_log;
create policy "time_log readable by anyone"
  on time_log for select using (true);

drop policy if exists "anyone can create a player" on players;
create policy "anyone can create a player"
  on players for insert with check (true);
drop policy if exists "anyone can log quest progress" on quest_progress;
create policy "anyone can log quest progress"
  on quest_progress for insert with check (true);
drop policy if exists "anyone can flag an entry" on flagged_entries;
create policy "anyone can flag an entry"
  on flagged_entries for insert with check (true);
drop policy if exists "anyone can log time" on time_log;
create policy "anyone can log time"
  on time_log for insert with check (true);

-- Leaderboard view -----------------------------------------------------
-- Combines all exercise types into one shared class scoreboard rather
-- than splitting by mode - simplest reading for a class that's meant to
-- see one ranking - but also breaks marks out per mode (wordsearch_marks,
-- spelling_marks, truefalse_marks, grouping_marks) so the scoreboard can
-- show where a player's marks actually came from, same as BA Quest's
-- sister app. total_marks is exposed as its own column (not just an
-- ORDER BY expression) specifically so js/supabase-client.js's
-- fetchQuestLeaderboard can .order() by it explicitly - PostgREST doesn't
-- guarantee it will honor a view's own internal ORDER BY, so the ranking
-- a player actually sees must come from a column the client requests by
-- name, not this view's default order alone. An inner join on
-- quest_progress is used deliberately: a player only appears on the board
-- once they've actually completed a round. total_time_seconds is a
-- correlated subquery rather than a second join, since joining time_log
-- directly alongside quest_progress would multiply rows (a cross join of
-- every round against every time-log entry) and silently inflate every
-- summed total. Dropped and recreated rather than `create or replace` -
-- Postgres only allows that form to append new trailing columns, not
-- insert or reorder any, and this view has grown columns in the middle
-- (the per-mode marks columns land before rounds_completed) since its
-- first release, which `create or replace` rejects with "cannot change
-- name of view column". A plain drop+create has no such restriction and
-- is just as safe to re-run, since nothing else in this schema depends
-- on this view.

drop view if exists quest_leaderboard;
create view quest_leaderboard as
select
  p.display_name,
  coalesce(sum(qp.bronze_found), 0) as total_bronze,
  coalesce(sum(qp.silver_found), 0) as total_silver,
  coalesce(sum(qp.gold_found), 0) as total_gold,
  coalesce(sum(qp.marks_earned), 0) as total_marks,
  coalesce(sum(qp.marks_earned) filter (where qp.mode = 'wordsearch'), 0) as wordsearch_marks,
  coalesce(sum(qp.marks_earned) filter (where qp.mode = 'spelling'), 0) as spelling_marks,
  coalesce(sum(qp.marks_earned) filter (where qp.mode = 'truefalse'), 0) as truefalse_marks,
  coalesce(sum(qp.marks_earned) filter (where qp.mode = 'grouping'), 0) as grouping_marks,
  count(qp.id) as rounds_completed,
  coalesce((select sum(tl.seconds) from time_log tl where tl.player_id = p.id), 0) as total_time_seconds
from players p
join quest_progress qp on qp.player_id = p.id
group by p.display_name, p.id
order by total_marks desc;
