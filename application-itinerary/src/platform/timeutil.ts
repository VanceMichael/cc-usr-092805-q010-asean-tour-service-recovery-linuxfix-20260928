/** ISO 8601 带时区时间与可注入时钟，与协同平台 timeutil 对应。 */
import { ValidationError } from "./errors.js";

export function parseInstant(value: string): Date {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError("时间不能为空");
  const normalized = value.trim().replace(/Z$/, "+00:00");
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) throw new ValidationError("时间必须使用 ISO 8601 格式");
  const date = new Date(ms);
  if (!normalized.includes("+") && !normalized.includes("-", 10)) {
    throw new ValidationError("时间必须包含时区");
  }
  return date;
}

export function canonicalInstant(value: string): string {
  return parseInstant(value).toISOString().replace(/\.000Z$/, "Z");
}

export function nowUtc(): string {
  return new Date().toISOString().replace(/\.000Z$/, "Z");
}

export class Clock {
  constructor(private readonly fixed?: string) {}

  now(): string {
    return this.fixed ? canonicalInstant(this.fixed) : nowUtc();
  }

  isDue(dueAt: string): boolean {
    return parseInstant(dueAt).getTime() <= parseInstant(this.now()).getTime();
  }
}
