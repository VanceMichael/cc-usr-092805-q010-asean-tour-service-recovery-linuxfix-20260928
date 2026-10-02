"""中断事件、替代方案、服务恢复记录与资金对账。

规则要点：
- 供应商退出、容量缩减、目的地风险或航班变化只影响尚未履行的环节；
  已经使用的服务保留原责任，不能被纳入恢复范围。
- 替代方案逐项比较时间、价值与无障碍条件；退款减补差必须等于被影响项目
  的价值差，代金权益逐服务标记原因。
- 客服发起的高额补偿必须由另一名审核人员确认（四眼），资金过账到不可变分录。
- 供应商状态回执重复投递不产生第二次退款；内容矛盾的消息挂起等待核对。
- 临近出发提醒、替代确认超时与退款对账通过可恢复定时任务在重启后续接。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import timedelta
from typing import Mapping

from .approvals import ApprovalService
from .errors import ConflictError, NotFoundError, PermissionDenied, ValidationError
from .idempotency import idempotent
from .identifiers import new_id
from .inbox import Inbox
from .jobs import JobQueue
from .jsonutil import canonical_json
from .outbox import Outbox
from .repository import EntityRepository
from .reservations import ReservationBook
from .security import AccessContext, assert_distinct
from .timeutil import parse_instant
from .tours import BOOKING_TYPE, BATCH_TYPE, TourService, require_minor


RECOVERY_TYPE = "tour_recoveries"
OPTION_TYPE = "tour_options"
SETTLEMENT_TYPE = "tour_settlements"

EVENT_KINDS = ("supplier_exit", "capacity_reduction", "destination_risk", "flight_change")
RECOVERY_STATES = ("open", "options_proposed", "in_settlement", "settled", "closed")
OPTION_STATES = ("proposed", "accepted", "rejected", "expired", "applied")
SETTLEMENT_STATES = ("draft", "pending_approval", "approved", "posted", "rejected")

FULFILLMENT_BOOKED = "booked"
FULFILLMENT_USED = "used"
FULFILLMENT_INTERRUPTED = "interrupted"
FULFILLMENT_REPLACED = "replaced"
FULFILLMENT_REFUNDED = "refunded"

# 代金（补偿）合计达到该金额需要另一人复核（最小货币单位，1000.00 元）。
HIGH_COMPENSATION_MINOR = 100000
OPTION_CONFIRM_HOURS = 48
RECONCILE_AFTER_HOURS = 24

TERMINAL_STATUS = {
    "cancelled": {"operating", "on_time"},
    "operating": {"cancelled"},
    "on_time": {"rescheduled"},
    "rescheduled": {"on_time", "operating"},
}


def _minutes(a: str, b: str) -> int:
    return int((parse_instant(a) - parse_instant(b)).total_seconds() // 60)


@dataclass(frozen=True)
class RecoveryService:
    repository: EntityRepository
    reservations: ReservationBook
    approvals: ApprovalService
    outbox: Outbox
    inbox: Inbox
    jobs: JobQueue

    # ----- 中断事件：只处理尚未履行的环节 -----

    @idempotent("tour:open_recovery")
    def open_recovery(self, context: AccessContext, values: Mapping[str, object], *, request_key: str) -> dict:
        context.require("write:tour_recoveries")
        booking = self._booking(values.get("booking_id"))
        kind = str(values.get("kind", ""))
        if kind not in EVENT_KINDS:
            raise ValidationError("中断类型必须是 " + "/".join(EVENT_KINDS))
        reason = str(values.get("reason", "")).strip()
        if not reason:
            raise ValidationError("必须说明中断原因")
        affected_ids = [str(item) for item in values.get("affected_services", [])]
        if not affected_ids:
            raise ValidationError("至少要指明一个被影响的服务")
        services = {item["service_id"]: item for item in booking["services"]}
        missing = [sid for sid in affected_ids if sid not in services]
        if missing:
            raise ValidationError("服务不在购买版本中: " + ", ".join(missing))
        with self.repository.database.connect() as connection:
            for sid in affected_ids:
                status = self._fulfillment_status(connection, booking["entity_id"], sid)
                if status == FULFILLMENT_USED:
                    raise ConflictError(f"{sid} 已经使用，保留原责任，不能纳入恢复")
                if status in (FULFILLMENT_INTERRUPTED, FULFILLMENT_REPLACED, FULFILLMENT_REFUNDED):
                    raise ConflictError(f"{sid} 已在其它恢复单中处理")
        payload = {
            "state": RECOVERY_STATES[0],
            "booking_id": booking["entity_id"], "batch_id": booking["batch_id"], "kind": kind,
            "reason": reason, "occurred_at": self.repository.clock.now(),
            "reported_by": str(values.get("reported_by", context.actor_id)),
            "affected_services": [self._service_brief(services[sid]) for sid in affected_ids],
            "currency": booking["currency"],
        }
        recovery = self.repository.create(RECOVERY_TYPE, payload, actor=context.actor_id, request_key=request_key)
        self._mark_interrupted(booking["entity_id"], affected_ids, reason, context.actor_id)
        return recovery

    def mark_service_used(self, context: AccessContext, booking_id: str, service_id: str) -> dict:
        """地接回执确认服务已实际使用；之后任何恢复都不得改动该环节。"""
        context.require("write:tour_recoveries")
        self._booking(booking_id)
        with self.repository.database.transaction() as connection:
            row = connection.execute("SELECT * FROM tour_fulfillment WHERE booking_id=? AND service_id=?", (booking_id, service_id)).fetchone()
            if not row:
                raise NotFoundError("履行记录不存在")
            if row["status"] == FULFILLMENT_USED:
                return {"status": FULFILLMENT_USED, "replayed": True}
            if row["status"] != FULFILLMENT_BOOKED:
                raise ConflictError(f"服务当前为 {row['status']}，不能登记为已使用")
            connection.execute(
                "UPDATE tour_fulfillment SET status=?,consumed_at=?,reason=?,updated_at=?,updated_by=?,version=version+1 WHERE booking_id=? AND service_id=?",
                (FULFILLMENT_USED, self.repository.clock.now(), "服务已实际使用，保留原责任", self.repository.clock.now(), context.actor_id, booking_id, service_id),
            )
        return {"status": FULFILLMENT_USED}

    # ----- 替代方案：时间 / 价值 / 无障碍比较 -----

    @idempotent("tour:propose_option")
    def propose_option(self, context: AccessContext, recovery_id: str, values: Mapping[str, object], *, request_key: str) -> dict:
        context.require("write:tour_options")
        recovery = self.repository.get(RECOVERY_TYPE, recovery_id)
        if recovery["state"] not in ("open", "options_proposed"):
            raise ConflictError("当前恢复状态不能提出替代方案")
        booking = self._booking(recovery["booking_id"])
        raw_items = values.get("items")
        if not isinstance(raw_items, list) or not raw_items:
            raise ValidationError("替代方案必须包含逐项安排")
        affected = {item["service_id"]: item for item in recovery["affected_services"]}
        items = [self._build_option_item(booking, affected, raw) for raw in raw_items]
        covered = {item["service_id"] for item in items}
        if covered != set(affected):
            raise ValidationError("替代方案必须覆盖全部被影响服务，多余或遗漏都不允许")
        expires_at = (parse_instant(self.repository.clock.now()) + timedelta(hours=OPTION_CONFIRM_HOURS)).isoformat().replace("+00:00", "Z")
        payload = {
            "state": OPTION_STATES[0], "recovery_id": recovery_id, "booking_id": booking["entity_id"],
            "currency": booking["currency"], "expires_at": expires_at, "items": items,
            "totals": self._sum_effects(items),
        }
        option = self.repository.create(OPTION_TYPE, payload, actor=context.actor_id, request_key=request_key)
        self.repository.update(RECOVERY_TYPE, recovery_id, {"state": "options_proposed", "active_option_id": option["entity_id"]}, actor=context.actor_id, expected_version=recovery["version"], request_key=request_key + "-recovery")
        self.outbox.enqueue(topic="tour.option_proposed", aggregate_id=booking["entity_id"], payload={"recovery_id": recovery_id, "option_id": option["entity_id"], "expires_at": expires_at}, dedupe_key=f"option_proposed:{option['entity_id']}")
        self._schedule_once("tour.option_expiry", option["entity_id"], expires_at, {"option_id": option["entity_id"], "booking_id": booking["entity_id"]})
        return option

    @idempotent("tour:respond_option")
    def respond_option(self, context: AccessContext, option_id: str, *, decision: str, request_key: str, expected_version: int) -> dict:
        """游客接受或拒绝替代方案；只有游客本人可以表态。"""
        option = self.repository.get(OPTION_TYPE, option_id)
        booking = self._booking(option["booking_id"])
        if booking["tourist"].get("actor") and context.actor_id != booking["tourist"]["actor"]:
            raise PermissionDenied("只有游客本人可以确认替代方案")
        if option["state"] != OPTION_STATES[0]:
            raise ConflictError(f"方案当前为 {option['state']}，不能再表态")
        if parse_instant(option["expires_at"]) <= parse_instant(self.repository.clock.now()):
            raise ConflictError("方案已过确认期限")
        if decision not in ("accepted", "rejected"):
            raise ValidationError("decision 必须是 accepted 或 rejected")
        updated = self.repository.update(OPTION_TYPE, option_id, {"state": decision, "decided_by": context.actor_id, "decided_at": self.repository.clock.now()}, actor=context.actor_id, expected_version=expected_version, request_key=request_key)
        recovery = self.repository.get(RECOVERY_TYPE, option["recovery_id"])
        if decision == "accepted":
            self.repository.update(RECOVERY_TYPE, recovery["entity_id"], {"state": "in_settlement"}, actor=context.actor_id, expected_version=recovery["version"], request_key=request_key + "-recovery")
        self.outbox.enqueue(topic=f"tour.option_{decision}", aggregate_id=booking["entity_id"], payload={"option_id": option_id, "recovery_id": recovery["entity_id"]}, dedupe_key=f"option_decision:{option_id}:{decision}")
        return updated

    @idempotent("tour:apply_option")
    def apply_option(self, context: AccessContext, option_id: str, *, request_key: str) -> dict:
        """游客接受后落实替代：占用新容量、释放尚未履行环节的旧容量。"""
        context.require("write:tour_options")
        option = self.repository.get(OPTION_TYPE, option_id)
        if option["state"] != "accepted":
            raise ConflictError("只有已接受的方案可以落实")
        booking = self._booking(option["booking_id"])
        frozen = {item["service_id"]: item for item in booking["services"]}
        now = self.repository.clock.now()
        new_reservations: list[str] = []
        try:
            for item in option["items"]:
                replacement = item.get("replacement")
                if replacement is None:
                    continue
                row = self.reservations.reserve(
                    resource_id=replacement["resource_id"], subject_id=booking["entity_id"], quantity=1,
                    capacity=int(replacement["capacity"]), start_at=replacement["start_at"], end_at=replacement["end_at"], actor=context.actor_id,
                )
                new_reservations.append(row["reservation_id"])
                replacement["reservation_id"] = row["reservation_id"]
        except Exception:
            for rid in new_reservations:
                self.reservations.release(rid, expected_version=1)
            raise
        with self.repository.database.transaction() as connection:
            for item in option["items"]:
                old = frozen[item["service_id"]]
                if old.get("reservation_id"):
                    held = connection.execute("SELECT version FROM resource_reservations WHERE reservation_id=? AND status IN ('held','confirmed')", (old["reservation_id"],)).fetchone()
                    if held:
                        connection.execute("UPDATE resource_reservations SET status='released',version=version+1 WHERE reservation_id=?", (old["reservation_id"],))
                target = FULFILLMENT_REFUNDED if item.get("replacement") is None else FULFILLMENT_REPLACED
                connection.execute(
                    "UPDATE tour_fulfillment SET status=?,replaced_by_option_id=?,updated_at=?,updated_by=?,version=version+1 WHERE booking_id=? AND service_id=? AND status=?",
                    (target, option_id, now, context.actor_id, booking["entity_id"], item["service_id"], FULFILLMENT_INTERRUPTED),
                )
        return self.repository.update(OPTION_TYPE, option_id, {"state": "applied", "items": option["items"]}, actor=context.actor_id, expected_version=option["version"], request_key=request_key)

    # ----- 补差 / 退款 / 代金结算与四眼审核 -----

    @idempotent("tour:create_settlement")
    def create_settlement(self, context: AccessContext, recovery_id: str, *, request_key: str) -> dict:
        context.require("write:tour_settlements")
        recovery = self.repository.get(RECOVERY_TYPE, recovery_id)
        if recovery["state"] != "in_settlement":
            raise ConflictError("只有游客接受方案并进入结算阶段后才能建账")
        option = self.repository.get(OPTION_TYPE, recovery["active_option_id"])
        if option["state"] != "applied":
            raise ConflictError("替代方案落实后才能结算")
        items = []
        for item in option["items"]:
            original = item["original"]
            effects = item["effects"]
            items.append({
                "service_id": item["service_id"], "title": item["title"],
                "responsible_party": self._responsible(recovery["kind"], recovery["booking_id"], item["service_id"]),
                "affected_value_minor": original["price_minor"],
                "replacement_value_minor": (item["replacement"]["price_minor"] if item.get("replacement") else 0),
                "refund_minor": effects["refund_minor"], "surcharge_minor": effects["surcharge_minor"],
                "voucher_minor": effects["voucher_minor"], "reason": effects.get("reason", ""),
            })
        totals = self._sum_effects(option["items"])
        payload = {"state": SETTLEMENT_STATES[0], "recovery_id": recovery_id, "booking_id": recovery["booking_id"],
                   "currency": option["currency"], "items": items, "totals": totals,
                   "needs_review": totals["voucher_minor"] >= HIGH_COMPENSATION_MINOR}
        settlement = self.repository.create(SETTLEMENT_TYPE, payload, actor=context.actor_id, request_key=request_key)
        self._persist_items(settlement["entity_id"], recovery_id, recovery["booking_id"], items)
        return settlement

    @idempotent("tour:submit_settlement")
    def submit_settlement(self, context: AccessContext, settlement_id: str, *, request_key: str, expected_version: int) -> dict:
        context.require("write:tour_settlements")
        settlement = self.repository.get(SETTLEMENT_TYPE, settlement_id)
        if settlement["state"] != "draft":
            raise ConflictError("只有草稿结算可以提交")
        approval_id = ""
        if settlement["needs_review"]:
            approval = self.approvals.create(context, {"case_id": settlement["recovery_id"], "step": "高额补偿复核", "reviewer": "unassigned", "decision": "pending", "reason": f"代金补偿合计 {settlement['totals']['voucher_minor']}，等待第二人确认"}, request_key=request_key + "-approval")
            approval_id = approval["entity_id"]
        updated = self.repository.update(SETTLEMENT_TYPE, settlement_id, {"state": "pending_approval", "submitted_by": context.actor_id, "approval_id": approval_id}, actor=context.actor_id, expected_version=expected_version, request_key=request_key)
        self._schedule_once("tour.settlement_reconcile", settlement_id, self._hours_from_now(RECONCILE_AFTER_HOURS), {"settlement_id": settlement_id})
        return updated

    @idempotent("tour:review_settlement")
    def review_settlement(self, context: AccessContext, settlement_id: str, *, decision: str, reason: str, request_key: str, expected_version: int) -> dict:
        """另一名审核人员确认或驳回高额补偿；提交者不能审核自己的结算。"""
        context.require("review:tour_settlements")
        settlement = self.repository.get(SETTLEMENT_TYPE, settlement_id)
        if settlement["state"] != "pending_approval":
            raise ConflictError("结算不在待审核状态")
        assert_distinct(context.actor_id, settlement.get("submitted_by", ""))
        if decision not in ("approved", "rejected") or not reason.strip():
            raise ValidationError("必须给出 approved/rejected 决定与理由")
        if not settlement["needs_review"]:
            raise ValidationError("该结算无需第二人复核")
        approval = self.repository.get("approvals", settlement["approval_id"])
        # 内部审批记录随四眼复核一并更新，不再要求复核人持有审批写权限。
        self.repository.update("approvals", settlement["approval_id"], {"reviewer": context.actor_id, "decision": decision, "reason": reason.strip()}, actor=context.actor_id, expected_version=approval["version"], request_key=request_key + "-revise")
        self.repository.update("approvals", settlement["approval_id"], {"state": "approved", "transition_reason": f"复核{decision}: {reason.strip()}"}, actor=context.actor_id, expected_version=approval["version"] + 1, request_key=request_key + "-approve")
        if decision == "rejected":
            self.repository.update("approvals", settlement["approval_id"], {"state": "rejected", "transition_reason": reason.strip()}, actor=context.actor_id, expected_version=approval["version"] + 2, request_key=request_key + "-reject")
        target = "posted" if decision == "approved" else "rejected"
        updated = self.repository.update(SETTLEMENT_TYPE, settlement_id, {"state": target, "reviewed_by": context.actor_id, "review_reason": reason.strip()}, actor=context.actor_id, expected_version=expected_version, request_key=request_key)
        if decision == "approved":
            self._post_entries(settlement_id, actor=context.actor_id)
            self._mark_settled(settlement_id, actor=context.actor_id)
        else:
            self.outbox.enqueue(topic="tour.settlement_rejected", aggregate_id=settlement["booking_id"], payload={"settlement_id": settlement_id, "reason": reason.strip()}, dedupe_key=f"settlement_rejected:{settlement_id}")
        return updated

    @idempotent("tour:post_settlement")
    def post_settlement(self, context: AccessContext, settlement_id: str, *, request_key: str) -> dict:
        """未达高额补偿门槛的结算，提交后直接过账。"""
        context.require("write:tour_settlements")
        settlement = self.repository.get(SETTLEMENT_TYPE, settlement_id)
        if settlement["state"] != "pending_approval":
            raise ConflictError("结算不在待过账状态")
        if settlement["needs_review"]:
            raise ConflictError("高额补偿必须等待第二人复核")
        updated = self.repository.update(SETTLEMENT_TYPE, settlement_id, {"state": "posted", "posted_by": context.actor_id}, actor=context.actor_id, expected_version=settlement["version"], request_key=request_key)
        self._post_entries(settlement_id, actor=context.actor_id)
        self._mark_settled(settlement_id, actor=context.actor_id)
        return updated

    @idempotent("tour:close_recovery")
    def close_recovery(self, context: AccessContext, recovery_id: str, *, expected_version: int, request_key: str) -> dict:
        context.require("write:tour_recoveries")
        recovery = self.repository.get(RECOVERY_TYPE, recovery_id)
        if recovery["state"] != "settled":
            raise ConflictError("只有已结清的恢复单可以关闭")
        return self.repository.update(RECOVERY_TYPE, recovery_id, {"state": "closed", "closed_at": self.repository.clock.now()}, actor=context.actor_id, expected_version=expected_version, request_key=request_key)

    def reconcile_settlement(self, context: AccessContext, settlement_id: str) -> dict:
        """按不可变分录核对每个被影响项目的补差、退款与代金是否账实相符。"""
        context.require("read:tour_settlements")
        settlement = self.repository.get(SETTLEMENT_TYPE, settlement_id)
        with self.repository.database.connect() as connection:
            rows = connection.execute("SELECT * FROM tour_settlement_items WHERE settlement_id=?", (settlement_id,)).fetchall()
        checked = []
        balanced = True
        for row in rows:
            entry_ids = json.loads(row["entry_ids_json"])
            posted = {"refund": 0, "surcharge": 0, "voucher": 0}
            with self.repository.database.connect() as connection:
                for entry_id in entry_ids:
                    entry = connection.execute("SELECT amount_minor,direction,account FROM journal_entries WHERE entry_id=?", (entry_id,)).fetchone()
                    bucket = "voucher" if entry["account"] == "voucher_payable" else ("refund" if entry["account"] == "refund_payable" else "surcharge")
                    sign = 1 if entry["direction"] == ("credit" if bucket != "surcharge" else "debit") else -1
                    posted[bucket] += sign * int(entry["amount_minor"])
            item_ok = posted["refund"] == row["refund_minor"] and posted["surcharge"] == row["surcharge_minor"] and posted["voucher"] == row["voucher_minor"]
            value_ok = row["refund_minor"] - row["surcharge_minor"] == row["affected_value_minor"] - row["replacement_value_minor"]
            balanced = balanced and item_ok and value_ok
            checked.append({"service_id": row["service_id"], "posted": posted, "item_ok": item_ok, "value_ok": value_ok})
        return {"settlement_id": settlement_id, "state": settlement["state"], "balanced": balanced, "items": checked}

    # ----- 供应商状态回执：重复不二次退款，矛盾先挂起 -----

    def receive_status_receipt(self, *, source: str, source_key: str, sequence: int, reported_status: str, payload: Mapping[str, object], occurred_at: str) -> dict:
        accepted = self.inbox.receive(source=source, source_key=source_key, sequence=sequence, payload={"reported_status": reported_status, **dict(payload)}, occurred_at=occurred_at)
        if accepted["status"] == "duplicate":
            # 同一回执重放：只确认，不允许触发任何新的退款或替代动作。
            return {"status": "duplicate", "effect": "ignored"}
        with self.repository.database.connect() as connection:
            prior = connection.execute(
                "SELECT reported_status FROM tour_receipts WHERE source=? AND source_key=? AND status='applied' ORDER BY rowid DESC LIMIT 1",
                (source, source_key),
            ).fetchone()
        contradictory = prior is not None and reported_status in TERMINAL_STATUS.get(prior["reported_status"], set())
        # 矛盾消息先持久化为挂起记录，再交由人工核对，不能随异常回滚丢失。
        with self.repository.database.transaction() as connection:
            connection.execute(
                "INSERT INTO tour_receipts(receipt_key,source,source_key,sequence,reported_status,status,detail_json,received_at) VALUES(?,?,?,?,?,?,?,?)",
                (f"{source}:{source_key}:{sequence}", source, source_key, sequence, reported_status, "held_contradiction" if contradictory else "applied", canonical_json({"reported_status": reported_status, **dict(payload)}), self.repository.clock.now()),
            )
        if contradictory:
            raise ConflictError(f"与 {prior['reported_status']} 状态矛盾，消息挂起等待核对")
        return {"status": "applied"}

    def held_receipts(self, context: AccessContext) -> list[dict]:
        context.require("review:tour_recoveries")
        with self.repository.database.connect() as connection:
            return [dict(row) for row in connection.execute("SELECT * FROM tour_receipts WHERE status='held_contradiction' ORDER BY received_at")]

    # ----- 视图 -----

    def tourist_view(self, context: AccessContext, booking_id: str) -> dict:
        """游客看到行程为何改变，以及权益如何逐项计算。"""
        booking = self._booking(booking_id)
        if not context.allows("*") and booking["tourist"].get("actor") != context.actor_id:
            raise PermissionDenied("只能查看自己的订单")
        with self.repository.database.connect() as connection:
            statuses = {row["service_id"]: dict(row) for row in connection.execute("SELECT service_id,status,reason,replaced_by_option_id,settlement_id FROM tour_fulfillment WHERE booking_id=?", (booking_id,))}
        recoveries = self.repository.search(RECOVERY_TYPE, "booking_id", booking_id, limit=100)
        options = self.repository.search(OPTION_TYPE, "booking_id", booking_id, limit=100)
        settlements = self.repository.search(SETTLEMENT_TYPE, "booking_id", booking_id, limit=100)
        return {
            "booking_id": booking_id, "frozen_version": booking["batch_version"], "currency": booking["currency"],
            "itinerary": [{"day": s["day"], "service_id": s["service_id"], "kind": s["kind"], "title": s["title"], "time": {"start_at": s["start_at"], "end_at": s["end_at"]}, "price_minor": s["price_minor"], "accessibility": s["accessibility"], "fulfillment": statuses.get(s["service_id"], {}).get("status", FULFILLMENT_BOOKED)} for s in booking["services"]],
            "changes": [{"recovery_id": r["entity_id"], "kind": r["kind"], "reason": r["reason"], "affected_services": r["affected_services"], "state": r["state"]} for r in recoveries],
            "options": [{"option_id": o["entity_id"], "state": o["state"], "expires_at": o["expires_at"], "items": [self._tourist_item(item) for item in o["items"]], "totals": o["totals"]} for o in options],
            "entitlements": [{"settlement_id": s["entity_id"], "state": s["state"], "totals": s["totals"], "items": [{"service_id": i["service_id"], "title": i["title"], "affected_value_minor": i["affected_value_minor"], "replacement_value_minor": i["replacement_value_minor"], "refund_minor": i["refund_minor"], "surcharge_minor": i["surcharge_minor"], "voucher_minor": i["voucher_minor"], "reason": i["reason"]} for i in s["items"]]} for s in settlements],
        }

    def supplier_view(self, context: AccessContext, supplier_id: str) -> list[dict]:
        """供应商只看本方任务，看不到游客信息与其它供应商安排。"""
        context.require("read:tour_supplier_tasks")
        tasks = []
        for booking in self.repository.list(BOOKING_TYPE, state="confirmed", limit=500):
            with self.repository.database.connect() as connection:
                statuses = {row["service_id"]: row["status"] for row in connection.execute("SELECT service_id,status FROM tour_fulfillment WHERE booking_id=?", (booking["entity_id"],))}
            for service in booking["services"]:
                if service["supplier_id"] != supplier_id:
                    continue
                tasks.append({"booking_id": booking["entity_id"], "service_id": service["service_id"], "kind": service["kind"], "day": service["day"], "title": service["title"], "start_at": service["start_at"], "end_at": service["end_at"], "required_accessibility": service["accessibility"], "status": statuses.get(service["service_id"], FULFILLMENT_BOOKED)})
        # 已落实替代方案中的新安排同样只向中选供应商开放。
        for option in self.repository.list(OPTION_TYPE, state="applied", limit=500):
            for item in option["items"]:
                replacement = item.get("replacement")
                if replacement is None or replacement["supplier_id"] != supplier_id:
                    continue
                tasks.append({"booking_id": option["booking_id"], "service_id": f"replacement:{item['service_id']}", "kind": replacement["kind"], "title": replacement["title"], "start_at": replacement["start_at"], "end_at": replacement["end_at"], "required_accessibility": replacement["accessibility"], "status": "assigned"})
        return tasks

    def operator_queue(self, context: AccessContext, *, batch_id: str | None = None) -> list[dict]:
        """运营据此确定下一责任方，而不是重新拼接多家供应商的聊天记录。"""
        context.require("read:tour_recoveries")
        queue = []
        for recovery in self.repository.list(RECOVERY_TYPE, limit=500):
            if batch_id and recovery["batch_id"] != batch_id:
                continue
            next_party, next_action = self._next_step(recovery)
            queue.append({"recovery_id": recovery["entity_id"], "batch_id": recovery["batch_id"], "booking_id": recovery["booking_id"], "kind": recovery["kind"], "state": recovery["state"], "next_responsible_party": next_party, "next_action": next_action})
        return queue

    # ----- 定时任务处理（应用重启后由持久化队列自动续接） -----

    def schedule_departure_reminders(self, context: AccessContext, batch_id: str) -> list[str]:
        context.require("write:tour_batches")
        batch = self.repository.get(BATCH_TYPE, batch_id)
        tour_service = TourService(self.repository, self.reservations)
        run_at = tour_service.departure_reminder_at(batch)
        ids = []
        for booking in self.repository.search(BOOKING_TYPE, "batch_id", batch_id, limit=500):
            if booking["state"] != "confirmed":
                continue
            ids.append(self._schedule_once("tour.departure_reminder", booking["entity_id"], run_at, {"booking_id": booking["entity_id"], "departure_at": batch["departure_at"]}))
        return ids

    def process_due_jobs(self, *, limit: int = 20) -> list[dict]:
        results = []
        for job in self.jobs.claim_due(limit=limit):
            outcome = self._handle_job(job)
            self.jobs.finish(job["job_id"])
            results.append({"job_id": job["job_id"], "job_type": job["job_type"], "outcome": outcome})
        return results

    def _handle_job(self, job: Mapping[str, object]) -> str:
        payload = json.loads(job["payload_json"])
        kind = job["job_type"]
        if kind == "tour.departure_reminder":
            self.outbox.enqueue(topic="tour.departure_reminder", aggregate_id=payload["booking_id"], payload=payload, dedupe_key=f"departure_reminder:{payload['booking_id']}")
            return "reminder_sent"
        if kind == "tour.option_expiry":
            option = self.repository.get(OPTION_TYPE, payload["option_id"])
            if option["state"] == OPTION_STATES[0] and parse_instant(option["expires_at"]) <= parse_instant(self.repository.clock.now()):
                self.repository.update(OPTION_TYPE, option["entity_id"], {"state": "expired"}, actor="system", expected_version=option["version"], request_key=f"expire:{option['entity_id']}")
                self.outbox.enqueue(topic="tour.option_expired", aggregate_id=option["booking_id"], payload={"option_id": option["entity_id"]}, dedupe_key=f"option_expired:{option['entity_id']}")
                return "option_expired"
            return "already_decided"
        if kind == "tour.settlement_reconcile":
            report = self.reconcile_settlement(AccessContext.system("system"), payload["settlement_id"])
            if not report["balanced"] and report["state"] != "posted":
                self.outbox.enqueue(topic="tour.settlement_unbalanced", aggregate_id=payload["settlement_id"], payload=report)
                return "unbalanced_alert"
            return "balanced"
        return "unknown_job"

    # ----- 内部辅助 -----

    def _build_option_item(self, booking: dict, affected: dict, raw: object) -> dict:
        if not isinstance(raw, Mapping) or "service_id" not in raw:
            raise ValidationError("替代项必须指明 service_id")
        sid = str(raw["service_id"])
        if sid not in affected:
            raise ValidationError(f"{sid} 不在本次被影响范围内")
        original = next(s for s in booking["services"] if s["service_id"] == sid)
        if not original["substitution"]["allowed"] and raw.get("replacement") is not None:
            raise ValidationError(f"{sid} 合同约定不允许替代，只能取消并退款")
        replacement = None
        if raw.get("replacement") is not None:
            replacement = self._validate_replacement(original, raw["replacement"])
        effects = self._validate_effects(original, replacement, raw.get("effects", {}))
        comparison = self._compare(booking, original, replacement)
        if replacement is not None and not comparison["accessibility"]["meets_requirement"]:
            raise ValidationError(f"{sid} 的替代缺少无障碍条件: {', '.join(comparison['accessibility']['missing'])}；如无达标方案只能取消并退款")
        return {
            "service_id": sid, "kind": original["kind"], "title": original["title"],
            "original": self._service_brief(original),
            "replacement": replacement,
            "comparison": comparison,
            "effects": effects,
        }

    @staticmethod
    def _validate_replacement(original: dict, raw: object) -> dict:
        if not isinstance(raw, Mapping):
            raise ValidationError("替代安排必须是对象")
        for key in ("kind", "title", "supplier_id", "resource_id", "start_at", "end_at", "price_minor", "capacity", "accessibility"):
            if key not in raw:
                raise ValidationError(f"替代安排缺少 {key}")
        allowed_kinds = original["substitution"].get("allowed_kinds", [])
        if allowed_kinds and str(raw["kind"]) not in allowed_kinds:
            raise ValidationError(f"{original['service_id']} 只允许替代为 {','.join(allowed_kinds)}")
        accessibility = [str(item) for item in raw["accessibility"]]
        from .timeutil import canonical_instant
        result = {"kind": str(raw["kind"]), "title": str(raw["title"]), "supplier_id": str(raw["supplier_id"]), "resource_id": str(raw["resource_id"]), "start_at": canonical_instant(raw["start_at"]), "end_at": canonical_instant(raw["end_at"]), "price_minor": require_minor(raw["price_minor"], "替代服务价格"), "capacity": int(raw["capacity"]), "accessibility": accessibility, "heritage": bool(raw.get("heritage", False))}
        if parse_instant(result["start_at"]) >= parse_instant(result["end_at"]):
            raise ValidationError("替代安排结束时间必须晚于开始时间")
        if result["capacity"] <= 0:
            raise ValidationError("替代容量必须为正数")
        return result

    def _compare(self, booking: dict, original: dict, replacement: dict | None) -> dict:
        required = set()
        for need in booking.get("special_needs", []):
            if original["service_id"] in need.get("services", []):
                required.update(need.get("accessibility", []))
        required.update(feature for feature in original["accessibility"] if original["substitution"].get("same_accessibility_required", True))
        if replacement is None:
            return {"time": None, "value": {"original_minor": original["price_minor"], "replacement_minor": 0, "difference_minor": original["price_minor"]}, "accessibility": {"required": sorted(required), "provided": [], "missing": sorted(required), "meets_requirement": not required}, "heritage_preserved": False, "cancelled": True}
        time_cmp = {"start_shift_minutes": _minutes(replacement["start_at"], original["start_at"]), "end_shift_minutes": _minutes(replacement["end_at"], original["end_at"]), "same_day": replacement["start_at"][:10] == original["start_at"][:10]}
        provided = set(replacement["accessibility"])
        return {"time": time_cmp, "value": {"original_minor": original["price_minor"], "replacement_minor": replacement["price_minor"], "difference_minor": original["price_minor"] - replacement["price_minor"]}, "accessibility": {"required": sorted(required), "provided": replacement["accessibility"], "missing": sorted(required - provided), "meets_requirement": required <= provided}, "heritage_preserved": original.get("heritage", False) == replacement.get("heritage", False) or not original.get("heritage", False)}

    @staticmethod
    def _validate_effects(original: dict, replacement: dict | None, raw: object) -> dict:
        if not isinstance(raw, Mapping):
            raise ValidationError("权益 effects 必须是对象")
        refund = require_minor(raw.get("refund_minor", 0), "退款金额", allow_zero=True)
        surcharge = require_minor(raw.get("surcharge_minor", 0), "补差金额", allow_zero=True)
        voucher = require_minor(raw.get("voucher_minor", 0), "代金金额", allow_zero=True)
        if min(refund, surcharge, voucher) < 0:
            raise ValidationError("补差、退款与代金金额不能为负")
        replacement_value = replacement["price_minor"] if replacement else 0
        if refund - surcharge != original["price_minor"] - replacement_value:
            raise ValidationError(f"{original['service_id']} 退款减补差 {refund - surcharge} 必须等于被影响项目价值差 {original['price_minor'] - replacement_value}")
        reason = str(raw.get("reason", "")).strip()
        if voucher > 0 and not reason:
            raise ValidationError(f"{original['service_id']} 代金补偿必须说明原因")
        return {"refund_minor": refund, "surcharge_minor": surcharge, "voucher_minor": voucher, "reason": reason}

    @staticmethod
    def _sum_effects(items: list[dict]) -> dict:
        return {"refund_minor": sum(i["effects"]["refund_minor"] for i in items), "surcharge_minor": sum(i["effects"]["surcharge_minor"] for i in items), "voucher_minor": sum(i["effects"]["voucher_minor"] for i in items)}

    def _responsible(self, kind: str, booking_id: str, service_id: str) -> str:
        service = next(s for s in self._booking(booking_id)["services"] if s["service_id"] == service_id)
        if kind == "flight_change":
            return service["supplier_id"] if service["kind"] == "flight" else "org:operator"
        if kind in ("supplier_exit", "capacity_reduction"):
            return service["supplier_id"]
        return "org:operator"

    @staticmethod
    def _service_brief(service: dict) -> dict:
        return {"service_id": service["service_id"], "kind": service["kind"], "day": service["day"], "title": service["title"], "supplier_id": service["supplier_id"], "start_at": service["start_at"], "end_at": service["end_at"], "price_minor": service["price_minor"], "accessibility": service["accessibility"], "heritage": service.get("heritage", False)}

    @staticmethod
    def _tourist_item(item: dict) -> dict:
        return {"service_id": item["service_id"], "title": item["title"], "replacement": None if item.get("replacement") is None else {k: item["replacement"][k] for k in ("kind", "title", "start_at", "end_at", "price_minor", "accessibility", "heritage")}, "comparison": item["comparison"], "effects": item["effects"]}

    def _booking(self, booking_id: object) -> dict:
        if not isinstance(booking_id, str):
            raise ValidationError("缺少 booking_id")
        booking = self.repository.get(BOOKING_TYPE, booking_id)
        if booking["state"] not in ("confirmed", "completed"):
            raise ConflictError("订单尚未确认冻结，不能进入恢复流程")
        return booking

    @staticmethod
    def _fulfillment_status(connection, booking_id: str, service_id: str) -> str:
        row = connection.execute("SELECT status FROM tour_fulfillment WHERE booking_id=? AND service_id=?", (booking_id, service_id)).fetchone()
        if not row:
            raise NotFoundError(f"履行记录 {service_id} 不存在")
        return row["status"]

    def _mark_interrupted(self, booking_id: str, service_ids: list[str], reason: str, actor: str) -> None:
        now = self.repository.clock.now()
        with self.repository.database.transaction() as connection:
            for sid in service_ids:
                connection.execute(
                    "UPDATE tour_fulfillment SET status=?,reason=?,updated_at=?,updated_by=?,version=version+1 WHERE booking_id=? AND service_id=? AND status=?",
                    (FULFILLMENT_INTERRUPTED, reason, now, actor, booking_id, sid, FULFILLMENT_BOOKED),
                )

    def _persist_items(self, settlement_id: str, recovery_id: str, booking_id: str, items: list[dict]) -> None:
        with self.repository.database.transaction() as connection:
            for item in items:
                connection.execute(
                    "INSERT INTO tour_settlement_items(settlement_id,recovery_id,booking_id,service_id,responsible_party,affected_value_minor,replacement_value_minor,refund_minor,surcharge_minor,voucher_minor,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (settlement_id, recovery_id, booking_id, item["service_id"], item["responsible_party"], item["affected_value_minor"], item["replacement_value_minor"], item["refund_minor"], item["surcharge_minor"], item["voucher_minor"], item["reason"]),
                )

    def _post_entries(self, settlement_id: str, *, actor: str) -> None:
        """补差/退款/代金按被影响项目逐笔登记到不可变分录；引用号保证不重复过账。"""
        settlement = self.repository.get(SETTLEMENT_TYPE, settlement_id)
        journal_key = f"tour:{settlement['booking_id']}"
        posted: dict[str, list[str]] = {}
        accounts = (("refund_minor", "refund_payable", "credit"), ("surcharge_minor", "upgrade_charge", "debit"), ("voucher_minor", "voucher_payable", "credit"))
        with self.repository.database.transaction() as connection:
            for item in settlement["items"]:
                ids: list[str] = []
                for field_name, account, direction in accounts:
                    amount = int(item[field_name])
                    if amount <= 0:
                        continue
                    reference = f"{settlement_id}:{item['service_id']}:{field_name.removesuffix('_minor')}"
                    duplicate = connection.execute("SELECT entry_id FROM journal_entries WHERE journal_key=? AND reference=? AND direction=?", (journal_key, reference, direction)).fetchone()
                    if duplicate:
                        ids.append(str(duplicate["entry_id"]))
                        continue
                    entry_id = new_id("entry")
                    connection.execute("INSERT INTO journal_entries(entry_id,journal_key,account,currency,amount_minor,direction,reference,occurred_at,posted_by) VALUES(?,?,?,?,?,?,?,?,?)", (entry_id, journal_key, account, settlement["currency"], amount, direction, reference, self.repository.clock.now(), actor))
                    ids.append(entry_id)
                posted[item["service_id"]] = ids
        with self.repository.database.transaction() as connection:
            for service_id, ids in posted.items():
                connection.execute("UPDATE tour_settlement_items SET entry_ids_json=? WHERE settlement_id=? AND service_id=?", (canonical_json(ids), settlement_id, service_id))
                connection.execute("UPDATE tour_fulfillment SET settlement_id=?,updated_at=?,updated_by=?,version=version+1 WHERE booking_id=? AND service_id=? AND settlement_id IS NULL", (settlement_id, self.repository.clock.now(), actor, settlement["booking_id"], service_id))
        self.outbox.enqueue(topic="tour.settlement_posted", aggregate_id=settlement["booking_id"], payload={"settlement_id": settlement_id, "totals": settlement["totals"], "items": [{"service_id": i["service_id"], "refund_minor": i["refund_minor"], "surcharge_minor": i["surcharge_minor"], "voucher_minor": i["voucher_minor"], "responsible_party": i["responsible_party"]} for i in settlement["items"]]}, dedupe_key=f"settlement_posted:{settlement_id}")

    def _mark_settled(self, settlement_id: str, *, actor: str) -> None:
        settlement = self.repository.get(SETTLEMENT_TYPE, settlement_id)
        recovery = self.repository.get(RECOVERY_TYPE, settlement["recovery_id"])
        if recovery["state"] == "in_settlement":
            self.repository.update(RECOVERY_TYPE, recovery["entity_id"], {"state": "settled", "settlement_id": settlement_id, "settled_at": self.repository.clock.now()}, actor=actor, expected_version=recovery["version"], request_key=f"settle:{settlement_id}")

    def _next_step(self, recovery: dict) -> tuple[str, str]:
        state = recovery["state"]
        if state == "open":
            return "org:operator", "propose_option"
        if state == "options_proposed":
            option = self.repository.get(OPTION_TYPE, recovery["active_option_id"])
            if option["state"] == "rejected":
                return "org:operator", "propose_new_option"
            if option["state"] == "expired":
                return "org:operator", "propose_new_option"
            return "tourist", "confirm_or_reject_option"
        if state == "in_settlement":
            option = self.repository.get(OPTION_TYPE, recovery["active_option_id"])
            if option["state"] == "accepted":
                return "org:operator", "apply_option"
            return "org:operator", "create_and_post_settlement"
        if state == "settled":
            return "org:operator", "close_recovery"
        return "none", "done"

    def _schedule_once(self, job_type: str, subject_id: str, run_at: str, payload: dict) -> str:
        with self.repository.database.connect() as connection:
            row = connection.execute("SELECT job_id FROM scheduled_jobs WHERE job_type=? AND subject_id=? AND status IN ('waiting','retry','running')", (job_type, subject_id)).fetchone()
        if row:
            return str(row["job_id"])
        return self.jobs.schedule(job_type=job_type, subject_id=subject_id, run_at=run_at, payload=payload)

    def _hours_from_now(self, hours: int) -> str:
        return (parse_instant(self.repository.clock.now()) + timedelta(hours=hours)).isoformat().replace("+00:00", "Z")
