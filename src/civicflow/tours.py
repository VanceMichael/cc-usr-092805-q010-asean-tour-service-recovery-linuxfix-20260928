"""旅游线路批次目录与游客订单（购买版本冻结）。

每个出发批次保存逐日行程、交通住宿与活动供应、容量、价格构成、签证或入境条件、
导游资质与允许的替代范围。游客确认后冻结其实际购买的批次版本与服务快照，
之后批次目录的任何修订都不改变已售版本。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Mapping

from .errors import ConflictError, ValidationError
from .idempotency import idempotent
from .repository import EntityRepository
from .reservations import ReservationBook
from .security import AccessContext
from .timeutil import canonical_instant, parse_instant


BATCH_TYPE = "tour_batches"
BOOKING_TYPE = "tour_bookings"
SERVICE_KINDS = ("flight", "hotel", "transport", "activity")
BATCH_STATES = ("draft", "published", "closed",)
BOOKING_STATES = ("draft", "confirmed", "completed", "cancelled",)
FULFILLMENT_BOOKED = "booked"


def require_minor(value: object, label: str, *, allow_zero: bool = False) -> int:
    """金额字段以整数最小货币单位入账（如分），不接受浮点金额串。"""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError(f"{label} 必须是整数最小货币单位")
    if value < 0 or (value == 0 and not allow_zero):
        raise ValidationError(f"{label} 必须大于零")
    return value


@dataclass(frozen=True)
class TourService:
    """线路批次发布、游客下单确认与购买版本冻结。"""

    repository: EntityRepository
    reservations: ReservationBook

    # ----- 批次目录 -----

    def create_batch(self, context: AccessContext, values: Mapping[str, object], *, request_key: str) -> dict:
        context.require("write:tour_batches")
        payload = self._validate_batch(values)
        payload["state"] = BATCH_STATES[0]
        return self.repository.create(BATCH_TYPE, payload, actor=context.actor_id, request_key=request_key)

    def revise_batch(self, context: AccessContext, batch_id: str, values: Mapping[str, object], *, expected_version: int, request_key: str) -> dict:
        context.require("write:tour_batches")
        batch = self.repository.get(BATCH_TYPE, batch_id)
        if batch["state"] != "draft":
            raise ConflictError("已发布批次只能通过服务恢复流程处理变更")
        payload = self._validate_batch(values, partial=True)
        if "state" in payload:
            raise ValidationError("状态必须通过 publish/close 修改")
        merged = {**batch, **payload}
        self._validate_batch(merged)
        return self.repository.update(BATCH_TYPE, batch_id, payload, actor=context.actor_id, expected_version=expected_version, request_key=request_key)

    def publish_batch(self, context: AccessContext, batch_id: str, *, expected_version: int, request_key: str) -> dict:
        context.require("write:tour_batches")
        batch = self.repository.get(BATCH_TYPE, batch_id)
        if batch["state"] != "draft":
            raise ConflictError("只有草稿批次可以发布")
        self._validate_batch(batch)
        return self.repository.update(BATCH_TYPE, batch_id, {"state": "published"}, actor=context.actor_id, expected_version=expected_version, request_key=request_key)

    def get_batch(self, context: AccessContext, batch_id: str) -> dict:
        context.require("read:tour_batches")
        return self.repository.get(BATCH_TYPE, batch_id)

    def batch_snapshot(self, context: AccessContext, batch_id: str, *, as_of: str) -> dict:
        context.require("history:tour_batches")
        return self.repository.snapshot(BATCH_TYPE, batch_id, as_of=as_of)

    def list_batches(self, context: AccessContext, *, state: str | None = None) -> list[dict]:
        context.require("read:tour_batches")
        return self.repository.list(BATCH_TYPE, state=state)

    # ----- 游客订单 -----

    def create_booking(self, context: AccessContext, values: Mapping[str, object], *, request_key: str) -> dict:
        context.require("write:tour_bookings")
        payload = self._validate_booking(values)
        payload["state"] = BOOKING_STATES[0]
        return self.repository.create(BOOKING_TYPE, payload, actor=context.actor_id, request_key=request_key)

    @idempotent("tour:confirm_booking")
    def confirm_booking(self, context: AccessContext, booking_id: str, *, expected_version: int, request_key: str) -> dict:
        """游客确认：冻结实际购买的批次版本与全部服务快照，并按容量占座。"""
        context.require("write:tour_bookings")
        booking = self.repository.get(BOOKING_TYPE, booking_id)
        if booking["state"] != "draft":
            raise ConflictError("只有草稿订单可以确认冻结")
        batch = self.repository.get(BATCH_TYPE, booking["batch_id"])
        if batch["state"] != "published":
            raise ConflictError("批次尚未发布，不能确认")
        reserved: list[str] = []
        for service in batch["services"]:
            try:
                row = self.reservations.reserve(
                    resource_id=f"{batch['entity_id']}:{service['service_id']}",
                    subject_id=booking_id, quantity=1, capacity=int(service["capacity"]),
                    start_at=service["start_at"], end_at=service["end_at"], actor=context.actor_id,
                )
            except Exception:
                for reservation_id in reserved:
                    self.reservations.release(reservation_id, expected_version=1)
                raise
            reserved.append(row["reservation_id"])
        frozen = {
            "state": "confirmed",
            "batch_version": batch["version"],
            "currency": batch["currency"],
            "frozen_at": self.repository.clock.now(),
            "destination": batch["destination"],
            "departure_at": batch["departure_at"],
            "return_at": batch["return_at"],
            "visa_requirements": batch["visa_requirements"],
            "guide_qualifications": batch["guide_qualifications"],
            "price_components": batch["price_components"],
            "services": [dict(service, reservation_id=rid) for service, rid in zip(batch["services"], reserved)],
        }
        try:
            updated = self.repository.update(BOOKING_TYPE, booking_id, frozen, actor=context.actor_id, expected_version=expected_version, request_key=request_key)
        except Exception:
            for reservation_id in reserved:
                self.reservations.release(reservation_id, expected_version=1)
            raise
        self._init_fulfillment(updated, actor=context.actor_id)
        return updated

    def get_booking(self, context: AccessContext, booking_id: str) -> dict:
        context.require("read:tour_bookings")
        return self.repository.get(BOOKING_TYPE, booking_id)

    def list_bookings(self, context: AccessContext, batch_id: str) -> list[dict]:
        context.require("read:tour_bookings")
        return self.repository.search(BOOKING_TYPE, "batch_id", batch_id, limit=500)

    def departure_reminder_at(self, batch: Mapping[str, object], *, hours: int = 48) -> str:
        run = parse_instant(str(batch["departure_at"])) - timedelta(hours=hours)
        return run.isoformat().replace("+00:00", "Z")

    # ----- 履行明细初始化 -----

    def _init_fulfillment(self, booking: Mapping[str, object], *, actor: str) -> None:
        now = self.repository.clock.now()
        with self.repository.database.transaction() as connection:
            for service in booking["services"]:
                connection.execute(
                    "INSERT INTO tour_fulfillment(booking_id,service_id,batch_version,status,reservation_id,updated_at,updated_by,version) VALUES(?,?,?,?,?,?,?,1)",
                    (booking["entity_id"], service["service_id"], booking["batch_version"], FULFILLMENT_BOOKED, service.get("reservation_id"), now, actor),
                )

    # ----- 校验 -----

    def _validate_batch(self, values: Mapping[str, object], *, partial: bool = False) -> dict:
        required = ("operator_org", "product_name", "destination", "departure_at", "return_at", "currency", "capacity", "services", "price_components", "visa_requirements", "guide_qualifications")
        self._require_fields(values, required, partial=partial)
        payload = {key: values[key] for key in required if key in values}
        if "departure_at" in payload:
            payload["departure_at"] = canonical_instant(payload["departure_at"])
        if "return_at" in payload:
            payload["return_at"] = canonical_instant(payload["return_at"])
        if "departure_at" in payload and "return_at" in payload and parse_instant(payload["departure_at"]) >= parse_instant(payload["return_at"]):
            raise ValidationError("返程时间必须晚于出发时间")
        if "capacity" in payload and (not isinstance(payload["capacity"], int) or payload["capacity"] <= 0):
            raise ValidationError("批次容量必须为正整数")
        if "currency" in payload and (not isinstance(payload["currency"], str) or len(payload["currency"]) != 3):
            raise ValidationError("币种必须为三位货币代码")
        if "services" in payload:
            payload["services"] = [self._validate_service(item) for item in payload["services"]]
            ids = [item["service_id"] for item in payload["services"]]
            if len(set(ids)) != len(ids):
                raise ValidationError("服务标识在批次内必须唯一")
            for item in payload["services"]:
                if int(item["capacity"]) > int(payload.get("capacity", item["capacity"])):
                    raise ValidationError(f"{item['service_id']} 容量不能超过批次容量")
        if "price_components" in payload:
            payload["price_components"] = [self._validate_price_component(item) for item in payload["price_components"]]
        if "visa_requirements" in payload:
            payload["visa_requirements"] = [self._validate_visa(item) for item in payload["visa_requirements"]]
        if "guide_qualifications" in payload:
            payload["guide_qualifications"] = [self._validate_guide(item) for item in payload["guide_qualifications"]]
        if "services" in payload and "price_components" in payload:
            service_total = sum(int(item["price_minor"]) for item in payload["services"])
            component_total = sum(int(item["amount_minor"]) for item in payload["price_components"])
            if service_total != component_total:
                raise ValidationError(f"价格构成合计 {component_total} 必须与服务价格合计 {service_total} 一致")
        return payload

    def _validate_service(self, raw: object) -> dict:
        if not isinstance(raw, Mapping):
            raise ValidationError("服务项必须是对象")
        required = ("service_id", "kind", "day", "title", "supplier_id", "start_at", "end_at", "price_minor", "capacity", "accessibility", "substitution")
        self._require_fields(raw, required, partial=False)
        kind = str(raw["kind"])
        if kind not in SERVICE_KINDS:
            raise ValidationError(f"未知服务类型: {kind}")
        substitution = raw["substitution"]
        if not isinstance(substitution, Mapping) or not isinstance(substitution.get("allowed"), bool):
            raise ValidationError("替代范围 substitution.allowed 必须为布尔值")
        allowed_kinds = substitution.get("allowed_kinds", [])
        if not isinstance(allowed_kinds, list) or any(item not in SERVICE_KINDS for item in allowed_kinds):
            raise ValidationError("allowed_kinds 只能包含平台已知服务类型")
        accessibility = raw["accessibility"]
        if not isinstance(accessibility, list) or any(not isinstance(item, str) for item in accessibility):
            raise ValidationError("无障碍条件必须为字符串列表")
        day = raw["day"]
        if not isinstance(day, int) or day < 1:
            raise ValidationError("行程日序必须从 1 开始")
        result = {
            "service_id": str(raw["service_id"]), "kind": kind, "day": day, "title": str(raw["title"]),
            "supplier_id": str(raw["supplier_id"]),
            "start_at": canonical_instant(raw["start_at"]), "end_at": canonical_instant(raw["end_at"]),
            "price_minor": require_minor(raw["price_minor"], "服务价格"), "capacity": int(raw["capacity"]),
            "accessibility": list(accessibility), "heritage": bool(raw.get("heritage", False)),
            "substitution": {"allowed": bool(substitution["allowed"]), "allowed_kinds": list(allowed_kinds), "same_accessibility_required": bool(substitution.get("same_accessibility_required", True))},
        }
        if parse_instant(result["start_at"]) >= parse_instant(result["end_at"]):
            raise ValidationError(f"{result['service_id']} 结束时间必须晚于开始时间")
        if result["capacity"] <= 0:
            raise ValidationError(f"{result['service_id']} 容量必须为正数")
        return result

    @staticmethod
    def _validate_price_component(raw: object) -> dict:
        if not isinstance(raw, Mapping) or not {"code", "title", "amount_minor"} <= set(raw):
            raise ValidationError("价格构成必须包含 code/title/amount_minor")
        return {"code": str(raw["code"]), "title": str(raw["title"]), "amount_minor": require_minor(raw["amount_minor"], "价格构成金额")}

    @staticmethod
    def _validate_visa(raw: object) -> dict:
        if not isinstance(raw, Mapping) or not {"nationality", "requirement"} <= set(raw):
            raise ValidationError("签证或入境条件必须包含 nationality/requirement")
        return {"nationality": str(raw["nationality"]), "requirement": str(raw["requirement"]), "notes": str(raw.get("notes", ""))}

    @staticmethod
    def _validate_guide(raw: object) -> dict:
        if not isinstance(raw, Mapping) or not {"guide_id", "name", "license"} <= set(raw):
            raise ValidationError("导游资质必须包含 guide_id/name/license")
        return {"guide_id": str(raw["guide_id"]), "name": str(raw["name"]), "license": str(raw["license"]), "languages": [str(item) for item in raw.get("languages", [])]}

    def _validate_booking(self, values: Mapping[str, object]) -> dict:
        required = ("batch_id", "tourist", "paid_minor")
        self._require_fields(values, required, partial=False)
        batch = self.repository.get(BATCH_TYPE, str(values["batch_id"]))
        tourist = values["tourist"]
        if not isinstance(tourist, Mapping) or not {"name", "contact", "nationality"} <= set(tourist):
            raise ValidationError("游客信息必须包含 name/contact/nationality")
        actor = str(tourist.get("actor", ""))
        clean_tourist = {"name": str(tourist["name"]), "contact": str(tourist["contact"]), "nationality": str(tourist["nationality"])}
        if actor:
            clean_tourist["actor"] = actor
        needs = values.get("special_needs", [])
        if not isinstance(needs, list):
            raise ValidationError("特殊需求必须为列表")
        clean_needs = []
        known_services = {item["service_id"] for item in batch["services"]}
        for need in needs:
            if not isinstance(need, Mapping) or "need" not in need:
                raise ValidationError("特殊需求必须说明 need")
            linked = [str(item) for item in need.get("services", [])]
            if any(item not in known_services for item in linked):
                raise ValidationError("特殊需求引用了批次中不存在的服务")
            features = [str(item) for item in need.get("accessibility", [])]
            clean_needs.append({"need": str(need["need"]), "accessibility": features, "services": linked})
        paid = require_minor(values["paid_minor"], "实付金额")
        total = sum(int(item["price_minor"]) for item in batch["services"])
        if paid != total:
            raise ValidationError(f"实付 {paid} 与冻结版本价格合计 {total} 不一致")
        return {"batch_id": batch["entity_id"], "tourist": clean_tourist, "special_needs": clean_needs, "paid_minor": paid}

    @staticmethod
    def _require_fields(values: Mapping[str, object], required: tuple[str, ...], *, partial: bool) -> None:
        missing = [key for key in required if key not in values]
        if not partial and missing:
            raise ValidationError("缺少字段: " + ", ".join(missing))
        for key in required:
            if key in values and values[key] is None:
                raise ValidationError(f"{key} 不能为空")
