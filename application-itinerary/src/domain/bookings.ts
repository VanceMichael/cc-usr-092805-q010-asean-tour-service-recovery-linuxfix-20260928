/**
 * 游客订单：登记特殊需求；游客确认后冻结实际购买的批次版本（完整快照），
 * 之后批次再怎么修订都不影响该订单。确认时通过平台资源预约锁定每个环节 1 份容量。
 * 履约进度只允许向前：scheduled -> in_use -> fulfilled，或 cancelled；
 * 已进入 in_use/fulfilled 的服务视为“已经使用”，恢复时保留原责任。
 */
import type { EntityRepository } from "../platform/repository.js";
import type { ReservationBook } from "../platform/reservations.js";
import type { JobQueue } from "../platform/jobs.js";
import type { Clock } from "../platform/timeutil.js";
import { ConflictError, NotFoundError, ValidationError } from "../platform/errors.js";
import type { AccessContext } from "../platform/access.js";
import { newId } from "../platform/ids.js";
import { allItems } from "./departures.js";
import type { BookingPayload, ItemFulfillment, SpecialNeed } from "./types.js";
import { itemTotal } from "./money.js";

const ENTITY_TYPE = "bookings";
const FORWARD: Record<ItemFulfillment, ItemFulfillment[]> = {
  scheduled: ["in_use", "cancelled"],
  in_use: ["fulfilled"],
  fulfilled: [],
  cancelled: [],
};

export class BookingService {
  constructor(
    private readonly repo: EntityRepository,
    private readonly reservations: ReservationBook,
    private readonly jobs: JobQueue,
    private readonly clock: Clock,
  ) {}

  /** 游客下单（未确认），记录特殊需求及其关联环节。 */
  place(
    ctx: AccessContext,
    fields: {
      departureId: string;
      traveler: BookingPayload["traveler"];
      specialNeeds: SpecialNeed[];
      packageTotalMinor: number;
    },
    requestKey: string,
  ) {
    ctx.require("write:bookings");
    const departure = this.repo.get("departures", fields.departureId);
    if (departure.state !== "published") throw new ConflictError("批次尚未发布，不能下单");
    const itemIds = new Set(allItems(departure).map((item) => item.item_id));
    for (const need of fields.specialNeeds) {
      if (!need.code?.trim() || !need.detail?.trim()) {
        throw new ValidationError("特殊需求的代码和说明不能为空");
      }
      for (const itemId of need.item_ids) {
        if (!itemIds.has(itemId)) throw new ValidationError(`特殊需求关联了不存在的环节: ${itemId}`);
      }
    }
    const itemStates: Record<string, ItemFulfillment> = {};
    for (const item of allItems(departure)) itemStates[item.item_id] = "scheduled";
    const bookingId = newId("booking");
    const payload: BookingPayload = {
      code: `BK-${bookingId.slice(-8).toUpperCase()}`,
      departure_id: fields.departureId,
      traveler: fields.traveler,
      special_needs: fields.specialNeeds,
      frozen_departure_version: 0,
      frozen_snapshot: undefined as unknown as BookingPayload["frozen_snapshot"],
      item_states: itemStates,
      total_minor: fields.packageTotalMinor,
      state: "pending",
      confirmed_at: "",
    };
    return this.repo.create(ENTITY_TYPE, payload as unknown as Record<string, unknown>, {
      actor: ctx.actorId,
      requestKey,
    });
  }

  /** 游客确认：冻结版本快照并占用容量，同时安排“临近出发”续接任务。 */
  confirm(ctx: AccessContext, bookingId: string, expectedVersion: number, requestKey: string) {
    ctx.require("write:bookings");
    const booking = this.require(bookingId);
    if (booking.state !== "pending") throw new ConflictError("只有待确认订单可以确认");
    const departure = this.repo.get("departures", booking.departure_id);
    const reservations: Record<string, string> = {};
    for (const item of allItems(departure)) {
      const held = this.reservations.reserve({
        resourceId: `${booking.departure_id}:item:${item.item_id}`,
        subjectId: bookingId,
        quantity: 1,
        capacity: item.capacity,
        startAt: item.start_at,
        endAt: item.end_at,
        actor: ctx.actorId,
      });
      reservations[item.item_id] = held.reservationId;
    }
    // 临近出发提醒：出发前 48 小时（应用重启后由任务轮询自动续接）。
    const departAt = departure.depart_at as string;
    const reminderAt = new Date(Date.parse(departAt) - 48 * 3600 * 1000)
      .toISOString()
      .replace(/\.000Z$/, "Z");
    this.jobs.schedule({
      jobType: "departure_reminder",
      subjectId: bookingId,
      runAt: reminderAt,
      payload: { booking_id: bookingId, departure_id: booking.departure_id },
    });
    const snapshot = departure as unknown as BookingPayload["frozen_snapshot"];
    return this.repo.update(
      ENTITY_TYPE,
      bookingId,
      {
        state: "confirmed",
        confirmed_at: this.clock.now(),
        frozen_departure_version: departure.version,
        frozen_snapshot: snapshot,
        reservations,
      },
      { actor: ctx.actorId, expectedVersion, requestKey },
    );
  }

  /** 履约推进：服务开始使用/已完成。已使用即保留原责任，恢复流程不得再动它。 */
  markFulfillment(
    ctx: AccessContext,
    bookingId: string,
    itemId: string,
    target: ItemFulfillment,
    expectedVersion: number,
    requestKey: string,
  ) {
    ctx.require("write:bookings");
    const booking = this.require(bookingId);
    ctx.requireOwnBooking(bookingId);
    const states = booking.item_states as Record<string, ItemFulfillment>;
    const current = states[itemId];
    if (!current) throw new NotFoundError(`订单不含环节 ${itemId}`);
    if (!FORWARD[current].includes(target)) {
      throw new ConflictError(`环节不能从 ${current} 变为 ${target}`);
    }
    const nextStates = { ...states, [itemId]: target };
    const changes: Record<string, unknown> = { item_states: nextStates };
    if (target === "in_use" && booking.state === "confirmed") changes.state = "in_travel";
    if (target === "fulfilled") {
      const anyOpen = Object.values(nextStates).some((s) => s === "scheduled" || s === "in_use");
      if (!anyOpen) changes.state = "completed";
    }
    return this.repo.update(ENTITY_TYPE, bookingId, changes, {
      actor: ctx.actorId,
      expectedVersion,
      requestKey,
    });
  }

  require(bookingId: string) {
    const entity = this.repo.find(ENTITY_TYPE, bookingId);
    if (!entity) throw new NotFoundError(`订单 ${bookingId} 不存在`);
    return entity as unknown as BookingPayload & {
      entity_id: string;
      version: number;
      state: string;
      reservations?: Record<string, string>;
    };
  }

  get(ctx: AccessContext, bookingId: string) {
    ctx.requireOwnBooking(bookingId);
    return this.repo.get(ENTITY_TYPE, bookingId);
  }

  listForDeparture(departureId: string) {
    return (this.repo.list(ENTITY_TYPE, { limit: 500 }) as unknown as Array<
      BookingPayload & { entity_id: string; version: number }
    >).filter((b) => b.departure_id === departureId);
  }

  /** 订单内某环节游客实际支付的价格（按确认冻结版本计算）。 */
  static itemPrice(booking: BookingPayload, itemId: string): number {
    for (const day of booking.frozen_snapshot.days) {
      const item = day.items.find((candidate) => candidate.item_id === itemId);
      if (item) return itemTotal(item);
    }
    throw new NotFoundError(`冻结版本中找不到环节 ${itemId}`);
  }
}

