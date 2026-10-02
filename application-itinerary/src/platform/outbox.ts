/** 可靠通知发件箱，租约投递、失败计数，与协同平台 outbox.py 对应。 */
import type { Database } from "./database.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { newId } from "./ids.js";
import { canonicalJson } from "./jsonutil.js";
import type { Clock } from "./timeutil.js";
import { parseInstant } from "./timeutil.js";

export interface OutboxMessage {
  messageId: string;
  topic: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
  leaseOwner?: string;
}

const MAX_ATTEMPTS = 5;

export class Outbox {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
  ) {}

  enqueue(fields: {
    topic: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    availableAt?: string;
  }): string {
    const messageId = newId("msg");
    const availableAt = fields.availableAt ?? this.clock.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO outbox_messages(message_id,topic,aggregate_id,payload_json,available_at,status)
           VALUES(?,?,?,?,?,?)`,
        )
        .run(
          messageId,
          fields.topic,
          fields.aggregateId,
          canonicalJson(fields.payload),
          availableAt,
          "pending",
        );
    });
    return messageId;
  }

  lease(owner: string, opts: { seconds?: number; limit?: number } = {}): OutboxMessage[] {
    const seconds = opts.seconds ?? 30;
    const limit = opts.limit ?? 20;
    const now = parseInstant(this.clock.now());
    const leaseUntil = new Date(now.getTime() + seconds * 1000).toISOString().replace(/\.000Z$/, "Z");
    const nowText = this.clock.now();
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT * FROM outbox_messages WHERE status IN ('pending','failed') AND available_at<=?
           AND (lease_until IS NULL OR lease_until<?) ORDER BY available_at,message_id LIMIT ?`,
        )
        .all(nowText, nowText, limit) as Array<Record<string, unknown>>;
      const result: OutboxMessage[] = [];
      for (const row of rows) {
        const changed = this.database
          .prepare(
            `UPDATE outbox_messages SET status='leased',lease_until=?,attempts=attempts+1
             WHERE message_id=? AND status IN ('pending','failed') AND (lease_until IS NULL OR lease_until<?)`,
          )
          .run(leaseUntil, row.message_id, nowText).changes;
        if (changed === 1) {
          result.push({
            messageId: row.message_id as string,
            topic: row.topic as string,
            aggregateId: row.aggregate_id as string,
            payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
            attempts: (row.attempts as number) + 1,
            leaseOwner: owner,
          });
        }
      }
      return result;
    });
  }

  complete(messageId: string): void {
    this.database.transaction(() => {
      const changed = this.database
        .prepare(
          "UPDATE outbox_messages SET status='delivered',delivered_at=?,lease_until=NULL WHERE message_id=? AND status='leased'",
        )
        .run(this.clock.now(), messageId).changes;
      if (changed !== 1) throw new ConflictError("消息没有有效租约");
    });
  }

  fail(messageId: string, retryAt: string): string {
    return this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT attempts FROM outbox_messages WHERE message_id=?")
        .get(messageId) as { attempts?: number } | undefined;
      if (!row) throw new NotFoundError("消息不存在");
      const status = (row.attempts ?? 0) >= MAX_ATTEMPTS ? "dead" : "failed";
      this.database
        .prepare(
          "UPDATE outbox_messages SET status=?,lease_until=NULL,available_at=? WHERE message_id=?",
        )
        .run(status, retryAt, messageId);
      return status;
    });
  }

  /** 重启续接：租约已过期的 leased 消息回到 failed，允许再次投递。 */
  recoverStaleLeases(): number {
    return this.database.transaction(() => {
      const info = this.database
        .prepare(
          `UPDATE outbox_messages SET status='failed',lease_until=NULL
           WHERE status='leased' AND lease_until IS NOT NULL AND lease_until<?`,
        )
        .run(this.clock.now());
      return info.changes;
    });
  }
}
