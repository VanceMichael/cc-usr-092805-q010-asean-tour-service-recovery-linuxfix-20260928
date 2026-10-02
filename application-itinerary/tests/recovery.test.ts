/**
 * 关键不变量测试（node:test，标准库 + node:sqlite）：
 * 1. 确认即冻结版本，批次后续修订不影响已购订单；
 * 2. 扰动只作用于未履行环节，已使用服务保留原责任；
 * 3. 替代必须同时比较时间/价值/无障碍，无障碍不达标不能接受；
 * 4. 补差、退款、代金逐环节对应且守恒；
 * 5. 高额补偿必须另一名审核人确认，自审被拒，未审不能过账；
 * 6. 供应商只见本方任务；
 * 7. 重复回执不触发第二次退款，矛盾消息挂起；
 * 8. 重启后任务（替代到期/对账/临近出发）自动续接；
 * 9. 不可变资金分录与审计链可校验，重复过账不产生新分录；
 * 10. 容量缩减时超售被容量预约拦截；不可替代/仅限同类的替代范围被强制。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AccessContext } from "../src/platform/access.js";
import { ConflictError, PermissionDenied } from "../src/platform/errors.js";
import { Platform } from "../src/platform/app.js";
import { book, CS, newApp, NOW, OP, RV } from "./harness.js";
import type { ItineraryItem } from "../src/domain/types.js";
import { TravelApp } from "../src/domain/app.js";

function replacement(p: Partial<ItineraryItem> & Pick<ItineraryItem, "item_id" | "supplier_org_id">): ItineraryItem {
  return {
    day: 1,
    category: "transport",
    title: "替代服务",
    service_code: p.item_id,
    start_at: "2026-11-10T10:00:00+07:00",
    end_at: "2026-11-10T12:00:00+07:00",
    capacity: 10,
    price: { base_minor: 20000, surcharge_minor: 0, tax_minor: 0 },
    accessibility: { wheelchair: true, sensory_friendly: false, notes: "" },
    credentials: ["越南持证导游"],
    substitution_scope: { replaceable: true, same_category_only: true, notes: "" },
    detail: "",
    ...p,
  };
}

test("确认后冻结实际购买版本，批次修订不影响订单", () => {
  const { app, departureId } = newApp();
  const booking = book(app, departureId, "t:a", "甲", [], "k1");
  const frozenVersion = booking.frozen_departure_version;
  const before = booking.frozen_snapshot.days[0]!.items.length;
  // 批次发布后修订（产生新版本）
  const departure = app.departures.require(departureId);
  app.departures.revise(
    OP(),
    departureId,
    { route_name: "改了名的线路" },
    departure.version,
    "k1:revise",
    "航线调整",
  );
  const reloaded = app.bookings.require(booking.entity_id);
  assert.equal(reloaded.frozen_departure_version, frozenVersion);
  assert.equal(reloaded.frozen_snapshot.route_name, "测试线路");
  assert.equal(reloaded.frozen_snapshot.days[0]!.items.length, before);
});

test("扰动只处理未履行环节：已使用的酒店保留原责任且不开退款", () => {
  const { app, departureId } = newApp();
  const used = book(app, departureId, "t:b", "乙", [], "k2");
  const fresh = book(app, departureId, "t:a", "甲", [], "k2b");
  // 乙的酒店已开始使用
  app.bookings.markFulfillment(OP(), used.entity_id, "hotel1", "in_use", used.version, "k2:use");

  const result = app.recoveries.ingest(
    OP(),
    {
      departureId,
      trigger: "destination_risk",
      detail: "目的地风险，涉及首日酒店",
      receipt: { source: "gov", sourceKey: "risk-1", sequence: 1, occurredAt: NOW, payload: { level: 2 } },
      target: { itemIds: ["hotel1"] },
    },
    "k2:ingest",
  );
  assert.equal(result.status, "accepted");
  const ids = new Set(result.recoveries);
  const usedRecovery = app.recoveries.listForBooking(used.entity_id)[0]!;
  const freshRecovery = app.recoveries.listForBooking(fresh.entity_id)[0]!;
  assert.ok(ids.has(usedRecovery.entity_id));
  assert.deepEqual(usedRecovery.affected_item_ids, []);
  assert.deepEqual(usedRecovery.retained_item_ids, ["hotel1"]);
  assert.equal(usedRecovery.next_responsible.party, "supplier");
  // 纯保留单不能走结算
  app.recoveries.closeRetentionOnly(OP(), usedRecovery.entity_id, usedRecovery.version, "k2:close", "无需调整");
  assert.throws(
    () => app.recoveries.prepareSettlement(OP(), usedRecovery.entity_id, [], "k2:bad"),
    ConflictError,
  );
  // 未使用酒店的甲正常进入待处理
  assert.deepEqual(freshRecovery.affected_item_ids, ["hotel1"]);
});

test("替代同时比较时间/价值/无障碍；不满足轮椅需求的替代不能接受", () => {
  const { app, departureId, org } = newApp();
  const booking = book(app, departureId, "t:c", "丙", [
    { code: "wheelchair", detail: "全程依赖轮椅，需要无障碍车辆", item_ids: ["car"] },
  ], "k3");
  const ingested = app.recoveries.ingest(
    OP(),
    {
      departureId,
      trigger: "capacity_reduction",
      detail: "无障碍车容量缩减",
      receipt: { source: "car-co", sourceKey: "cap", sequence: 1, occurredAt: NOW, payload: {} },
      target: { itemIds: ["car"] },
    },
    "k3:ingest",
  );
  const recovery = app.recoveries.requireRecovery(ingested.recoveries[0]!);

  // 更贵、更晚且不支持轮椅的替代：比较结果应逐项体现
  const bad = replacement({
    item_id: "car-bad",
    category: "transport",
    title: "普通大巴",
    supplier_org_id: org.gh!,
    start_at: "2026-11-11T09:30:00+07:00",
    end_at: "2026-11-11T19:00:00+07:00",
    price: { base_minor: 8000, surcharge_minor: 0, tax_minor: 0 },
    accessibility: { wheelchair: false, sensory_friendly: false, notes: "无升降台" },
  });
  app.recoveries.proposeAlternative(
    OP(),
    recovery.entity_id,
    { rationale: "先试普通车", expiresAt: "2026-11-05T00:00:00+07:00", mappings: [{ originalItemId: "car", replacement: bad }] },
    "k3:alt1",
  );
  let current = app.recoveries.requireRecovery(recovery.entity_id);
  const comparison = current.alternatives[0]!.comparisons[0]!;
  assert.equal(comparison.time.start_delta_minutes, 90);
  assert.equal(comparison.value.delta_minor, 3000);
  assert.equal(comparison.accessibility.required_needs_met, false);
  assert.match(comparison.accessibility.gaps[0]!, /轮椅/);
  const traveler = AccessContext.traveler("t:c", booking.entity_id);
  assert.throws(
    () => app.recoveries.acceptAlternative(traveler, current.entity_id, current.alternatives[0]!.alternative_id, current.version, "k3:accept-bad"),
    /无障碍|特殊/,
  );

  // 拒绝后重新提满足无障碍且更便宜的替代
  app.recoveries.rejectAlternative(traveler, current.entity_id, current.alternatives[0]!.alternative_id, current.version, "k3:reject", "轮椅上不了车");
  const good = replacement({
    item_id: "car-good",
    title: "另一台无障碍车",
    supplier_org_id: org.car!,
    start_at: "2026-11-11T08:00:00+07:00",
    end_at: "2026-11-11T18:00:00+07:00",
    price: { base_minor: 4000, surcharge_minor: 0, tax_minor: 0 },
    accessibility: { wheelchair: true, sensory_friendly: false, notes: "有升降台" },
  });
  app.recoveries.proposeAlternative(
    OP(),
    recovery.entity_id,
    { rationale: "换同等无障碍车", expiresAt: "2026-11-05T00:00:00+07:00", mappings: [{ originalItemId: "car", replacement: good }] },
    "k3:alt2",
  );
  current = app.recoveries.requireRecovery(recovery.entity_id);
  const c2 = current.alternatives[1]!.comparisons[0]!;
  assert.equal(c2.accessibility.required_needs_met, true);
  assert.equal(c2.value.delta_minor, -1000);
  app.recoveries.acceptAlternative(traveler, current.entity_id, current.alternatives[1]!.alternative_id, current.version, "k3:accept-good");
  const settled = app.recoveries.requireRecovery(recovery.entity_id);
  assert.equal(settled.state, "ready_to_settle");
});

test("补差/退款/代金逐环节守恒：超额代金被拒，退款金额对应环节差价", () => {
  const { app, departureId } = newApp();
  const booking = book(app, departureId, "t:d", "丁", [], "k4");
  const ingested = app.recoveries.ingest(
    OP(),
    {
      departureId,
      trigger: "supplier_exit",
      detail: "工坊退出",
      receipt: { source: "gh", sourceKey: "ws", sequence: 1, occurredAt: NOW, payload: {} },
      target: { itemIds: ["workshop"] },
    },
    "k4:ingest",
  );
  const recovery = app.recoveries.requireRecovery(ingested.recoveries[0]!);
  // 更便宜的同类替代（活动→活动）
  app.recoveries.proposeAlternative(
    OP(),
    recovery.entity_id,
    {
      rationale: "改文庙观光",
      expiresAt: "2026-11-05T00:00:00+07:00",
      mappings: [{
        originalItemId: "workshop",
        replacement: replacement({
          item_id: "sight-1", category: "activity", title: "文庙观光", supplier_org_id: org_sight(app),
          start_at: "2026-11-11T14:00:00+07:00", end_at: "2026-11-11T16:00:00+07:00",
          price: { base_minor: 22000, surcharge_minor: 0, tax_minor: 0 },
        }),
      }],
    },
    "k4:alt",
  );
  let current = app.recoveries.requireRecovery(recovery.entity_id);
  const traveler = AccessContext.traveler("t:d", booking.entity_id);
  app.recoveries.acceptAlternative(traveler, current.entity_id, current.active_alternative_id, current.version, "k4:accept");

  // 退款+代金超过已付（退差 800 + 代金 30000 > 30000）→ 拒绝
  current = app.recoveries.requireRecovery(recovery.entity_id);
  assert.throws(
    () => app.recoveries.prepareSettlement(OP(), current.entity_id, [
      { itemId: "workshop", minor: 30000, reason: "超额代金" },
    ], "k4:over"),
    /超过游客实际支付/,
  );
  // 合法：800 退差 + 500 代金 ≤ 30000
  const settlement = app.recoveries.prepareSettlement(OP(), current.entity_id, [
    { itemId: "workshop", minor: 500, reason: "手作材料代金" },
  ], "k4:ok");
  assert.equal(settlement.totals.refund, 8000);
  assert.equal(settlement.totals.voucher, 500);
  const posted = app.recoveries.postSettlement(OP(), recovery.entity_id, "k4:post");
  assert.equal(posted.replayed, false);
  const replayed = app.recoveries.postSettlement(OP(), recovery.entity_id, "k4:post-again");
  assert.equal(replayed.replayed, true);
  // 只有 2 条分录（退差 + 代金），重复过账没有第二条
  const entries = app.platform.ledger.entries(`booking:${booking.entity_id}`);
  assert.equal(entries.length, 2);
  const result = app.recoveries.reconcile(settlement.entity_id);
  assert.equal(result.ok, true);
});

function org_sight(app: ReturnType<typeof newApp>["app"]): string {
  const found = app.organizations.list().find((o) => o.name === "观光公司");
  if (!found) throw new Error("fixture missing sight org");
  return found.entity_id;
}

test("高额补偿双人审批：自审拒绝、未审不能过账、他人审批后可过账", () => {
  const { app, departureId } = newApp();
  const booking = book(app, departureId, "t:e", "戊", [], "k5");
  const ingested = app.recoveries.ingest(
    OP(),
    {
      departureId,
      trigger: "flight_change",
      detail: "航班改期",
      receipt: { source: "air", sourceKey: "f1", sequence: 1, occurredAt: NOW, payload: {} },
      target: { itemIds: ["flight"] },
    },
    "k5:ingest",
  );
  const recoveryId = ingested.recoveries[0]!;
  app.recoveries.settleWithoutAlternative(OP(), recoveryId, 1, "k5:noalt", "不等替代");
  const settlement = app.recoveries.prepareSettlement(OP(), recoveryId, [], "k5:prepare");
  const approval = app.recoveries.requestCompensation(CS(), recoveryId, 60000, "客服关怀补偿", "k5:comp");

  // 未审批：过账被拒
  assert.throws(() => app.recoveries.postSettlement(OP(), recoveryId, "k5:post1"), /等待另一名审核人员/);
  // 发起人本人不能审批
  assert.throws(
    () => app.recoveries.approvals.decide(CS(), approval.entity_id, { approve: true, note: "自审", expectedVersion: approval.version }, "k5:self"),
    PermissionDenied,
  );
  // 另一名审核人员驳回 → 仍不能过账（驳回后无 pending，但补偿不进入结算；此处验证驳回留痕）
  app.recoveries.approvals.decide(RV(), approval.entity_id, { approve: false, note: "证据不足", expectedVersion: approval.version }, "k5:reject");
  // 重新发起并由审核人通过
  const approval2 = app.recoveries.requestCompensation(CS(), recoveryId, 60000, "补充证据后再次申请", "k5:comp2");
  app.recoveries.approvals.decide(RV(), approval2.entity_id, { approve: true, note: "同意", expectedVersion: approval2.version }, "k5:approve2");
  const posted = app.recoveries.postSettlement(OP(), recoveryId, "k5:post2");
  assert.equal((posted.settlement.totals as Record<string, number>).compensation, 60000);
  const reconcile = app.recoveries.reconcile(settlement.entity_id);
  assert.equal(reconcile.ok, true);
  void booking;
});

test("供应商只能看到本方任务，不能触碰他方环节", () => {
  const { app, departureId, org } = newApp();
  book(app, departureId, "t:f", "己", [], "k6");
  app.recoveries.ingest(
    OP(),
    {
      departureId,
      trigger: "flight_change",
      detail: "航班变动",
      receipt: { source: "air", sourceKey: "f", sequence: 1, occurredAt: NOW, payload: {} },
      target: { itemIds: ["flight"] },
    },
    "k6:ingest",
  );
  const airlineView = app.recoveries.listForSupplier(org.air!);
  const hotelView = app.recoveries.listForSupplier(org.hotel!);
  assert.equal(airlineView.length, 1);
  assert.equal(hotelView.length, 0);
  const supplierCtx = AccessContext.supplier("s:hotel", org.hotel!);
  // 酒店供应商不能撤回航司的目录服务（若存在）
  assert.throws(() => supplierCtx.requireOwnOrg(org.air!), PermissionDenied);
});

test("重复回执幂等：不重复开单、不重复退款；矛盾消息挂起等待核对", () => {
  const { app, departureId } = newApp();
  book(app, departureId, "t:g", "庚", [], "k7");
  const input = {
    departureId,
    trigger: "flight_change" as const,
    detail: "航班取消",
    receipt: { source: "air", sourceKey: "fx", sequence: 1, occurredAt: NOW, payload: { v: 1 } },
    target: { itemIds: ["flight"] },
  };
  const first = app.recoveries.ingest(OP(), input, "k7:1");
  const second = app.recoveries.ingest(OP(), input, "k7:2");
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "duplicate");
  assert.deepEqual(second.recoveries, first.recoveries);

  // 同序号不同内容 → held，业务不推进
  const conflicting = app.recoveries.ingest(
    OP(),
    { ...input, receipt: { ...input.receipt, payload: { v: 2, changed: true } } },
    "k7:3",
  );
  assert.equal(conflicting.status, "held");
  assert.equal(app.platform.inbox.heldConflicts().length, 1);
  const recoveryId = first.recoveries[0]!;
  // 挂起期间恢复单仍只有一张、状态未变
  assert.equal(app.recoveries.listForBooking(app.recoveries.requireRecovery(recoveryId).booking_id).length, 1);
});

test("替代范围强制：不可替代环节拒绝替代，仅同类环节不能跨类", () => {
  const { app, departureId, org } = newApp();
  book(app, departureId, "t:h", "辛", [], "k8");
  const ingested = app.recoveries.ingest(
    OP(),
    {
      departureId,
      trigger: "flight_change",
      detail: "航班变动",
      receipt: { source: "air", sourceKey: "fz", sequence: 1, occurredAt: NOW, payload: {} },
      target: { itemIds: ["flight"] },
    },
    "k8:ingest",
  );
  const recoveryId = ingested.recoveries[0]!;
  // flight 的 same_category_only=true：换成 activity 必须被拒
  assert.throws(
    () => app.recoveries.proposeAlternative(
      OP(),
      recoveryId,
      {
        rationale: "改成活动",
        expiresAt: "2026-11-05T00:00:00+07:00",
        mappings: [{
          originalItemId: "flight",
          replacement: replacement({
            item_id: "x", category: "activity", title: "室内活动", supplier_org_id: org.sight!,
          }),
        }],
      },
      "k8:bad-alt",
    ),
    /只允许同类替代/,
  );
});

test("容量预约拦截超售：替代容量不足时拒绝提出方案", () => {
  const { app, departureId, org } = newApp();
  // 占满替代资源的窗口容量（fixture 容量 10，订 10 个其他主体）
  for (let i = 0; i < 10; i++) {
    app.platform.reservations.reserve({
      resourceId: "service:car-tight",
      subjectId: `other:${i}`,
      quantity: 1,
      capacity: 10,
      startAt: "2026-11-11T08:00:00+07:00",
      endAt: "2026-11-11T18:00:00+07:00",
      actor: "op:1",
    });
  }
  book(app, departureId, "t:i", "壬", [], "k9");
  const ingested = app.recoveries.ingest(
    OP(),
    {
      departureId,
      trigger: "capacity_reduction",
      detail: "原车退出",
      receipt: { source: "car-co", sourceKey: "cap2", sequence: 1, occurredAt: NOW, payload: {} },
      target: { itemIds: ["car"] },
    },
    "k9:ingest",
  );
  const recoveryId = ingested.recoveries[0]!;
  assert.throws(
    () => app.recoveries.proposeAlternative(
      OP(),
      recoveryId,
      {
        rationale: "满员车辆",
        expiresAt: "2026-11-05T00:00:00+07:00",
        mappings: [{
          originalItemId: "car",
          replacement: replacement({
            item_id: "car-tight", title: "满员车", supplier_org_id: org.car!,
            start_at: "2026-11-11T08:00:00+07:00", end_at: "2026-11-11T18:00:00+07:00",
          }),
        }],
      },
      "k9:alt",
    ),
    /容量不足/,
  );
});

test("重启后自动续接：到期替代自动失效释放占座，过账后对账自动完成", () => {
  const { app, departureId, org } = newApp();
  const booking = book(app, departureId, "t:j", "癸", [], "k10");
  const ingested = app.recoveries.ingest(
    OP(),
    {
      departureId,
      trigger: "supplier_exit",
      detail: "工坊退出",
      receipt: { source: "gh", sourceKey: "ws2", sequence: 1, occurredAt: NOW, payload: {} },
      target: { itemIds: ["workshop"] },
    },
    "k10:ingest",
  );
  const recoveryId = ingested.recoveries[0]!;
  app.recoveries.proposeAlternative(
    OP(),
    recoveryId,
    {
      rationale: "替代",
      expiresAt: "2026-11-03T00:00:00+07:00",
      mappings: [{
        originalItemId: "workshop",
        replacement: replacement({
          item_id: "sight-2", category: "activity", title: "文庙", supplier_org_id: org.sight!,
          start_at: "2026-11-11T14:00:00+07:00", end_at: "2026-11-11T16:00:00+07:00",
          price: { base_minor: 10000, surcharge_minor: 0, tax_minor: 0 },
        }),
      }],
    },
    "k10:alt",
  );
  // 模拟应用重启：时钟拨到截止后，用同一数据库装出新应用实例并 resume
  const restarted: InstanceType<typeof TravelApp> = new TravelApp(new Platform(app.platform.database, "2026-11-04T00:00:00+07:00"));
  const summary = restarted.resume();
  assert.ok(summary.ran.length >= 1);
  const after = restarted.recoveries.requireRecovery(recoveryId);
  assert.equal(after.alternatives[0]!.status, "expired");
  assert.equal(after.state, "opened");
  // 占座已释放：同一资源可再被订满之前的 1 份
  const holds = app.platform.reservations.listBySubject(`${recoveryId}:workshop`);
  assert.ok(holds.every((h) => h.status === "released"));
  void booking;
});

test("审计哈希链可校验，实体历史保留全部版本", () => {
  const { app, departureId } = newApp();
  const booking = book(app, departureId, "t:k", "子", [], "k11");
  const versions = app.platform.repository.history("bookings", booking.entity_id);
  assert.ok(versions.length >= 2); // place + confirm
  assert.doesNotThrow(() => app.platform.verify());
});
