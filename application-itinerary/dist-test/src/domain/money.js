/** 金额工具：价格构成合计与展示。 */
export function itemTotal(item) {
    return item.price.base_minor + item.price.surcharge_minor + item.price.tax_minor;
}
export function formatMinor(minor, currency) {
    const sign = minor < 0 ? "-" : "";
    const abs = Math.abs(minor);
    return `${sign}${currency} ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
export function assertNonNegativeMinor(minor, label) {
    if (!Number.isInteger(minor) || minor < 0)
        throw new Error(`${label}必须是非负整数（最小币种单位）`);
}
