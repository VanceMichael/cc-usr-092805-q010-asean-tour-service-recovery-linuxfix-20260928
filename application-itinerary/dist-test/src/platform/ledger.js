import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { newId, requireSafe } from "./ids.js";
export function toMinor(amount) {
    if (!/^-?\d+(\.\d{1,2})?$/.test(amount))
        throw new ValidationError("金额格式错误");
    const [whole, fraction = ""] = amount.split(".");
    return Number(`${whole}${(fraction + "00").slice(0, 2)}`);
}
export function fromMinor(minor) {
    const sign = minor < 0 ? "-" : "";
    const abs = Math.abs(minor);
    return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
export class Ledger {
    database;
    clock;
    constructor(database, clock) {
        this.database = database;
        this.clock = clock;
    }
    post(fields) {
        requireSafe(fields.journalKey, "账簿标识");
        requireSafe(fields.currency, "币种");
        const minor = toMinor(fields.amount);
        if (minor <= 0)
            throw new ValidationError("金额必须大于零");
        return this.database.transaction(() => {
            const duplicate = this.database
                .prepare("SELECT entry_id FROM journal_entries WHERE journal_key=? AND reference=? AND direction=?")
                .get(fields.journalKey, fields.reference, fields.direction);
            if (duplicate)
                throw new ConflictError("相同参考号和方向已经入账");
            const entryId = newId("entry");
            this.database
                .prepare(`INSERT INTO journal_entries(entry_id,journal_key,account,currency,amount_minor,direction,reference,occurred_at,posted_by)
           VALUES(?,?,?,?,?,?,?,?,?)`)
                .run(entryId, fields.journalKey, fields.account, fields.currency, minor, fields.direction, fields.reference, this.clock.now(), fields.actor);
            return { entryId, amountMinor: minor, direction: fields.direction };
        });
    }
    reverse(entryId, opts) {
        return this.database.transaction(() => {
            const row = this.database
                .prepare("SELECT * FROM journal_entries WHERE entry_id=?")
                .get(entryId);
            if (!row)
                throw new NotFoundError("原分录不存在");
            const existing = this.database
                .prepare("SELECT entry_id FROM journal_entries WHERE reversed_entry_id=?")
                .get(entryId);
            if (existing?.entry_id)
                return { entryId: existing.entry_id, replayed: true };
            const reversal = newId("entry");
            const direction = row.direction === "debit" ? "credit" : "debit";
            this.database
                .prepare(`INSERT INTO journal_entries(entry_id,journal_key,account,currency,amount_minor,direction,reference,reversed_entry_id,occurred_at,posted_by)
           VALUES(?,?,?,?,?,?,?,?,?,?)`)
                .run(reversal, row.journal_key, row.account, row.currency, row.amount_minor, direction, opts.reference, entryId, this.clock.now(), opts.actor);
            return { entryId: reversal, replayed: false };
        });
    }
    entries(journalKey) {
        return this.database
            .prepare("SELECT * FROM journal_entries WHERE journal_key=? ORDER BY occurred_at,entry_id")
            .all(journalKey);
    }
    balance(journalKey, currency) {
        const row = this.database
            .prepare(`SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END),0) AS value
         FROM journal_entries WHERE journal_key=? AND currency=?`)
            .get(journalKey, currency);
        return row.value;
    }
}
