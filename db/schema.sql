-- Primer MVP schema. See PLAN.md §3.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS children (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  age INT,
  onboarding_notes TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID REFERENCES children(id),
  plan JSONB NOT NULL,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  transcript JSONB DEFAULT '[]'
);

-- Append-only. Never UPDATE or DELETE rows here.
CREATE TABLE IF NOT EXISTS reading_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  child_id UUID REFERENCES children(id),
  ts TIMESTAMPTZ DEFAULT now(),
  expected_word TEXT,
  attempt INT DEFAULT 1,
  error_type TEXT,
  accuracy_score REAL,
  phonemes JSONB,
  pause_ms INT
);

CREATE TABLE IF NOT EXISTS skill_mastery (
  child_id UUID REFERENCES children(id),
  skill_id TEXT,
  p_mastery REAL DEFAULT 0.2,
  last_practiced TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (child_id, skill_id)
);

CREATE TABLE IF NOT EXISTS child_memory (
  child_id UUID PRIMARY KEY REFERENCES children(id),
  interests JSONB DEFAULT '[]',
  personality_notes TEXT,
  canon JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now(),
  version INT DEFAULT 1
);

CREATE TABLE IF NOT EXISTS child_memory_history (
  LIKE child_memory INCLUDING ALL,
  archived_at TIMESTAMPTZ DEFAULT now()
);

-- child_memory_history inherits the PK from child_memory, but it is an archive:
-- the same child is archived many times. Drop the uniqueness constraint.
ALTER TABLE child_memory_history DROP CONSTRAINT IF EXISTS child_memory_history_pkey;

CREATE TABLE IF NOT EXISTS session_flags (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  ts TIMESTAMPTZ DEFAULT now(),
  type TEXT,
  detail TEXT
);

-- Next-session plan produced by consolidation (PLAN.md §12 step 5, §13 GET /api/plan).
CREATE TABLE IF NOT EXISTS next_plans (
  child_id UUID PRIMARY KEY REFERENCES children(id),
  plan JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Watermark so consolidation only folds in reading_events it hasn't seen.
CREATE TABLE IF NOT EXISTS consolidation_state (
  child_id UUID PRIMARY KEY REFERENCES children(id),
  last_event_id BIGINT DEFAULT 0,
  last_run_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS reading_events_child_id_idx ON reading_events (child_id, id);
CREATE INDEX IF NOT EXISTS sessions_child_started_idx ON sessions (child_id, started_at DESC);
