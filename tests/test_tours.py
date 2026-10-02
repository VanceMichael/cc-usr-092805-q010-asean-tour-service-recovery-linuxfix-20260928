from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from civicflow.application import CivicFlow
from civicflow.errors import ConflictError, PermissionDenied, ValidationError
from civicflow.security import AccessContext


def batch_values():
    services = [
        {"service_id": "s_flight", "kind": "flight", "day": 1, "title": "VN303 航班", "supplier_id": "airline:vn",
         "start_at": "2026-10-10T08:00:00+07:00", "end_at": "2026-10-10T11:30:00+07:00", "price_minor": 300000,
         "capacity": 8, "accessibility": [], "substitution": {"allowed": True, "allowed_kinds": ["flight"]}},
        {"service_id": "s_hotel", "kind": "hotel", "day": 1, "title": "河内老城酒店三晚", "supplier_id": "hotel:hanoi",
         "start_at": "2026-10-10T14:00:00+07:00", "end_at": "2026-10-13T11:00:00+07:00", "price_minor": 120000,
         "capacity": 8, "accessibility": ["step_free"], "substitution": {"allowed": False}},
        {"service_id": "s_ride", "kind": "transport", "day": 2, "title": "无障碍用车一日", "supplier_id": "ground:accessible",
         "start_at": "2026-10-11T09:00:00+07:00", "end_at": "2026-10-11T18:00:00+07:00", "price_minor": 80000,
         "capacity": 3, "accessibility": ["wheelchair_vehicle", "step_free"],
         "substitution": {"allowed": True, "allowed_kinds": ["transport"], "same_accessibility_required": True}},
        {"service_id": "s_heritage", "kind": "activity", "day": 3, "title": "水上木偶非遗体验", "supplier_id": "coop:heritage",
         "start_at": "2026-10-12T14:00:00+07:00", "end_at": "2026-10-12T17:00:00+07:00", "price_minor": 150000,
         "capacity": 8, "accessibility": ["step_free"], "heritage": True,
         "substitution": {"allowed": True, "allowed_kinds": ["activity"]}},
    ]
    return {
        "operator_org": "org:agency", "product_name": "越南北部小众线路", "destination": "越南河内",
        "departure_at": "2026-10-10T08:00:00+07:00", "return_at": "2026-10-13T18:00:00+07:00",
        "currency": "CNY", "capacity": 8, "services": services,
        "price_components": [
            {"code": "airfare", "title": "国际机票", "amount_minor": 300000},
            {"code": "lodging", "title": "住宿", "amount_minor": 120000},
            {"code": "ground", "title": "地面交通", "amount_minor": 80000},
            {"code": "activities", "title": "活动", "amount_minor": 150000},
        ],
        "visa_requirements": [{"nationality": "CN", "requirement": "另纸签证，提前3个工作日办理", "notes": ""}],
        "guide_qualifications": [{"guide_id": "guide:an", "name": "阿南", "license": "VN-GUIDE-2026-018", "languages": ["zh", "vi"]}],
    }


TOURISTS = {
    "A": {"name": "阿文", "contact": "13800000001", "nationality": "CN", "actor": "tourist:A"},
    "B": {"name": "小琪", "contact": "13800000002", "nationality": "CN", "actor": "tourist:B"},
    "C": {"name": "阿杰", "contact": "13800000003", "nationality": "CN", "actor": "tourist:C"},
}
SPECIAL_NEEDS_B = [{"need": "全程轮椅出行", "accessibility": ["wheelchair_vehicle", "step_free"], "services": ["s_ride", "s_heritage"]}]
PAID = 650000


class TourRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "tour.sqlite3"
        self.app = CivicFlow.open(self.db_path, fixed_now="2026-10-02T08:00:00+07:00")
        self.operator = AccessContext.system("ops:lin")
        self.tours = self.app.tours
        self.recovery = self.app.recovery
        batch = self.tours.create_batch(self.operator, batch_values(), request_key="batch:1")
        self.batch_id = batch["entity_id"]
        self.tours.publish_batch(self.operator, self.batch_id, expected_version=1, request_key="batch:publish")
        self.bookings = {}
        for key, tourist in TOURISTS.items():
            needs = SPECIAL_NEEDS_B if key == "B" else []
            booking = self.tours.create_booking(self.operator, {"batch_id": self.batch_id, "tourist": tourist, "special_needs": needs, "paid_minor": PAID}, request_key=f"booking:{key}")
            confirmed = self.tours.confirm_booking(self.operator, booking["entity_id"], expected_version=1, request_key=f"confirm:{key}")
            self.bookings[key] = confirmed["entity_id"]

    def tearDown(self):
        self.temp.cleanup()

    def tourist_ctx(self, key):
        return AccessContext(actor_id=f"tourist:{key}", permissions=frozenset())

    # 1. 冻结购买版本；确认幂等不重复占座
    def test_booking_freezes_purchased_version_and_confirm_is_idempotent(self):
        booking = self.tours.get_booking(self.operator, self.bookings["A"])
        self.assertEqual(booking["batch_version"], 2)
        self.assertEqual(len(booking["services"]), 4)
        with self.assertRaises(ConflictError):
            self.tours.revise_batch(self.operator, self.batch_id, {"product_name": "改版线路"}, expected_version=2, request_key="batch:revise")
        replay = self.tours.confirm_booking(self.operator, self.bookings["A"], expected_version=1, request_key="confirm:A")
        self.assertEqual(replay["entity_id"], self.bookings["A"])
        with self.app.database.connect() as conn:
            count = conn.execute("SELECT COUNT(*) AS n FROM resource_reservations WHERE subject_id=?", (self.bookings["A"],)).fetchone()["n"]
        self.assertEqual(count, 4)

    # 2. 已使用酒店保留原责任，不能纳入恢复；回执重复不触发二次处理，矛盾消息挂起
    def test_used_service_kept_and_receipts_dedup_or_held(self):
        self.recovery.mark_service_used(self.operator, self.bookings["A"], "s_hotel")
        r1 = self.recovery.receive_status_receipt(source="airline:vn", source_key=self.bookings["A"], sequence=1, reported_status="rescheduled", payload={"flight": "VN303"}, occurred_at=self.app.clock.now())
        self.assertEqual(r1["status"], "applied")
        replay = self.recovery.receive_status_receipt(source="airline:vn", source_key=self.bookings["A"], sequence=1, reported_status="rescheduled", payload={"flight": "VN303"}, occurred_at=self.app.clock.now())
        self.assertEqual(replay, {"status": "duplicate", "effect": "ignored"})
        with self.assertRaises(ConflictError):
            self.recovery.receive_status_receipt(source="airline:vn", source_key=self.bookings["A"], sequence=2, reported_status="on_time", payload={"flight": "VN303"}, occurred_at=self.app.clock.now())
        # 矛盾消息即使异常也必须落库挂起；同序号重发被去重忽略，不新增挂起记录。
        held = self.recovery.held_receipts(AccessContext.system("reviewer"))
        self.assertEqual(len(held), 1)
        resend = self.recovery.receive_status_receipt(source="airline:vn", source_key=self.bookings["A"], sequence=2, reported_status="on_time", payload={"flight": "VN303"}, occurred_at=self.app.clock.now())
        self.assertEqual(resend, {"status": "duplicate", "effect": "ignored"})
        self.assertEqual(len(self.recovery.held_receipts(AccessContext.system("reviewer"))), 1)
        with self.assertRaises(ConflictError):
            self.recovery.open_recovery(self.operator, {"booking_id": self.bookings["A"], "kind": "destination_risk", "reason": "酒店区域预警", "affected_services": ["s_hotel"]}, request_key="recovery:hotel")

    # 3-12. 端到端：航班改期 + 非遗换观光 + 无障碍车辆容量缩减 + 结算四眼 + 重启续接 + 视图
    def test_full_recovery_flow(self):
        self.recovery.mark_service_used(self.operator, self.bookings["A"], "s_hotel")

        ra_flight = self.recovery.open_recovery(self.operator, {"booking_id": self.bookings["A"], "kind": "flight_change", "reason": "航空公司航班改期，起飞延后5小时", "affected_services": ["s_flight"]}, request_key="ra-flight")["entity_id"]
        ra_heritage = self.recovery.open_recovery(self.operator, {"booking_id": self.bookings["A"], "kind": "supplier_exit", "reason": "非遗工坊停业退出", "affected_services": ["s_heritage"]}, request_key="ra-heritage")["entity_id"]
        rb_flight = self.recovery.open_recovery(self.operator, {"booking_id": self.bookings["B"], "kind": "flight_change", "reason": "航空公司航班改期，起飞延后5小时", "affected_services": ["s_flight"]}, request_key="rb-flight")["entity_id"]
        rb_ride = self.recovery.open_recovery(self.operator, {"booking_id": self.bookings["B"], "kind": "capacity_reduction", "reason": "无障碍车队缩减运力", "affected_services": ["s_ride"]}, request_key="rb-ride")["entity_id"]
        rc_flight = self.recovery.open_recovery(self.operator, {"booking_id": self.bookings["C"], "kind": "flight_change", "reason": "航空公司航班改期", "affected_services": ["s_flight"]}, request_key="rc-flight")["entity_id"]

        new_flight = {"kind": "flight", "title": "VN305 改期航班", "supplier_id": "airline:vn", "resource_id": "flight:vn305",
                      "start_at": "2026-10-10T13:00:00+07:00", "end_at": "2026-10-10T16:30:00+07:00", "price_minor": 300000, "capacity": 8, "accessibility": []}

        # A 的航班替代：等值改期，无补差
        oa_flight = self.recovery.propose_option(self.operator, ra_flight, {"items": [{"service_id": "s_flight", "replacement": new_flight, "effects": {"refund_minor": 0}}]}, request_key="oa-flight")
        self.assertEqual(oa_flight["items"][0]["comparison"]["time"]["start_shift_minutes"], 300)

        # A 的非遗替代：整单比例退款被拒绝，金额必须对应被影响项目（150000-90000=60000）
        sightseeing = {"kind": "activity", "title": "城区普通观光", "supplier_id": "coop:sight", "resource_id": "activity:sight-walk",
                       "start_at": "2026-10-12T14:00:00+07:00", "end_at": "2026-10-12T17:00:00+07:00", "price_minor": 90000, "capacity": 8, "accessibility": ["step_free"], "heritage": False}
        with self.assertRaises(ValidationError):
            self.recovery.propose_option(self.operator, ra_heritage, {"items": [{"service_id": "s_heritage", "replacement": sightseeing, "effects": {"refund_minor": 100000}}]}, request_key="bad-refund")
        oa_heritage = self.recovery.propose_option(self.operator, ra_heritage, {"items": [{"service_id": "s_heritage", "replacement": sightseeing, "effects": {"refund_minor": 60000}}]}, request_key="oa-heritage")
        self.assertFalse(oa_heritage["items"][0]["comparison"]["heritage_preserved"])

        # B 的航班替代：高额代金补偿必须说明原因
        with self.assertRaises(ValidationError):
            self.recovery.propose_option(self.operator, rb_flight, {"items": [{"service_id": "s_flight", "replacement": new_flight, "effects": {"voucher_minor": 120000}}]}, request_key="no-reason")
        ob_flight = self.recovery.propose_option(self.operator, rb_flight, {"items": [{"service_id": "s_flight", "replacement": new_flight, "effects": {"voucher_minor": 120000, "reason": "航班延误5小时补偿券"}}]}, request_key="ob-flight")
        self.assertEqual(ob_flight["totals"]["voucher_minor"], 120000)

        # B 的无障碍车辆：缺少无障碍条件的替代被拒绝；达标替代通过
        bad_van = {"kind": "transport", "title": "普通商务车", "supplier_id": "ground:city", "resource_id": "transport:van-1",
                   "start_at": "2026-10-11T09:00:00+07:00", "end_at": "2026-10-11T18:00:00+07:00", "price_minor": 80000, "capacity": 3, "accessibility": []}
        with self.assertRaises(ValidationError):
            self.recovery.propose_option(self.operator, rb_ride, {"items": [{"service_id": "s_ride", "replacement": bad_van, "effects": {}}]}, request_key="bad-van")
        good_van = {**bad_van, "title": "无障碍专用车", "supplier_id": "ground:accessible", "resource_id": "transport:van-2", "accessibility": ["wheelchair_vehicle", "step_free"]}
        ob_ride = self.recovery.propose_option(self.operator, rb_ride, {"items": [{"service_id": "s_ride", "replacement": good_van, "effects": {}}]}, request_key="ob-ride")
        self.assertTrue(ob_ride["items"][0]["comparison"]["accessibility"]["meets_requirement"])

        # C 收到方案但迟迟不确认（用于重启后续接的超时任务）
        self.recovery.propose_option(self.operator, rc_flight, {"items": [{"service_id": "s_flight", "replacement": new_flight, "effects": {}}]}, request_key="oc-flight")

        # 游客表态（只有本人）
        for option_id, key in ((oa_flight["entity_id"], "A"), (oa_heritage["entity_id"], "A"), (ob_flight["entity_id"], "B"), (ob_ride["entity_id"], "B")):
            self.recovery.respond_option(self.tourist_ctx(key), option_id, decision="accepted", expected_version=1, request_key=f"accept:{option_id}")
        with self.assertRaises(PermissionDenied):
            self.recovery.respond_option(self.tourist_ctx("C"), oa_flight["entity_id"], decision="accepted", expected_version=2, request_key="steal")

        # 落实方案：占用新容量、释放未履行旧容量（幂等重放不重复占用）
        for option_id in (oa_flight["entity_id"], oa_heritage["entity_id"], ob_flight["entity_id"], ob_ride["entity_id"]):
            self.recovery.apply_option(self.operator, option_id, request_key=f"apply:{option_id}")
        self.recovery.apply_option(self.operator, oa_heritage["entity_id"], request_key=f"apply:{oa_heritage['entity_id']}")
        with self.app.database.connect() as conn:
            sight_usage = conn.execute("SELECT COUNT(*) AS n FROM resource_reservations WHERE resource_id='activity:sight-walk' AND status='confirmed'").fetchone()["n"]
        self.assertEqual(sight_usage, 1)

        self._settle(oa_flight["entity_id"], ra_flight, high_value=False)
        heritage_settlement = self._settle(oa_heritage["entity_id"], ra_heritage, high_value=False)
        self._settle(ob_ride["entity_id"], rb_ride, high_value=False)

        # B 航班：高额补偿四眼审核
        rb_settlement = self.recovery.create_settlement(self.operator, rb_flight, request_key="set:rb-flight")
        self.assertTrue(rb_settlement["needs_review"])
        self.recovery.submit_settlement(self.operator, rb_settlement["entity_id"], expected_version=1, request_key="submit:rb-flight")
        with self.assertRaises(ConflictError):
            self.recovery.post_settlement(self.operator, rb_settlement["entity_id"], request_key="post:rb-flight")
        with self.assertRaises(PermissionDenied):
            self.recovery.review_settlement(self.operator, rb_settlement["entity_id"], decision="approved", reason="自审无效", expected_version=2, request_key="self-review")
        reviewer = AccessContext(actor_id="ops:zhou", permissions=frozenset({"review:tour_settlements"}))
        self.recovery.review_settlement(reviewer, rb_settlement["entity_id"], decision="approved", reason="延误凭证齐全，同意发券", expected_version=2, request_key="review:rb-flight")
        report_b = self.recovery.reconcile_settlement(self.operator, rb_settlement["entity_id"])
        self.assertTrue(report_b["balanced"])

        # A 非遗退款账实相符，且不可变分录不允许重复过账
        report_a = self.recovery.reconcile_settlement(self.operator, heritage_settlement)
        self.assertTrue(report_a["balanced"])
        self.assertEqual(report_a["items"][0]["posted"]["refund"], 60000)
        with self.app.database.connect() as conn:
            before = conn.execute("SELECT COUNT(*) AS n FROM journal_entries").fetchone()["n"]
        self.recovery._post_entries(heritage_settlement, actor="ops:lin")
        with self.app.database.connect() as conn:
            after = conn.execute("SELECT COUNT(*) AS n FROM journal_entries").fetchone()["n"]
        self.assertEqual(before, after)
        self.assertEqual(self.app.ledger.balance(f"tour:{self.bookings['A']}", currency="CNY"), -60000)
        self.assertEqual(self.app.ledger.balance(f"tour:{self.bookings['B']}", currency="CNY"), -120000)

        self.recovery.close_recovery(self.operator, ra_heritage, expected_version=4, request_key="close:ra-heritage")

        # 视图：游客看到原因与权益计算；不能看别人的订单
        view_a = self.recovery.tourist_view(self.tourist_ctx("A"), self.bookings["A"])
        self.assertEqual(len(view_a["changes"]), 2)
        self.assertEqual(view_a["entitlements"][0]["totals"]["refund_minor"] + view_a["entitlements"][1]["totals"]["refund_minor"], 60000)
        hotel = next(item for item in view_a["itinerary"] if item["service_id"] == "s_hotel")
        self.assertEqual(hotel["fulfillment"], "used")
        replaced = next(item for item in view_a["itinerary"] if item["service_id"] == "s_heritage")
        self.assertEqual(replaced["fulfillment"], "replaced")
        with self.assertRaises(PermissionDenied):
            self.recovery.tourist_view(self.tourist_ctx("B"), self.bookings["A"])

        # 供应商只看本方任务，不泄露游客信息与其他供应商
        supplier_ctx = AccessContext(actor_id="coop:heritage", permissions=frozenset({"read:tour_supplier_tasks"}))
        heritage_tasks = self.recovery.supplier_view(supplier_ctx, "coop:heritage")
        self.assertTrue(all(t["service_id"] == "s_heritage" for t in heritage_tasks))
        self.assertTrue(all("tourist" not in t for t in heritage_tasks))
        sight_tasks = self.recovery.supplier_view(supplier_ctx, "coop:sight")
        self.assertEqual({t["service_id"] for t in sight_tasks}, {"replacement:s_heritage"})
        with self.assertRaises(PermissionDenied):
            self.recovery.supplier_view(AccessContext(actor_id="nobody", permissions=frozenset()), "coop:heritage")

        # 重启后续接：临近出发提醒与 C 的方案超时自动处理
        self.recovery.schedule_departure_reminders(self.operator, self.batch_id)
        restarted = CivicFlow.open(self.db_path, fixed_now="2026-10-09T02:30:00Z")
        outcomes = restarted.recovery.process_due_jobs()
        kinds = {item["outcome"] for item in outcomes}
        self.assertIn("reminder_sent", kinds)
        self.assertIn("option_expired", kinds)
        with restarted.database.connect() as conn:
            reminders = conn.execute("SELECT COUNT(*) AS n FROM outbox_messages WHERE topic='tour.departure_reminder'").fetchone()["n"]
            expired = conn.execute("SELECT COUNT(*) AS n FROM outbox_messages WHERE topic='tour.option_expired'").fetchone()["n"]
        self.assertEqual(reminders, 3)
        self.assertEqual(expired, 1)
        # 再次轮询不重复处理
        self.assertEqual(restarted.recovery.process_due_jobs(), [])

        # 运营队列：C 的方案超时后指向“重新提案”，责任人明确
        queue = restarted.recovery.operator_queue(self.operator)
        c_row = next(row for row in queue if row["booking_id"] == self.bookings["C"])
        self.assertEqual(c_row["next_responsible_party"], "org:operator")
        self.assertEqual(c_row["next_action"], "propose_new_option")

    def _settle(self, option_id: str, recovery_id: str, *, high_value: bool) -> str:
        settlement = self.recovery.create_settlement(self.operator, recovery_id, request_key=f"set:{option_id}")
        self.recovery.submit_settlement(self.operator, settlement["entity_id"], expected_version=1, request_key=f"submit:{option_id}")
        self.recovery.post_settlement(self.operator, settlement["entity_id"], request_key=f"post:{option_id}")
        report = self.recovery.reconcile_settlement(self.operator, settlement["entity_id"])
        self.assertTrue(report["balanced"])
        return settlement["entity_id"]


if __name__ == "__main__":
    unittest.main()
