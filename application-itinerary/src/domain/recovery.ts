/**
 * 服务恢复核心：
 * - 扰动（供应商退出/容量缩减/目的地风险/航班变化）只作用于尚未履行的环节，
 *   已使用（in_use/fulfilled）的服务保留原责任，记入 retained；
 * - 替代方案自动比较时间、价值与无障碍条件，并受批次替代范围约束；
 * - 补差/退款/代金权益逐环节生成并守恒：每个受影响环节都必须被覆盖，
 *   退款+代金不得超过该环节游客实际支付；高额补偿必须先经另一名审核人员批准；
 * - 结算过账为不可变资金分录，参考号唯一，重复回执不会触发第二次退款；
 * - 临近出发、替代到期、退款对账全部走可恢复任务队列，重启自动续接。
 */
import type { EntityRepository } from "../platform/repository.js";
import type { ReservationBook } from "../platform/reservations.js";
import type { Ledger } from "../platform/ledger.js";
import type { JobQueue } from "../platform/jobs.js";
import type { Outbox } from "../platform/outbox.js";
import type { Inbox } from "../platform/inbox.js";
import type { Clock } from "../platform/timeutil.js";
import { ConflictError, InvariantViolation, NotFoundError, ValidationError } from "../platform/errors.js";
import type { AccessContext } from "../platform/access.js";
import { newId } from "../platform/ids.js";
import type { BookingService } from "./bookings.js";
import { CompensationApprovalService } from "./approvals.js";
import { itemTotal } from "./money.js";
import type {
  Alternative,
  BookingPayload,
  ChangeEvent,
  ComparisonItem,
  ItineraryItem,
  NextResponsible,
  RecoveryPayload,
  RecoveryTrigger,
  SettlementLine,
  SettlementPayload,
  SpecialNeed,
} from "./types.js";

const RECOVERY_TYPE = "recoveries";
const SETTLEMENT_TYPE = "settlements";
const TRIGGERS: RecoveryTrigger[] = ["supplier_exit", "capacity_reduction", "destination_risk", "flight_change"];

/** 高额补偿阈值：500.00（最小币种单位），超过必须双人审批。 */
export const HIGH_COMPENSATION_MINOR = 50000;

export interface IngestInput {
  departureId: string;
  trigger: RecoveryTrigger;
  detail: string;
  receipt: { source: string; sourceKey: string; sequence: number; occurredAt: string; payload: Record<string, unknown> };
  target: {
    supplierOrgId?: string;
    itemIds?: string[];
    serviceCodes?: string[];
    windowStart?: string;
    windowEnd?: string;
    /** 定向到特定订单（如针对某位住客的风险通告）。 */
    bookingIds?: string[];
  };
}

export class RecoveryService {
  constructor(
    private readonly repo: EntityRepository,
    private readonly bookings: BookingService,
    private readonly reservations: ReservationBook,
    private readonly ledger: Ledger,
    private readonly jobs: JobQueue,
    private readonly outbox: Outbox,
    private readonly inbox: Inbox,
    private readonly clock: Clock,
    readonly approvals: CompensationApprovalService,
  ) {}

  // ---------------------------------------------------------------- 扰动接入

  /**
   * 登记外部回执并为每个受影响游客开恢复单。
   * 回执内容一致的重复推送返回 duplicate，不产生第二个恢复单、不产生第二笔钱；
   * 回执内容矛盾（同序号不同摘要）时收件箱挂起，本方法不推进任何业务。
   */
  ingest(ctx: AccessContext, input: IngestInput, requestKey: string): {
    status: "accepted" | "duplicate" | "held";
    recoveries: string[];
    conflictId?: number;
  } {
    ctx.require("write:recoveries");
    if (!TRIGGERS.includes(input.trigger)) throw new ValidationError("扰动类型不合法");
    if (!input.detail.trim()) throw new ValidationError("扰动说明不能为空");
    const receipt = this.inbox.receive({
      source: input.receipt.source,
      sourceKey: input.receipt.sourceKey,
      sequence: input.receipt.sequence,
      payload: input.receipt.payload,
      occurredAt: input.receipt.occurredAt,
    });
    if (receipt.status === "held") {
      return { status: "held", recoveries: [], conflictId: receipt.conflictId ?? 0 };
    }
    const receiptKey = `${input.receipt.source}/${input.receipt.sourceKey}/${input.receipt.sequence}`;
    return this.runIngest(ctx, input, receiptKey, receipt.status === "duplicate", requestKey);
  }

  private runIngest(
    ctx: AccessContext,
    input: IngestInput,
    receiptKey: string,
    duplicate: boolean,
    requestKey: string,
  ): { status: "accepted" | "duplicate"; recoveries: string[] } {
    const existing = this.findOpenByReceipt(receiptKey);
    if (duplicate || existing.length > 0) {
      // 重复状态回执：原单照原样返回，绝不重复退款/重复开单。
      return { status: "duplicate", recoveries: existing.map((r) => r.entity_id) };
    }
    const created: string[] = [];
    for (const booking of this.bookings.listForDeparture(input.departureId)) {
      if (booking.state === "pending" || booking.state === "cancelled") continue;
      if (input.target.bookingIds && !input.target.bookingIds.includes(booking.entity_id)) continue;
      const matched = this.matchItems(booking, input.target);
      if (matched.length === 0) continue;
      const affected = matched.filter((id) => booking.item_states[id] === "scheduled");
      const retained = matched.filter((id) =>
        booking.item_states[id] === "in_use" || booking.item_states[id] === "fulfilled",
      );
      if (affected.length === 0 && retained.length === 0) continue;
      const event: ChangeEvent = {
        at: this.clock.now(),
        trigger: input.trigger,
        actor: ctx.actorId,
        detail: input.detail.trim(),
        affected_item_ids: matched,
        inbox_refs: [
          {
            source: input.receipt.source,
            source_key: input.receipt.sourceKey,
            sequence: input.receipt.sequence,
          },
        ],
      };
      const recoveryId = newId("recovery");
      const retainedOnly = affected.length === 0;
      const nextResponsible = retainedOnly
        ? this.retainedResponsible(booking, retained)
        : {
            party: "operator" as const,
            org_id: "",
            action: "propose_alternative_or_refund",
            reason: "扰动已确认，等待运营提出替代方案或决定仅退款",
          };
      const payload: RecoveryPayload = {
        booking_id: booking.entity_id,
        departure_id: input.departureId,
        title: this.travelerTitle(booking, input.trigger),
        trigger: input.trigger,
        events: [event],
        affected_item_ids: affected,
        retained_item_ids: retained,
        alternatives: [],
        active_alternative_id: "",
        settlement_id: "",
        next_responsible: nextResponsible,
        state: "opened",
        state_reason: retainedOnly
          ? `${input.detail.trim()}；该游客相关服务均已使用，原责任保留，不产生退款或替代`
          : input.detail.trim(),
      };
      const entity = this.repo.create(
        RECOVERY_TYPE,
        payload as unknown as Record<string, unknown>,
        { actor: ctx.actorId, requestKey: `${requestKey}:${booking.entity_id}` },
      );
      created.push(entity.entity_id);
      this.outbox.enqueue({
        topic: "recovery.opened",
        aggregateId: entity.entity_id,
        payload: {
          recovery_id: entity.entity_id,
          booking_id: booking.entity_id,
          traveler: booking.traveler.actor,
          affected: affected,
          retained: retained,
          receipt_key: receiptKey,
        },
      });
    }
    return { status: "accepted", recoveries: created };
  }

  private matchItems(booking: BookingPayload, target: IngestInput["target"]): string[] {
    const items = booking.frozen_snapshot.days.flatMap((day) => day.items);
    return items
      .filter((item) => {
        if (target.supplierOrgId && item.supplier_org_id !== target.supplierOrgId) return false;
        if (target.itemIds && !target.itemIds.includes(item.item_id)) return false;
        if (target.serviceCodes && !target.serviceCodes.includes(item.service_code)) return false;
        if (target.windowStart && item.end_at <= target.windowStart) return false;
        if (target.windowEnd && item.start_at >= target.windowEnd) return false;
        return true;
      })
      .map((item) => item.item_id);
  }

  // ---------------------------------------------------------------- 替代方案

  /**
   * 提出替代方案：逐环节比较时间、价值、无障碍；替代范围按冻结批次政策校验；
   * 替代容量经平台资源预约提前占位，拒绝/过期时释放。
   */
  proposeAlternative(
    ctx: AccessContext,
    recoveryId: string,
    fields: {
      rationale: string;
      expiresAt: string;
      mappings: Array<{ originalItemId: string; replacement: ItineraryItem }>;
    },
    requestKey: string,
  ) {
    ctx.require("write:recoveries");
    const recovery = this.requireRecovery(recoveryId);
    const booking = this.bookings.require(recovery.booking_id);
    if (!["opened", "alternative_pending"].includes(recovery.state)) {
      throw new ConflictError(`当前状态 ${recovery.state} 不能提出替代方案`);
    }
    if (fields.mappings.length === 0) throw new ValidationError("替代方案至少包含一个环节");
    if (!fields.rationale.trim()) throw new ValidationError("替代理由不能为空");
    const affected = new Set(recovery.affected_item_ids);
    const originals = new Map<string, ItineraryItem>();
    for (const day of booking.frozen_snapshot.days) {
      for (const item of day.items) originals.set(item.item_id, item);
    }
    const policy = booking.frozen_snapshot.substitution_policy;
    const comparisons: ComparisonItem[] = [];
    const seenOrigins = new Set<string>();
    for (const mapping of fields.mappings) {
      if (!affected.has(mapping.originalItemId)) {
        throw new ValidationError(`环节 ${mapping.originalItemId} 不在本恢复单受影响范围内`);
      }
      if (seenOrigins.has(mapping.originalItemId)) {
        throw new ValidationError(`环节 ${mapping.originalItemId} 出现重复替代`);
      }
      seenOrigins.add(mapping.originalItemId);
      const original = originals.get(mapping.originalItemId);
      if (!original) throw new NotFoundError(`原环节 ${mapping.originalItemId} 不存在`);
      const replacement = mapping.replacement;
      validateReplacementShape(replacement);
      // 替代范围：不可替代 / 仅同类 / 批次是否允许跨类。
      if (!original.substitution_scope.replaceable) {
        throw new ConflictError(`环节 ${original.title} 不在允许替代范围内`);
      }
      if (replacement.category !== original.category) {
        if (original.substitution_scope.same_category_only || !policy.allow_category_change) {
          throw new ConflictError(`环节 ${original.title} 只允许同类替代，不能换成 ${replacement.category}`);
        }
      }
      // 替代范围限定同类时，原环节全部资质必须保留；允许异质替代（如非遗工坊→普通观光）时，
      // 只强制保留批次导游资质，供应方基地类资质的落差通过价值退款补偿。
      const sameKind = original.substitution_scope.same_category_only && replacement.category === original.category;
      const requiredCredentials = sameKind
        ? original.credentials
        : original.credentials.filter((c) =>
            booking.frozen_snapshot.guide_requirements.credentials.includes(c),
          );
      if (
        policy.preserve_credentials &&
        !requiredCredentials.every((c) => replacement.credentials.includes(c))
      ) {
        throw new ConflictError(`替代服务不满足环节 ${original.title} 的导游资质要求`);
      }
      comparisons.push(this.compare(booking, original, replacement));
      // 替代容量提前占位，防止多人确认时超售。
      this.reservations.reserve({
        resourceId: `service:${replacement.item_id}`,
        subjectId: `${recoveryId}:${mapping.originalItemId}`,
        quantity: 1,
        capacity: replacement.capacity,
        startAt: replacement.start_at,
        endAt: replacement.end_at,
        actor: ctx.actorId,
      });
    }
    const alternative: Alternative = {
      alternative_id: newId("alternative"),
      proposed_at: this.clock.now(),
      proposed_by: ctx.actorId,
      expires_at: fields.expiresAt,
      rationale: fields.rationale.trim(),
      comparisons,
      status: "proposed",
      decided_at: "",
      traveler_note: "",
    };
    const next: NextResponsible = {
      party: "traveler",
      org_id: "",
      action: "accept_or_reject_alternative",
      reason: `替代方案等待游客确认，截止 ${fields.expiresAt}`,
    };
    const updated = this.repo.update(
      RECOVERY_TYPE,
      recoveryId,
      {
        alternatives: [...recovery.alternatives, alternative],
        active_alternative_id: alternative.alternative_id,
        state: "alternative_pending",
        state_reason: "替代方案已提出，等待游客确认",
        next_responsible: next,
      },
      { actor: ctx.actorId, expectedVersion: this.versionOf(recoveryId), requestKey },
    );
    this.jobs.schedule({
      jobType: "alternative_expiry",
      subjectId: recoveryId,
      runAt: fields.expiresAt,
      payload: { recovery_id: recoveryId, alternative_id: alternative.alternative_id },
    });
    this.outbox.enqueue({
      topic: "alternative.proposed",
      aggregateId: recoveryId,
      payload: {
        recovery_id: recoveryId,
        booking_id: recovery.booking_id,
        traveler: booking.traveler.actor,
        alternative_id: alternative.alternative_id,
        expires_at: fields.expiresAt,
        comparison_count: comparisons.length,
      },
    });
    return updated;
  }

  private compare(
    booking: BookingPayload,
    original: ItineraryItem,
    replacement: ItineraryItem,
  ): ComparisonItem {
    const oStart = Date.parse(original.start_at);
    const oEnd = Date.parse(original.end_at);
    const rStart = Date.parse(replacement.start_at);
    const rEnd = Date.parse(replacement.end_at);
    const originalTotal = itemTotal(original);
    const replacementTotal = itemTotal(replacement);
    const needs = booking.special_needs.filter((need) => need.item_ids.includes(original.item_id));
    const gaps: string[] = [];
    for (const need of needs) {
      const gap = describeNeedGap(need, replacement);
      if (gap) gaps.push(gap);
    }
    if (booking.frozen_snapshot.substitution_policy.preserve_accessibility) {
      if (original.accessibility.wheelchair && !replacement.accessibility.wheelchair) {
        gaps.push("原服务支持轮椅，替代服务不支持");
      }
    }
    return {
      original_item_id: original.item_id,
      replacement,
      time: {
        original_start: original.start_at,
        original_end: original.end_at,
        replacement_start: replacement.start_at,
        replacement_end: replacement.end_at,
        start_delta_minutes: Math.round((rStart - oStart) / 60000),
        duration_delta_minutes: Math.round((rEnd - rStart - (oEnd - oStart)) / 60000),
      },
      value: {
        original_total_minor: originalTotal,
        replacement_total_minor: replacementTotal,
        delta_minor: replacementTotal - originalTotal,
      },
      accessibility: {
        original: original.accessibility,
        replacement: replacement.accessibility,
        required_needs_met: gaps.length === 0,
        gaps,
      },
    };
  }

  /** 游客接受替代：冻结替代履约，释放原环节预约，进入结算准备。 */
  acceptAlternative(
    ctx: AccessContext,
    recoveryId: string,
    alternativeId: string,
    expectedVersion: number,
    requestKey: string,
    note = "",
  ) {
    const recovery = this.requireRecovery(recoveryId);
    const booking = this.bookings.require(recovery.booking_id);
    ctx.requireOwnBooking(recovery.booking_id);
    const alternative = recovery.alternatives.find((a) => a.alternative_id === alternativeId);
    if (!alternative) throw new NotFoundError("替代方案不存在");
    if (alternative.status !== "proposed" || recovery.active_alternative_id !== alternativeId) {
      throw new ConflictError("该替代方案已不可确认");
    }
    if (this.clock.now() > alternative.expires_at) throw new ConflictError("替代方案已过确认截止时间");
    if (alternative.comparisons.some((c) => !c.accessibility.required_needs_met)) {
      throw new ConflictError("替代方案不能满足该游客的特殊无障碍需求，不能接受");
    }
    // 订单履约：原环节取消（保留记录与原价格事实），替代环节排入行程。
    const itemStates = { ...booking.item_states };
    for (const comparison of alternative.comparisons) {
      itemStates[comparison.original_item_id] = "cancelled";
      itemStates[comparison.replacement.item_id] = "scheduled";
    }
    this.repo.update(
      "bookings",
      recovery.booking_id,
      { item_states: itemStates },
      {
        actor: ctx.actorId,
        expectedVersion: booking.version,
        requestKey: `${requestKey}:booking`,
      },
    );
    // 释放被替代环节的原容量预约。
    const reservationIds = (booking as unknown as { reservations?: Record<string, string> }).reservations;
    for (const comparison of alternative.comparisons) {
      const reservationId = reservationIds?.[comparison.original_item_id];
      if (reservationId) {
        const row = this.reservations.findById(reservationId);
        if (row && row.status !== "released") {
          this.reservations.release(reservationId, Number(row.version));
        }
      }
    }
    const alternatives = recovery.alternatives.map((a) =>
      a.alternative_id === alternativeId
        ? { ...a, status: "accepted" as const, decided_at: this.clock.now(), traveler_note: note }
        : a.status === "proposed"
          ? { ...a, status: "expired" as const, decided_at: this.clock.now(), traveler_note: "游客选择了另一方案" }
          : a,
    );
    const next: NextResponsible = {
      party: "operator",
      org_id: "",
      action: "prepare_settlement",
      reason: "游客已接受替代，等待运营按环节生成补差/退款/代金",
    };
    const updated = this.repo.update(
      RECOVERY_TYPE,
      recoveryId,
      {
        alternatives,
        state: "ready_to_settle",
        state_reason: "替代已接受，待结算",
        next_responsible: next,
      },
      { actor: ctx.actorId, expectedVersion, requestKey },
    );
    this.outbox.enqueue({
      topic: "alternative.accepted",
      aggregateId: recoveryId,
      payload: { recovery_id: recoveryId, booking_id: recovery.booking_id, alternative_id: alternativeId },
    });
    return updated;
  }

  /** 游客拒绝替代：方案标记 rejected，恢复单回到运营，可再提方案或转为仅退款。 */
  rejectAlternative(
    ctx: AccessContext,
    recoveryId: string,
    alternativeId: string,
    expectedVersion: number,
    requestKey: string,
    reason: string,
  ) {
    const recovery = this.requireRecovery(recoveryId);
    ctx.requireOwnBooking(recovery.booking_id);
    if (!reason.trim()) throw new ValidationError("拒绝时必须填写原因");
    const alternative = recovery.alternatives.find((a) => a.alternative_id === alternativeId);
    if (!alternative || alternative.status !== "proposed") {
      throw new ConflictError("替代方案不可拒绝或已结束");
    }
    this.releaseAlternativeHolds(recoveryId, alternative);
    const alternatives = recovery.alternatives.map((a) =>
      a.alternative_id === alternativeId
        ? { ...a, status: "rejected" as const, decided_at: this.clock.now(), traveler_note: reason.trim() }
        : a,
    );
    return this.repo.update(
      RECOVERY_TYPE,
      recoveryId,
      {
        alternatives,
        active_alternative_id: "",
        state: "alternative_pending",
        state_reason: `游客拒绝：${reason.trim()}`,
        next_responsible: {
          party: "operator",
          org_id: "",
          action: "propose_alternative_or_refund",
          reason: "游客拒绝了替代方案，运营需重新安排或仅退款",
        },
      },
      { actor: ctx.actorId, expectedVersion, requestKey },
    );
  }

  /**
   * 纯保留单（受影响环节为空、相关服务均已使用）：运营评估后确认无需变更，
   * 归档关闭；原供应方责任仍然保留，不产生任何退款或替代。
   */
  closeRetentionOnly(
    ctx: AccessContext,
    recoveryId: string,
    expectedVersion: number,
    requestKey: string,
    note: string,
  ) {
    ctx.require("write:recoveries");
    const recovery = this.requireRecovery(recoveryId);
    if (recovery.affected_item_ids.length !== 0 || recovery.retained_item_ids.length === 0) {
      throw new ConflictError("只有不涉及未履行环节的恢复单可以按原责任保留归档");
    }
    if (!note.trim()) throw new ValidationError("归档说明不能为空");
    const next: NextResponsible = {
      ...recovery.next_responsible,
      reason: `已归档：${note.trim()}；已使用服务的原责任由原供应方继续承担`,
    };
    return this.repo.update(
      RECOVERY_TYPE,
      recoveryId,
      { state: "closed", state_reason: `无需调整，原责任保留：${note.trim()}`, next_responsible: next },
      { actor: ctx.actorId, expectedVersion, requestKey },
    );
  }

  /** 运营决定不提供替代：直接进入仅退款结算。 */
  settleWithoutAlternative(
    ctx: AccessContext,
    recoveryId: string,
    expectedVersion: number,
    requestKey: string,
    reason: string,
  ) {
    ctx.require("write:recoveries");
    const recovery = this.requireRecovery(recoveryId);
    if (!["opened", "alternative_pending"].includes(recovery.state)) {
      throw new ConflictError("当前状态不能转为仅退款");
    }
    if (!reason.trim()) throw new ValidationError("必须说明不提供替代的原因");
    for (const alternative of recovery.alternatives.filter((a) => a.status === "proposed")) {
      this.releaseAlternativeHolds(recoveryId, alternative);
    }
    return this.repo.update(
      RECOVERY_TYPE,
      recoveryId,
      {
        state: "ready_to_settle",
        state_reason: `不提供替代：${reason.trim()}`,
        active_alternative_id: "",
        next_responsible: {
          party: "operator",
          org_id: "",
          action: "prepare_settlement",
          reason: "按受影响环节全额退款",
        },
      },
      { actor: ctx.actorId, expectedVersion, requestKey },
    );
  }

  // ---------------------------------------------------------------- 结算

  /**
   * 按受影响环节生成结算行：
   * - 有已接受替代：低价退差额，高价补差额；
   * - 无替代：按该环节冻结价格全额退款；
   * 代金券可逐环节追加，但 退款+代金 不得超过该环节实际支付。
   */
  prepareSettlement(
    ctx: AccessContext,
    recoveryId: string,
    vouchers: Array<{ itemId: string; minor: number; reason: string }>,
    requestKey: string,
  ) {
    ctx.require("write:settlements");
    const recovery = this.requireRecovery(recoveryId);
    const booking = this.bookings.require(recovery.booking_id);
    if (recovery.state !== "ready_to_settle") throw new ConflictError("恢复单尚未进入结算阶段");
    const accepted = recovery.alternatives.find((a) => a.status === "accepted");
    const prices = new Map<string, number>();
    for (const day of booking.frozen_snapshot.days) {
      for (const item of day.items) prices.set(item.item_id, itemTotal(item));
    }
    const replacementPrice = new Map<string, number>();
    for (const comparison of accepted?.comparisons ?? []) {
      replacementPrice.set(comparison.original_item_id, comparison.value.replacement_total_minor);
    }
    const lines: SettlementLine[] = [];
    const covered = new Set<string>();
    for (const itemId of recovery.affected_item_ids) {
      const original = prices.get(itemId);
      if (original === undefined) throw new InvariantViolation(`受影响环节 ${itemId} 没有冻结价格`);
      const replacement = replacementPrice.get(itemId);
      if (replacement === undefined) {
        lines.push({
          kind: "refund",
          item_id: itemId,
          minor: original,
          reason: "未履行且无替代，按环节全额退款",
          reference: "",
        });
      } else if (replacement < original) {
        lines.push({
          kind: "refund",
          item_id: itemId,
          minor: original - replacement,
          reason: "替代服务价值更低，退还差价",
          reference: "",
        });
      } else if (replacement > original) {
        lines.push({
          kind: "supplement",
          item_id: itemId,
          minor: replacement - original,
          reason: "替代服务价值更高，游客补差价",
          reference: "",
        });
      }
      covered.add(itemId);
    }
    for (const voucher of vouchers) {
      if (!covered.has(voucher.itemId)) {
        throw new ValidationError(`代金券必须对应受影响环节，${voucher.itemId} 不在范围内`);
      }
      if (!Number.isInteger(voucher.minor) || voucher.minor <= 0) {
        throw new ValidationError("代金金额必须为正整数");
      }
      lines.push({
        kind: "voucher",
        item_id: voucher.itemId,
        minor: voucher.minor,
        reason: voucher.reason.trim() || "代金权益",
        reference: "",
      });
    }
    // 守恒：每个受影响环节的退款+代金 ≤ 该环节实际支付。
    for (const itemId of recovery.affected_item_ids) {
      const paid = prices.get(itemId) ?? 0;
      const given = lines
        .filter((l) => l.item_id === itemId && (l.kind === "refund" || l.kind === "voucher"))
        .reduce((sum, l) => sum + l.minor, 0);
      if (given > paid) {
        throw new ConflictError(`环节 ${itemId} 的退款+代金 ${given} 超过游客实际支付 ${paid}`);
      }
    }
    // 资金参考号使用独立业务键，与仓储生成的实体 id 解耦，创建前即可确定。
    const settlementRef = newId("settlement");
    for (const line of lines) line.reference = `${settlementRef}:${line.item_id}:${line.kind}`;
    const payload: SettlementPayload = {
      recovery_id: recoveryId,
      booking_id: recovery.booking_id,
      currency: booking.frozen_snapshot.currency,
      lines,
      totals: sumTotals(lines),
      approval_id: "",
      entries: [],
      state: "prepared",
      prepared_by: ctx.actorId,
      posted_at: "",
      last_reconciled_at: "",
      last_reconcile_result: "",
    };
    const created = this.repo.create(SETTLEMENT_TYPE, payload as unknown as Record<string, unknown>, {
      actor: ctx.actorId,
      requestKey,
    });
    this.repo.update(
      RECOVERY_TYPE,
      recoveryId,
      { settlement_id: created.entity_id },
      {
        actor: ctx.actorId,
        expectedVersion: this.versionOf(recoveryId),
        requestKey: `${requestKey}:link`,
      },
    );
    return this.requireSettlement(created.entity_id);
  }

  /**
   * 登记高额补偿：达到阈值必须生成双人审批，未批准前结算不能过账。
   */
  requestCompensation(
    ctx: AccessContext,
    recoveryId: string,
    amountMinor: number,
    reason: string,
    requestKey: string,
  ) {
    const recovery = this.requireRecovery(recoveryId);
    if (amountMinor < HIGH_COMPENSATION_MINOR) {
      throw new ValidationError(`低于高额阈值 ${HIGH_COMPENSATION_MINOR} 的补偿按普通退款处理`);
    }
    return this.approvals.submit(
      ctx,
      {
        recoveryId,
        bookingId: recovery.booking_id,
        amountMinor,
        currency: this.bookings.require(recovery.booking_id).frozen_snapshot.currency,
        reason,
      },
      requestKey,
    );
  }

  /**
   * 过账：不可变资金分录。参考号包含结算/环节/类型，重复调用（含重复回执）
   * 只回放已有结果，绝不产生第二笔退款。有未决高额审批时拒绝过账。
   */
  postSettlement(ctx: AccessContext, recoveryId: string, requestKey: string) {
    ctx.require("post:settlements");
    const recovery = this.requireRecovery(recoveryId);
    if (!recovery.settlement_id) throw new ConflictError("结算单尚未生成");
    const settlement = this.requireSettlement(recovery.settlement_id);
    if (settlement.state === "posted" || settlement.state === "verified") {
      return { settlement, replayed: true as const };
    }
    if (settlement.state !== "prepared" && settlement.state !== "approved") {
      throw new ConflictError(`结算单状态 ${settlement.state} 不能过账`);
    }
    const pending = this.approvals.pendingForRecovery(recoveryId);
    if (pending.length > 0) {
      throw new ConflictError("高额补偿仍在等待另一名审核人员确认，不能过账");
    }
    // 追加已批准的补偿行。
    const lines = [...settlement.lines];
    const approved = (this.repo.list("compensation_approvals", { state: "approved", limit: 200 }) as unknown as Array<
      { recovery_id: string; amount_minor: number; entity_id: string }
    >).filter((a) => a.recovery_id === recoveryId);
    for (const approval of approved) {
      if (lines.some((l) => l.kind === "compensation" && l.reference.includes(approval.entity_id))) continue;
      lines.push({
        kind: "compensation",
        item_id: "",
        minor: approval.amount_minor,
        reason: `高额补偿（审批 ${approval.entity_id}）`,
        reference: `${settlement.entity_id}:comp:${approval.entity_id}`,
      });
    }
    const entries: SettlementPayload["entries"] = [];
    for (const line of lines) {
      const direction = line.kind === "supplement" ? "debit" : "credit";
      const account = {
        refund: "payable:refund",
        supplement: "receivable:supplement",
        voucher: "payable:voucher",
        compensation: "payable:compensation",
      }[line.kind];
      // 参考号唯一约束本身也拦截重复，state 守卫之外双保险。
      const posted = this.ledger.post({
        journalKey: `booking:${settlement.booking_id}`,
        account,
        currency: settlement.currency,
        amount: (line.minor / 100).toFixed(2),
        direction,
        reference: line.reference,
        actor: ctx.actorId,
      });
      entries.push({ entry_id: posted.entryId, kind: line.kind, reference: line.reference });
    }
    const next: NextResponsible = {
      party: "traveler",
      org_id: "",
      action: "receive_funds",
      reason: "结算已过账，退款/代金/补偿进入支付通道",
    };
    const updated = this.repo.update(
      SETTLEMENT_TYPE,
      settlement.entity_id,
      {
        lines,
        totals: sumTotals(lines),
        entries,
        state: "posted",
        posted_at: this.clock.now(),
      },
      { actor: ctx.actorId, expectedVersion: settlement.version, requestKey },
    );
    this.repo.update(
      RECOVERY_TYPE,
      recoveryId,
      {
        state: "settled",
        state_reason: "资金已过账",
        next_responsible: next,
      },
      {
        actor: ctx.actorId,
        expectedVersion: this.versionOf(recoveryId),
        requestKey: `${requestKey}:recovery`,
      },
    );
    this.jobs.schedule({
      jobType: "settlement_reconcile",
      subjectId: settlement.entity_id,
      runAt: this.clock.now(),
      payload: { settlement_id: settlement.entity_id, recovery_id: recoveryId },
    });
    this.outbox.enqueue({
      topic: "settlement.posted",
      aggregateId: recoveryId,
      payload: {
        recovery_id: recoveryId,
        booking_id: settlement.booking_id,
        traveler: this.bookings.require(recovery.booking_id).traveler.actor,
        totals: sumTotals(lines),
      },
    });
    return { settlement: updated, replayed: false as const };
  }

  /**
   * 退款对账：逐条核对不可变分录与结算行的金额、方向、参考号，并校验合计。
   * 可在应用重启后由任务自动再次执行。
   */
  reconcile(settlementId: string): { ok: boolean; detail: string } {
    const settlement = this.requireSettlement(settlementId);
    if (settlement.state !== "posted" && settlement.state !== "verified") {
      return { ok: false, detail: "结算尚未过账" };
    }
    const rows = this.ledger.entries(`booking:${settlement.booking_id}`);
    const byReference = new Map(rows.map((row) => [row.reference as string, row]));
    for (const line of settlement.lines) {
      const row = byReference.get(line.reference);
      if (!row) return this.markReconcile(settlement, false, `缺少分录: ${line.reference}`);
      if (Number(row.amount_minor) !== line.minor) {
        return this.markReconcile(settlement, false, `金额不一致: ${line.reference}`);
      }
      const expectedDirection = line.kind === "supplement" ? "debit" : "credit";
      if (row.direction !== expectedDirection) {
        return this.markReconcile(settlement, false, `方向不一致: ${line.reference}`);
      }
    }
    const entriesSum = settlement.entries.reduce((sum, e) => {
      const row = byReference.get(e.reference);
      return sum + (row ? Number(row.amount_minor) : 0);
    }, 0);
    const linesSum = settlement.lines.reduce((sum, l) => sum + l.minor, 0);
    if (entriesSum !== linesSum) {
      return this.markReconcile(settlement, false, `分录合计 ${entriesSum} 与结算合计 ${linesSum} 不符`);
    }
    return this.markReconcile(settlement, true, `对账通过：${settlement.lines.length} 条分录，合计 ${linesSum}`);
  }

  private markReconcile(
    settlement: SettlementPayload & { entity_id: string; version: number },
    ok: boolean,
    detail: string,
  ) {
    // 已通过对账的结算重复执行（含重启续接）直接回放结果，不再写新版本。
    if (settlement.state === "verified" && ok) return { ok: true, detail: settlement.last_reconcile_result || detail };
    this.repo.update(
      SETTLEMENT_TYPE,
      settlement.entity_id,
      {
        state: ok ? "verified" : "posted",
        last_reconciled_at: this.clock.now(),
        last_reconcile_result: detail,
      },
      { actor: "system", expectedVersion: settlement.version, requestKey: `reconcile:${settlement.entity_id}:v${settlement.version}` },
    );
    return { ok, detail };
  }

  // ---------------------------------------------------------------- 查询

  requireRecovery(recoveryId: string): RecoveryPayload & { entity_id: string; version: number } {
    const entity = this.repo.find(RECOVERY_TYPE, recoveryId);
    if (!entity) throw new NotFoundError(`恢复单 ${recoveryId} 不存在`);
    return entity as unknown as RecoveryPayload & { entity_id: string; version: number };
  }

  requireSettlement(settlementId: string): SettlementPayload & { entity_id: string; version: number } {
    const entity = this.repo.find(SETTLEMENT_TYPE, settlementId);
    if (!entity) throw new NotFoundError(`结算单 ${settlementId} 不存在`);
    return entity as unknown as SettlementPayload & { entity_id: string; version: number };
  }

  listForBooking(bookingId: string) {
    return (this.repo.list(RECOVERY_TYPE, { limit: 500 }) as unknown as Array<
      RecoveryPayload & { entity_id: string; version: number }
    >).filter((r) => r.booking_id === bookingId);
  }

  listOpen() {
    return (this.repo.list(RECOVERY_TYPE, { limit: 500 }) as unknown as Array<
      RecoveryPayload & { entity_id: string; version: number }
    >).filter((r) => r.state !== "closed");
  }

  /** 供应商视角：只返回涉及本方机构的恢复单与环节。 */
  listForSupplier(orgId: string) {
    return this.listOpen().filter((recovery) => {
      const booking = this.bookings.require(recovery.booking_id);
      const ids = new Set([...recovery.affected_item_ids, ...recovery.retained_item_ids]);
      return booking.frozen_snapshot.days.some((day) =>
        day.items.some((item) => ids.has(item.item_id) && item.supplier_org_id === orgId),
      );
    });
  }

  /** 待游客确认的替代（重启后续接页面使用）。 */
  listPendingAlternatives() {
    const now = this.clock.now();
    return this.listOpen()
      .filter((r) => r.state === "alternative_pending" && r.active_alternative_id)
      .map((r) => ({
        recovery: r,
        alternative: r.alternatives.find((a) => a.alternative_id === r.active_alternative_id),
        expired: (r.alternatives.find((a) => a.alternative_id === r.active_alternative_id)?.expires_at ?? "") < now,
      }));
  }

  // ---------------------------------------------------------------- 内部

  private findOpenByReceipt(receiptKey: string): Array<RecoveryPayload & { entity_id: string }> {
    return this.listOpen().filter((r) =>
      r.events.some((e) =>
        e.inbox_refs.some((ref) => `${ref.source}/${ref.source_key}/${ref.sequence}` === receiptKey),
      ),
    );
  }

  /** 已使用服务的下一责任方：按原供应方机构类型直接指向地接/航司/酒店等责任方。 */
  private retainedResponsible(
    booking: BookingPayload,
    retainedIds: string[],
  ): NextResponsible {
    const items = booking.frozen_snapshot.days.flatMap((day) => day.items);
    const first = items.find((i) => i.item_id === retainedIds[0]);
    const orgId = first?.supplier_org_id ?? "";
    let party: NextResponsible["party"] = "supplier";
    if (orgId) {
      const org = this.repo.find("organizations", orgId);
      const orgType = org ? String(org.org_type) : "";
      if (orgType === "airline") party = "airline";
      else if (orgType === "ground_handler") party = "ground_handler";
    }
    return {
      party,
      org_id: orgId,
      action: "honor_used_service_liability",
      reason: "相关服务已使用，由原供应方继续承担既有责任，旅行社不再发起退款/替代",
    };
  }

  private travelerTitle(booking: BookingPayload, trigger: RecoveryTrigger): string {    const names: Record<RecoveryTrigger, string> = {
      supplier_exit: "供应商退出导致行程调整",
      capacity_reduction: "容量缩减导致行程调整",
      destination_risk: "目的地风险导致行程调整",
      flight_change: "航班变化导致行程调整",
    };
    return `${names[trigger]}（订单 ${booking.code}）`;
  }

  private releaseAlternativeHolds(recoveryId: string, alternative: Alternative): void {
    for (const comparison of alternative.comparisons) {
      const rows = this.reservations.listBySubject(`${recoveryId}:${comparison.original_item_id}`);
      for (const row of rows) {
        if (row.status !== "released") {
          this.reservations.release(String(row.reservation_id), Number(row.version));
        }
      }
    }
  }

  private versionOf(recoveryId: string): number {
    return this.requireRecovery(recoveryId).version;
  }

  /** 到期未确认的替代：释放占座、方案置为过期、责任回到运营（可由任务在重启后续接）。 */
  expireAlternative(recoveryId: string, alternativeId: string): void {
    const recovery = this.requireRecovery(recoveryId);
    const alternative = recovery.alternatives.find((a) => a.alternative_id === alternativeId);
    if (!alternative || alternative.status !== "proposed") return;
    if (this.clock.now() < alternative.expires_at) return;
    this.releaseAlternativeHolds(recoveryId, alternative);
    const alternatives = recovery.alternatives.map((a) =>
      a.alternative_id === alternativeId
        ? { ...a, status: "expired" as const, decided_at: this.clock.now(), traveler_note: "超过确认截止时间自动失效" }
        : a,
    );
    this.repo.update(
      RECOVERY_TYPE,
      recoveryId,
      {
        alternatives,
        active_alternative_id: "",
        state: "opened",
        state_reason: "替代方案到期未确认，已释放占座",
        next_responsible: {
          party: "operator",
          org_id: "",
          action: "propose_alternative_or_refund",
          reason: "游客未在截止时间前确认，运营需重新安排",
        },
      },
      {
        actor: "system",
        expectedVersion: recovery.version,
        requestKey: `expire:${recoveryId}:${alternativeId}:v${recovery.version}`,
      },
    );
  }
}

function sumTotals(lines: SettlementLine[]): Record<SettlementLine["kind"], number> {
  const totals = { refund: 0, supplement: 0, voucher: 0, compensation: 0 };
  for (const line of lines) totals[line.kind] += line.minor;
  return totals;
}

function validateReplacementShape(item: ItineraryItem): void {
  if (!item.item_id?.trim()) throw new ValidationError("替代环节标识不能为空");
  if (!item.title?.trim() || !item.supplier_org_id?.trim()) {
    throw new ValidationError("替代环节的标题与供应商不能为空");
  }
  if (!item.start_at || !item.end_at) throw new ValidationError("替代环节时间不完整");
  if (!Number.isInteger(item.capacity) || item.capacity <= 0) {
    throw new ValidationError("替代环节容量必须为正整数");
  }
  const p = item.price;
  if (!p || [p.base_minor, p.surcharge_minor, p.tax_minor].some((v) => !Number.isInteger(v) || v < 0)) {
    throw new ValidationError("替代环节价格构成不合法");
  }
  if (!item.accessibility || typeof item.accessibility.wheelchair !== "boolean") {
    throw new ValidationError("替代环节无障碍条件不合法");
  }
  if (!Array.isArray(item.credentials)) throw new ValidationError("替代环节资质列表不合法");
}

/** 判断替代服务能否满足该游客挂在原环节上的特殊需求，不能则给出人话说明。 */
function describeNeedGap(need: SpecialNeed, replacement: ItineraryItem): string {
  const text = `${need.code} ${need.detail}`;
  if (/轮椅|无障碍|wheelchair/i.test(text) && !replacement.accessibility.wheelchair) {
    return `特殊需求「${need.detail}」：替代服务不支持轮椅通行`;
  }
  if (/听障|视障|感官|sensory/i.test(text) && !replacement.accessibility.sensory_friendly) {
    return `特殊需求「${need.detail}」：替代服务不提供感官友好安排`;
  }
  return "";
}
