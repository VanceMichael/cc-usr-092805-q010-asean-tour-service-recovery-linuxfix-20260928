import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { newId } from "./ids.js";
import { digestJson, canonicalJson } from "./jsonutil.js";
import { parseInstant } from "./timeutil.js";
export class EntityRepository {
    database;
    clock;
    audit;
    constructor(database, clock, audit) {
        this.database = database;
        this.clock = clock;
        this.audit = audit;
    }
    create(entityType, payload, opts) {
        return this.database.transaction(() => {
            const existing = this.lookupIdempotency(entityType, undefined, opts.requestKey, digestJson(payload));
            if (existing)
                return JSON.parse(existing);
            const entityId = newId(entityType);
            const now = this.clock.now();
            const state = String(payload.state ?? "draft");
            const body = { ...payload, state };
            this.database
                .prepare(`INSERT INTO entities(entity_type,entity_id,version,state,payload_json,created_at,updated_at,created_by,updated_by)
           VALUES(?,?,?,?,?,?,?,?,?)`)
                .run(entityType, entityId, 1, state, canonicalJson(body), now, now, opts.actor, opts.actor);
            this.database
                .prepare(`INSERT INTO entity_versions(entity_type,entity_id,version,state,payload_json,valid_from,actor_id,request_key)
           VALUES(?,?,?,?,?,?,?,?)`)
                .run(entityType, entityId, 1, state, canonicalJson(body), now, opts.actor, opts.requestKey);
            this.audit.append(this.database, {
                actorId: opts.actor,
                action: "create",
                entityType,
                entityId,
                version: 1,
                detail: body,
            });
            const result = this.rowToEntity(this.database
                .prepare("SELECT * FROM entities WHERE entity_type=? AND entity_id=?")
                .get(entityType, entityId));
            this.storeIdempotency(entityType, undefined, opts.requestKey, payload, result);
            return result;
        });
    }
    update(entityType, entityId, changes, opts) {
        if (Object.keys(changes).length === 0)
            throw new ValidationError("修改内容不能为空");
        return this.database.transaction(() => {
            const existing = this.lookupIdempotency(entityType, entityId, opts.requestKey, digestJson({ changes, expected_version: opts.expectedVersion }));
            if (existing)
                return JSON.parse(existing);
            const row = this.database
                .prepare("SELECT * FROM entities WHERE entity_type=? AND entity_id=?")
                .get(entityType, entityId);
            if (!row)
                throw new NotFoundError(`${entityType}/${entityId} 不存在`);
            if (row.version !== opts.expectedVersion) {
                throw new ConflictError(`版本冲突，当前为 ${String(row.version)}`);
            }
            const payload = JSON.parse(row.payload_json);
            Object.assign(payload, changes);
            const version = opts.expectedVersion + 1;
            const state = String(payload.state ?? row.state);
            const now = this.clock.now();
            const changed = this.database
                .prepare(`UPDATE entities SET version=?,state=?,payload_json=?,updated_at=?,updated_by=?
           WHERE entity_type=? AND entity_id=? AND version=?`)
                .run(version, state, canonicalJson(payload), now, opts.actor, entityType, entityId, opts.expectedVersion).changes;
            if (changed !== 1)
                throw new ConflictError("并发修改导致版本变化");
            this.database
                .prepare(`INSERT INTO entity_versions(entity_type,entity_id,version,state,payload_json,valid_from,actor_id,request_key)
           VALUES(?,?,?,?,?,?,?,?)`)
                .run(entityType, entityId, version, state, canonicalJson(payload), now, opts.actor, opts.requestKey);
            this.audit.append(this.database, {
                actorId: opts.actor,
                action: "update",
                entityType,
                entityId,
                version,
                detail: changes,
            });
            const result = this.rowToEntity(this.database
                .prepare("SELECT * FROM entities WHERE entity_type=? AND entity_id=?")
                .get(entityType, entityId));
            this.storeIdempotency(entityType, entityId, opts.requestKey, { changes, expected_version: opts.expectedVersion }, result);
            return result;
        });
    }
    get(entityType, entityId) {
        const row = this.database
            .prepare("SELECT * FROM entities WHERE entity_type=? AND entity_id=?")
            .get(entityType, entityId);
        if (!row)
            throw new NotFoundError(`${entityType}/${entityId} 不存在`);
        return this.rowToEntity(row);
    }
    find(entityType, entityId) {
        const row = this.database
            .prepare("SELECT * FROM entities WHERE entity_type=? AND entity_id=?")
            .get(entityType, entityId);
        return row ? this.rowToEntity(row) : undefined;
    }
    list(entityType, filter) {
        const limit = filter?.limit ?? 100;
        if (limit < 1 || limit > 500)
            throw new ValidationError("limit 必须在 1 到 500 之间");
        let sql = "SELECT * FROM entities WHERE entity_type=?";
        const params = [entityType];
        if (filter?.state) {
            sql += " AND state=?";
            params.push(filter.state);
        }
        sql += " ORDER BY updated_at, entity_id LIMIT ?";
        params.push(limit);
        return this.database.prepare(sql).all(...params).map((row) => this.rowToEntity(row));
    }
    history(entityType, entityId) {
        const rows = this.database
            .prepare("SELECT * FROM entity_versions WHERE entity_type=? AND entity_id=? ORDER BY version")
            .all(entityType, entityId);
        if (rows.length === 0)
            throw new NotFoundError(`${entityType}/${entityId} 不存在`);
        return rows.map((row) => this.versionToEntity(row));
    }
    snapshot(entityType, entityId, asOf) {
        const instant = parseInstant(asOf).toISOString().replace(/\.000Z$/, "Z");
        const row = this.database
            .prepare(`SELECT * FROM entity_versions WHERE entity_type=? AND entity_id=? AND valid_from<=?
         ORDER BY valid_from DESC,version DESC LIMIT 1`)
            .get(entityType, entityId, instant);
        if (!row)
            throw new NotFoundError("指定时点没有可见版本");
        return this.versionToEntity(row);
    }
    idempotencyScope(entityType, entityId) {
        return entityId ? `update:${entityType}:${entityId}` : `create:${entityType}`;
    }
    lookupIdempotency(entityType, entityId, requestKey, requestDigest) {
        const row = this.database
            .prepare("SELECT request_digest, response_json FROM idempotency_keys WHERE scope=? AND request_key=?")
            .get(this.idempotencyScope(entityType, entityId), requestKey);
        if (!row)
            return undefined;
        if (row.request_digest !== requestDigest) {
            throw new ConflictError("相同请求标识对应不同内容");
        }
        return row.response_json;
    }
    storeIdempotency(entityType, entityId, requestKey, request, response) {
        this.database
            .prepare(`INSERT INTO idempotency_keys(scope,request_key,request_digest,response_json,created_at)
         VALUES(?,?,?,?,?)`)
            .run(this.idempotencyScope(entityType, entityId), requestKey, digestJson(request), canonicalJson(response), this.clock.now());
    }
    rowToEntity(row) {
        if (!row)
            throw new NotFoundError("实体不存在");
        const payload = JSON.parse(row.payload_json);
        return {
            ...payload,
            entity_type: row.entity_type,
            entity_id: row.entity_id,
            version: row.version,
            state: row.state,
            created_at: row.created_at,
            updated_at: row.updated_at,
            created_by: row.created_by,
            updated_by: row.updated_by,
        };
    }
    versionToEntity(row) {
        const payload = JSON.parse(row.payload_json);
        return {
            ...payload,
            entity_type: row.entity_type,
            entity_id: row.entity_id,
            version: row.version,
            state: row.state,
            valid_from: row.valid_from,
            actor_id: row.actor_id,
            request_key: row.request_key,
        };
    }
}
