/** 不可变资金分录与冲正，金额按最小币种单位整数记账，与协同平台 ledger.py 对应。 */
import type { Database } from "./database.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { newId, requireSafe } from "./ids.js";
import type { Clock } from "./timeutil.js";

export function toMinor(amount: string): number {
  if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) throw new ValidationError("金额格式错误");
  const [whole, fraction = ""] = amount.split(".");
  return Number(`${whole}${(fraction + "00").slice(0, 2)}`);
}

export function fromMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export type Direction = "debit" | "credit";

export interface PostEntry {
  entryId: string;
  amountMinor: number;
  direction: Direction;
}

export class Ledger {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
  ) {}

  post(fields: {
    journalKey: string;
    account: string;
    currency: string;
    amount: string;
    direction: Direction;
    reference: string;
    actor: string;
  }): PostEntry {
    requireSafe(fields.journalKey, "账簿标识");
    requireSafe(fields.currency, "币种");
    const minor = toMinor(fields.amount);
    if (minor <= 0) throw new ValidationError("金额必须大于零");
    return this.database.transaction(() => {
      const duplicate = this.database
        .prepare(
          "SELECT entry_id FROM journal_entries WHERE journal_key=? AND reference=? AND direction=?",
        )
        .get(fields.journalKey, fields.reference, fields.direction);
      if (duplicate) throw new ConflictError("相同参考号和方向已经入账");
      const entryId = newId("entry");
      this.database
        .prepare(
          `INSERT INTO journal_entries(entry_id,journal_key,account,currency,amount_minor,direction,reference,occurred_at,posted_by)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          entryId,
          fields.journalKey,
          fields.account,
          fields.currency,
          minor,
          fields.direction,
          fields.reference,
          this.clock.now(),
          fields.actor,
        );
      return { entryId, amountMinor: minor, direction: fields.direction };
    });
  }

  reverse(entryId: string, opts: { reference: string; actor: string }): { entryId: string; replayed: boolean } {
    return this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM journal_entries WHERE entry_id=?")
        .get(entryId) as Record<string, unknown> | undefined;
      if (!row) throw new NotFoundError("原分录不存在");
      const existing = this.database
        .prepare("SELECT entry_id FROM journal_entries WHERE reversed_entry_id=?")
        .get(entryId) as { entry_id?: string } | undefined;
      if (existing?.entry_id) return { entryId: existing.entry_id, replayed: true };
      const reversal = newId("entry");
      const direction: Direction = row.direction === "debit" ? "credit" : "debit";
      this.database
        .prepare(
          `INSERT INTO journal_entries(entry_id,journal_key,account,currency,amount_minor,direction,reference,reversed_entry_id,occurred_at,posted_by)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          reversal,
          row.journal_key,
          row.account,
          row.currency,
          row.amount_minor,
          direction,
          opts.reference,
          entryId,
          this.clock.now(),
          opts.actor,
        );
      return { entryId: reversal, replayed: false };
    });
  }

  entries(journalKey: string): Array<Record<string, unknown>> {
    return this.database
      .prepare("SELECT * FROM journal_entries WHERE journal_key=? ORDER BY occurred_at,entry_id")
      .all(journalKey) as Array<Record<string, unknown>>;
  }

  balance(journalKey: string, currency: string): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END),0) AS value
         FROM journal_entries WHERE journal_key=? AND currency=?`,
      )
      .get(journalKey, currency) as { value: number };
    return row.value;
  }
}
