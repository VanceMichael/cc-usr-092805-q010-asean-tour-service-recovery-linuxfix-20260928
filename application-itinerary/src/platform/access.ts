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

export type Role = "system" | "operator" | "reviewer" | "supplier" | "traveler";

export class AccessContext {
  private constructor(
    readonly actorId: string,
    readonly role: Role,
    readonly permissions: ReadonlySet<string>,
    /** 供应商可见的机构标识（仅 supplier 角色）。 */
    readonly orgId?: string,
    /** 游客可见的订单标识（仅 traveler 角色）。 */
    readonly bookingId?: string,
  ) {}

  static system(actorId = "system"): AccessContext {
    return new AccessContext(actorId, "system", new Set(["*"]));
  }

  static operator(actorId: string): AccessContext {
    return new AccessContext(actorId, "operator", new Set(["*"]));
  }

  static reviewer(actorId: string): AccessContext {
    return new AccessContext(actorId, "reviewer", new Set(["*"]));
  }

  static supplier(actorId: string, orgId: string): AccessContext {
    return new AccessContext(actorId, "supplier", new Set(), orgId);
  }

  static traveler(actorId: string, bookingId: string): AccessContext {
    return new AccessContext(actorId, "traveler", new Set(), undefined, bookingId);
  }

  allows(permission: string): boolean {
    return this.permissions.has("*") || this.permissions.has(permission);
  }

  require(permission: string): void {
    if (!this.allows(permission)) throw new PermissionDenied(`缺少权限: ${permission}`);
  }

  /** 供应商只能操作本方机构的供应项。 */
  requireOwnOrg(orgId: string): void {
    if (this.role === "supplier" && this.orgId !== orgId) {
      throw new PermissionDenied("供应商只能查看和处理本方任务");
    }
    if (this.role === "traveler") throw new PermissionDenied("游客不能访问供应商任务");
  }

  /** 游客只能访问自己的订单。 */
  requireOwnBooking(bookingId: string): void {
    if (this.role === "traveler" && this.bookingId !== bookingId) {
      throw new PermissionDenied("游客只能访问自己的订单");
    }
  }
}

/** 提交者与审核者必须为不同的人。 */
export function assertDistinct(submitter: string, reviewer: string): void {
  if (submitter === reviewer) throw new PermissionDenied("提交者不能审核自己的事项");
}
