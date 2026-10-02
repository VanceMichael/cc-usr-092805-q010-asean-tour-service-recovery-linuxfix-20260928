/** 构造最小批次与订单的测试夹具。 */
import { AccessContext } from "../src/platform/access.js";
import { Platform } from "../src/platform/app.js";
import { TravelApp } from "../src/domain/app.js";
import type { BookingPayload, DeparturePayload, ItineraryItem } from "../src/domain/types.js";

export const NOW = "2026-11-02T10:00:00+07:00";
export const OP = () => AccessContext.operator("op:1");
export const CS = () => AccessContext.operator("cs:2");
export const RV = () => AccessContext.reviewer("rv:3");

let counter = 0;
export function newApp(): { app: TravelApp; org: Record<string, string>; departureId: string } {
  counter += 1;
  const platform = Platform.open(`:memory:`, NOW);
  const app = new TravelApp(platform);
  const org: Record<string, string> = {};
  const addOrg = (key: string, name: string, type: Parameters<TravelApp["organizations"]["create"]>[1]["org_type"]) => {
    org[key] = app.organizations.create(
      OP(),
      { name, org_type: type, contact: `${key}@x.test`, state: "active" },
      `t${counter}:org:${key}`,
    ).entity_id;
  };
  addOrg("air", "航司", "airline");
  addOrg("hotel", "酒店", "hotel");
  addOrg("gh", "地接", "ground_handler");
  addOrg("heritage", "非遗工坊", "activity_supplier");
  addOrg("sight", "观光公司", "activity_supplier");
  addOrg("car", "无障碍车行", "transport_supplier");

  const it = (p: Partial<ItineraryItem> & Pick<ItineraryItem, "item_id" | "title" | "category" | "supplier_org_id" | "start_at" | "end_at">): ItineraryItem => ({
    day: 1,
    service_code: p.item_id!,
    capacity: 10,
    price: { base_minor: 10000, surcharge_minor: 0, tax_minor: 0 },
    accessibility: { wheelchair: true, sensory_friendly: false, notes: "" },
    credentials: ["越南持证导游"],
    substitution_scope: { replaceable: true, same_category_only: p.category === "transport", notes: "" },
    detail: "",
    ...p,
  });

  const flight = it({
    item_id: "flight", category: "transport", title: "去程航班", supplier_org_id: org.air!,
    start_at: "2026-11-10T09:00:00+07:00", end_at: "2026-11-10T11:00:00+07:00",
    price: { base_minor: 20000, surcharge_minor: 0, tax_minor: 0 },
  });
  const hotelItem = it({
    item_id: "hotel1", category: "lodging", title: "酒店第一晚", supplier_org_id: org.hotel!,
    start_at: "2026-11-10T14:00:00+07:00", end_at: "2026-11-11T11:00:00+07:00",
  });
  const workshop = it({
    item_id: "workshop", category: "activity", title: "非遗手作", supplier_org_id: org.heritage!,
    start_at: "2026-11-11T14:00:00+07:00", end_at: "2026-11-11T16:00:00+07:00",
    price: { base_minor: 30000, surcharge_minor: 0, tax_minor: 0 },
    credentials: ["越南持证导游", "非遗传承基地"],
  });
  const car = it({
    item_id: "car", category: "transport", title: "无障碍车", supplier_org_id: org.car!,
    start_at: "2026-11-11T08:00:00+07:00", end_at: "2026-11-11T18:00:00+07:00",
    price: { base_minor: 5000, surcharge_minor: 0, tax_minor: 0 },
  });

  const draft: Omit<DeparturePayload, "state"> = {
    code: `T${counter}`,
    route_name: "测试线路",
    destination_country: "越南",
    depart_at: "2026-11-10T09:00:00+07:00",
    return_at: "2026-11-12T18:00:00+07:00",
    currency: "CNY",
    visa_policy: { type: "电子签", conditions: ["护照 6 个月"], notes: "" },
    guide_requirements: { languages: ["中文"], credentials: ["越南持证导游"] },
    substitution_policy: { allow_category_change: true, preserve_accessibility: true, preserve_credentials: true, notes: "" },
    package_charges: [{ code: "pkg", name: "打包", minor: 65000 }],
    days: [
      { day: 1, date: "2026-11-10", title: "D1", items: [flight, hotelItem] },
      { day: 2, date: "2026-11-11", title: "D2", items: [car, workshop] },
    ],
  };
  const departure = app.departures.createDraft(OP(), draft, `t${counter}:dep`);
  app.departures.publish(OP(), departure.entity_id, 1, `t${counter}:pub`);
  return { app, org, departureId: departure.entity_id };
}

export function book(
  app: TravelApp,
  departureId: string,
  actor: string,
  name: string,
  specialNeeds: Parameters<TravelApp["bookings"]["place"]>[1]["specialNeeds"] = [],
  key: string,
) {
  const b = app.bookings.place(
    OP(),
    { departureId, traveler: { actor, name, contact: `${actor}@x.test`, language: "zh" }, specialNeeds, packageTotalMinor: 65000 },
    `${key}:place`,
  );
  const confirmed = app.bookings.confirm(OP(), b.entity_id, b.version, `${key}:confirm`);
  return confirmed as unknown as BookingPayload & { entity_id: string; version: number };
}
