import { ConflictError, NotFoundError, ValidationError } from "../platform/errors.js";
import { newId } from "../platform/ids.js";
import { allItems } from "./departures.js";
import { itemTotal } from "./money.js";
const ENTITY_TYPE = "bookings";
const FORWARD = {
    scheduled: ["in_use", "cancelled"],
    in_use: ["fulfilled"],
    fulfilled: [],
    cancelled: [],
};
export class BookingService {
    repo;
    reservations;
    jobs;
    clock;
    constructor(repo, reservations, jobs, clock) {
        this.repo = repo;
        this.reservations = reservations;
        this.jobs = jobs;
        this.clock = clock;
    }
    /** 游客下单（未确认），记录特殊需求及其关联环节。 */
    place(ctx, fields, requestKey) {
        ctx.require("write:bookings");
        const departure = this.repo.get("departures", fields.departureId);
        if (departure.state !== "published")
            throw new ConflictError("批次尚未发布，不能下单");
        const itemIds = new Set(allItems(departure).map((item) => item.item_id));
        for (const need of fields.specialNeeds) {
            if (!need.code?.trim() || !need.detail?.trim()) {
                throw new ValidationError("特殊需求的代码和说明不能为空");
            }
            for (const itemId of need.item_ids) {
                if (!itemIds.has(itemId))
                    throw new ValidationError(`特殊需求关联了不存在的环节: ${itemId}`);
            }
        }
        const itemStates = {};
        for (const item of allItems(departure))
            itemStates[item.item_id] = "scheduled";
        const bookingId = newId("booking");
        const payload = {
            code: `BK-${bookingId.slice(-8).toUpperCase()}`,
            departure_id: fields.departureId,
            traveler: fields.traveler,
            special_needs: fields.specialNeeds,
            frozen_departure_version: 0,
            frozen_snapshot: undefined,
            item_states: itemStates,
            total_minor: fields.packageTotalMinor,
            state: "pending",
            confirmed_at: "",
        };
        return this.repo.create(ENTITY_TYPE, payload, {
            actor: ctx.actorId,
            requestKey,
        });
    }
    /** 游客确认：冻结版本快照并占用容量，同时安排“临近出发”续接任务。 */
    confirm(ctx, bookingId, expectedVersion, requestKey) {
        ctx.require("write:bookings");
        const booking = this.require(bookingId);
        if (booking.state !== "pending")
            throw new ConflictError("只有待确认订单可以确认");
        const departure = this.repo.get("departures", booking.departure_id);
        const reservations = {};
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
        const departAt = departure.depart_at;
        const reminderAt = new Date(Date.parse(departAt) - 48 * 3600 * 1000)
            .toISOString()
            .replace(/\.000Z$/, "Z");
        this.jobs.schedule({
            jobType: "departure_reminder",
            subjectId: bookingId,
            runAt: reminderAt,
            payload: { booking_id: bookingId, departure_id: booking.departure_id },
        });
        const snapshot = departure;
        return this.repo.update(ENTITY_TYPE, bookingId, {
            state: "confirmed",
            confirmed_at: this.clock.now(),
            frozen_departure_version: departure.version,
            frozen_snapshot: snapshot,
            reservations,
        }, { actor: ctx.actorId, expectedVersion, requestKey });
    }
    /** 履约推进：服务开始使用/已完成。已使用即保留原责任，恢复流程不得再动它。 */
    markFulfillment(ctx, bookingId, itemId, target, expectedVersion, requestKey) {
        ctx.require("write:bookings");
        const booking = this.require(bookingId);
        ctx.requireOwnBooking(bookingId);
        const states = booking.item_states;
        const current = states[itemId];
        if (!current)
            throw new NotFoundError(`订单不含环节 ${itemId}`);
        if (!FORWARD[current].includes(target)) {
            throw new ConflictError(`环节不能从 ${current} 变为 ${target}`);
        }
        const nextStates = { ...states, [itemId]: target };
        const changes = { item_states: nextStates };
        if (target === "in_use" && booking.state === "confirmed")
            changes.state = "in_travel";
        if (target === "fulfilled") {
            const anyOpen = Object.values(nextStates).some((s) => s === "scheduled" || s === "in_use");
            if (!anyOpen)
                changes.state = "completed";
        }
        return this.repo.update(ENTITY_TYPE, bookingId, changes, {
            actor: ctx.actorId,
            expectedVersion,
            requestKey,
        });
    }
    require(bookingId) {
        const entity = this.repo.find(ENTITY_TYPE, bookingId);
        if (!entity)
            throw new NotFoundError(`订单 ${bookingId} 不存在`);
        return entity;
    }
    get(ctx, bookingId) {
        ctx.requireOwnBooking(bookingId);
        return this.repo.get(ENTITY_TYPE, bookingId);
    }
    listForDeparture(departureId) {
        return this.repo.list(ENTITY_TYPE, { limit: 500 }).filter((b) => b.departure_id === departureId);
    }
    /** 订单内某环节游客实际支付的价格（按确认冻结版本计算）。 */
    static itemPrice(booking, itemId) {
        for (const day of booking.frozen_snapshot.days) {
            const item = day.items.find((candidate) => candidate.item_id === itemId);
            if (item)
                return itemTotal(item);
        }
        throw new NotFoundError(`冻结版本中找不到环节 ${itemId}`);
    }
}
