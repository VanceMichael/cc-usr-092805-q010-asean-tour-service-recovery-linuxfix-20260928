/**
 * 越南小众线路离线演示数据：
 * - 同团三位（另加一位已结案）游客：A 尚未使用任何服务；B 已入住第一晚酒店；
 *   C 依赖轮椅无障碍交通；D 的恢复已全额退款并对账通过；
 * - 航班 VN553 改期 + 非遗供应（东湖版画工坊）退出；
 * - 运营已为 A 提出替代（改期航班 + 普通观光），等待 A 确认；
 * - A 的航班恢复单挂着一笔 600.00 高额补偿，等待独立审核人。
 */
import { AccessContext } from "../platform/access.js";
const OPERATOR = AccessContext.operator("op:meilin");
const CS = AccessContext.operator("cs:li");
function item(partial) {
    return partial;
}
export function seedDemo(app) {
    const orgIds = {};
    const addOrg = (key, name, type, contact) => {
        const entity = app.organizations.create(OPERATOR, { name, org_type: type, contact, state: "active" }, `seed:org:${key}`);
        orgIds[key] = entity.entity_id;
    };
    addOrg("ta", "同行者旅行社", "travel_agency", "ops@ta.example");
    addOrg("air", "越南航空承运方", "airline", "ops@air.example");
    addOrg("hotel", "还剑湖精品酒店", "hotel", "front@hotel.example");
    addOrg("gh", "河内本地地接社", "ground_handler", "gh@hanoi.example");
    addOrg("heritage", "东湖民间版画工坊", "activity_supplier", "art@dongho.example");
    addOrg("sight", "升龙观光服务公司", "activity_supplier", "tours@thanglong.example");
    addOrg("transit", "顺安无障碍车行", "transport_supplier", "ride@thuanan.example");
    const flightOut = item({
        item_id: "flight-vn553",
        day: 1,
        category: "transport",
        title: "VN553 飞河内（原 09:20 起飞）",
        supplier_org_id: orgIds.air,
        service_code: "VN553",
        start_at: "2026-11-10T09:20:00+07:00",
        end_at: "2026-11-10T10:50:00+07:00",
        capacity: 12,
        price: { base_minor: 180000, surcharge_minor: 12000, tax_minor: 8000 },
        accessibility: { wheelchair: true, sensory_friendly: false, notes: "窄体客机，可申请轮椅服务" },
        credentials: ["航司运营资质"],
        substitution_scope: { replaceable: true, same_category_only: true, notes: "只能改为其他航班" },
        detail: "南宁—河内直飞",
    });
    const hotelNight1 = item({
        item_id: "hotel-night1",
        day: 1,
        category: "lodging",
        title: "还剑湖精品酒店 第1晚（含早）",
        supplier_org_id: orgIds.hotel,
        service_code: "HK-STD",
        start_at: "2026-11-10T14:00:00+07:00",
        end_at: "2026-11-11T11:00:00+07:00",
        capacity: 12,
        price: { base_minor: 42000, surcharge_minor: 0, tax_minor: 3000 },
        accessibility: { wheelchair: true, sensory_friendly: true, notes: "有无障碍客房" },
        credentials: ["旅游住宿登记"],
        substitution_scope: { replaceable: true, same_category_only: true, notes: "同等或更高标准酒店" },
        detail: "双人间",
    });
    const accessibleCar = item({
        item_id: "car-day2",
        day: 2,
        category: "transport",
        title: "无障碍商务车 河内—宁平往返",
        supplier_org_id: orgIds.transit,
        service_code: "TA-WAV-02",
        start_at: "2026-11-11T08:00:00+07:00",
        end_at: "2026-11-11T18:00:00+07:00",
        capacity: 4,
        price: { base_minor: 60000, surcharge_minor: 0, tax_minor: 0 },
        accessibility: { wheelchair: true, sensory_friendly: false, notes: "配备轮椅升降台与固定装置" },
        credentials: ["营运资质", "无障碍车辆年检"],
        substitution_scope: { replaceable: true, same_category_only: true, notes: "必须同等无障碍条件" },
        detail: "含司机",
    });
    const heritageWorkshop = item({
        item_id: "heritage-dongho",
        day: 2,
        category: "activity",
        title: "非遗体验：东湖民间版画工坊（含手作）",
        supplier_org_id: orgIds.heritage,
        service_code: "DH-WS",
        start_at: "2026-11-11T14:00:00+07:00",
        end_at: "2026-11-11T16:30:00+07:00",
        capacity: 12,
        price: { base_minor: 26000, surcharge_minor: 0, tax_minor: 1000 },
        accessibility: { wheelchair: false, sensory_friendly: true, notes: "工坊为平房，无台阶" },
        credentials: ["非遗传承基地", "越南持证导游"],
        substitution_scope: { replaceable: true, same_category_only: false, notes: "可改为河内市区同类文化观光" },
        detail: "传承人带领印制版画",
    });
    const cityTour = item({
        item_id: "sight-oldquarter",
        day: 3,
        category: "activity",
        title: "老城区步行导览",
        supplier_org_id: orgIds.gh,
        service_code: "GH-OQ",
        start_at: "2026-11-12T09:00:00+07:00",
        end_at: "2026-11-12T12:00:00+07:00",
        capacity: 12,
        price: { base_minor: 15000, surcharge_minor: 0, tax_minor: 0 },
        accessibility: { wheelchair: false, sensory_friendly: false, notes: "石板路" },
        credentials: ["越南持证导游"],
        substitution_scope: { replaceable: true, same_category_only: false, notes: "" },
        detail: "地接导游带队",
    });
    const departureDraft = {
        code: "VN-NICHE-20261110",
        route_name: "越南河内·宁平小众文化四日",
        destination_country: "越南",
        depart_at: "2026-11-10T09:20:00+07:00",
        return_at: "2026-11-13T20:00:00+07:00",
        currency: "CNY",
        visa_policy: {
            type: "越南电子签 e-visa",
            conditions: ["有效期 6 个月以上护照", "提前至少 7 个工作日申请", "打印电子签批文随身携带"],
            notes: "航班改期不改变入境条件，但若延后超过批文生效日需重新申请",
        },
        guide_requirements: { languages: ["中文", "越南语"], credentials: ["越南持证导游", "非遗基地讲解备案"] },
        substitution_policy: {
            allow_category_change: true,
            preserve_accessibility: true,
            preserve_credentials: true,
            notes: "跨类替代须运营经理审批；无障碍与资质条件不得降级",
        },
        package_charges: [
            { code: "land", name: "地面服务", minor: 42000 },
            { code: "air", name: "国际机票", minor: 200000 },
            { code: "guide", name: "导游与资质", minor: 18000 },
        ],
        days: [
            { day: 1, date: "2026-11-10", title: "抵达河内", items: [flightOut, hotelNight1] },
            { day: 2, date: "2026-11-11", title: "宁平与非遗", items: [accessibleCar, heritageWorkshop] },
            { day: 3, date: "2026-11-12", title: "河内文化", items: [cityTour] },
            {
                day: 4,
                date: "2026-11-13",
                title: "返程",
                items: [
                    item({
                        item_id: "flight-vn554",
                        day: 4,
                        category: "transport",
                        title: "VN554 返程",
                        supplier_org_id: orgIds.air,
                        service_code: "VN554",
                        start_at: "2026-11-13T15:30:00+07:00",
                        end_at: "2026-11-13T18:10:00+07:00",
                        capacity: 12,
                        price: { base_minor: 180000, surcharge_minor: 12000, tax_minor: 8000 },
                        accessibility: { wheelchair: true, sensory_friendly: false, notes: "" },
                        credentials: ["航司运营资质"],
                        substitution_scope: { replaceable: true, same_category_only: true, notes: "" },
                        detail: "河内—南宁",
                    }),
                ],
            },
        ],
    };
    const departure = app.departures.createDraft(OPERATOR, departureDraft, "seed:departure:1");
    app.departures.publish(OPERATOR, departure.entity_id, 1, "seed:departure:publish");
    const departureId = departure.entity_id;
    const totalMinor = departureDraft.package_charges.reduce((s, c) => s + c.minor, 0);
    const placeAndConfirm = (actor, name, specialNeeds, key) => {
        const booking = app.bookings.place(OPERATOR, {
            departureId,
            traveler: { actor, name, contact: `${actor}@traveler.example`, language: "zh" },
            specialNeeds,
            packageTotalMinor: totalMinor,
        }, `seed:booking:place:${key}`);
        const confirmed = app.bookings.confirm(OPERATOR, booking.entity_id, booking.version, `seed:booking:confirm:${key}`);
        return confirmed;
    };
    const bookingA = placeAndConfirm("t:an", "安然", [], "an");
    const bookingB = placeAndConfirm("t:bei", "贝宁", [
        { code: "meal-halal", detail: "清真餐", item_ids: [] },
    ], "bei");
    const bookingC = placeAndConfirm("t:cen", "岑溪", [
        { code: "wheelchair", detail: "全程依赖轮椅，需要无障碍车辆", item_ids: ["car-day2"] },
    ], "cen");
    const bookingD = placeAndConfirm("t:duan", "段雨", [], "duan");
    // B 已实际入住第 1 晚酒店：该服务已经使用。
    app.bookings.markFulfillment(OPERATOR, bookingB.entity_id, "hotel-night1", "in_use", bookingB.version, "seed:bei:hotel");
    // 外部回执 1：航司通知 VN553 改期（同团全员航班未履行）。
    const flightIngest = app.recoveries.ingest(OPERATOR, {
        departureId,
        trigger: "flight_change",
        detail: "越南航空通知 VN553 由 09:20 改期为 11:40，到达顺延 2 小时 20 分",
        receipt: {
            source: "airline",
            sourceKey: "VN553",
            sequence: 1,
            occurredAt: "2026-11-02T08:00:00+07:00",
            payload: { flight: "VN553", new_depart: "11:40", reason: "机型调度" },
        },
        target: { serviceCodes: ["VN553"] },
    }, "seed:ingest:flight");
    // 外部回执 2：非遗工坊退出（导游与活动供应变化）。
    const heritageIngest = app.recoveries.ingest(OPERATOR, {
        departureId,
        trigger: "supplier_exit",
        detail: "东湖版画工坊通知本季停止团队接待，未履行场次全部退出",
        receipt: {
            source: "ground_handler",
            sourceKey: "DH-WS",
            sequence: 1,
            occurredAt: "2026-11-02T09:30:00+07:00",
            payload: { supplier: "dongho", items: ["DH-WS"] },
        },
        target: { supplierOrgId: orgIds.heritage },
    }, "seed:ingest:heritage");
    // 外部回执 3：目的地风险通告，仅定向 B（已入住酒店）：
    // 酒店已经使用，只保留原责任，不退款、不替代，运营评估后归档。
    const riskIngest = app.recoveries.ingest(OPERATOR, {
        departureId,
        trigger: "destination_risk",
        detail: "河内发布暴雨内涝黄色提示，地接评估已入住酒店区域不受影响",
        receipt: {
            source: "official_advisory",
            sourceKey: "hanoi-flood-20261110",
            sequence: 1,
            occurredAt: "2026-11-10T19:00:00+07:00",
            payload: { level: "yellow", area: "old_quarter", hotel_affected: false },
        },
        target: { itemIds: ["hotel-night1"], bookingIds: [bookingB.entity_id] },
    }, "seed:ingest:risk:bei");
    for (const recoveryId of riskIngest.recoveries) {
        const recovery = app.recoveries.requireRecovery(recoveryId);
        app.recoveries.closeRetentionOnly(OPERATOR, recoveryId, recovery.version, `seed:bei:risk:close:${recoveryId.slice(-6)}`, "酒店区域不在受淹范围，已入住服务继续按原合同由酒店承担");
    }
    // D 的两个恢复单：不提供替代，全额退款、过账并对账（演示已结案路径）。
    const dRecoveries = app.recoveries
        .listForBooking(bookingD.entity_id)
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    for (const [index, recovery] of dRecoveries.entries()) {
        app.recoveries.settleWithoutAlternative(OPERATOR, recovery.entity_id, recovery.version, `seed:duan:noalt:${index}`, "游客选择不再等待替代安排");
        const settlement = app.recoveries.prepareSettlement(OPERATOR, recovery.entity_id, [], `seed:duan:settle:${index}`);
        app.recoveries.postSettlement(OPERATOR, recovery.entity_id, `seed:duan:post:${index}`);
        app.recoveries.reconcile(settlement.entity_id);
    }
    // A：运营提出两个待确认替代（改期航班同价；非遗换成普通观光，价值更低）。
    const aRecoveries = app.recoveries
        .listForBooking(bookingA.entity_id)
        .sort((x, y) => (x.trigger === "flight_change" ? -1 : 1));
    const flightRecovery = aRecoveries.find((r) => r.trigger === "flight_change");
    const heritageRecovery = aRecoveries.find((r) => r.trigger === "supplier_exit");
    app.recoveries.proposeAlternative(OPERATOR, flightRecovery.entity_id, {
        rationale: "航司保护到同日 11:40 航班，时刻顺延但服务标准不变",
        expiresAt: "2026-11-05T18:00:00+07:00",
        mappings: [
            {
                originalItemId: "flight-vn553",
                replacement: item({
                    item_id: "flight-vn553-r",
                    day: 1,
                    category: "transport",
                    title: "VN553R 飞河内（改期 11:40）",
                    supplier_org_id: orgIds.air,
                    service_code: "VN553R",
                    start_at: "2026-11-10T11:40:00+07:00",
                    end_at: "2026-11-10T13:10:00+07:00",
                    capacity: 12,
                    price: { base_minor: 180000, surcharge_minor: 12000, tax_minor: 8000 },
                    accessibility: { wheelchair: true, sensory_friendly: false, notes: "可申请轮椅服务" },
                    credentials: ["航司运营资质"],
                    substitution_scope: { replaceable: true, same_category_only: true, notes: "" },
                    detail: "改期航班",
                }),
            },
        ],
    }, "seed:an:alt:flight");
    app.recoveries.proposeAlternative(OPERATOR, heritageRecovery.entity_id, {
        rationale: "统一改为升龙文庙—国子监文化观光，同为文化类，价值更低部分按环节退差",
        expiresAt: "2026-11-05T18:00:00+07:00",
        mappings: [
            {
                originalItemId: "heritage-dongho",
                replacement: item({
                    item_id: "sight-temple-lit",
                    day: 2,
                    category: "activity",
                    title: "普通观光：文庙—国子监文化讲解",
                    supplier_org_id: orgIds.sight,
                    service_code: "TL-VM",
                    start_at: "2026-11-11T14:00:00+07:00",
                    end_at: "2026-11-11T16:00:00+07:00",
                    capacity: 12,
                    price: { base_minor: 14000, surcharge_minor: 0, tax_minor: 0 },
                    accessibility: { wheelchair: true, sensory_friendly: false, notes: "主要区域可通行轮椅" },
                    credentials: ["越南持证导游"],
                    substitution_scope: { replaceable: true, same_category_only: false, notes: "" },
                    detail: "观光讲解，不含手作材料",
                }),
            },
        ],
    }, "seed:an:alt:heritage");
    // A 的航班改期：客服发起高额补偿 600.00，等待另一名审核人员确认。
    const approval = app.recoveries.requestCompensation(CS, flightRecovery.entity_id, 60000, "航班改期导致中转等待与地面交通改签，客服按关怀政策申请高额补偿", "seed:an:comp:flight");
    const allBookings = [
        { entity: bookingA, name: "安然" },
        { entity: bookingB, name: "贝宁" },
        { entity: bookingC, name: "岑溪" },
        { entity: bookingD, name: "段雨" },
    ];
    const recoveryRows = [
        ...app.recoveries.listForBooking(bookingA.entity_id),
        ...app.recoveries.listForBooking(bookingB.entity_id),
        ...app.recoveries.listForBooking(bookingC.entity_id),
        ...app.recoveries.listForBooking(bookingD.entity_id),
    ];
    const nameByBooking = new Map(allBookings.map((b) => [b.entity.entity_id, b.name]));
    return {
        orgs: orgIds,
        departureId,
        bookings: allBookings.map((b) => ({
            bookingId: b.entity.entity_id,
            actor: b.entity.traveler.actor,
            name: b.name,
            code: b.entity.code,
        })),
        recoveries: recoveryRows.map((r) => ({
            recoveryId: r.entity_id,
            traveler: nameByBooking.get(r.booking_id) ?? r.booking_id,
            trigger: r.trigger,
            state: r.state,
        })),
        approvalId: approval.entity_id,
    };
}
