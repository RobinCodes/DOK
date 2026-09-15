// Database schema, versioned with PRAGMA user_version.
// To change the schema later, append a new migration; never edit an applied one.

/**
 * Records in the ledger tables are immutable once written: the only change
 * allowed is voiding ("sztornó") an active record exactly once. Enforced here,
 * inside SQLite, so no code path (or bug) can quietly rewrite history.
 * Rulebook §3.5 (storno & correction), §3.7 (event log).
 */
function immutableExceptVoid(table, columns) {
  const changed = columns.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ');
  return `
    CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table}
    WHEN OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL OR ${changed}
    BEGIN SELECT RAISE(ABORT, '${table} rows are immutable: void and re-create instead'); END;
    CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} rows cannot be deleted'); END;`;
}

const VOID_COLUMNS = `
  voided_by   INTEGER REFERENCES users(id),
  voided_at   TEXT,
  void_reason TEXT`;

const migrations = [
  // 1 — initial schema
  `
  CREATE TABLE classes (
    id     INTEGER PRIMARY KEY,
    name   TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 20),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    sort   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'logadmin', 'superadmin')),
    is_casino     INTEGER NOT NULL DEFAULT 0 CHECK (is_casino IN (0, 1)),
    class_id      INTEGER REFERENCES classes(id),
    use_timer     INTEGER NOT NULL DEFAULT 1 CHECK (use_timer IN (0, 1)),
    active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at    TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE programs (
    id             INTEGER PRIMARY KEY,
    slug           TEXT NOT NULL UNIQUE,
    name_hu        TEXT NOT NULL,
    name_en        TEXT NOT NULL,
    description_hu TEXT NOT NULL DEFAULT '',
    description_en TEXT NOT NULL DEFAULT '',
    when_hu        TEXT NOT NULL DEFAULT '',
    when_en        TEXT NOT NULL DEFAULT '',
    starts_at      TEXT,
    ends_at        TEXT,
    status         TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'open', 'closed')),
    style_budget   INTEGER NOT NULL DEFAULT 0 CHECK (style_budget >= 0),
    public         INTEGER NOT NULL DEFAULT 1 CHECK (public IN (0, 1)),
    sort           INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE reasons (
    id           INTEGER PRIMARY KEY,
    program_id   INTEGER NOT NULL REFERENCES programs(id),
    name_hu      TEXT NOT NULL,
    name_en      TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('manual', 'style', 'formula', 'minutes', 'pool', 'casino')),
    needs_person INTEGER NOT NULL DEFAULT 1 CHECK (needs_person IN (0, 1)),
    min_points   INTEGER NOT NULL DEFAULT 1,
    max_points   INTEGER NOT NULL DEFAULT 100,
    formula      TEXT NOT NULL DEFAULT '',
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    sort         INTEGER NOT NULL DEFAULT 0
  );

  -- Named numbers used by a reason's formula and limits (e.g. stamp_points = 5).
  CREATE TABLE reason_params (
    reason_id INTEGER NOT NULL REFERENCES reasons(id),
    name      TEXT NOT NULL CHECK (name GLOB '[a-z]*' AND name NOT GLOB '*[^a-z0-9_]*'),
    value     REAL NOT NULL,
    PRIMARY KEY (reason_id, name)
  );

  -- Per-organizer style point allowance; without a row the program default applies.
  CREATE TABLE budgets (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    program_id INTEGER NOT NULL REFERENCES programs(id),
    amount     INTEGER NOT NULL CHECK (amount >= 0),
    PRIMARY KEY (user_id, program_id)
  );

  -- The points ledger. A class's score is the sum of its active entries.
  CREATE TABLE entries (
    id          INTEGER PRIMARY KEY,
    program_id  INTEGER REFERENCES programs(id),
    reason_id   INTEGER REFERENCES reasons(id),
    class_id    INTEGER NOT NULL REFERENCES classes(id),
    person_name TEXT NOT NULL DEFAULT '',
    person_key  TEXT NOT NULL DEFAULT '',
    amount      INTEGER NOT NULL,
    inputs      TEXT NOT NULL DEFAULT '{}',
    source      TEXT NOT NULL CHECK (source IN ('form', 'timer', 'pool', 'casino', 'adjustment')),
    batch       TEXT,
    corrects_id INTEGER REFERENCES entries(id),
    cashout_id  INTEGER REFERENCES casino_cashouts(id),
    note        TEXT NOT NULL DEFAULT '',
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    nonce       TEXT UNIQUE,
    ${VOID_COLUMNS}
  );
  CREATE INDEX entries_class ON entries(class_id);
  CREATE INDEX entries_program ON entries(program_id);
  CREATE INDEX entries_creator ON entries(created_by);
  CREATE INDEX entries_person ON entries(person_key);
  -- A casino cash-out can be converted into points only once.
  CREATE UNIQUE INDEX entries_one_per_cashout ON entries(cashout_id)
    WHERE cashout_id IS NOT NULL AND voided_at IS NULL;

  -- Check-in/check-out timers for participation points (Rulebook §4.3).
  CREATE TABLE timers (
    id          INTEGER PRIMARY KEY,
    reason_id   INTEGER NOT NULL REFERENCES reasons(id),
    class_id    INTEGER NOT NULL REFERENCES classes(id),
    person_name TEXT NOT NULL,
    person_key  TEXT NOT NULL,
    started_by  INTEGER NOT NULL REFERENCES users(id),
    started_at  TEXT NOT NULL,
    ended_by    INTEGER REFERENCES users(id),
    ended_at    TEXT,
    outcome     TEXT CHECK (outcome IN ('stopped', 'cancelled')),
    entry_id    INTEGER REFERENCES entries(id)
  );
  -- Nobody can be at two stations at once.
  CREATE UNIQUE INDEX timers_one_running_per_person ON timers(person_key) WHERE ended_at IS NULL;

  -- Casino (Rulebook §5).
  CREATE TABLE casino_games (
    id      INTEGER PRIMARY KEY,
    name_hu TEXT NOT NULL,
    name_en TEXT NOT NULL,
    kind    TEXT NOT NULL CHECK (kind IN ('house', 'pvp')),
    active  INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    sort    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE casino_visits (
    id          INTEGER PRIMARY KEY,
    program_id  INTEGER NOT NULL REFERENCES programs(id),
    class_id    INTEGER NOT NULL REFERENCES classes(id),
    person_name TEXT NOT NULL,
    person_key  TEXT NOT NULL,
    start_chips INTEGER NOT NULL CHECK (start_chips >= 0),
    recorded    INTEGER NOT NULL DEFAULT 1 CHECK (recorded IN (0, 1)),
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    nonce       TEXT UNIQUE,
    ${VOID_COLUMNS}
  );
  CREATE INDEX casino_visits_person ON casino_visits(program_id, person_key);

  CREATE TABLE casino_cashouts (
    id          INTEGER PRIMARY KEY,
    visit_id    INTEGER NOT NULL REFERENCES casino_visits(id),
    chips       INTEGER NOT NULL CHECK (chips >= 0),
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    nonce       TEXT UNIQUE,
    ${VOID_COLUMNS}
  );
  CREATE UNIQUE INDEX casino_one_cashout_per_visit ON casino_cashouts(visit_id) WHERE voided_at IS NULL;

  CREATE TABLE casino_rounds (
    id          INTEGER PRIMARY KEY,
    program_id  INTEGER NOT NULL REFERENCES programs(id),
    game_id     INTEGER NOT NULL REFERENCES casino_games(id),
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    nonce       TEXT UNIQUE,
    ${VOID_COLUMNS}
  );

  CREATE TABLE casino_results (
    round_id INTEGER NOT NULL REFERENCES casino_rounds(id),
    visit_id INTEGER NOT NULL REFERENCES casino_visits(id),
    delta    INTEGER NOT NULL CHECK (delta <> 0),
    PRIMARY KEY (round_id, visit_id)
  );
  CREATE TRIGGER casino_results_immutable BEFORE UPDATE ON casino_results
  BEGIN SELECT RAISE(ABORT, 'casino_results rows are immutable'); END;
  CREATE TRIGGER casino_results_no_delete BEFORE DELETE ON casino_results
  BEGIN SELECT RAISE(ABORT, 'casino_results rows cannot be deleted'); END;

  -- Physical chip counts per casino staff member, for reconciliation (Rulebook §5.6).
  CREATE TABLE casino_counts (
    id         INTEGER PRIMARY KEY,
    program_id INTEGER NOT NULL REFERENCES programs(id),
    staff_id   INTEGER NOT NULL REFERENCES users(id),
    chips      INTEGER NOT NULL CHECK (chips >= 0),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  -- Published standings (Rulebook §7.2).
  CREATE TABLE snapshots (
    id         INTEGER PRIMARY KEY,
    label      TEXT NOT NULL DEFAULT '',
    hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE snapshot_rows (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    class_id    INTEGER NOT NULL REFERENCES classes(id),
    points      INTEGER NOT NULL,
    rank        INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, class_id)
  );

  -- Hash-chained, append-only event log (Rulebook §3.7).
  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    actor_id   INTEGER REFERENCES users(id),
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    subject    TEXT NOT NULL DEFAULT '',
    details    TEXT NOT NULL DEFAULT '{}',
    ip         TEXT NOT NULL DEFAULT '',
    prev_hash  TEXT NOT NULL,
    hash       TEXT NOT NULL UNIQUE
  );
  CREATE INDEX audit_log_action ON audit_log(action);
  CREATE INDEX audit_log_actor ON audit_log(actor_id);
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

  ${immutableExceptVoid('entries', ['id', 'program_id', 'reason_id', 'class_id', 'person_name', 'person_key', 'amount', 'inputs', 'source', 'batch', 'corrects_id', 'cashout_id', 'note', 'created_by', 'created_at', 'nonce'])}
  ${immutableExceptVoid('casino_visits', ['id', 'program_id', 'class_id', 'person_name', 'person_key', 'start_chips', 'recorded', 'created_by', 'created_at', 'nonce'])}
  ${immutableExceptVoid('casino_cashouts', ['id', 'visit_id', 'chips', 'created_by', 'created_at', 'nonce'])}
  ${immutableExceptVoid('casino_rounds', ['id', 'program_id', 'game_id', 'created_by', 'created_at', 'nonce'])}
  `,
];

export const SCHEMA_VERSION = migrations.length;

export function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current > migrations.length) {
    throw new Error(`Database schema v${current} is newer than this code (v${migrations.length}).`);
  }
  for (let version = current; version < migrations.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migrations[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { fresh: current === 0 };
}
