import { ValidationError } from "../platform/errors.js";
const ENTITY_TYPE = "catalog_services";
export class CatalogService {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
    create(ctx, values, requestKey) {
        ctx.require("write:catalog");
        validate(values);
        return this.repo.create(ENTITY_TYPE, { ...values, state: values.state ?? "active" }, { actor: ctx.actorId, requestKey });
    }
    get(serviceId) {
        return this.repo.get(ENTITY_TYPE, serviceId);
    }
    listBySupplier(orgId) {
        return this.repo.list(ENTITY_TYPE, { limit: 300 }).filter((s) => s.supplier_org_id === orgId);
    }
    active() {
        return this.repo.list(ENTITY_TYPE, { state: "active", limit: 300 });
    }
    /** 供应商退出：目录服务整体撤回。 */
    withdraw(ctx, serviceId, expectedVersion, requestKey, reason) {
        const current = this.get(serviceId);
        ctx.requireOwnOrg(current.supplier_org_id);
        return this.repo.update(ENTITY_TYPE, serviceId, { state: "withdrawn", withdrawn_reason: reason }, { actor: ctx.actorId, expectedVersion, requestKey });
    }
}
function validate(values) {
    if (!values.code?.trim())
        throw new ValidationError("服务代码不能为空");
    if (!values.name?.trim())
        throw new ValidationError("服务名称不能为空");
    if (!values.supplier_org_id?.trim())
        throw new ValidationError("供应机构不能为空");
    if (!Number.isInteger(values.capacity) || values.capacity <= 0) {
        throw new ValidationError("容量必须为正整数");
    }
    const p = values.price;
    if (!p || [p.base_minor, p.surcharge_minor, p.tax_minor].some((v) => !Number.isInteger(v) || v < 0)) {
        throw new ValidationError("价格构成必须为非负整数");
    }
    if (!values.accessibility)
        throw new ValidationError("无障碍条件不能为空");
    if (!Array.isArray(values.credentials))
        throw new ValidationError("资质必须为列表");
}
