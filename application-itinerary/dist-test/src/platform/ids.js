/** 实体标识，与协同平台 identifiers 对应。 */
import { randomUUID } from "node:crypto";
import { ValidationError } from "./errors.js";
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function newId(prefix) {
    if (!SAFE.test(prefix))
        throw new ValidationError("标识前缀不合法");
    return `${prefix}:${randomUUID().replace(/-/g, "")}`;
}
export function requireSafe(value, label = "标识") {
    if (typeof value !== "string" || !SAFE.test(value.trim())) {
        throw new ValidationError(`${label}不合法`);
    }
    return value.trim();
}
