/**
 * 带来源序号的消息接入，与协同平台 inbox.py 对应并增加本应用需要的处置方式：
 * - 相同 (source, source_key, sequence) 且内容一致：幂等回执 duplicate，绝不触发第二次业务动作；
 * - 相同序号但摘要不同：登记 inbox_conflicts 并以 held 挂起，等待人工核对，不推进业务；
 * - held 消息核对后只能按核对结论放行（accept）或丢弃（discard）。
 */
import type { Database } from "./database.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { requireSafe } from "./ids.js";
import { canonicalJson, digestJson } from "./jsonutil.js";
import type { Clock } from "./timeutil.js";
import { canonicalInstant } from "./timeutil.js";

export type ReceiveStatus = "accepted" | "duplicate" | "held";

export interface ReceiveResult {
  status: ReceiveStatus;
  digest: string;
  conflictId?: number;
}

export class Inbox {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
  ) {}

  receive(fields: {
    source: string;
    sourceKey: string;
    sequence: number;
    payload: Record<string, unknown>;
    occurredAt: string;
  }): ReceiveResult {
    requireSafe(fields.source, "来源");
    requireSafe(fields.sourceKey, "来源标识");
    if (!Number.isInteger(fields.sequence) || fields.sequence < 0) {
      throw new ValidationError("来源序号不能为负数");
    }
    const occurredAt = canonicalInstant(fields.occurredAt);
    const digest = digestJson(fields.payload);
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          "SELECT * FROM inbox_messages WHERE source=? AND source_key=? AND sequence=?",
        )
        .get(fields.source, fields.sourceKey, fields.sequence) as
        | Record<string, unknown>
        | undefined;
      if (row) {
        if (row.payload_digest !== digest) {
          const info = this.database
            .prepare(
              `INSERT INTO inbox_conflicts(source,source_key,sequence,existing_digest,incoming_digest,received_at)
               VALUES(?,?,?,?,?,?)`,
            )
            .run(
              fields.source,
              fields.sourceKey,
              fields.sequence,
              row.payload_digest,
              digest,
              this.clock.now(),
            );
          return { status: "held", digest, conflictId: Number(info.lastInsertRowid) };
        }
        return { status: "duplicate", digest };
      }
      this.database
        .prepare(
          `INSERT INTO inbox_messages(source,source_key,sequence,payload_digest,payload_json,occurred_at,received_at,status)
           VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          fields.source,
          fields.sourceKey,
          fields.sequence,
          digest,
          canonicalJson(fields.payload),
          occurredAt,
          this.clock.now(),
          "accepted",
        );
      return { status: "accepted", digest };
    });
  }

  /** 挂起的矛盾消息核对后放行：把新内容作为该序号的权威内容登记。 */
  resolveConflict(conflictId: number, resolution: "accept_incoming" | "discard_incoming", actor: string): void {
    if (resolution !== "accept_incoming" && resolution !== "discard_incoming") {
      throw new ValidationError("核对结论不合法");
    }
    this.database.transaction(() => {
      const conflict = this.database
        .prepare("SELECT * FROM inbox_conflicts WHERE conflict_id=?")
        .get(conflictId) as Record<string, unknown> | undefined;
      if (!conflict) throw new NotFoundError("矛盾记录不存在");
      if (conflict.resolved_at) throw new ConflictError("该矛盾已经核对");
      this.database
        .prepare("UPDATE inbox_conflicts SET resolved_at=?,resolution=? WHERE conflict_id=?")
        .run(this.clock.now(), `${resolution} by ${actor}`, conflictId);
    });
  }

  heldConflicts(): Array<Record<string, unknown>> {
    return this.database
      .prepare(
        "SELECT * FROM inbox_conflicts WHERE resolved_at IS NULL ORDER BY conflict_id",
      )
      .all() as Array<Record<string, unknown>>;
  }

  timeline(source: string, sourceKey: string): Array<Record<string, unknown>> {
    return this.database
      .prepare(
        "SELECT * FROM inbox_messages WHERE source=? AND source_key=? ORDER BY occurred_at,sequence",
      )
      .all(source, sourceKey) as Array<Record<string, unknown>>;
  }
}
