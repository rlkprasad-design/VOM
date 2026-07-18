-- Management Quest Supabase schema
-- Run this in the SQL editor of a NEW Supabase project created just for
-- this app - do not reuse another app's project.

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  display_name text not null unique,
  created_at timestamptz not null default now()
);

-- One row per completed round, either exercise type - see js/storage.js's
-- recordRoundProgressLocal/js/app.js's tallyRound for how these numbers
-- are computed client-side. bronze/silver/gold map to the easy/medium/
-- difficult Bloom's-grouped tiers; marks_earned is the round's total
-- (1/3/6 marks per tier) so the scoreboard can rank on accumulated marks,
-- not just raw counts.
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

create policy "players readable by anyone"
  on players for select using (true);
create policy "quest_progress readable by anyone"
  on quest_progress for select using (true);
create policy "flagged_entries readable by anyone"
  on flagged_entries for select using (true);

create policy "anyone can create a player"
  on players for insert with check (true);
create policy "anyone can log quest progress"
  on quest_progress for insert with check (true);
create policy "anyone can flag an entry"
  on flagged_entries for insert with check (true);

-- Leaderboard view -----------------------------------------------------
-- Combines both exercise types into one shared class scoreboard rather
-- than splitting by mode - simplest reading for a class that's meant to
-- see one ranking. total_marks is exposed as its own column (not just an
-- ORDER BY expression) specifically so js/supabase-client.js's
-- fetchQuestLeaderboard can .order() by it explicitly - PostgREST doesn't
-- guarantee it will honor a view's own internal ORDER BY, so the ranking
-- a player actually sees must come from a column the client requests by
-- name, not this view's default order alone. An inner join is used
-- deliberately: a player only appears on the board once they've actually
-- completed a round.

create or replace view quest_leaderboard as
select
  p.display_name,
  coalesce(sum(qp.bronze_found), 0) as total_bronze,
  coalesce(sum(qp.silver_found), 0) as total_silver,
  coalesce(sum(qp.gold_found), 0) as total_gold,
  coalesce(sum(qp.marks_earned), 0) as total_marks,
  count(qp.id) as rounds_completed
from players p
join quest_progress qp on qp.player_id = p.id
group by p.display_name
order by total_marks desc;
