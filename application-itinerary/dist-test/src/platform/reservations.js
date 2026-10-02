import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { newId } from "./ids.js";
import { canonicalInstant, parseInstant } from "./timeutil.js";
export class ReservationBook {
    database;
    constructor(database) {
        this.database = database;
    }
    reserve(fields) {
        const startAt = canonicalInstant(fields.startAt);
        const endAt = canonicalInstant(fields.endAt);
        if (parseInstant(startAt).getTime() >= parseInstant(endAt).getTime()) {
            throw new ValidationError("预约结束时间必须晚于开始时间");
        }
        if (fields.quantity <= 0 || fields.capacity <= 0 || fields.quantity > fields.capacity) {
            throw new ValidationError("预约数量或容量不合法");
        }
        return this.database.transaction(() => {
            const row = this.database
                .prepare(`SELECT COALESCE(SUM(quantity),0) AS used FROM resource_reservations
           WHERE resource_id=? AND status IN ('held','confirmed') AND start_at<? AND end_at>?`)
                .get(fields.resourceId, endAt, startAt);
            if (row.used + fields.quantity > fields.capacity)
                throw new ConflictError("资源容量不足");
            const reservationId = newId("reservation");
            this.database
                .prepare(`INSERT INTO resource_reservations(reservation_id,resource_id,subject_id,quantity,start_at,end_at,status,version,created_by)
           VALUES(?,?,?,?,?,?,?,?,?)`)
                .run(reservationId, fields.resourceId, fields.subjectId, fields.quantity, startAt, endAt, "confirmed", 1, fields.actor);
            return { reservationId, status: "confirmed", version: 1 };
        });
    }
    release(reservationId, expectedVersion) {
        return this.database.transaction(() => {
            const changed = this.database
                .prepare(`UPDATE resource_reservations SET status='released',version=version+1
           WHERE reservation_id=? AND version=? AND status IN ('held','confirmed')`)
                .run(reservationId, expectedVersion).changes;
            if (changed !== 1) {
                const row = this.database
                    .prepare("SELECT * FROM resource_reservations WHERE reservation_id=?")
                    .get(reservationId);
                if (!row)
                    throw new NotFoundError("预约不存在");
                throw new ConflictError("预约版本或状态已经变化");
            }
            return this.database
                .prepare("SELECT * FROM resource_reservations WHERE reservation_id=?")
                .get(reservationId);
        });
    }
    usage(resourceId, at) {
        const instant = canonicalInstant(at);
        const row = this.database
            .prepare(`SELECT COALESCE(SUM(quantity),0) AS used FROM resource_reservations
         WHERE resource_id=? AND status IN ('held','confirmed') AND start_at<=? AND end_at>?`)
            .get(resourceId, instant, instant);
        return row.used;
    }
    findById(reservationId) {
        return this.database
            .prepare("SELECT * FROM resource_reservations WHERE reservation_id=?")
            .get(reservationId);
    }
    listBySubject(subjectId) {
        return this.database
            .prepare("SELECT * FROM resource_reservations WHERE subject_id=? ORDER BY reservation_id")
            .all(subjectId);
    }
    /** 预检窗口容量，不产生预约。 */
    fits(resourceId, quantity, capacity, startAt, endAt) {
        const start = canonicalInstant(startAt);
        const end = canonicalInstant(endAt);
        const row = this.database
            .prepare(`SELECT COALESCE(SUM(quantity),0) AS used FROM resource_reservations
         WHERE resource_id=? AND status IN ('held','confirmed') AND start_at<? AND end_at>?`)
            .get(resourceId, end, start);
        return row.used + quantity <= capacity;
    }
}
