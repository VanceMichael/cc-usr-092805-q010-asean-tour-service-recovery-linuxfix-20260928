/** SQLite 连接与建表，表结构沿用协同平台 database.py。 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 包装预编译语句，允许业务层直接传 unknown 参数并统一行类型。 */
export class Statement {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.stmt.run(...(params as Array<string | number | bigint | Uint8Array | null>));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.stmt.get(
      ...(params as Array<string | number | bigint | Uint8Array | null>),
    ) as Record<string, unknown> | undefined;
  }

  all(...params: unknown[]): Array<Record<string, unknown>> {
    return this.stmt.all(
      ...(params as Array<string | number | bigint | Uint8Array | null>),
    ) as Array<Record<string, unknown>>;
  }
}

export const PLATFORM_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS entities (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY(entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS entity_versions (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    PRIMARY KEY(entity_type, entity_id, version)
);
CREATE INDEX IF NOT EXISTS entity_versions_asof ON entity_versions(entity_type, entity_id, valid_from, version);
CREATE TABLE IF NOT EXISTS idempotency_keys (
    scope TEXT NOT NULL,
    request_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(scope, request_key)
);
CREATE TABLE IF NOT EXISTS audit_entries (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    detail_json TEXT NOT NULL,
    previous_digest TEXT NOT NULL,
    entry_digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_messages (
    source TEXT NOT NULL,
    source_key TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    payload_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY(source, source_key, sequence)
);
CREATE TABLE IF NOT EXISTS inbox_conflicts (
    conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_key TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    existing_digest TEXT NOT NULL,
    incoming_digest TEXT NOT NULL,
    received_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS outbox_messages (
    message_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    available_at TEXT NOT NULL,
    lease_until TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS outbox_ready ON outbox_messages(status, available_at, lease_until);
CREATE TABLE IF NOT EXISTS journal_entries (
    entry_id TEXT PRIMARY KEY,
    journal_key TEXT NOT NULL,
    account TEXT NOT NULL,
    currency TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    direction TEXT NOT NULL,
    reference TEXT NOT NULL,
    reversed_entry_id TEXT,
    occurred_at TEXT NOT NULL,
    posted_by TEXT NOT NULL,
    FOREIGN KEY(reversed_entry_id) REFERENCES journal_entries(entry_id)
);
CREATE INDEX IF NOT EXISTS journal_reference ON journal_entries(journal_key, reference, occurred_at);
CREATE TABLE IF NOT EXISTS resource_reservations (
    reservation_id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reservation_window ON resource_reservations(resource_id, start_at, end_at, status);
CREATE TABLE IF NOT EXISTS scheduled_jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    run_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    lease_until TEXT,
    last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS jobs_due ON scheduled_jobs(status, run_at, lease_until);
`;

export class Database {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (dir) mkdirSync(dir, { recursive: true });
    }
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys=ON");
    this.sqlite.exec("PRAGMA journal_mode=WAL");
    this.sqlite.exec("PRAGMA busy_timeout=30000");
  }

  initialize(extraSchema: string = ""): void {
    this.sqlite.exec(PLATFORM_SCHEMA);
    if (extraSchema) this.sqlite.exec(extraSchema);
  }

  prepare(sql: string): Statement {
    return new Statement(this.sqlite.prepare(sql));
  }

  transaction<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.sqlite.close();
  }
}
