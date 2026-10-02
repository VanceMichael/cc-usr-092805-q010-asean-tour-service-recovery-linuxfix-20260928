"""命令行入口。"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .application import CivicFlow
from .cases import CaseService
from .security import AccessContext


def emit(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2))
def demo(app: CivicFlow) -> dict:
    context = AccessContext.system("demo-operator")
    cases = CaseService(app.repository)
    created = cases.create(context, {"case_type": "协同事项", "subject": "示例联合处置", "owner_org": "org:demo", "priority": "high", "opened_at": app.clock.now()}, request_key="demo-case")
    accepted = app.inbox.receive(source="demo", source_key=created["entity_id"], sequence=1, payload={"kind": "opened"}, occurred_at=app.clock.now())
    reservation = app.reservations.reserve(resource_id="room:joint", subject_id=created["entity_id"], quantity=2, capacity=10, start_at="2026-09-28T10:00:00+08:00", end_at="2026-09-28T11:00:00+08:00", actor=context.actor_id)
    debit = app.ledger.post(journal_key="demo", account="coordination", currency="CNY", amount="12.34", direction="debit", reference="demo-debit", actor=context.actor_id)
    credit = app.ledger.post(journal_key="demo", account="coordination", currency="CNY", amount="12.34", direction="credit", reference="demo-credit", actor=context.actor_id)
    message = app.outbox.enqueue(topic="case.opened", aggregate_id=created["entity_id"], payload={"case_id": created["entity_id"]})
    return {"case": created, "inbox": accepted, "reservation": reservation, "entries": [debit, credit], "balance": app.ledger.balance("demo", currency="CNY"), "message_id": message, "verification": app.verify()}


def tour_demo(app: CivicFlow) -> dict:
    """越南小众线路航班改期后的逐人版本冻结与服务恢复演示。"""
    operator = AccessContext.system("ops:lin")
    services = [
        {"service_id": "s_flight", "kind": "flight", "day": 1, "title": "VN303 航班", "supplier_id": "airline:vn",
         "start_at": "2026-10-10T08:00:00+07:00", "end_at": "2026-10-10T11:30:00+07:00", "price_minor": 300000,
         "capacity": 8, "accessibility": [], "substitution": {"allowed": True, "allowed_kinds": ["flight"]}},
        {"service_id": "s_hotel", "kind": "hotel", "day": 1, "title": "河内老城酒店三晚", "supplier_id": "hotel:hanoi",
         "start_at": "2026-10-10T14:00:00+07:00", "end_at": "2026-10-13T11:00:00+07:00", "price_minor": 120000,
         "capacity": 8, "accessibility": ["step_free"], "substitution": {"allowed": False}},
        {"service_id": "s_heritage", "kind": "activity", "day": 3, "title": "水上木偶非遗体验", "supplier_id": "coop:heritage",
         "start_at": "2026-10-12T14:00:00+07:00", "end_at": "2026-10-12T17:00:00+07:00", "price_minor": 150000,
         "capacity": 8, "accessibility": ["step_free"], "heritage": True, "substitution": {"allowed": True, "allowed_kinds": ["activity"]}},
    ]
    batch = app.tours.create_batch(operator, {
        "operator_org": "org:agency", "product_name": "越南北部小众线路", "destination": "越南河内",
        "departure_at": "2026-10-10T08:00:00+07:00", "return_at": "2026-10-13T18:00:00+07:00", "currency": "CNY", "capacity": 8,
        "services": services,
        "price_components": [
            {"code": "airfare", "title": "国际机票", "amount_minor": 300000},
            {"code": "lodging", "title": "住宿", "amount_minor": 120000},
            {"code": "activities", "title": "活动", "amount_minor": 150000},
        ],
        "visa_requirements": [{"nationality": "CN", "requirement": "另纸签证，提前3个工作日办理"}],
        "guide_qualifications": [{"guide_id": "guide:an", "name": "阿南", "license": "VN-GUIDE-2026-018", "languages": ["zh", "vi"]}],
    }, request_key="demo:batch")
    app.tours.publish_batch(operator, batch["entity_id"], expected_version=1, request_key="demo:publish")
    booking = app.tours.create_booking(operator, {"batch_id": batch["entity_id"], "tourist": {"name": "阿文", "contact": "13800000001", "nationality": "CN", "actor": "tourist:A"}, "special_needs": [], "paid_minor": 570000}, request_key="demo:booking")
    booking_id = app.tours.confirm_booking(operator, booking["entity_id"], expected_version=1, request_key="demo:confirm")["entity_id"]

    # 阿文已入住酒店：该环节保留原责任。
    app.recovery.mark_service_used(operator, booking_id, "s_hotel")
    flight_change = app.recovery.open_recovery(operator, {"booking_id": booking_id, "kind": "flight_change", "reason": "航空公司航班改期，起飞延后5小时", "affected_services": ["s_flight"]}, request_key="demo:ra-flight")
    heritage_exit = app.recovery.open_recovery(operator, {"booking_id": booking_id, "kind": "supplier_exit", "reason": "非遗工坊停业退出", "affected_services": ["s_heritage"]}, request_key="demo:ra-heritage")

    new_flight = {"kind": "flight", "title": "VN305 改期航班", "supplier_id": "airline:vn", "resource_id": "flight:vn305",
                  "start_at": "2026-10-10T13:00:00+07:00", "end_at": "2026-10-10T16:30:00+07:00", "price_minor": 300000, "capacity": 8, "accessibility": []}
    sightseeing = {"kind": "activity", "title": "城区普通观光", "supplier_id": "coop:sight", "resource_id": "activity:sight-walk",
                   "start_at": "2026-10-12T14:00:00+07:00", "end_at": "2026-10-12T17:00:00+07:00", "price_minor": 90000, "capacity": 8, "accessibility": ["step_free"], "heritage": False}
    option_flight = app.recovery.propose_option(operator, flight_change["entity_id"], {"items": [{"service_id": "s_flight", "replacement": new_flight, "effects": {"refund_minor": 0}}]}, request_key="demo:oa-flight")
    option_heritage = app.recovery.propose_option(operator, heritage_exit["entity_id"], {"items": [{"service_id": "s_heritage", "replacement": sightseeing, "effects": {"refund_minor": 60000}}]}, request_key="demo:oa-heritage")
    tourist_a = AccessContext(actor_id="tourist:A", permissions=frozenset())
    app.recovery.respond_option(tourist_a, option_flight["entity_id"], decision="accepted", expected_version=1, request_key="demo:accept-flight")
    app.recovery.respond_option(tourist_a, option_heritage["entity_id"], decision="accepted", expected_version=1, request_key="demo:accept-heritage")
    app.recovery.apply_option(operator, option_flight["entity_id"], request_key="demo:apply-flight")
    app.recovery.apply_option(operator, option_heritage["entity_id"], request_key="demo:apply-heritage")
    for option_id, recovery_id in ((option_flight["entity_id"], flight_change["entity_id"]), (option_heritage["entity_id"], heritage_exit["entity_id"])):
        settlement = app.recovery.create_settlement(operator, recovery_id, request_key=f"demo:set:{option_id}")
        app.recovery.submit_settlement(operator, settlement["entity_id"], expected_version=1, request_key=f"demo:submit:{option_id}")
        app.recovery.post_settlement(operator, settlement["entity_id"], request_key=f"demo:post:{option_id}")
    app.recovery.schedule_departure_reminders(operator, batch["entity_id"])
    return {
        "tourist_view": app.recovery.tourist_view(tourist_a, booking_id),
        "operator_queue": app.recovery.operator_queue(operator),
        "ledger_balance_minor": app.ledger.balance(f"tour:{booking_id}", currency="CNY"),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="协同事务平台")
    parser.add_argument("--db", default=os.getenv("CIVICFLOW_DB", "civicflow.sqlite3"))
    parser.add_argument("--now", default=None, help="测试或演示使用的固定时间")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("demo")
    commands.add_parser("tour-demo")
    commands.add_parser("verify")
    commands.add_parser("list-cases")
    args = parser.parse_args(argv)
    app = CivicFlow.open(Path(args.db), fixed_now=args.now)
    if args.command == "demo": emit(demo(app))
    elif args.command == "tour-demo": emit(tour_demo(app))
    elif args.command == "verify": emit(app.verify())
    elif args.command == "list-cases": emit(CaseService(app.repository).list_current(AccessContext.system("cli")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
