/** 追加式 SHA-256 哈希审计链，与协同平台 audit.py 对应。 */
import { createHash } from "node:crypto";
import { InvariantViolation } from "./errors.js";
import { canonicalJson } from "./jsonutil.js";
export class AuditLog {
    clock;
    constructor(clock) {
        this.clock = clock;
    }
    append(db, fields) {
        const row = db
            .prepare("SELECT entry_digest FROM audit_entries ORDER BY audit_id DESC LIMIT 1")
            .get();
        const previous = row?.entry_digest ?? "0".repeat(64);
        const occurredAt = this.clock.now();
        const body = canonicalJson({
            occurred_at: occurredAt,
            actor_id: fields.actorId,
            action: fields.action,
            entity_type: fields.entityType,
            entity_id: fields.entityId,
            version: fields.version,
            detail: fields.detail,
            previous,
        });
        const digest = createHash("sha256").update(body, "utf8").digest("hex");
        db.prepare(`INSERT INTO audit_entries(occurred_at,actor_id,action,entity_type,entity_id,version,detail_json,previous_digest,entry_digest)
       VALUES(?,?,?,?,?,?,?,?,?)`).run(occurredAt, fields.actorId, fields.action, fields.entityType, fields.entityId, fields.version, canonicalJson(fields.detail), previous, digest);
        return digest;
    }
    verify(db) {
        let previous = "0".repeat(64);
        let count = 0;
        const rows = db
            .prepare("SELECT * FROM audit_entries ORDER BY audit_id")
            .all();
        for (const row of rows) {
            const body = canonicalJson({
                occurred_at: row.occurred_at,
                actor_id: row.actor_id,
                action: row.action,
                entity_type: row.entity_type,
                entity_id: row.entity_id,
                version: row.version,
                detail: JSON.parse(row.detail_json),
                previous,
            });
            const expected = createHash("sha256").update(body, "utf8").digest("hex");
            if (row.previous_digest !== previous || row.entry_digest !== expected) {
                throw new InvariantViolation(`审计链在 ${String(row.audit_id)} 处不连续`);
            }
            previous = expected;
            count += 1;
        }
        return count;
    }
}
