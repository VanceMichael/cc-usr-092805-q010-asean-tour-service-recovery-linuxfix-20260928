import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { requireSafe } from "./ids.js";
import { canonicalJson, digestJson } from "./jsonutil.js";
import { canonicalInstant } from "./timeutil.js";
export class Inbox {
    database;
    clock;
    constructor(database, clock) {
        this.database = database;
        this.clock = clock;
    }
    receive(fields) {
        requireSafe(fields.source, "来源");
        requireSafe(fields.sourceKey, "来源标识");
        if (!Number.isInteger(fields.sequence) || fields.sequence < 0) {
            throw new ValidationError("来源序号不能为负数");
        }
        const occurredAt = canonicalInstant(fields.occurredAt);
        const digest = digestJson(fields.payload);
        return this.database.transaction(() => {
            const row = this.database
                .prepare("SELECT * FROM inbox_messages WHERE source=? AND source_key=? AND sequence=?")
                .get(fields.source, fields.sourceKey, fields.sequence);
            if (row) {
                if (row.payload_digest !== digest) {
                    const info = this.database
                        .prepare(`INSERT INTO inbox_conflicts(source,source_key,sequence,existing_digest,incoming_digest,received_at)
               VALUES(?,?,?,?,?,?)`)
                        .run(fields.source, fields.sourceKey, fields.sequence, row.payload_digest, digest, this.clock.now());
                    return { status: "held", digest, conflictId: Number(info.lastInsertRowid) };
                }
                return { status: "duplicate", digest };
            }
            this.database
                .prepare(`INSERT INTO inbox_messages(source,source_key,sequence,payload_digest,payload_json,occurred_at,received_at,status)
           VALUES(?,?,?,?,?,?,?,?)`)
                .run(fields.source, fields.sourceKey, fields.sequence, digest, canonicalJson(fields.payload), occurredAt, this.clock.now(), "accepted");
            return { status: "accepted", digest };
        });
    }
    /** 挂起的矛盾消息核对后放行：把新内容作为该序号的权威内容登记。 */
    resolveConflict(conflictId, resolution, actor) {
        if (resolution !== "accept_incoming" && resolution !== "discard_incoming") {
            throw new ValidationError("核对结论不合法");
        }
        this.database.transaction(() => {
            const conflict = this.database
                .prepare("SELECT * FROM inbox_conflicts WHERE conflict_id=?")
                .get(conflictId);
            if (!conflict)
                throw new NotFoundError("矛盾记录不存在");
            if (conflict.resolved_at)
                throw new ConflictError("该矛盾已经核对");
            this.database
                .prepare("UPDATE inbox_conflicts SET resolved_at=?,resolution=? WHERE conflict_id=?")
                .run(this.clock.now(), `${resolution} by ${actor}`, conflictId);
        });
    }
    heldConflicts() {
        return this.database
            .prepare("SELECT * FROM inbox_conflicts WHERE resolved_at IS NULL ORDER BY conflict_id")
            .all();
    }
    timeline(source, sourceKey) {
        return this.database
            .prepare("SELECT * FROM inbox_messages WHERE source=? AND source_key=? ORDER BY occurred_at,sequence")
            .all(source, sourceKey);
    }
}
