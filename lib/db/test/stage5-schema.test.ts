import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appliedMigrations, loadMigrations, migrate, schemaVersion } from "../src/migrate.js";
import type { SqliteDatabase } from "../src/open.js";
import { createTemporaryLedger, type TemporaryLedger } from "../src/testing.js";
import { withWriteTransaction } from "../src/transaction.js";

const id = (n: number, prefix = "10000000") => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCOUNT = id(1);
const OTHER_ACCOUNT = id(2);
const CATEGORY = id(30);
const RULE = id(40);
const TX = id(50);
const OTHER_TX = id(51);
const BATCH = id(60);
const ROW = id(70);
const SOURCE = id(80);
const POSTING = id(90);
const UNCATEGORIZED = "30000000-0000-4000-8000-000000000000";
const DIGEST = "a".repeat(64);
const HASH = "b".repeat(64);
const KEY = "c".repeat(32);
const NOW = 1770000000000;
const DAY = 86400000;

let ledger: TemporaryLedger | undefined;
const scratch: string[] = [];
afterEach(() => {
  ledger?.close(); ledger = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function migrationDir(count = 5, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), "money-desk-import-migrations-"));
  scratch.push(dir);
  for (const m of loadMigrations().slice(0, count)) {
    writeFileSync(join(dir, m.name), m.sql + (fail && m.id === 5 ? "\nSELECT nonexistent_function();" : ""));
  }
  return dir;
}

function seed(db: SqliteDatabase): void {
  for (const [account, name] of [[ACCOUNT, "Synthetic Checking"], [OTHER_ACCOUNT, "Synthetic Card"]] as const) {
    db.prepare(`INSERT INTO accounts (id, kind, provider_key, display_name, tracking_start_date,
      opening_cents, creation_digest, version, ledger_revision, created_at, updated_at)
      VALUES (?, 'checking', 'other', ?, '2026-01-01', 0, ?, 1, 0, ?, ?)`)
      .run(account, name, DIGEST, NOW, NOW);
  }
  db.prepare(`INSERT INTO categories (id, display_name, normalized_name, color, protected,
    version, created_at, updated_at) VALUES (?, 'Food', 'food', '#112233', 0, 1, ?, ?)`)
    .run(CATEGORY, NOW, NOW);
  // A rule and its current revision reference each other, so they only become
  // consistent at COMMIT: they have to be inserted inside one transaction.
  withWriteTransaction(db, () => {
    db.prepare("INSERT INTO rules (id, position, revision, creation_digest, version, created_at, updated_at) VALUES (?, 1, 1, ?, 1, ?, ?)")
      .run(RULE, DIGEST, NOW, NOW);
    db.prepare(`INSERT INTO rule_revisions (rule_id, revision, change, match_type, pattern,
      normalized_pattern, account_id, applies_to, category_id, category_name, enabled, changed_at)
      VALUES (?, 1, 'created', 'contains', 'Market', 'market', ?, 'purchases_and_refunds', ?, 'Food', 1, ?)`)
      .run(RULE, ACCOUNT, CATEGORY, NOW);
  });
  for (const [tx, account] of [[TX, ACCOUNT], [OTHER_TX, OTHER_ACCOUNT]] as const) {
    db.prepare(`INSERT INTO transactions (id, account_id, posted_date, merchant_text, normalized_text,
      amount_cents, kind, category_id, assignment_origin, assigned_at, lifecycle, original_posted_date,
      original_amount_cents, version, created_at, updated_at)
      VALUES (?, ?, '2026-01-02', 'SYNTHETIC MARKET', 'synthetic market', -4599, 'purchase', ?, 'manual', ?,
      'active', '2026-01-02', -4599, 1, ?, ?)`)
      .run(tx, account, CATEGORY, NOW, NOW, NOW);
  }
}

/** One open preview, ready to be poked at. */
function batch(db: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: BATCH, account_id: ACCOUNT, format_id: "synthetic-canonical-checking", format_version: 1,
    filename: "synthetic-checking-may.csv", status: "preview", parent_import_id: null,
    created_at: NOW, last_reviewed_at: NOW, expires_at: NOW + 30 * DAY, version: 1,
    captured_ledger_revision: 0, captured_rule_set_revision: 0, captured_account_archived: 0,
    failure_code: null, failure_message: null, result_rows: null, result_added: null,
    result_excluded: null, result_paired_transfers: null, result_json: null, completed_at: null,
    upload_retained_until: null, creation_digest: DIGEST, updated_at: NOW,
    ...overrides,
  };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO import_batches (${columns.join(", ")}) VALUES (${columns.map(c => `:${c}`).join(", ")})`)
    .run(row);
}

function row(db: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  const record = {
    id: ROW, import_id: BATCH, source_row_number: 1,
    source_fields_json: '{"Date":"05/01/2026","Amount":"-45.99"}', source_record_id: null,
    posted_date: "2026-05-01", merchant_text: "SYNTHETIC MARKET", normalized_text: "synthetic market",
    amount_cents: -4599, kind: "purchase", kind_source: "bank",
    category_id: CATEGORY, assignment_origin: "manual", rule_id: null, rule_revision: null,
    state: "ready", issues_json: "[]", excluded: 0, review_required: 0,
    changed_suggestions_json: "[]",
    duplicate_status: "none", duplicate_matches_json: "[]", duplicate_match_count: 0,
    duplicate_evidence_digest: null, duplicate_decision: null,
    transfer_candidate_json: null, transfer_counterpart_id: null, transfer_counterpart_version: null,
    transfer_decision: null, posted_transaction_id: null, version: 1, created_at: NOW, updated_at: NOW,
    ...overrides,
  };
  const columns = Object.keys(record);
  db.prepare(`INSERT INTO import_rows (${columns.join(", ")}) VALUES (${columns.map(c => `:${c}`).join(", ")})`)
    .run(record);
}

function sourceRecord(db: SqliteDatabase, recordId = SOURCE, rowNumber = 1): void {
  db.prepare(`INSERT INTO import_source_records (id, account_id, origin_import_id, origin_row_number,
    source_fields_json, normalized_json, category_id, rule_id, rule_revision, created_at)
    VALUES (?, ?, ?, ?, '{"Amount":"-45.99"}', '{"amountCents":-4599}', ?, NULL, NULL, ?)`)
    .run(recordId, ACCOUNT, BATCH, rowNumber, CATEGORY, NOW);
}

function posting(db: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  const record = {
    id: POSTING, source_record_id: SOURCE, transaction_id: TX, posting_import_id: BATCH,
    posting_row_number: 1, posting_path: "commit", posted_at: NOW, paired_counterpart_id: null,
    ...overrides,
  };
  const columns = Object.keys(record);
  db.prepare(`INSERT INTO import_postings (${columns.join(", ")}) VALUES (${columns.map(c => `:${c}`).join(", ")})`)
    .run(record);
}

function open(stage4 = false): SqliteDatabase {
  ledger = createTemporaryLedger({ migrated: !stage4 });
  if (stage4) migrate(ledger.db, migrationDir(4));
  seed(ledger.db);
  return ledger.db;
}

describe("import schema upgrade", () => {
  it("upgrades a populated stage 4 database without touching its finance data or earlier migrations", () => {
    const db = open(true);
    db.prepare(`INSERT INTO audit_events (id, entity_type, entity_id, account_id, event_type, origin, after_json, occurred_at)
      VALUES (?, 'transaction', ?, ?, 'transaction_created', 'owner', '{"synthetic":true}', ?)`)
      .run(id(99), TX, ACCOUNT, NOW);
    const tables = ["accounts", "categories", "transactions", "rules", "rule_revisions", "audit_events"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    const migrations = appliedMigrations(db);
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();

    expect(migrate(db).appliedNow).toEqual(["0005_imports.sql"]);

    expect(schemaVersion(db)).toBe(5);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).toEqual(before);
    expect(appliedMigrations(db).slice(0, 4)).toEqual(migrations);
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all())
      .toEqual(expect.arrayContaining(triggers));
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
  });

  it("now accepts an import audit event, and still refuses changing or removing one", () => {
    const db = open();
    batch(db);
    db.prepare(`INSERT INTO audit_events (id, entity_type, entity_id, account_id, event_type, origin, after_json, occurred_at)
      VALUES (?, 'import', ?, ?, 'import_created', 'import', '{"rows":3}', ?)`).run(id(98), BATCH, ACCOUNT, NOW);
    expect(() => db.exec("UPDATE audit_events SET event_type = 'changed'")).toThrow(/cannot be changed/);
    expect(() => db.exec("DELETE FROM audit_events")).toThrow(/cannot be removed/);
    expect(() => db.prepare(`INSERT INTO audit_events (id, entity_type, entity_id, event_type, origin, occurred_at)
      VALUES (?, 'made_up', ?, 'x', 'owner', ?)`).run(id(97), BATCH, NOW)).toThrow(/CHECK/);
  });

  it("rolls a late failure back, leaving no import table behind", () => {
    const db = open(true);
    const before = db.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all();
    const audit = db.prepare("SELECT * FROM audit_events").all();
    expect(() => migrate(db, migrationDir(5, true))).toThrow(/nonexistent_function/);
    expect(db.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM audit_events").all()).toEqual(audit);
    expect(schemaVersion(db)).toBe(4);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
  });

  it("creates every import table as STRICT", () => {
    const db = open();
    const rows = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'
      AND name IN ('import_batches', 'import_rows', 'import_source_records', 'import_postings',
        'import_file_claims', 'uploads', 'source_identities')`).all() as { name: string; sql: string }[];
    expect(rows).toHaveLength(7);
    for (const table of rows) expect(table.sql.toUpperCase(), `${table.name} should be STRICT`).toMatch(/STRICT\s*$/);
  });
});

describe("import batch lifecycle", () => {
  it("accepts an open preview and refuses an unknown status or format id", () => {
    const db = open();
    batch(db);
    expect(db.prepare("SELECT status, version FROM import_batches").get()).toEqual({ status: "preview", version: 1n });
    expect(() => batch(db, { id: id(61), status: "reviewing" })).toThrow(/CHECK/);
    for (const formatId of ["", "-leading", "Has Caps", "under_score", "x".repeat(65)]) {
      expect(() => batch(db, { id: id(61), format_id: formatId })).toThrow(/CHECK/);
    }
  });

  it("never lets a filename be used as a path", () => {
    const db = open();
    for (const filename of ["", ".", "..", "a/b.csv", "a\\b.csv", "/etc/passwd", "x".repeat(256)]) {
      expect(() => batch(db, { id: id(61), filename })).toThrow(/CHECK/);
    }
    expect(() => batch(db, { id: id(61), filename: "statement (may) #2.csv" })).not.toThrow();
  });

  it("ties the review deadline to being open", () => {
    const db = open();
    // Open without a deadline, and finished with one, are both refused.
    expect(() => batch(db, { id: id(61), expires_at: null })).toThrow(/CHECK/);
    expect(() => batch(db, {
      id: id(62), status: "cancelled", expires_at: NOW + DAY,
    })).toThrow(/CHECK/);
    expect(() => batch(db, { id: id(63), status: "cancelled", expires_at: null })).not.toThrow();
  });

  it("only records an outcome for a completed import, and only a failure for a failed one", () => {
    const db = open();
    const completed = {
      status: "committed", expires_at: null, result_rows: 3, result_added: 2, result_excluded: 1,
      result_paired_transfers: 0, result_json: '{"added":2}', completed_at: NOW + 1000,
    };
    expect(() => batch(db, { id: id(61), ...completed })).not.toThrow();
    // An outcome on an open preview, or a half-written one, is refused.
    expect(() => batch(db, { id: id(62), result_json: '{"added":2}' })).toThrow(/CHECK/);
    expect(() => batch(db, { id: id(63), ...completed, result_added: null })).toThrow(/CHECK/);
    // Counts must be internally consistent.
    expect(() => batch(db, { id: id(64), ...completed, result_added: 3, result_excluded: 1 })).toThrow(/CHECK/);
    expect(() => batch(db, { id: id(65), ...completed, result_paired_transfers: 3 })).toThrow(/CHECK/);
    // A failure explanation belongs only to a failed import, and its code must be declared.
    expect(() => batch(db, { id: id(66), failure_code: "header_mismatch", failure_message: "no" })).toThrow(/CHECK/);
    expect(() => batch(db, {
      id: id(67), status: "failed", expires_at: null, failure_code: "made_up", failure_message: "no",
    })).toThrow(/CHECK/);
    expect(() => batch(db, {
      id: id(68), status: "failed", expires_at: null, failure_code: "header_mismatch", failure_message: null,
    })).toThrow(/CHECK/);
  });

  it("keeps only a completed import's retention deadline", () => {
    const db = open();
    expect(() => batch(db, { id: id(61), upload_retained_until: NOW + 30 * DAY })).toThrow(/CHECK/);
  });

  it("allows only sensible status changes", () => {
    const db = open();
    batch(db, { status: "receiving" });
    const setStatus = (status: string, extra = "") =>
      db.prepare(`UPDATE import_batches SET status = ?, version = version + 1${extra} WHERE id = ?`).run(status, BATCH);
    expect(() => setStatus("parsing")).not.toThrow();
    // Backwards is refused.
    expect(() => setStatus("receiving")).toThrow(/not allowed/);
    expect(() => setStatus("preview")).not.toThrow();
    expect(() => setStatus("committed", ", expires_at = NULL, result_rows = 1, result_added = 1, result_excluded = 0, result_paired_transfers = 0, result_json = '{}', completed_at = " + String(NOW + 1)))
      .not.toThrow();
    // A finished import never reopens.
    for (const status of ["preview", "parsing", "cancelled", "expired", "receiving"]) {
      expect(() => setStatus(status)).toThrow(/not allowed/);
    }
  });

  it("cannot commit something that was never a preview", () => {
    const db = open();
    batch(db, { status: "receiving" });
    expect(() => db.prepare("UPDATE import_batches SET status = 'committed', expires_at = NULL WHERE id = ?").run(BATCH))
      .toThrow(/not allowed/);
  });

  it("never rewrites a recorded outcome", () => {
    const db = open();
    batch(db, {
      status: "committed", expires_at: null, result_rows: 3, result_added: 2, result_excluded: 1,
      result_paired_transfers: 1, result_json: '{"added":2}', completed_at: NOW + 1000,
    });
    for (const change of [
      "result_added = 3", "result_json = '{\"added\":3}'", "result_rows = 9",
      "result_excluded = 0", "result_paired_transfers = 0", `completed_at = ${String(NOW + 2000)}`,
    ]) {
      expect(() => db.exec(`UPDATE import_batches SET ${change} WHERE id = '${BATCH}'`))
        .toThrow(/completed import outcome cannot be changed/);
    }
  });

  it("holds identity, the pinned format and the version direction", () => {
    const db = open();
    batch(db);
    for (const change of [
      `account_id = '${OTHER_ACCOUNT}'`, "format_id = 'other-format'", "format_version = 2",
      "filename = 'renamed.csv'", `created_at = ${String(NOW - 1)}`, `creation_digest = '${HASH}'`,
      `parent_import_id = '${BATCH}'`,
    ]) {
      expect(() => db.exec(`UPDATE import_batches SET ${change} WHERE id = '${BATCH}'`))
        .toThrow(/identity and pinned format cannot be changed/);
    }
    db.prepare("UPDATE import_batches SET version = 4 WHERE id = ?").run(BATCH);
    expect(() => db.exec(`UPDATE import_batches SET version = 3 WHERE id = '${BATCH}'`))
      .toThrow(/version cannot go backward/);
  });

  it("keeps the history entry even when its contents are purged", () => {
    const db = open();
    batch(db);
    expect(() => db.exec(`DELETE FROM import_batches WHERE id = '${BATCH}'`)).toThrow(/history cannot be removed/);
  });

  it("refuses a follow-up that is its own parent, and a missing parent", () => {
    const db = open();
    batch(db);
    expect(() => batch(db, { id: id(61), parent_import_id: id(61) })).toThrow(/CHECK/);
    expect(() => batch(db, { id: id(62), parent_import_id: id(999) })).toThrow(/FOREIGN KEY/);
    expect(() => batch(db, { id: id(63), parent_import_id: BATCH })).not.toThrow();
  });

  it("makes a retried follow-up request collide instead of creating a second preview", () => {
    const db = open();
    batch(db);
    expect(() => batch(db, { id: id(61), parent_import_id: BATCH })).not.toThrow();
    expect(() => batch(db, { id: id(62), parent_import_id: BATCH })).toThrow(/UNIQUE/);
    // Two originals may share a digest; only follow-ups are keyed by it.
    expect(() => batch(db, { id: id(63) })).not.toThrow();
  });

  it("refuses an account that does not exist and will not let one be deleted underneath", () => {
    const db = open();
    batch(db);
    expect(() => batch(db, { id: id(61), account_id: id(999) })).toThrow(/FOREIGN KEY/);
    expect(() => db.exec(`DELETE FROM accounts WHERE id = '${ACCOUNT}'`)).toThrow(/FOREIGN KEY/);
  });
});

describe("stored uploads", () => {
  function upload(db: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
    const record = {
      storage_key: KEY, import_id: BATCH, byte_size: 1024, sha256: HASH,
      state: "available", retention_deadline: null, created_at: NOW, updated_at: NOW,
      ...overrides,
    };
    const columns = Object.keys(record);
    db.prepare(`INSERT INTO uploads (${columns.join(", ")}) VALUES (${columns.map(c => `:${c}`).join(", ")})`)
      .run(record);
  }

  it("stores a random key that cannot express a path", () => {
    const db = open();
    batch(db);
    upload(db);
    for (const key of ["../../etc/passwd", "c".repeat(31), "c".repeat(33), "C".repeat(32), "c/".repeat(16), "z".repeat(32)]) {
      expect(() => upload(db, { storage_key: key, import_id: id(61) })).toThrow(/CHECK|FOREIGN KEY/);
    }
  });

  it("knows a size and fingerprint only once the bytes are all in", () => {
    const db = open();
    batch(db);
    expect(() => upload(db, { state: "receiving", byte_size: null, sha256: null })).not.toThrow();
    expect(() => upload(db, { storage_key: "d".repeat(32), state: "receiving" })).toThrow(/CHECK/);
  });

  it("bounds the stored size to the declared file limit", () => {
    const db = open();
    batch(db);
    expect(() => upload(db, { byte_size: 10485760 })).not.toThrow();
    expect(() => upload(db, { storage_key: "d".repeat(32), byte_size: 10485761 })).toThrow(/CHECK/);
    expect(() => upload(db, { storage_key: "e".repeat(32), byte_size: -1 })).toThrow(/CHECK/);
  });

  it("allows one stored copy per import", () => {
    const db = open();
    batch(db);
    upload(db);
    expect(() => upload(db, { storage_key: "d".repeat(32) })).toThrow(/UNIQUE/);
  });

  it("only moves bytes forward, so deletion intent survives a restart", () => {
    const db = open();
    batch(db);
    upload(db, { state: "receiving", byte_size: null, sha256: null });
    const setState = (state: string, extra = "") =>
      db.prepare(`UPDATE uploads SET state = ?${extra} WHERE storage_key = ?`).run(state, KEY);
    expect(() => setState("available", `, byte_size = 10, sha256 = '${HASH}'`)).not.toThrow();
    expect(() => setState("receiving")).toThrow(/not allowed/);
    expect(() => setState("deletion_pending")).not.toThrow();
    // This is the important one: a restart must not resurrect bytes that are
    // already meant to be gone.
    expect(() => setState("available")).toThrow(/not allowed/);
    expect(() => setState("deleted")).not.toThrow();
    expect(() => setState("deletion_pending")).toThrow(/not allowed/);
  });

  it("keeps the record that bytes still need removing", () => {
    const db = open();
    batch(db);
    upload(db, { state: "deletion_pending" });
    expect(() => db.exec(`DELETE FROM uploads WHERE storage_key = '${KEY}'`)).toThrow(/rather than removing its record/);
  });

  it("never lets a stored fingerprint change once it is known", () => {
    const db = open();
    batch(db);
    upload(db);
    for (const change of [`sha256 = '${"f".repeat(64)}'`, "byte_size = 2048", `import_id = '${BATCH}x'`, `created_at = ${String(NOW - 1)}`]) {
      expect(() => db.exec(`UPDATE uploads SET ${change} WHERE storage_key = '${KEY}'`))
        .toThrow(/identity and fingerprint cannot be changed|CHECK|FOREIGN KEY/);
    }
  });
});

describe("file claims", () => {
  function claim(db: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
    const record = { account_id: ACCOUNT, sha256: HASH, import_id: BATCH, created_at: NOW, ...overrides };
    const columns = Object.keys(record);
    db.prepare(`INSERT INTO import_file_claims (${columns.join(", ")}) VALUES (${columns.map(c => `:${c}`).join(", ")})`)
      .run(record);
  }

  it("lets one account claim a file once, and another account claim the same file", () => {
    const db = open();
    batch(db);
    claim(db);
    expect(() => claim(db)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => claim(db, { account_id: OTHER_ACCOUNT })).not.toThrow();
  });

  it("is released rather than moved to another import", () => {
    const db = open();
    batch(db);
    batch(db, { id: id(61) });
    claim(db);
    expect(() => db.exec(`UPDATE import_file_claims SET import_id = '${id(61)}'`))
      .toThrow(/release a file claim rather than moving it/);
    // Releasing is a delete, which is allowed: an abandoned attempt stops
    // recognising its file.
    expect(() => db.exec(`DELETE FROM import_file_claims WHERE sha256 = '${HASH}'`)).not.toThrow();
  });

  it("requires a real fingerprint", () => {
    const db = open();
    batch(db);
    for (const sha of ["", "b".repeat(63), "B".repeat(64), "z".repeat(64)]) {
      expect(() => claim(db, { sha256: sha })).toThrow(/CHECK/);
    }
  });
});

describe("preview rows", () => {
  it("holds an invalid value rather than rounding, dropping or guessing it", () => {
    const db = open();
    batch(db);
    // Every normalized field may be absent while the row waits for correction.
    expect(() => row(db, {
      posted_date: null, merchant_text: null, normalized_text: null, amount_cents: null,
      kind: null, kind_source: null, category_id: null, assignment_origin: null,
      state: "held", issues_json: '[{"code":"invalid_amount"}]',
    })).not.toThrow();
    // A zero amount is held, not rejected: the owner corrects it.
    expect(() => row(db, { id: id(71), source_row_number: 2, amount_cents: 0, state: "held" })).not.toThrow();
  });

  it("still refuses an impossible date or an out-of-range amount", () => {
    const db = open();
    batch(db);
    for (const posted of ["2026-02-30", "05/01/2026", "2026-1-1", "1899-12-31", "3000-01-01"]) {
      expect(() => row(db, { posted_date: posted })).toThrow(/CHECK/);
    }
    for (const cents of [100000000000, -100000000000]) {
      expect(() => row(db, { amount_cents: cents })).toThrow(/CHECK/);
    }
  });

  it("numbers rows uniquely within their own import only", () => {
    const db = open();
    batch(db);
    batch(db, { id: id(61) });
    row(db);
    expect(() => row(db, { id: id(71) })).toThrow(/UNIQUE/);
    expect(() => row(db, { id: id(72), import_id: id(61) })).not.toThrow();
    for (const number of [0, -1, 25001]) {
      expect(() => row(db, { id: id(73), source_row_number: number })).toThrow(/CHECK/);
    }
  });

  it("will not let a confirmed duplicate be included", () => {
    const db = open();
    batch(db);
    expect(() => row(db, {
      duplicate_status: "confirmed", duplicate_decision: "include", state: "held",
      duplicate_match_count: 1, duplicate_evidence_digest: DIGEST,
    })).toThrow(/CHECK/);
    expect(() => row(db, {
      duplicate_status: "confirmed", duplicate_decision: "exclude", state: "excluded",
      duplicate_match_count: 1, duplicate_evidence_digest: DIGEST,
    })).not.toThrow();
  });

  it("refuses a decision about something there is no candidate for", () => {
    const db = open();
    batch(db);
    expect(() => row(db, { duplicate_status: "none", duplicate_decision: "include" })).toThrow(/CHECK/);
    // A status with no matches behind it, or matches with no status, are both refused.
    expect(() => row(db, { duplicate_status: "suspected", duplicate_match_count: 0 })).toThrow(/CHECK/);
    expect(() => row(db, { duplicate_match_count: 2, duplicate_evidence_digest: DIGEST })).toThrow(/CHECK/);
    expect(() => row(db, {
      duplicate_status: "suspected", duplicate_match_count: 1, duplicate_evidence_digest: null,
    })).toThrow(/CHECK/);
    expect(() => row(db, { transfer_decision: "confirm" })).toThrow(/CHECK/);
    expect(() => row(db, { transfer_candidate_json: '{"transactionId":"x"}' })).toThrow(/CHECK/);
  });

  it("keeps the stored state agreeing with the reasons for it", () => {
    const db = open();
    batch(db);
    // Excluded in name only, or excluded without a reason, are both refused.
    expect(() => row(db, { excluded: 1, state: "ready" })).toThrow(/CHECK/);
    expect(() => row(db, { excluded: 0, state: "excluded" })).toThrow(/CHECK/);
    expect(() => row(db, { excluded: 1, state: "excluded" })).not.toThrow();
    expect(() => row(db, {
      id: id(71), source_row_number: 2, duplicate_status: "suspected",
      duplicate_match_count: 1, duplicate_evidence_digest: DIGEST,
      duplicate_decision: "exclude", state: "excluded",
    })).not.toThrow();
  });

  it("keeps the changed-suggestion list and the review flag in agreement", () => {
    const db = open();
    batch(db);
    expect(() => row(db, { review_required: 1, changed_suggestions_json: "[]", state: "held" }))
      .toThrow(/CHECK/);
    expect(() => row(db, { review_required: 0, changed_suggestions_json: '["kind"]' })).toThrow(/CHECK/);
    expect(() => row(db, { changed_suggestions_json: '{"kind":true}' })).toThrow(/CHECK/);
    expect(() => row(db, {
      review_required: 1, changed_suggestions_json: '["kind","duplicate"]', state: "held",
    })).not.toThrow();
  });

  it("will not store more displayed matches than the contract shows, or than were found", () => {
    const db = open();
    batch(db);
    const match = '{"transactionId":null,"rowId":null,"lifecycle":null,"reason":"within_file"}';
    const displayed = (count: number): string => `[${Array.from({ length: count }, () => match).join(",")}]`;
    expect(() => row(db, {
      duplicate_status: "suspected", duplicate_matches_json: displayed(21),
      duplicate_match_count: 21, duplicate_evidence_digest: DIGEST, state: "held",
    })).toThrow(/CHECK/);
    // Fewer shown than found is exactly the intended case; the reverse is not.
    expect(() => row(db, {
      duplicate_status: "suspected", duplicate_matches_json: displayed(2),
      duplicate_match_count: 1, duplicate_evidence_digest: DIGEST, state: "held",
    })).toThrow(/CHECK/);
    expect(() => row(db, {
      duplicate_status: "suspected", duplicate_matches_json: displayed(20),
      duplicate_match_count: 500, duplicate_evidence_digest: DIGEST, state: "held",
    })).not.toThrow();
  });

  it("keeps a type and its source together, and a rule origin with its revision", () => {
    const db = open();
    batch(db);
    expect(() => row(db, { kind: "purchase", kind_source: null })).toThrow(/CHECK/);
    expect(() => row(db, { kind: null, kind_source: "bank" })).toThrow(/CHECK/);
    expect(() => row(db, { category_id: null })).toThrow(/CHECK/);
    expect(() => row(db, { assignment_origin: "rule" })).toThrow(/CHECK/);
    expect(() => row(db, { assignment_origin: "rule", rule_id: RULE, rule_revision: 1 })).not.toThrow();
    expect(() => row(db, { id: id(71), source_row_number: 2, rule_id: RULE, rule_revision: 9 }))
      .toThrow(/CHECK|FOREIGN KEY/);
  });

  it("never edits the values the bank actually wrote", () => {
    const db = open();
    batch(db);
    row(db);
    for (const change of [
      `source_fields_json = '{"Amount":"0.00"}'`, "source_row_number = 2",
      `created_at = ${String(NOW - 1)}`, `import_id = '${BATCH}'`,
    ]) {
      const statement = `UPDATE import_rows SET ${change} WHERE id = '${ROW}'`;
      if (change.startsWith("import_id")) continue;
      expect(() => db.exec(statement)).toThrow(/original source values cannot be changed/);
    }
    // A correction changes the normalized value beside the source, which is allowed.
    expect(() => db.exec(`UPDATE import_rows SET amount_cents = -4600, version = 2 WHERE id = '${ROW}'`)).not.toThrow();
  });

  it("cannot be added to a finished import", () => {
    const db = open();
    for (const [index, status] of ["committed", "cancelled", "expired", "failed"].entries()) {
      const batchId = id(200 + index);
      batch(db, {
        id: batchId, status, expires_at: null,
        ...(status === "committed"
          ? { result_rows: 0, result_added: 0, result_excluded: 0, result_paired_transfers: 0, result_json: "{}", completed_at: NOW }
          : {}),
        ...(status === "failed" ? { failure_code: "malformed_csv", failure_message: "bad" } : {}),
      });
      expect(() => row(db, { id: id(300 + index), import_id: batchId }))
        .toThrow(/finished import cannot gain rows/);
    }
  });

  it("refuses a version going backward", () => {
    const db = open();
    batch(db);
    row(db, { version: 3 });
    expect(() => db.exec(`UPDATE import_rows SET version = 2 WHERE id = '${ROW}'`))
      .toThrow(/row version cannot go backward/);
  });
});

describe("a row that already posted through a tracking-start extension", () => {
  function postedRow(db: SqliteDatabase): void {
    batch(db);
    sourceRecord(db);
    row(db, { posted_transaction_id: TX, source_record_id: SOURCE });
  }

  it("must be settled: ready, included and with nothing to re-review", () => {
    const db = open();
    batch(db);
    sourceRecord(db);
    for (const overrides of [
      { state: "held" },
      { state: "excluded", excluded: 1 },
      { review_required: 1 },
    ]) {
      expect(() => row(db, { posted_transaction_id: TX, source_record_id: SOURCE, ...overrides })).toThrow(/CHECK/);
    }
    expect(() => row(db, { posted_transaction_id: TX, source_record_id: SOURCE })).not.toThrow();
  });

  it("can never post a second transaction, or be reviewed again", () => {
    const db = open();
    postedRow(db);
    for (const change of [
      `posted_transaction_id = '${OTHER_TX}'`, "posted_transaction_id = NULL",
      "state = 'held'", "excluded = 1", "amount_cents = -1", "posted_date = '2026-05-09'",
      "merchant_text = 'CHANGED'", "kind = 'refund'", "kind_source = 'owner'",
      "duplicate_decision = 'exclude'", "review_required = 1",
    ]) {
      expect(() => db.exec(`UPDATE import_rows SET ${change} WHERE id = '${ROW}'`))
        .toThrow(/already posted cannot be reviewed or posted again|CHECK/);
    }
  });

  it("is never claimed by two rows", () => {
    const db = open();
    postedRow(db);
    batch(db, { id: id(61) });
    sourceRecord(db, id(81), 2);
    expect(() => row(db, { id: id(71), import_id: id(61), posted_transaction_id: TX, source_record_id: id(81) }))
      .toThrow(/UNIQUE/);
  });

  it("survives the purge that removes the rest of the abandoned preview", () => {
    const db = open();
    postedRow(db);
    row(db, { id: id(71), source_row_number: 2, state: "held", issues_json: '[{"code":"choose_type"}]' });
    // This is what discarding does: delete the unfinished rows.
    expect(() => db.exec(`DELETE FROM import_rows WHERE id = '${id(71)}'`)).not.toThrow();
    expect(() => db.exec(`DELETE FROM import_rows WHERE id = '${ROW}'`)).toThrow(/already posted cannot be purged/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM import_rows").get()).toEqual({ n: 1n });
  });
});

describe("retained source evidence and postings", () => {
  it("records evidence once per originating row and never rewrites it", () => {
    const db = open();
    batch(db);
    sourceRecord(db);
    expect(() => sourceRecord(db, id(81), 1)).toThrow(/UNIQUE/);
    expect(() => sourceRecord(db, id(81), 2)).not.toThrow();
    expect(() => db.exec(`UPDATE import_source_records SET normalized_json = '{}' WHERE id = '${SOURCE}'`))
      .toThrow(/retained source evidence cannot be changed/);
  });

  it("lets unclaimed evidence be cleaned up but keeps what a posting depends on", () => {
    const db = open();
    batch(db);
    sourceRecord(db);
    sourceRecord(db, id(81), 2);
    posting(db);
    expect(() => db.exec(`DELETE FROM import_source_records WHERE id = '${id(81)}'`)).not.toThrow();
    expect(() => db.exec(`DELETE FROM import_source_records WHERE id = '${SOURCE}'`))
      .toThrow(/posted source evidence cannot be removed/);
  });

  it("posts one source once and one transaction once", () => {
    const db = open();
    batch(db);
    sourceRecord(db);
    sourceRecord(db, id(81), 2);
    posting(db);
    // The same source offered by a second follow-up cannot post again.
    expect(() => posting(db, { id: id(91), transaction_id: OTHER_TX })).toThrow(/UNIQUE/);
    // And one transaction is never credited to two source rows.
    expect(() => posting(db, { id: id(92), source_record_id: id(81) })).toThrow(/UNIQUE/);
    expect(() => posting(db, { id: id(93), source_record_id: id(81), transaction_id: OTHER_TX })).not.toThrow();
  });

  it("records which path posted it, and refuses an undeclared one", () => {
    const db = open();
    batch(db);
    sourceRecord(db);
    expect(() => posting(db, { posting_path: "baseline_extension" })).not.toThrow();
    sourceRecord(db, id(81), 2);
    expect(() => posting(db, { id: id(91), source_record_id: id(81), transaction_id: OTHER_TX, posting_path: "somehow" }))
      .toThrow(/CHECK/);
  });

  it("is history: never changed, never removed, and it outlives a void and an unlink", () => {
    const db = open();
    batch(db);
    sourceRecord(db);
    posting(db, { paired_counterpart_id: OTHER_TX });
    expect(() => db.exec(`UPDATE import_postings SET posting_row_number = 2 WHERE id = '${POSTING}'`))
      .toThrow(/posting history cannot be changed/);
    expect(() => db.exec(`DELETE FROM import_postings WHERE id = '${POSTING}'`))
      .toThrow(/posting history cannot be removed/);
    // Voiding the transaction leaves the record of where it came from intact.
    db.prepare("UPDATE transactions SET lifecycle = 'void', voided_at = ?, version = 2 WHERE id = ?").run(NOW, TX);
    expect(db.prepare("SELECT transaction_id, paired_counterpart_id FROM import_postings").get())
      .toEqual({ transaction_id: TX, paired_counterpart_id: OTHER_TX });
  });

  it("refuses a pairing with itself", () => {
    const db = open();
    batch(db);
    sourceRecord(db);
    expect(() => posting(db, { paired_counterpart_id: TX })).toThrow(/CHECK/);
  });

  it("keeps a completed import's lineage separate from the batch that posted it", () => {
    const db = open();
    batch(db);
    batch(db, { id: id(61), parent_import_id: BATCH });
    sourceRecord(db);
    // Evidence from the original import, posted by the follow-up.
    expect(() => posting(db, { posting_import_id: id(61) })).not.toThrow();
    expect(db.prepare(`SELECT s.origin_import_id, p.posting_import_id FROM import_postings p
      JOIN import_source_records s ON s.id = p.source_record_id`).get())
      .toEqual({ origin_import_id: BATCH, posting_import_id: id(61) });
  });
});

describe("bank identities", () => {
  function identity(db: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
    const record = {
      account_id: ACCOUNT, provider_namespace: "synthetic-canonical", bank_transaction_id: "BANK-1",
      transaction_id: TX, created_at: NOW, ...overrides,
    };
    const columns = Object.keys(record);
    db.prepare(`INSERT INTO source_identities (${columns.join(", ")}) VALUES (${columns.map(c => `:${c}`).join(", ")})`)
      .run(record);
  }

  // The clobber trigger reaches a second claim before the primary key does, so
  // the refusal now names the claim rather than the constraint. Either way the
  // same bank record cannot be claimed twice, which is what this pins.
  it("is unique per account, namespace and bank id", () => {
    const db = open();
    identity(db);
    expect(() => identity(db, { transaction_id: OTHER_TX }))
      .toThrow(/UNIQUE|PRIMARY KEY|bank identity cannot be replaced/);
    expect(() => identity(db, { account_id: OTHER_ACCOUNT, transaction_id: OTHER_TX })).not.toThrow();
    expect(() => identity(db, { provider_namespace: "other-namespace", transaction_id: OTHER_TX })).not.toThrow();
  });

  it("still blocks the same bank record after its transaction is voided", () => {
    const db = open();
    identity(db);
    db.prepare("UPDATE transactions SET lifecycle = 'void', voided_at = ?, version = 2 WHERE id = ?").run(NOW, TX);
    expect(() => identity(db, { transaction_id: OTHER_TX }))
      .toThrow(/UNIQUE|PRIMARY KEY|bank identity cannot be replaced/);
  });

  it("is never reassigned to a different transaction", () => {
    const db = open();
    identity(db);
    expect(() => db.exec(`UPDATE source_identities SET transaction_id = '${OTHER_TX}'`))
      .toThrow(/bank identity cannot be reassigned/);
  });

  // Refusing UPDATE on its own is not append-only: a claim that can be deleted,
  // or replaced through conflict resolution, can still be reassigned in two
  // steps. Both are refused at the database, not just in the service.
  it("is never removed", () => {
    const db = open();
    identity(db);
    expect(() => db.exec("DELETE FROM source_identities")).toThrow(/bank identity cannot be removed/);
    expect(() => db.exec(`DELETE FROM source_identities WHERE bank_transaction_id = 'BANK-1'`))
      .toThrow(/bank identity cannot be removed/);
    expect(db.prepare("SELECT transaction_id FROM source_identities").get()).toEqual({ transaction_id: TX });
  });

  it.each(["INSERT OR REPLACE INTO", "REPLACE INTO"])("is never replaced by %s", statement => {
    const db = open();
    identity(db);
    // Refused by the clobber trigger before REPLACE's implicit delete is even
    // reached, so this does not depend on how the connection is configured.
    expect(() => db.prepare(`${statement} source_identities (account_id, provider_namespace,
      bank_transaction_id, transaction_id, created_at) VALUES (?, 'synthetic-canonical', 'BANK-1', ?, ?)`)
      .run(ACCOUNT, OTHER_TX, NOW)).toThrow(/bank identity cannot be replaced/);
    expect(db.prepare("SELECT transaction_id FROM source_identities").get()).toEqual({ transaction_id: TX });
  });

  /**
   * The protection must not rest on `recursive_triggers`, which is a property
   * of the connection and not of the file: a shell or a backup tool opening
   * this database would not have it. With it off, REPLACE's implicit delete
   * does not fire the delete trigger, so the clobber trigger is what holds.
   */
  it("is never replaced even on a connection without recursive triggers", () => {
    const db = open();
    identity(db);
    db.pragma("recursive_triggers = OFF");
    expect(() => db.prepare(`INSERT OR REPLACE INTO source_identities (account_id, provider_namespace,
      bank_transaction_id, transaction_id, created_at) VALUES (?, 'synthetic-canonical', 'BANK-1', ?, ?)`)
      .run(ACCOUNT, OTHER_TX, NOW)).toThrow(/bank identity cannot be replaced/);
    expect(db.prepare("SELECT transaction_id FROM source_identities").get()).toEqual({ transaction_id: TX });
  });

  it("still accepts a genuinely new claim", () => {
    const db = open();
    identity(db);
    expect(() => identity(db, { bank_transaction_id: "BANK-2", transaction_id: OTHER_TX })).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM source_identities").get()).toEqual({ n: 2n });
  });

  it("bounds its namespace and bank id", () => {
    const db = open();
    for (const namespace of ["", "Has Caps", "has space", "x".repeat(65)]) {
      expect(() => identity(db, { provider_namespace: namespace })).toThrow(/CHECK/);
    }
    expect(() => identity(db, { bank_transaction_id: "" })).toThrow(/CHECK/);
    expect(() => identity(db, { bank_transaction_id: "x".repeat(256) })).toThrow(/CHECK/);
  });
});

describe("references financial records restrictively", () => {
  it("will not let a category, rule revision or transaction be deleted out from under an import", () => {
    const db = open();
    batch(db);
    sourceRecord(db);
    row(db, { assignment_origin: "rule", rule_id: RULE, rule_revision: 1 });
    posting(db);
    expect(() => db.exec(`DELETE FROM categories WHERE id = '${CATEGORY}'`)).toThrow(/FOREIGN KEY/);
    // Rule revisions carry their own refusal, which is stronger than the
    // reference: they are never removable at all.
    expect(() => db.exec(`DELETE FROM rule_revisions WHERE rule_id = '${RULE}'`))
      .toThrow(/rule revisions cannot be removed/);
    // Transactions are never deletable at all, which is what protects a posting.
    expect(() => db.exec(`DELETE FROM transactions WHERE id = '${TX}'`)).toThrow(/must be voided/);
  });

  it("leaves no dangling reference behind after a full migration", () => {
    const db = open();
    batch(db);
    sourceRecord(db);
    row(db, { source_record_id: SOURCE });
    posting(db);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("refuses a row, upload, claim or evidence record for an import that does not exist", () => {
    const db = open();
    expect(() => row(db)).toThrow(/FOREIGN KEY/);
    expect(() => sourceRecord(db)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`INSERT INTO uploads (storage_key, import_id, byte_size, sha256, state, created_at, updated_at)
      VALUES (?, ?, 1, ?, 'available', ?, ?)`).run(KEY, BATCH, HASH, NOW, NOW)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("INSERT INTO import_file_claims VALUES (?, ?, ?, ?)").run(ACCOUNT, HASH, BATCH, NOW))
      .toThrow(/FOREIGN KEY/);
  });

  it("keeps the protected income category usable as a retained reference", () => {
    const db = open();
    batch(db);
    expect(() => row(db, { category_id: UNCATEGORIZED, assignment_origin: "unassigned" })).not.toThrow();
  });
});
