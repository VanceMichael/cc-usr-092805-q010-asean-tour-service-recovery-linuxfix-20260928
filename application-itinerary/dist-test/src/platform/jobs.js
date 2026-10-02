import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { newId } from "./ids.js";
import { canonicalJson } from "./jsonutil.js";
import { canonicalInstant, parseInstant } from "./timeutil.js";
const MAX_ATTEMPTS = 5;
export class JobQueue {
    database;
    clock;
    constructor(database, clock) {
        this.database = database;
        this.clock = clock;
    }
    schedule(fields) {
        const jobId = newId("job");
        const runAt = canonicalInstant(fields.runAt);
        this.database.transaction(() => {
            this.database
                .prepare(`INSERT INTO scheduled_jobs(job_id,job_type,subject_id,run_at,payload_json,status)
           VALUES(?,?,?,?,?,'waiting')`)
                .run(jobId, fields.jobType, fields.subjectId, runAt, canonicalJson(fields.payload));
        });
        return jobId;
    }
    claimDue(opts = {}) {
        const seconds = opts.seconds ?? 30;
        const limit = opts.limit ?? 20;
        if (seconds < 1 || limit < 1)
            throw new ValidationError("租约参数不合法");
        const now = parseInstant(this.clock.now());
        const leaseUntil = new Date(now.getTime() + seconds * 1000).toISOString().replace(/\.000Z$/, "Z");
        const nowText = this.clock.now();
        return this.database.transaction(() => {
            const rows = this.database
                .prepare(`SELECT * FROM scheduled_jobs WHERE run_at<=? AND status IN ('waiting','retry')
           AND (lease_until IS NULL OR lease_until<?) ORDER BY run_at,job_id LIMIT ?`)
                .all(nowText, nowText, limit);
            const result = [];
            for (const row of rows) {
                const changed = this.database
                    .prepare(`UPDATE scheduled_jobs SET status='running',lease_until=?,attempt=attempt+1
             WHERE job_id=? AND status IN ('waiting','retry') AND (lease_until IS NULL OR lease_until<?)`)
                    .run(leaseUntil, row.job_id, nowText).changes;
                if (changed === 1) {
                    result.push({
                        jobId: row.job_id,
                        jobType: row.job_type,
                        subjectId: row.subject_id,
                        runAt: row.run_at,
                        payload: JSON.parse(row.payload_json),
                        status: "running",
                        attempt: row.attempt + 1,
                    });
                }
            }
            return result;
        });
    }
    finish(jobId) {
        this.database.transaction(() => {
            const changed = this.database
                .prepare("UPDATE scheduled_jobs SET status='succeeded',lease_until=NULL,last_error='' WHERE job_id=? AND status='running'")
                .run(jobId).changes;
            if (changed !== 1)
                throw new ConflictError("任务没有有效运行租约");
        });
    }
    retry(jobId, error, retryAt) {
        const retryAtText = canonicalInstant(retryAt);
        return this.database.transaction(() => {
            const row = this.database
                .prepare("SELECT attempt FROM scheduled_jobs WHERE job_id=?")
                .get(jobId);
            if (!row)
                throw new NotFoundError("任务不存在");
            const status = (row.attempt ?? 0) >= MAX_ATTEMPTS ? "failed" : "retry";
            this.database
                .prepare("UPDATE scheduled_jobs SET status=?,run_at=?,lease_until=NULL,last_error=? WHERE job_id=?")
                .run(status, retryAtText, error.slice(0, 500), jobId);
            return status;
        });
    }
    /** 应用重启后自动续接：状态为 running 但租约已过期的任务回到 retry，等待再次领取。 */
    recoverStaleLeases() {
        return this.database.transaction(() => {
            const info = this.database
                .prepare(`UPDATE scheduled_jobs SET status='retry',lease_until=NULL
           WHERE status='running' AND lease_until IS NOT NULL AND lease_until<?`)
                .run(this.clock.now());
            return info.changes;
        });
    }
    pending() {
        const rows = this.database
            .prepare(`SELECT * FROM scheduled_jobs WHERE status IN ('waiting','retry','running')
         ORDER BY run_at,job_id`)
            .all();
        return rows.map((row) => ({
            jobId: row.job_id,
            jobType: row.job_type,
            subjectId: row.subject_id,
            runAt: row.run_at,
            payload: JSON.parse(row.payload_json),
            status: row.status,
            attempt: row.attempt,
        }));
    }
}
