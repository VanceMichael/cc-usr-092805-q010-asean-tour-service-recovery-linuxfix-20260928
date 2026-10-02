/**
 * 访问上下文，与协同平台 security.py 对应。
 * 角色：
 * - system      平台内部任务
 * - operator    旅行社运营/客服
 * - reviewer    高额补偿的独立审核人（不得与发起人相同）
 * - supplier    地接/航司等供应商，绑定本方机构，只能看到本方任务
 * - traveler    游客，只能看到自己的订单
 */
import { PermissionDenied } from "./errors.js";
export class AccessContext {
    actorId;
    role;
    permissions;
    orgId;
    bookingId;
    constructor(actorId, role, permissions, 
    /** 供应商可见的机构标识（仅 supplier 角色）。 */
    orgId, 
    /** 游客可见的订单标识（仅 traveler 角色）。 */
    bookingId) {
        this.actorId = actorId;
        this.role = role;
        this.permissions = permissions;
        this.orgId = orgId;
        this.bookingId = bookingId;
    }
    static system(actorId = "system") {
        return new AccessContext(actorId, "system", new Set(["*"]));
    }
    static operator(actorId) {
        return new AccessContext(actorId, "operator", new Set(["*"]));
    }
    static reviewer(actorId) {
        return new AccessContext(actorId, "reviewer", new Set(["*"]));
    }
    static supplier(actorId, orgId) {
        return new AccessContext(actorId, "supplier", new Set(), orgId);
    }
    static traveler(actorId, bookingId) {
        return new AccessContext(actorId, "traveler", new Set(), undefined, bookingId);
    }
    allows(permission) {
        return this.permissions.has("*") || this.permissions.has(permission);
    }
    require(permission) {
        if (!this.allows(permission))
            throw new PermissionDenied(`缺少权限: ${permission}`);
    }
    /** 供应商只能操作本方机构的供应项。 */
    requireOwnOrg(orgId) {
        if (this.role === "supplier" && this.orgId !== orgId) {
            throw new PermissionDenied("供应商只能查看和处理本方任务");
        }
        if (this.role === "traveler")
            throw new PermissionDenied("游客不能访问供应商任务");
    }
    /** 游客只能访问自己的订单。 */
    requireOwnBooking(bookingId) {
        if (this.role === "traveler" && this.bookingId !== bookingId) {
            throw new PermissionDenied("游客只能访问自己的订单");
        }
    }
}
/** 提交者与审核者必须为不同的人。 */
export function assertDistinct(submitter, reviewer) {
    if (submitter === reviewer)
        throw new PermissionDenied("提交者不能审核自己的事项");
}
