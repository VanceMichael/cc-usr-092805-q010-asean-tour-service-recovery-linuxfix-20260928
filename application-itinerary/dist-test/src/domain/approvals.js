import { ConflictError, NotFoundError, ValidationError } from "../platform/errors.js";
import { assertDistinct } from "../platform/access.js";
import { newId } from "../platform/ids.js";
const ENTITY_TYPE = "compensation_approvals";
export class CompensationApprovalService {
    repo;
    clock;
    constructor(repo, clock) {
        this.repo = repo;
        this.clock = clock;
    }
    submit(ctx, fields, requestKey) {
        ctx.require("write:approvals");
        if (!Number.isInteger(fields.amountMinor) || fields.amountMinor <= 0) {
            throw new ValidationError("补偿金额必须是正整数（最小币种单位）");
        }
        if (!fields.reason.trim())
            throw new ValidationError("补偿原因不能为空");
        const payload = {
            recovery_id: fields.recoveryId,
            booking_id: fields.bookingId,
            amount_minor: fields.amountMinor,
            currency: fields.currency,
            reason: fields.reason.trim(),
            submitter: ctx.actorId,
            reviewer: "",
            decision_note: "",
            state: "pending",
            decided_at: "",
        };
        return this.repo.create(ENTITY_TYPE, payload, {
            actor: ctx.actorId,
            requestKey,
        });
    }
    decide(ctx, approvalId, fields, requestKey) {
        if (ctx.role !== "reviewer" && !ctx.allows("review:approvals")) {
            throw new ConflictError("只有独立审核人员可以审批高额补偿");
        }
        const current = this.require(approvalId);
        if (current.state !== "pending")
            throw new ConflictError("该申请已经做出决定");
        // 职责分离：发起人本人不能审批。
        assertDistinct(current.submitter, ctx.actorId);
        if (!fields.note.trim())
            throw new ValidationError("审批意见不能为空");
        return this.repo.update(ENTITY_TYPE, approvalId, {
            state: fields.approve ? "approved" : "rejected",
            reviewer: ctx.actorId,
            decision_note: fields.note.trim(),
            decided_at: this.clock.now(),
        }, { actor: ctx.actorId, expectedVersion: fields.expectedVersion, requestKey });
    }
    require(approvalId) {
        const entity = this.repo.find(ENTITY_TYPE, approvalId);
        if (!entity)
            throw new NotFoundError(`审批 ${approvalId} 不存在`);
        return entity;
    }
    pendingForRecovery(recoveryId) {
        return this.repo.list(ENTITY_TYPE, { state: "pending", limit: 200 }).filter((a) => a.recovery_id === recoveryId);
    }
}
export function newApprovalId() {
    return newId("approval");
}
