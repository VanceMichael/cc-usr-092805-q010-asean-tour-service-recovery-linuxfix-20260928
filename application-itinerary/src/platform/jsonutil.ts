/** 稳定 JSON 与摘要，与协同平台 canonical_json/digest_json 对应。 */
import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sort(value) ?? null);
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sort((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ValidationError("内容包含非有限数字");
  }
  return value;
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
