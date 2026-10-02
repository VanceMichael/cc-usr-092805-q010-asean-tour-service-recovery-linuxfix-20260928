import { ConflictError, NotFoundError, ValidationError } from "../platform/errors.js";
import { newId } from "../platform/ids.js";
const ENTITY_TYPE = "departures";
const VERSIONED_STATES = ["draft", "published", "closed"];
export function itemResourceId(departureId, itemId) {
    return `${departureId}:item:${itemId}`;
}
export class DepartureService {
    repo;
    reservations;
    constructor(repo, reservations) {
        this.repo = repo;
        this.reservations = reservations;
    }
    createDraft(ctx, values, requestKey) {
        ctx.require("write:departures");
        validate(values);
        const payload = { ...values, state: "draft" };
        return this.repo.create(ENTITY_TYPE, payload, {
            actor: ctx.actorId,
            requestKey,
        });
    }
    /** 已发布批次的修订：生成新版本，尚未确认购买的游客看到新版，已冻结订单不变。 */
    revise(ctx, departureId, values, expectedVersion, requestKey, reason) {
        ctx.require("write:departures");
        const current = this.require(departureId);
        if (current.state === "closed")
            throw new ConflictError("已关闭批次不能修订");
        if (!reason.trim())
            throw new ValidationError("批次修订必须说明原因");
        const merged = { ...current, ...values };
        validate(merged);
        return this.repo.update(ENTITY_TYPE, departureId, { ...values, revision_reason: reason.trim() }, { actor: ctx.actorId, expectedVersion, requestKey });
    }
    publish(ctx, departureId, expectedVersion, requestKey) {
        ctx.require("write:departures");
        const current = this.require(departureId);
        if (current.state !== "draft")
            throw new ConflictError("只有草稿可以发布");
        return this.repo.update(ENTITY_TYPE, departureId, { state: "published" }, { actor: ctx.actorId, expectedVersion, requestKey });
    }
    get(departureId) {
        return this.repo.get(ENTITY_TYPE, departureId);
    }
    require(departureId) {
        const entity = this.repo.find(ENTITY_TYPE, departureId);
        if (!entity)
            throw new NotFoundError(`批次 ${departureId} 不存在`);
        return entity;
    }
    list() {
        return this.repo.list(ENTITY_TYPE, { limit: 200 });
    }
    history(ctx, departureId) {
        ctx.require("history:departures");
        return this.repo.history(ENTITY_TYPE, departureId);
    }
    /** 某环节在指定时间窗的已占用容量（预约沿用平台资源预约能力）。 */
    usedCapacity(departureId, itemId) {
        const item = findItem(this.require(departureId), itemId);
        return this.reservations.usage(itemResourceId(departureId, itemId), item.start_at);
    }
}
export function findItem(departure, itemId) {
    const payload = departure;
    for (const day of payload.days) {
        const item = day.items.find((candidate) => candidate.item_id === itemId);
        if (item)
            return item;
    }
    throw new NotFoundError(`环节 ${itemId} 不存在于该批次`);
}
export function allItems(departure) {
    return departure.days.flatMap((day) => day.items);
}
export function newItemId() {
    return newId("item");
}
function validate(values) {
    if (!values.code?.trim())
        throw new ValidationError("批次编号不能为空");
    if (!values.route_name?.trim())
        throw new ValidationError("线路名称不能为空");
    if (!values.destination_country?.trim())
        throw new ValidationError("目的地国家不能为空");
    if (!values.depart_at || !values.return_at)
        throw new ValidationError("出发与返程时间不能为空");
    if (!values.currency?.trim())
        throw new ValidationError("币种不能为空");
    if (!values.visa_policy?.type?.trim())
        throw new ValidationError("签证或入境条件不能为空");
    if (!Array.isArray(values.guide_requirements?.credentials) || values.guide_requirements.credentials.length === 0) {
        throw new ValidationError("导游资质要求不能为空");
    }
    if (!Array.isArray(values.days) || values.days.length === 0) {
        throw new ValidationError("逐日行程不能为空");
    }
    const itemIds = new Set();
    let dayCursor = 0;
    for (const day of values.days) {
        if (day.day !== ++dayCursor)
            throw new ValidationError("逐日行程的 day 必须从 1 连续编号");
        if (!day.date?.trim() || !day.title?.trim())
            throw new ValidationError("每日日期与标题不能为空");
        for (const item of day.items)
            validateItem(item, itemIds);
    }
    if (!Array.isArray(values.package_charges) || values.package_charges.length === 0) {
        throw new ValidationError("整包价格构成不能为空");
    }
}
function validateItem(item, seen) {
    if (!item.item_id?.trim())
        throw new ValidationError("环节标识不能为空");
    if (seen.has(item.item_id))
        throw new ValidationError(`环节标识重复: ${item.item_id}`);
    seen.add(item.item_id);
    if (!Number.isInteger(item.day))
        throw new ValidationError("环节日期不合法");
    const categories = ["transport", "lodging", "activity", "guide", "meal", "visa"];
    if (!categories.includes(item.category))
        throw new ValidationError(`环节类型不合法: ${item.item_id}`);
    if (!item.title?.trim() || !item.supplier_org_id?.trim()) {
        throw new ValidationError(`环节 ${item.item_id} 的标题与供应商不能为空`);
    }
    if (!item.start_at || !item.end_at)
        throw new ValidationError(`环节 ${item.item_id} 时间不完整`);
    if (!Number.isInteger(item.capacity) || item.capacity <= 0) {
        throw new ValidationError(`环节 ${item.item_id} 容量必须为正整数`);
    }
    const p = item.price;
    if (!p || [p.base_minor, p.surcharge_minor, p.tax_minor].some((v) => !Number.isInteger(v) || v < 0)) {
        throw new ValidationError(`环节 ${item.item_id} 价格构成不合法`);
    }
    if (!item.accessibility || typeof item.accessibility.wheelchair !== "boolean") {
        throw new ValidationError(`环节 ${item.item_id} 无障碍条件不合法`);
    }
    if (!Array.isArray(item.credentials))
        throw new ValidationError(`环节 ${item.item_id} 资质列表不合法`);
    if (!item.substitution_scope || typeof item.substitution_scope.replaceable !== "boolean") {
        throw new ValidationError(`环节 ${item.item_id} 替代范围不合法`);
    }
}
export { VERSIONED_STATES };
