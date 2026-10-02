/** 四类页面渲染：游客、运营、审核、供应商，外加矛盾消息核对页。 */
import type { TravelApp } from "../domain/app.js";
import type {
  BookingPayload,
  ComparisonItem,
  ItineraryItem,
  RecoveryPayload,
  SettlementPayload,
} from "../domain/types.js";
import { itemTotal } from "../domain/money.js";
import { AccessContext } from "../platform/access.js";
import { esc, money, page } from "./html.js";

const SYS = AccessContext.system();

const TRIGGER_LABEL: Record<string, string> = {
  supplier_exit: "供应商退出",
  capacity_reduction: "容量缩减",
  destination_risk: "目的地风险",
  flight_change: "航班变化",
};

const STATE_LABEL: Record<string, string> = {
  opened: "待处理",
  alternative_pending: "待游客确认替代",
  awaiting_review: "待补偿审核",
  ready_to_settle: "待结算",
  settled: "已过账",
  closed: "已归档（原责任保留）",
};

const FULFILLMENT_LABEL: Record<string, string> = {
  scheduled: "未履行",
  in_use: "使用中",
  fulfilled: "已使用",
  cancelled: "已取消（被替代）",
};

export function renderIndex(app: TravelApp): string {
  const departures = app.departures.list();
  const bookings = app.platform.repository
    .list("bookings", { limit: 500 })
    .map((row) => row as unknown as BookingPayload & { entity_id: string; state: string });
  const orgs = app.organizations.list();
  const openCount = app.recoveries.listOpen().length;
  const held = app.platform.inbox.heldConflicts().length;
  const body = `
  <h2>出发批次与游客</h2>
  <table><tr><th>批次</th><th>线路</th><th>出发</th><th>游客订单</th></tr>
  ${departures
    .map((d) => {
      const rows = bookings.filter((b) => b.departure_id === d.entity_id);
      return `<tr><td>${esc(d.code)}<br><span class="muted">v${String(d.version)} · ${esc(d.state)}</span></td>
      <td>${esc(d.route_name)}<br><span class="muted">${esc(d.destination_country)} · 冻结版本按游客保存</span></td>
      <td>${esc(d.depart_at)}</td>
      <td>${rows
        .map(
          (b) =>
            `<a href="/traveler?booking=${encodeURIComponent(b.entity_id)}">${esc(b.traveler.name)}（${esc(b.code)}）</a>`,
        )
        .join("<br>")}</td></tr>`;
    })
    .join("")}
  </table>
  <h2>工作台</h2>
  <div class="grid2">
    <div class="card"><h3>运营人员</h3>
      <p>打开恢复单、比较替代、计算补差退款、确定下一责任方。</p>
      <p><a class="btn" href="/operator">运营工作台（${String(openCount)} 张未关闭恢复单${held ? `，<b>${String(held)} 条矛盾消息待核对</b>` : ""}）</a></p>
    </div>
    <div class="card"><h3>独立审核人员</h3>
      <p>客服发起的高额补偿必须由另一名审核人员确认。</p>
      <p><a class="btn" href="/reviewer">补偿审核台</a></p>
    </div>
  </div>
  <h2>供应商入口（只看本方任务）</h2>
  <table><tr><th>机构</th><th>类型</th><th>入口</th></tr>
  ${orgs
    .map(
      (o) =>
        `<tr><td>${esc(o.name)}</td><td>${esc(o.org_type)}</td>
        <td><a href="/supplier?org=${encodeURIComponent(o.entity_id)}">本方任务与回执</a></td></tr>`,
    )
    .join("")}
  </table>`;
  return page("首页", body);
}

// ---------------------------------------------------------------- 游客页

export function renderTraveler(app: TravelApp, bookingId: string, message = ""): string {
  const bookingEntity = app.platform.repository.get("bookings", bookingId) as unknown as BookingPayload & {
    entity_id: string;
    version: number;
  };
  const recoveries = app.recoveries.listForBooking(bookingId);
  const frozen = bookingEntity.frozen_snapshot;
  const recoveryCards = recoveries
    .map((recovery) => recoveryCard(app, recovery))
    .join("\n");
  const body = `
  ${message ? `<div class="card">${esc(message)}</div>` : ""}
  <h2>${esc(bookingEntity.traveler.name)} 的订单 ${esc(bookingEntity.code)}</h2>
  <div class="card">
    <table class="kvs">
      <tr><td>线路</td><td>${esc(frozen.route_name)}（${esc(frozen.code)}）· ${esc(frozen.destination_country)}</td></tr>
      <tr><td>确认冻结版本</td><td>批次 v${String(bookingEntity.frozen_departure_version)}，确认于 ${esc(bookingEntity.confirmed_at)}。之后批次修订不影响您实际购买的版本。</td></tr>
      <tr><td>签证 / 入境条件</td><td>${esc(frozen.visa_policy.type)}<ul class="tight">${frozen.visa_policy.conditions
        .map((c) => `<li>${esc(c)}</li>`)
        .join("")}</ul><span class="muted">${esc(frozen.visa_policy.notes)}</span></td></tr>
      <tr><td>导游资质</td><td>${esc(frozen.guide_requirements.languages.join("、"))} · ${esc(frozen.guide_requirements.credentials.join("、"))}</td></tr>
      ${
        bookingEntity.special_needs.length
          ? `<tr><td>特殊需求</td><td><ul class="tight">${bookingEntity.special_needs
              .map((n) => `<li>${esc(n.detail)}（关联环节：${esc(n.item_ids.join("、") || "全行程")}）</li>`)
              .join("")}</ul></td></tr>`
          : ""
      }
    </table>
  </div>

  <h2>逐日行程（实际购买版本，标注履约状态与变更）</h2>
  ${frozen.days
    .map((day) => {
      const rows = day.items
        .map((item) => {
          const status = bookingEntity.item_states[item.item_id] ?? "scheduled";
          const changed = recoveries.some((r) => r.affected_item_ids.includes(item.item_id));
          const retained = recoveries.some((r) => r.retained_item_ids.includes(item.item_id));
          const badge = retained
            ? `<span class="badge ok">${esc(FULFILLMENT_LABEL[status] ?? status)}·原责任保留</span>`
            : changed
              ? `<span class="badge bad">${esc(FULFILLMENT_LABEL[status] ?? status)}·受变更影响</span>`
              : `<span class="badge">${esc(FULFILLMENT_LABEL[status] ?? status)}</span>`;
          return `<tr><td>D${String(day.day)} ${esc(item.title)}<br><span class="muted">${esc(item.service_code)} · ${esc(item.start_at)}–${esc(item.end_at)}</span></td>
          <td>${esc(item.category)}</td><td>${money(itemTotal(item), frozen.currency)}</td>
          <td>${item.accessibility.wheelchair ? "♿ 可轮椅" : "—"}${item.accessibility.sensory_friendly ? " · 感官友好" : ""}</td>
          <td>${badge}</td></tr>`;
        })
        .join("");
      return `<h3>D${String(day.day)} · ${esc(day.date)} ${esc(day.title)}</h3>
      <table><tr><th>环节</th><th>类型</th><th>价格构成合计</th><th>无障碍</th><th>状态</th></tr>${rows}</table>`;
    })
    .join("")}

  <h2>服务恢复记录：行程为何改变、权益如何计算</h2>
  ${recoveryCards || `<div class="card muted">当前没有受影响的环节。</div>`}
  `;
  return page(`${bookingEntity.traveler.name}的行程`, body);
}

function recoveryCard(app: TravelApp, recovery: RecoveryPayload & { entity_id: string; version: number }): string {
  const booking = app.bookings.require(recovery.booking_id);
  const currency = booking.frozen_snapshot.currency;
  const events = recovery.events
    .map(
      (e) =>
        `<li><b>${esc(TRIGGER_LABEL[e.trigger] ?? e.trigger)}</b> · ${esc(e.at)} · ${esc(e.detail)}
        <div class="muted">回执：${esc(e.inbox_refs.map((r) => `${r.source}/${r.source_key}#${String(r.sequence)}`).join("，"))}</div></li>`,
    )
    .join("");
  const retained = recovery.retained_item_ids
    .map((id) => itemTitle(booking, id))
    .filter(Boolean)
    .join("、");
  const active = recovery.alternatives.find((a) => a.alternative_id === recovery.active_alternative_id);
  const actor = booking.traveler.actor;
  const alternativeBlock = active
    ? alternativeDetail(
        active.alternative_id,
        active.comparisons,
        currency,
        recovery,
        actor,
        active.expires_at,
        active.status === "proposed",
      )
    : `<p class="muted">暂无待确认替代，运营可安排替代或按环节全额退款。</p>`;
  const settlement = recovery.settlement_id ? settlementBlock(app, recovery.settlement_id) : "";
  return `<div class="card">
    <h3>${esc(recovery.title)} <span class="badge ${recovery.state === "settled" ? "ok" : "warn"}">${esc(STATE_LABEL[recovery.state] ?? recovery.state)}</span></h3>
    <ul class="tight">${events}</ul>
    ${retained ? `<p>已使用的服务保留原责任，不参与本次退款/替代：<b>${esc(retained)}</b></p>` : ""}
    <p class="muted">受影响环节：${esc(recovery.affected_item_ids.map((id) => itemTitle(booking, id)).join("、"))}</p>
    ${alternativeBlock}
    ${settlement}
    <p>下一责任方：<b>${esc(nextLabel(recovery))}</b> — ${esc(recovery.next_responsible.reason)}</p>
  </div>`;
}

function alternativeDetail(
  alternativeId: string,
  comparisons: ComparisonItem[],
  currency: string,
  recovery: RecoveryPayload & { entity_id: string; version: number },
  actor: string,
  expiresAt: string,
  canDecide: boolean,
): string {
  const rows = comparisons
    .map((c) => {
      const deltaClass = c.value.delta_minor > 0 ? "delta-pos" : c.value.delta_minor < 0 ? "delta-neg" : "";
      const access = c.accessibility.required_needs_met
        ? `<span class="badge ok">需求满足</span>`
        : `<span class="badge bad">需求不满足</span><ul class="tight">${c.accessibility.gaps
            .map((g) => `<li>${esc(g)}</li>`)
            .join("")}</ul>`;
      return `<tr>
        <td>${esc(c.time.original_start.substring(11, 16))}–${esc(c.time.original_end.substring(11, 16))}<br><span class="muted">原服务</span></td>
        <td>${esc(c.time.replacement_start.substring(11, 16))}–${esc(c.time.replacement_end.substring(11, 16))}<br><span class="muted">替代服务</span></td>
        <td>开始时刻 ${signedMinutes(c.time.start_delta_minutes)}<br>时长变化 ${signedMinutes(c.time.duration_delta_minutes)}</td>
        <td>${money(c.value.original_total_minor, currency)}<br>→ ${money(c.value.replacement_total_minor, currency)}<br><span class="${deltaClass}">差额 ${money(c.value.delta_minor, currency)}</span></td>
        <td>${access}<br><span class="muted">替代：${c.replacement.accessibility.wheelchair ? "♿" : "—"} ${esc(c.replacement.accessibility.notes)}</span></td>
      </tr>`;
    })
    .join("");
  return `<h3>待确认替代方案（截止 ${esc(expiresAt)}）</h3>
  <table><tr><th>原时间</th><th>替代时间</th><th>时间比较</th><th>价值比较</th><th>无障碍比较</th></tr>${rows}</table>
  <p class="muted">补差/退款按环节计算：替代更贵则补差价，更便宜则退差价；退款与代金合计不超过该环节已付金额。</p>
  ${
    canDecide
      ? `<form method="post" action="/traveler/accept">
    <input type="hidden" name="recovery" value="${esc(recovery.entity_id)}">
    <input type="hidden" name="alternative" value="${esc(alternativeId)}">
    <input type="hidden" name="version" value="${String(recovery.version)}">
    <input type="hidden" name="actor" value="${esc(actor)}">
    <button type="submit">接受替代</button>
  </form>
  <form method="post" action="/traveler/reject">
    <input type="hidden" name="recovery" value="${esc(recovery.entity_id)}">
    <input type="hidden" name="alternative" value="${esc(alternativeId)}">
    <input type="hidden" name="version" value="${String(recovery.version)}">
    <input type="hidden" name="actor" value="${esc(actor)}">
    <input type="text" name="reason" placeholder="拒绝原因（必填）" required>
    <button class="danger" type="submit">拒绝替代</button>
  </form>`
      : `<p><span class="badge warn">该方案已结束</span></p>`
  }`;
}

function settlementBlock(app: TravelApp, settlementId: string): string {
  const settlement = app.recoveries.requireSettlement(settlementId);
  const currency = settlement.currency;
  const rows = settlement.lines
    .map(
      (l) =>
        `<tr><td>${esc(kindLabel(l.kind))}</td><td>${esc(l.item_id || "—")}</td><td>${money(l.minor, currency)}</td><td>${esc(l.reason)}</td></tr>`,
    )
    .join("");
  return `<h3>权益结算（合计与受影响环节一一对应）</h3>
  <table><tr><th>类型</th><th>对应环节</th><th>金额</th><th>说明</th></tr>${rows}</table>
  <p>退款 ${money(settlement.totals.refund, currency)} ｜ 补差 ${money(settlement.totals.supplement, currency)} ｜ 代金 ${money(settlement.totals.voucher, currency)} ｜ 补偿 ${money(settlement.totals.compensation, currency)}
  <span class="badge ${settlement.state === "verified" ? "ok" : settlement.state === "posted" ? "warn" : ""}">${esc(settlementState(settlement.state))}</span></p>
  ${settlement.last_reconcile_result ? `<p class="muted">对账：${esc(settlement.last_reconcile_result)}（${esc(settlement.last_reconciled_at)}）</p>` : ""}`;
}

// ---------------------------------------------------------------- 运营台

export function renderOperator(app: TravelApp): string {
  const open = app.recoveries.listOpen();
  const pendingApprovals = app.platform.repository.list("compensation_approvals", { state: "pending", limit: 200 });
  const body = `
  <h2>未关闭恢复单与下一责任方</h2>
  <table><tr><th>游客</th><th>扰动</th><th>状态</th><th>受影响 / 已使用保留</th><th>下一责任方</th><th>操作</th></tr>
  ${open
    .map((r) => {
      const booking = app.bookings.require(r.booking_id);
      return `<tr>
        <td><a href="/traveler?booking=${encodeURIComponent(r.booking_id)}">${esc(booking.traveler.name)}</a><br><span class="muted">${esc(booking.code)}</span></td>
        <td>${esc(TRIGGER_LABEL[r.trigger] ?? r.trigger)}<br><span class="muted">${esc(r.state_reason)}</span></td>
        <td><span class="badge ${r.state === "settled" ? "ok" : "warn"}">${esc(STATE_LABEL[r.state] ?? r.state)}</span></td>
        <td>${String(r.affected_item_ids.length)} / ${String(r.retained_item_ids.length)}</td>
        <td><b>${esc(nextLabel(r))}</b><br><span class="muted">${esc(r.next_responsible.action)}</span></td>
        <td>${operatorActions(r)}</td>
      </tr>`;
    })
    .join("")}
  </table>
  <h2>待独立审核的高额补偿（${String(pendingApprovals.length)}）</h2>
  <p class="muted">客服发起的补偿在审核台由另一名审核人员处理；未审核通过前结算不能过账。<a href="/reviewer">前往审核台</a></p>`;
  return page("运营工作台", body);
}

function operatorActions(r: RecoveryPayload & { entity_id: string; version: number }): string {
  const buttons: string[] = [];
  if (r.state === "opened" && r.affected_item_ids.length === 0 && r.retained_item_ids.length > 0) {
    buttons.push(
      `<form method="post" action="/operator/close-retention"><input type="hidden" name="recovery" value="${esc(r.entity_id)}"><input type="hidden" name="version" value="${String(r.version)}"><input type="hidden" name="actor" value="op:meilin"><input type="hidden" name="note" value="评估确认无需调整，原责任保留"><button class="secondary" type="submit">确认原责任保留并归档</button></form>`,
    );
  }
  if (r.state === "opened" || r.state === "alternative_pending") {
    buttons.push(
      `<form method="post" action="/operator/no-alternative"><input type="hidden" name="recovery" value="${esc(r.entity_id)}"><input type="hidden" name="version" value="${String(r.version)}"><input type="hidden" name="actor" value="op:meilin"><button class="secondary" type="submit">不提供替代，转全额退款</button></form>`,
    );
  }
  if (r.state === "ready_to_settle" && !r.settlement_id) {
    buttons.push(
      `<form method="post" action="/operator/prepare-settlement"><input type="hidden" name="recovery" value="${esc(r.entity_id)}"><input type="hidden" name="actor" value="op:meilin"><button type="submit">按环节生成退款/补差</button></form>`,
    );
  }
  if (r.settlement_id && r.state !== "settled") {
    buttons.push(
      `<form method="post" action="/operator/post-settlement"><input type="hidden" name="recovery" value="${esc(r.entity_id)}"><input type="hidden" name="actor" value="op:meilin"><button type="submit">过账（不可变分录）</button></form>`,
    );
  }
  if (r.state === "settled") {
    buttons.push(
      `<form method="post" action="/operator/reconcile"><input type="hidden" name="recovery" value="${esc(r.entity_id)}"><input type="hidden" name="actor" value="op:meilin"><button class="secondary" type="submit">重新对账</button></form>`,
    );
  }
  return buttons.join(" ");
}

// ---------------------------------------------------------------- 审核台

export function renderReviewer(app: TravelApp, actor = "rv:zhao", message = ""): string {
  const pending = app.platform.repository
    .list("compensation_approvals", { state: "pending", limit: 200 })
    .map((row) => row as never as {
      entity_id: string;
      version: number;
      recovery_id: string;
      booking_id: string;
      amount_minor: number;
      currency: string;
      reason: string;
      submitter: string;
    });
  const body = `
  ${message ? `<div class="card">${esc(message)}</div>` : ""}
  <form method="get" action="/reviewer" class="card">
    当前审核人身份：<input type="text" name="actor" value="${esc(actor)}">
    <button class="secondary" type="submit">切换</button>
    <span class="muted">提交者本人不能审批自己的申请。</span>
  </form>
  <h2>待审批高额补偿</h2>
  <table><tr><th>金额</th><th>发起人</th><th>原因</th><th>审批</th></tr>
  ${pending
    .map((a) => {
      const booking = app.bookings.require(a.booking_id);
      return `<tr><td><b>${money(a.amount_minor, a.currency)}</b></td><td>${esc(a.submitter)}</td>
      <td>${esc(a.reason)}<br><span class="muted">游客 ${esc(booking.traveler.name)} · 恢复单 ${esc(a.recovery_id)}</span></td>
      <td><form method="post" action="/reviewer/decide">
        <input type="hidden" name="approval" value="${esc(a.entity_id)}">
        <input type="hidden" name="version" value="${String(a.version)}">
        <input type="hidden" name="actor" value="${esc(actor)}">
        <input type="text" name="note" placeholder="审批意见（必填）" required>
        <button name="approve" value="1">通过</button>
        <button class="danger" name="approve" value="0">驳回</button>
      </form></td></tr>`;
    })
    .join("") || `<tr><td colspan="4" class="muted">没有待审批申请。</td></tr>`}
  </table>`;
  return page("补偿审核台", body);
}

// ---------------------------------------------------------------- 供应商台

export function renderSupplier(app: TravelApp, orgId: string, message = ""): string {
  const org = app.organizations.get(orgId);
  const recoveries = app.recoveries.listForSupplier(orgId);
  const catalog = app.catalog.listBySupplier(orgId);
  const body = `
  ${message ? `<div class="card">${esc(message)}</div>` : ""}
  <h2>${esc(org.name)} · 本方任务</h2>
  <p class="muted">供应商只能看到与本机构相关的环节与恢复单，不展示其他供应商任务、价格构成以外的游客隐私。</p>
  <table><tr><th>目录服务</th><th>容量</th><th>状态</th></tr>
  ${catalog
    .map(
      (s) =>
        `<tr><td>${esc(s.code)} · ${esc(s.name)}</td><td>${String(s.capacity)}</td><td>${esc(s.state)}</td></tr>`,
    )
    .join("") || `<tr><td colspan="3" class="muted">无目录服务</td></tr>`}
  </table>
  <h2>与本方相关的恢复单</h2>
  <table><tr><th>游客</th><th>扰动</th><th>本方环节（未履行 / 已使用保留）</th><th>下一责任方</th></tr>
  ${recoveries
    .map((r) => {
      const booking = app.bookings.require(r.booking_id);
      const mine = [...r.affected_item_ids, ...r.retained_item_ids]
        .map((id) => findItemOf(booking, id))
        .filter((i): i is ItineraryItem => i !== undefined && i.supplier_org_id === orgId);
      return `<tr><td>${esc(booking.traveler.name)}</td><td>${esc(TRIGGER_LABEL[r.trigger] ?? r.trigger)}</td>
      <td>${mine
        .map((i) => `${esc(i.title)}（${r.retained_item_ids.includes(i.item_id) ? "已使用·原责任保留" : "未履行"}）`)
        .join("<br>")}</td><td>${esc(nextLabel(r))}</td></tr>`;
    })
    .join("") || `<tr><td colspan="4" class="muted">当前没有涉及本方的恢复单。</td></tr>`}
  </table>
  <h2>状态回执推送（演示）</h2>
  <div class="card">
    <p>同一状态回执重复推送只返回“duplicate”，<b>不会触发第二次退款</b>；同序号但内容矛盾的消息会被挂起等待核对。</p>
    <form method="post" action="/supplier/receipt">
      <input type="hidden" name="org" value="${esc(orgId)}">
      <input type="hidden" name="kind" value="duplicate">
      <button type="submit">再次推送相同状态回执</button>
    </form>
    <form method="post" action="/supplier/receipt">
      <input type="hidden" name="org" value="${esc(orgId)}">
      <input type="hidden" name="kind" value="conflict">
      <button class="danger" type="submit">推送内容矛盾的“更正”</button>
    </form>
  </div>`;
  return page(`${org.name} · 供应商台`, body);
}

// ---------------------------------------------------------------- 矛盾核对

export function renderConflicts(app: TravelApp, message = ""): string {
  const held = app.platform.inbox.heldConflicts();
  const body = `
  ${message ? `<div class="card">${esc(message)}</div>` : ""}
  <h2>内容矛盾、等待核对的消息</h2>
  <p class="muted">这些消息没有推进任何业务（未开恢复单、未退款）。核对结论留痕后，应要求来源方以新序号重发确认后的版本。</p>
  <table><tr><th>#</th><th>来源</th><th>序号</th><th>原摘要</th><th>新摘要</th><th>收到时间</th><th>核对</th></tr>
  ${held
    .map(
      (c) => `<tr><td>${String(c.conflict_id)}</td><td>${esc(c.source)}/${esc(c.source_key)}</td><td>${String(c.sequence)}</td>
      <td class="muted">${esc(String(c.existing_digest).slice(0, 12))}…</td>
      <td class="muted">${esc(String(c.incoming_digest).slice(0, 12))}…</td>
      <td>${esc(c.received_at)}</td>
      <td><form method="post" action="/conflicts/resolve">
        <input type="hidden" name="conflict" value="${String(c.conflict_id)}">
        <input type="hidden" name="actor" value="op:meilin">
        <button name="resolution" value="accept_incoming">确认新内容</button>
        <button class="secondary" name="resolution" value="discard_incoming">丢弃新内容</button>
      </form></td></tr>`,
    )
    .join("") || `<tr><td colspan="7" class="muted">没有挂起消息。</td></tr>`}
  </table>`;
  return page("矛盾消息核对", body);
}

// ---------------------------------------------------------------- 小工具

function itemTitle(booking: BookingPayload, itemId: string): string {
  return findItemOf(booking, itemId)?.title ?? itemId;
}

function findItemOf(booking: BookingPayload, itemId: string): ItineraryItem | undefined {
  for (const day of booking.frozen_snapshot.days) {
    const found = day.items.find((i) => i.item_id === itemId);
    if (found) return found;
  }
  return undefined;
}

function nextLabel(r: RecoveryPayload): string {
  const party: Record<string, string> = {
    traveler: "游客",
    reviewer: "独立审核人",
    operator: "旅行社运营",
    airline: "航空公司",
    ground_handler: "地接社",
    supplier: "供应商",
    finance: "财务",
  };
  return party[r.next_responsible.party] ?? r.next_responsible.party;
}

function signedMinutes(minutes: number): string {
  if (minutes === 0) return "无变化";
  const sign = minutes > 0 ? "+" : "";
  return `${sign}${String(minutes)} 分钟`;
}

function kindLabel(kind: string): string {
  return { refund: "退款", supplement: "补差", voucher: "代金权益", compensation: "高额补偿" }[kind] ?? kind;
}

function settlementState(state: SettlementPayload["state"]): string {
  return { prepared: "已生成", approved: "已核准", posted: "已过账待对账", verified: "对账通过" }[state];
}

void SYS;
