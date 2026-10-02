/** 线路恢复领域的共享类型。 */

export type OrgType =
  | "travel_agency"
  | "ground_handler"
  | "airline"
  | "hotel"
  | "activity_supplier"
  | "transport_supplier";

export interface Organization {
  name: string;
  org_type: OrgType;
  contact: string;
  state: "active" | "disabled";
}

export type ItemCategory = "transport" | "lodging" | "activity" | "guide" | "meal" | "visa";

/** 逐日行程中的一个供应环节。 */
export interface ItineraryItem {
  item_id: string;
  day: number;
  category: ItemCategory;
  title: string;
  supplier_org_id: string;
  /** transport 时的航班号/车次；activity 时的活动代码。 */
  service_code: string;
  start_at: string;
  end_at: string;
  /** 该批次该环节的总容量。 */
  capacity: number;
  /** 每位游客的价格构成（最小币种单位）。 */
  price: {
    base_minor: number;
    surcharge_minor: number;
    tax_minor: number;
  };
  /** 无障碍条件。 */
  accessibility: {
    wheelchair: boolean;
    sensory_friendly: boolean;
    notes: string;
  };
  /** 导游/活动资质要求或已具资质。 */
  credentials: string[];
  /** 允许的替代范围。 */
  substitution_scope: {
    replaceable: boolean;
    same_category_only: boolean;
    notes: string;
  };
  detail: string;
}

export interface PriceLine {
  code: string;
  name: string;
  minor: number;
}

export interface DeparturePayload {
  code: string;
  route_name: string;
  destination_country: string;
  depart_at: string;
  return_at: string;
  currency: string;
  visa_policy: { type: string; conditions: string[]; notes: string };
  guide_requirements: { languages: string[]; credentials: string[] };
  /** 整团层面的特殊需求与替代总政策。 */
  substitution_policy: {
    allow_category_change: boolean;
    preserve_accessibility: boolean;
    preserve_credentials: boolean;
    notes: string;
  };
  package_charges: PriceLine[];
  days: Array<{ day: number; date: string; title: string; items: ItineraryItem[] }>;
  state: "draft" | "published" | "closed";
}

export interface SpecialNeed {
  code: string;
  detail: string;
  /** 关联的环节（如无障碍交通）。 */
  item_ids: string[];
}

export type ItemFulfillment = "scheduled" | "in_use" | "fulfilled" | "cancelled";

export interface BookingPayload {
  code: string;
  departure_id: string;
  traveler: { actor: string; name: string; contact: string; language: string };
  special_needs: SpecialNeed[];
  /** 确认时冻结的批次完整版本（实际购买版本，之后不再随批次改变）。 */
  frozen_departure_version: number;
  frozen_snapshot: DeparturePayload;
  /** 游客逐环节履约状态：已使用的服务保留原责任。 */
  item_states: Record<string, ItemFulfillment>;
  total_minor: number;
  state: "pending" | "confirmed" | "in_travel" | "completed" | "cancelled";
  confirmed_at: string;
}

export type RecoveryTrigger =
  | "supplier_exit"
  | "capacity_reduction"
  | "destination_risk"
  | "flight_change";

export interface ChangeEvent {
  at: string;
  trigger: RecoveryTrigger;
  actor: string;
  detail: string;
  /** 被波及的批次环节。 */
  affected_item_ids: string[];
  /** 引用的收件箱回执（source/source_key/sequence）。 */
  inbox_refs: Array<{ source: string; source_key: string; sequence: number }>;
}

export interface ComparisonItem {
  original_item_id: string;
  replacement: ItineraryItem;
  time: {
    original_start: string;
    original_end: string;
    replacement_start: string;
    replacement_end: string;
    start_delta_minutes: number;
    duration_delta_minutes: number;
  };
  value: {
    original_total_minor: number;
    replacement_total_minor: number;
    delta_minor: number;
  };
  accessibility: {
    original: ItineraryItem["accessibility"];
    replacement: ItineraryItem["accessibility"];
    required_needs_met: boolean;
    gaps: string[];
  };
}

export interface Alternative {
  alternative_id: string;
  proposed_at: string;
  proposed_by: string;
  expires_at: string;
  rationale: string;
  comparisons: ComparisonItem[];
  status: "proposed" | "accepted" | "rejected" | "expired";
  decided_at: string;
  traveler_note: string;
}

export type SettlementLineKind = "refund" | "supplement" | "voucher" | "compensation";

export interface SettlementLine {
  kind: SettlementLineKind;
  /** refund/supplement/voucher 必须对应被影响的具体环节；compensation 可对应整个恢复单。 */
  item_id: string;
  minor: number;
  reason: string;
  reference: string;
}

export interface NextResponsible {
  party: "traveler" | "reviewer" | "operator" | "airline" | "ground_handler" | "supplier" | "finance";
  org_id: string;
  action: string;
  reason: string;
}

export interface RecoveryPayload {
  booking_id: string;
  departure_id: string;
  title: string;
  trigger: RecoveryTrigger;
  events: ChangeEvent[];
  /** 对本游客实际受影响（尚未履行）的环节；已使用环节单列保留。 */
  affected_item_ids: string[];
  retained_item_ids: string[];
  alternatives: Alternative[];
  active_alternative_id: string;
  settlement_id: string;
  next_responsible: NextResponsible;
  state:
    | "opened"
    | "alternative_pending"
    | "awaiting_review"
    | "ready_to_settle"
    | "settled"
    | "closed";
  state_reason: string;
}

export interface CompensationApprovalPayload {
  recovery_id: string;
  booking_id: string;
  amount_minor: number;
  currency: string;
  reason: string;
  submitter: string;
  reviewer: string;
  decision_note: string;
  state: "pending" | "approved" | "rejected";
  decided_at: string;
}

export interface SettlementPayload {
  recovery_id: string;
  booking_id: string;
  currency: string;
  lines: SettlementLine[];
  totals: Record<SettlementLineKind, number>;
  approval_id: string;
  entries: Array<{ entry_id: string; kind: SettlementLineKind; reference: string }>;
  state: "prepared" | "approved" | "posted" | "verified";
  prepared_by: string;
  posted_at: string;
  last_reconciled_at: string;
  last_reconcile_result: string;
}

export interface CatalogServicePayload {
  code: string;
  name: string;
  category: ItemCategory;
  supplier_org_id: string;
  capacity: number;
  price: { base_minor: number; surcharge_minor: number; tax_minor: number };
  accessibility: ItineraryItem["accessibility"];
  credentials: string[];
  detail: string;
  state: "active" | "withdrawn";
}
