-- =============================================================================
-- convograph initial schema (migration 001)
-- =============================================================================
-- Tables:
--   threads          — one row per conversation session
--   messages         — append-only transcript
--   drafts           — in-progress task workspaces (slot state)
--   completed_tasks  — append-only event log of finished tasks
--   user_preferences — cross-session preference store
--
-- All tables live in the configured schema (default: convograph). The host
-- project's existing schemas are never touched.
-- =============================================================================

-- The schema name is interpolated by the migration runner via {{SCHEMA}}.
-- runMigrations replaces {{SCHEMA}} with the actual quoted identifier.

CREATE SCHEMA IF NOT EXISTS {{SCHEMA}};

-- -----------------------------------------------------------------------------
-- threads
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.threads (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_user_id      TEXT NOT NULL,
    external_org_id       TEXT,
    current_topic         TEXT,
    current_instance_id   UUID,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS threads_user_idx
    ON {{SCHEMA}}.threads (external_user_id);
CREATE INDEX IF NOT EXISTS threads_last_active_idx
    ON {{SCHEMA}}.threads (last_active_at DESC);

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id     UUID NOT NULL REFERENCES {{SCHEMA}}.threads(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
    content       JSONB NOT NULL,
    parent_uuid   UUID REFERENCES {{SCHEMA}}.messages(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_thread_idx
    ON {{SCHEMA}}.messages (thread_id, created_at);

-- -----------------------------------------------------------------------------
-- drafts
-- -----------------------------------------------------------------------------
-- Each (thread_id, topic) has at most one ACTIVE draft (is_parked = false).
-- This is the core invariant of the architecture: prevents two concurrent
-- in-progress tasks of the same topic on a single thread, and is enforced
-- at the DB level via a partial unique index.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.drafts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id       UUID NOT NULL REFERENCES {{SCHEMA}}.threads(id) ON DELETE CASCADE,
    topic           TEXT NOT NULL,
    slots           JSONB NOT NULL DEFAULT '{}'::jsonb,
    msg_bucket      JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_parked       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS drafts_active_unique
    ON {{SCHEMA}}.drafts (thread_id, topic)
    WHERE NOT is_parked;

CREATE INDEX IF NOT EXISTS drafts_stale_idx
    ON {{SCHEMA}}.drafts (last_touched_at);

-- -----------------------------------------------------------------------------
-- completed_tasks (append-only)
-- -----------------------------------------------------------------------------
-- When a draft's action executes successfully, the draft is deleted and a
-- row inserted here. completed_tasks is the immutable event log; nothing
-- ever updates these rows.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.completed_tasks (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id              UUID NOT NULL REFERENCES {{SCHEMA}}.threads(id) ON DELETE CASCADE,
    topic                  TEXT NOT NULL,
    slots_snapshot         JSONB NOT NULL,
    action_result          JSONB NOT NULL,
    parent_instance_id     UUID REFERENCES {{SCHEMA}}.completed_tasks(id) ON DELETE SET NULL,
    completed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS completed_tasks_thread_idx
    ON {{SCHEMA}}.completed_tasks (thread_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS completed_tasks_topic_idx
    ON {{SCHEMA}}.completed_tasks (topic, completed_at DESC);

-- -----------------------------------------------------------------------------
-- user_preferences
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.user_preferences (
    external_user_id  TEXT NOT NULL,
    key               TEXT NOT NULL,
    value             JSONB NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (external_user_id, key)
);
