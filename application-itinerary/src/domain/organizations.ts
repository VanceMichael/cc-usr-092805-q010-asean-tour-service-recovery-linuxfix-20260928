/** 机构目录：旅行社、地接、航司、酒店、活动与交通供应商。 */
import type { EntityRepository } from "../platform/repository.js";
import { ValidationError } from "../platform/errors.js";
import type { AccessContext } from "../platform/access.js";
import type { Organization } from "./types.js";

const ENTITY_TYPE = "organizations";

export class OrganizationService {
  constructor(private readonly repo: EntityRepository) {}

  create(ctx: AccessContext, values: Organization, requestKey: string) {
    ctx.require("write:organizations");
    validate(values);
    return this.repo.create(ENTITY_TYPE, { ...values, state: values.state ?? "active" }, {
      actor: ctx.actorId,
      requestKey,
    });
  }

  get(orgId: string) {
    return this.repo.get(ENTITY_TYPE, orgId);
  }

  list(): Array<Organization & { entity_id: string; version: number; state: string }> {
    return this.repo.list(ENTITY_TYPE, { limit: 200 }) as unknown as Array<
      Organization & { entity_id: string; version: number; state: string }
    >;
  }
}

function validate(values: Organization): void {
  if (!values.name?.trim()) throw new ValidationError("机构名称不能为空");
  const allowed = [
    "travel_agency",
    "ground_handler",
    "airline",
    "hotel",
    "activity_supplier",
    "transport_supplier",
  ];
  if (!allowed.includes(values.org_type)) throw new ValidationError("机构类型不合法");
  if (!values.contact?.trim()) throw new ValidationError("联系方式不能为空");
}
