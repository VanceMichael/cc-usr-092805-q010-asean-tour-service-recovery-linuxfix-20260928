/**
 * 应用装配：组合平台能力与旅游恢复领域服务，并提供重启后自动续接的任务执行器。
 * 续接三类工作：临近出发提醒、待确认替代到期、退款对账；发件箱通知同步续投。
 */
import { Platform } from "../platform/app.js";
import { BookingService } from "./bookings.js";
import { CatalogService } from "./catalog.js";
import { CompensationApprovalService } from "./approvals.js";
import { DepartureService } from "./departures.js";
import { OrganizationService } from "./organizations.js";
import { RecoveryService } from "./recovery.js";
export class TravelApp {
    platform;
    organizations;
    catalog;
    departures;
    bookings;
    approvals;
    recoveries;
    constructor(platform) {
        this.platform = platform;
        this.organizations = new OrganizationService(platform.repository);
        this.catalog = new CatalogService(platform.repository);
        this.departures = new DepartureService(platform.repository, platform.reservations);
        this.bookings = new BookingService(platform.repository, platform.reservations, platform.jobs, platform.clock);
        this.approvals = new CompensationApprovalService(platform.repository, platform.clock);
        this.recoveries = new RecoveryService(platform.repository, this.bookings, platform.reservations, platform.ledger, platform.jobs, platform.outbox, platform.inbox, platform.clock, this.approvals);
    }
    static open(path, fixedNow) {
        return new TravelApp(Platform.open(path, fixedNow));
    }
    /**
     * 应用启动/重启时调用：回收过期租约，执行所有到期任务并续投通知，
     * 使临近出发提醒、替代到期处置与退款对账在重启后自动续接。
     */
    resume() {
        const jobsReclaimed = this.platform.jobs.recoverStaleLeases();
        const messagesReclaimed = this.platform.outbox.recoverStaleLeases();
        const ran = [];
        for (const job of this.platform.jobs.claimDue({ seconds: 30, limit: 100 })) {
            try {
                this.runJob(job.jobType, job.subjectId, job.payload);
                this.platform.jobs.finish(job.jobId);
                ran.push(job.jobId);
            }
            catch (error) {
                const retryAt = new Date(Date.now() + 60_000).toISOString().replace(/\.000Z$/, "Z");
                this.platform.jobs.retry(job.jobId, String(error.message ?? error), retryAt);
            }
        }
        let delivered = 0;
        for (const message of this.platform.outbox.lease("resume", { seconds: 30, limit: 100 })) {
            // 本应用内置通道：通知只标记投递结果，真实通道由适配器接入发件箱。
            this.platform.outbox.complete(message.messageId);
            delivered += 1;
        }
        return { jobsReclaimed, messagesReclaimed, ran, delivered };
    }
    runJob(jobType, subjectId, payload) {
        if (jobType === "alternative_expiry") {
            this.recoveries.expireAlternative(String(payload.recovery_id ?? subjectId), String(payload.alternative_id));
        }
        else if (jobType === "settlement_reconcile") {
            const result = this.recoveries.reconcile(String(payload.settlement_id ?? subjectId));
            if (!result.ok)
                throw new Error(result.detail);
        }
        else if (jobType === "departure_reminder") {
            // 临近出发续接：通过发件箱产生一条可审计通知，页面也会展示临近状态。
            this.platform.outbox.enqueue({
                topic: "departure.reminder",
                aggregateId: String(payload.booking_id ?? subjectId),
                payload,
            });
        }
    }
}
