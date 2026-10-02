import { ValidationError } from "../platform/errors.js";
const ENTITY_TYPE = "organizations";
export class OrganizationService {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
    create(ctx, values, requestKey) {
        ctx.require("write:organizations");
        validate(values);
        return this.repo.create(ENTITY_TYPE, { ...values, state: values.state ?? "active" }, {
            actor: ctx.actorId,
            requestKey,
        });
    }
    get(orgId) {
        return this.repo.get(ENTITY_TYPE, orgId);
    }
    list() {
        return this.repo.list(ENTITY_TYPE, { limit: 200 });
    }
}
function validate(values) {
    if (!values.name?.trim())
        throw new ValidationError("机构名称不能为空");
    const allowed = [
        "travel_agency",
        "ground_handler",
        "airline",
        "hotel",
        "activity_supplier",
        "transport_supplier",
    ];
    if (!allowed.includes(values.org_type))
        throw new ValidationError("机构类型不合法");
    if (!values.contact?.trim())
        throw new ValidationError("联系方式不能为空");
}
