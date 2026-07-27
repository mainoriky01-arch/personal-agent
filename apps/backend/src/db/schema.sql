-- Personal Agent — Postgres schema (spec §24 modello dati minimo).
-- Production DDL. The backend uses these tables; tests use in-memory repos that
-- honour the same shapes. Storage should be EU-hosted (§26.1).

-- ── Users & devices ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL UNIQUE,
  language     TEXT NOT NULL DEFAULT 'it',
  timezone     TEXT NOT NULL DEFAULT 'Europe/Rome',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','suspended','deleted')),
  plan         TEXT NOT NULL DEFAULT 'free'
               CHECK (plan IN ('free','pro'))
);

CREATE TABLE IF NOT EXISTS devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL CHECK (platform IN ('ios','android')),
  os_version    TEXT,
  app_version   TEXT,
  push_token    TEXT,
  permissions   JSONB NOT NULL DEFAULT '{}',
  last_seen_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- ── Coach profile (§24 CoachProfile / §14) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS coach_profiles (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tone             TEXT NOT NULL DEFAULT 'balanced',
  intensity        TEXT NOT NULL DEFAULT 'balanced'
                   CHECK (intensity IN ('light','balanced','firm','extreme')),
  max_message_len  INT NOT NULL DEFAULT 300,
  humor            BOOLEAN NOT NULL DEFAULT false,
  banned_words     TEXT[] NOT NULL DEFAULT '{}',
  quiet_hours      JSONB NOT NULL DEFAULT '[]'
);

-- ── Habits, commitments, rules (§24 / §8) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS habits (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  type                TEXT NOT NULL
                      CHECK (type IN ('eliminate','reduce','build','substitute',
                                      'routine','situational','temporary')),
  description         TEXT,
  motivation          TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','paused','archived')),
  substitute_behavior TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);

CREATE TABLE IF NOT EXISTS commitments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_id            UUID NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  natural_text        TEXT NOT NULL,
  days                INT[] NOT NULL,
  start_minute        INT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute          INT NOT NULL CHECK (end_minute BETWEEN 0 AND 1439),
  duration_minutes    INT NOT NULL CHECK (duration_minutes > 0),
  version             INT NOT NULL DEFAULT 1,
  confirmed_by_user   BOOLEAN NOT NULL DEFAULT false  -- §42.3 never active without this
);
CREATE INDEX IF NOT EXISTS idx_commitments_habit ON commitments(habit_id);

CREATE TABLE IF NOT EXISTS rules (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_id                  UUID NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  commitment_id             UUID NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  intensity                 TEXT NOT NULL DEFAULT 'balanced',
  interfering_apps          TEXT[] NOT NULL DEFAULT '{}',
  threshold_minutes         INT NOT NULL DEFAULT 2,
  cooldown_seconds          INT NOT NULL DEFAULT 60,
  escalation                INT[] NOT NULL,
  max_interventions_session INT NOT NULL DEFAULT 3,
  max_interventions_day     INT NOT NULL DEFAULT 8,
  daily_budget_minutes      INT,             -- optional cumulative daily cap (COD-9)
  barrage                   BOOLEAN NOT NULL DEFAULT false, -- seatbelt barrage mode (COD-11)
  enabled                   BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent adds for durable DBs created before these columns landed (CREATE
-- TABLE above is a no-op once the table exists, so new columns need guarded ALTERs).
ALTER TABLE rules ADD COLUMN IF NOT EXISTS daily_budget_minutes INT;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS barrage BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_rules_habit ON rules(habit_id);

CREATE TABLE IF NOT EXISTS rule_exceptions (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id  UUID NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  date     DATE,
  reason   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exceptions_rule ON rule_exceptions(rule_id);

-- ── Sessions, interventions, outcomes (§24 / §8.9) ───────────────────────────

CREATE TABLE IF NOT EXISTS intervention_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id            UUID NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  date               DATE NOT NULL,
  state              TEXT NOT NULL,
  level              INT NOT NULL DEFAULT 0,
  interventions_sent INT NOT NULL DEFAULT 0,
  last_intervention_at TIMESTAMPTZ,
  outcome            TEXT,
  acknowledged       BOOLEAN NOT NULL DEFAULT false, -- barrage ack (COD-12)
  last_foreground_seconds INT,                       -- last reported streak (COD-12)
  UNIQUE (rule_id, date)          -- one live session per rule per day (§8.9 dedup)
);
CREATE INDEX IF NOT EXISTS idx_sessions_rule_date ON intervention_sessions(rule_id, date);
-- Idempotent adds for durable DBs created before COD-12.
ALTER TABLE intervention_sessions ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE intervention_sessions ADD COLUMN IF NOT EXISTS last_foreground_seconds INT;

-- Cumulative daily foreground accounting for the daily-budget criterion (COD-9).
-- One row per (user, rule, local day); the date column makes the counter reset
-- automatically at local midnight since a new day is a new row.
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id            UUID NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  date               DATE NOT NULL,
  foreground_seconds INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, rule_id, date)
);

CREATE TABLE IF NOT EXISTS interventions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID NOT NULL REFERENCES intervention_sessions(id) ON DELETE CASCADE,
  action         TEXT NOT NULL,
  channel        TEXT NOT NULL,
  message        TEXT NOT NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  level          INT NOT NULL,
  delivery_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_interventions_session ON interventions(session_id);

-- ── Memory (§18 / §24 MemoryItem) ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content              TEXT NOT NULL,
  category             TEXT NOT NULL,
  source               TEXT NOT NULL
                       CHECK (source IN ('user_stated','confirmed_rule',
                                         'system_observation','ai_inference','approved_summary')),
  confidence           REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  expires_at           TIMESTAMPTZ,
  proactive_use_allowed BOOLEAN NOT NULL DEFAULT true,
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','archived','deleted')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_items(user_id);

-- ── Consent & audit (§24 / §26) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS consent_records (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  shown_text   TEXT NOT NULL,
  version      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'granted'
               CHECK (status IN ('granted','revoked')),
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_consent_user ON consent_records(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  change        TEXT NOT NULL,
  origin        TEXT NOT NULL,
  object_type   TEXT NOT NULL,
  object_id     TEXT,
  previous      JSONB,
  next          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
