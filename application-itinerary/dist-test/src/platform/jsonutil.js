/** 稳定 JSON 与摘要，与协同平台 canonical_json/digest_json 对应。 */
import { createHash } from "node:crypto";
import { ValidationError } from "./errors.js";
export function canonicalJson(value) {
    return JSON.stringify(sort(value) ?? null);
}
function sort(value) {
    if (Array.isArray(value))
        return value.map(sort);
    if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = sort(value[key]);
        }
        return out;
    }
    if (value === null || value === undefined)
        return value ?? null;
    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new ValidationError("内容包含非有限数字");
    }
    return value;
}
export function digestJson(value) {
    return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
