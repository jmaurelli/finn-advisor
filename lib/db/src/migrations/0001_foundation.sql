-- Migration 0001: foundation only.
-- Ledger identity, owner sign-in, sessions, login throttling and preferences.
-- No finance tables: those arrive with their own migration in stage 2.
--
-- Times are stored as integer milliseconds since the Unix epoch, UTC. Session
-- and throttle records are operational, never exported, and never part of the
-- financial history, which uses calendar dates and RFC 3339 timestamps.

CREATE TABLE ledger_metadata (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  currency          TEXT    NOT NULL CHECK (currency = 'USD'),
  timezone          TEXT    NOT NULL CHECK (timezone = 'America/New_York'),
  schema_version    INTEGER NOT NULL CHECK (schema_version >= 1),
  finance_revision  INTEGER NOT NULL CHECK (finance_revision >= 0 AND finance_revision < 1000000000000000000),
  rule_set_revision INTEGER NOT NULL CHECK (rule_set_revision >= 0 AND rule_set_revision < 1000000000000000000),
  created_at        INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

INSERT INTO ledger_metadata (id, currency, timezone, schema_version, finance_revision, rule_set_revision, created_at)
VALUES (1, 'USD', 'America/New_York', 1, 0, 0, CAST(unixepoch('subsec') * 1000 AS INTEGER));

-- One owner. `generation` increases on every password change; sessions carry
-- the generation they were created under, so a password change invalidates
-- every existing session without depending on a delete succeeding everywhere.
CREATE TABLE owner_credentials (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  algorithm            TEXT    NOT NULL CHECK (algorithm = 'argon2id'),
  password_hash        TEXT    NOT NULL CHECK (length(password_hash) BETWEEN 16 AND 512),
  generation           INTEGER NOT NULL CHECK (generation >= 1 AND generation < 1000000000000000000),
  updated_at           INTEGER NOT NULL CHECK (updated_at > 0)
) STRICT;

-- Only hashes are stored. The bearer token and the CSRF token exist in the
-- owner's browser and in this process's memory, never on disk.
CREATE TABLE sessions (
  id                    TEXT    PRIMARY KEY CHECK (length(id) = 36),
  token_hash            BLOB    NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  csrf_hash             BLOB    NOT NULL CHECK (length(csrf_hash) = 32),
  credential_generation INTEGER NOT NULL CHECK (credential_generation >= 1),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  last_activity_at      INTEGER NOT NULL CHECK (last_activity_at >= created_at),
  idle_expires_at       INTEGER NOT NULL CHECK (idle_expires_at > created_at),
  absolute_expires_at   INTEGER NOT NULL CHECK (absolute_expires_at > created_at)
) STRICT;

CREATE INDEX sessions_absolute_expires_at ON sessions (absolute_expires_at);

-- Persistent login throttling: survives a restart, so stopping the service is
-- not a way around it. `scope` is 'owner' or 'source:<address>'.
CREATE TABLE login_throttles (
  scope             TEXT    PRIMARY KEY CHECK (
                      scope = 'owner' OR (scope LIKE 'source:%' AND length(scope) BETWEEN 8 AND 80)
                    ),
  failure_count     INTEGER NOT NULL CHECK (failure_count >= 0 AND failure_count < 1000000000),
  window_started_at INTEGER NOT NULL CHECK (window_started_at > 0),
  locked_until      INTEGER          CHECK (locked_until IS NULL OR locked_until > 0),
  updated_at        INTEGER NOT NULL CHECK (updated_at > 0)
) STRICT;

CREATE TABLE preferences (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT    NOT NULL CHECK (
                 length(display_name) BETWEEN 1 AND 60 AND trim(display_name) <> ''
               ),
  density      TEXT    NOT NULL CHECK (density IN ('standard', 'compact')),
  version      INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  updated_at   INTEGER NOT NULL CHECK (updated_at > 0)
) STRICT;

INSERT INTO preferences (id, display_name, density, version, updated_at)
VALUES (1, 'Personal space', 'standard', 1, CAST(unixepoch('subsec') * 1000 AS INTEGER));
