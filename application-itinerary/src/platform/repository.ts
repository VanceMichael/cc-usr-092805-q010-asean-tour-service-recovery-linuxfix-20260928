/** 版本化实体仓储，与协同平台 repository.py 对应（含历史与时点快照）。 */
import type { Database } from "./database.js";
import { AuditLog } from "./audit.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { newId } from "./ids.js";
import { digestJson, canonicalJson } from "./jsonutil.js";
import type { Clock } from "./timeutil.js";
import { parseInstant } from "./timeutil.js";

export type Entity = Record<string, unknown> & {
  entity_type: string;
  entity_id: string;
  version: number;
  state: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
};

export type EntityVersion = Record<string, unknown> & {
  entity_type: string;
  entity_id: string;
  version: number;
  state: string;
  valid_from: string;
  actor_id: string;
  request_key: string;
};

export class EntityRepository {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
    readonly audit: AuditLog,
  ) {}

  create(
    entityType: string,
    payload: Record<string, unknown>,
    opts: { actor: string; requestKey: string },
  ): Entity {
    return this.database.transaction(() => {
      const existing = this.lookupIdempotency(
        entityType,
        undefined,
        opts.requestKey,
        digestJson(payload),
      );
      if (existing) return JSON.parse(existing) as Entity;
      const entityId = newId(entityType);
      const now = this.clock.now();
      const state = String(payload.state ?? "draft");
      const body = { ...payload, state };
      this.database
        .prepare(
          `INSERT INTO entities(entity_type,entity_id,version,state,payload_json,created_at,updated_at,created_by,updated_by)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(entityType, entityId, 1, state, canonicalJson(body), now, now, opts.actor, opts.actor);
      this.database
        .prepare(
          `INSERT INTO entity_versions(entity_type,entity_id,version,state,payload_json,valid_from,actor_id,request_key)
           VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(entityType, entityId, 1, state, canonicalJson(body), now, opts.actor, opts.requestKey);
      this.audit.append(this.database, {
        actorId: opts.actor,
        action: "create",
        entityType,
        entityId,
        version: 1,
        detail: body,
      });
      const result = this.rowToEntity(
        this.database
          .prepare("SELECT * FROM entities WHERE entity_type=? AND entity_id=?")
          .get(entityType, entityId),
      );
      this.storeIdempotency(entityType, undefined, opts.requestKey, payload, result);
      return result;
    });
  }

  update(
    entityType: string,
    entityId: string,
    changes: Record<string, unknown>,
    opts: { actor: string; expectedVersion: number; requestKey: string },
  ): Entity {
    if (Object.keys(changes).length === 0) throw new ValidationError("修改内容不能为空");
    return this.database.transaction(() => {
      const existing = this.lookupIdempotency(
        entityType,
        entityId,
        opts.requestKey,
        digestJson({ changes, expected_version: opts.expectedVersion }),
      );
      if (existing) return JSON.parse(existing) as Entity;
      const row = this.database
        .prepare("SELECT * FROM entities WHERE entity_type=? AND entity_id=?")
        .get(entityType, entityId);
      if (!row) throw new NotFoundError(`${entityType}/${entityId} 不存在`);
      if (row.version !== opts.expectedVersion) {
        throw new ConflictError(`版本冲突，当前为 ${String(row.version)}`);
      }
      const payload = JSON.parse(row.payload_json as string) as Record<string, unknown>;
      Object.assign(payload, changes);
      const version = opts.expectedVersion + 1;
      const state = String(payload.state ?? row.state);
      const now = this.clock.now();
      const changed = this.database
        .prepare(
          `UPDATE entities SET version=?,state=?,payload_json=?,updated_at=?,updated_by=?
           WHERE entity_type=? AND entity_id=? AND version=?`,
        )
        .run(
          version,
          state,
          canonicalJson(payload),
          now,
          opts.actor,
          entityType,
          entityId,
          opts.expectedVersion,
        ).changes;
      if (changed !== 1) throw new ConflictError("并发修改导致版本变化");
      this.database
        .prepare(
          `INSERT INTO entity_versions(entity_type,entity_id,version,state,payload_json,valid_from,actor_id,request_key)
           VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(entityType, entityId, version, state, canonicalJson(payload), now, opts.actor, opts.requestKey);
      this.audit.append(this.database, {
        actorId: opts.actor,
        action: "update",
        entityType,
        entityId,
        version,
        detail: changes,
      });
      const result = this.rowToEntity(
        this.database
          .prepare("SELECT * FROM entities WHERE entity_type=? AND entity_id=?")
          .get(entityType, entityId),
      );
      this.storeIdempotency(
        entityType,
        entityId,
        opts.requestKey,
        { changes, expected_version: opts.expectedVersion },
        result,
      );
      return result;
    });
  }

  get(entityType: string, entityId: string): Entity {
    const row = this.database
      .prepare("SELECT * FROM entities WHERE entity_type=? AND entity_id=?")
      .get(entityType, entityId);
    if (!row) throw new NotFoundError(`${entityType}/${entityId} 不存在`);
    return this.rowToEntity(row);
  }

  find(entityType: string, entityId: string): Entity | undefined {
    const row = this.database
      .prepare("SELECT * FROM entities WHERE entity_type=? AND entity_id=?")
      .get(entityType, entityId);
    return row ? this.rowToEntity(row) : undefined;
  }

  list(entityType: string, filter?: { state?: string; limit?: number }): Entity[] {
    const limit = filter?.limit ?? 100;
    if (limit < 1 || limit > 500) throw new ValidationError("limit 必须在 1 到 500 之间");
    let sql = "SELECT * FROM entities WHERE entity_type=?";
    const params: unknown[] = [entityType];
    if (filter?.state) {
      sql += " AND state=?";
      params.push(filter.state);
    }
    sql += " ORDER BY updated_at, entity_id LIMIT ?";
    params.push(limit);
    return this.database.prepare(sql).all(...params).map((row) => this.rowToEntity(row));
  }

  history(entityType: string, entityId: string): EntityVersion[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM entity_versions WHERE entity_type=? AND entity_id=? ORDER BY version",
      )
      .all(entityType, entityId);
    if (rows.length === 0) throw new NotFoundError(`${entityType}/${entityId} 不存在`);
    return rows.map((row) => this.versionToEntity(row));
  }

  snapshot(entityType: string, entityId: string, asOf: string): EntityVersion {
    const instant = parseInstant(asOf).toISOString().replace(/\.000Z$/, "Z");
    const row = this.database
      .prepare(
        `SELECT * FROM entity_versions WHERE entity_type=? AND entity_id=? AND valid_from<=?
         ORDER BY valid_from DESC,version DESC LIMIT 1`,
      )
      .get(entityType, entityId, instant);
    if (!row) throw new NotFoundError("指定时点没有可见版本");
    return this.versionToEntity(row);
  }

  private idempotencyScope(entityType: string, entityId?: string): string {
    return entityId ? `update:${entityType}:${entityId}` : `create:${entityType}`;
  }

  private lookupIdempotency(
    entityType: string,
    entityId: string | undefined,
    requestKey: string,
    requestDigest: string,
  ): string | undefined {
    const row = this.database
      .prepare("SELECT request_digest, response_json FROM idempotency_keys WHERE scope=? AND request_key=?")
      .get(this.idempotencyScope(entityType, entityId), requestKey) as
      | { request_digest: string; response_json: string }
      | undefined;
    if (!row) return undefined;
    if (row.request_digest !== requestDigest) {
      throw new ConflictError("相同请求标识对应不同内容");
    }
    return row.response_json;
  }

  private storeIdempotency(
    entityType: string,
    entityId: string | undefined,
    requestKey: string,
    request: unknown,
    response: unknown,
  ): void {
    this.database
      .prepare(
        `INSERT INTO idempotency_keys(scope,request_key,request_digest,response_json,created_at)
         VALUES(?,?,?,?,?)`,
      )
      .run(
        this.idempotencyScope(entityType, entityId),
        requestKey,
        digestJson(request),
        canonicalJson(response),
        this.clock.now(),
      );
  }

  private rowToEntity(row: Record<string, unknown> | undefined): Entity {
    if (!row) throw new NotFoundError("实体不存在");
    const payload = JSON.parse(row.payload_json as string) as Record<string, unknown>;
    return {
      ...payload,
      entity_type: row.entity_type as string,
      entity_id: row.entity_id as string,
      version: row.version as number,
      state: row.state as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      created_by: row.created_by as string,
      updated_by: row.updated_by as string,
    };
  }

  private versionToEntity(row: Record<string, unknown>): EntityVersion {
    const payload = JSON.parse(row.payload_json as string) as Record<string, unknown>;
    return {
      ...payload,
      entity_type: row.entity_type as string,
      entity_id: row.entity_id as string,
      version: row.version as number,
      state: row.state as string,
      valid_from: row.valid_from as string,
      actor_id: row.actor_id as string,
      request_key: row.request_key as string,
    };
  }
}
