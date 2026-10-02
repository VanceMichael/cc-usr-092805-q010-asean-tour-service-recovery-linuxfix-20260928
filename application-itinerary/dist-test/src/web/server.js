/**
 * 离线 HTTP 入口：纯 Node 标准库。
 * 页面与表单沿用平台权限模型（游客只能操作自己的订单、供应商只看本方、
 * 高额补偿由独立审核人决定）；所有写操作都带 requestKey 保证重复提交幂等。
 */
import { createServer } from "node:http";
import { AccessContext } from "../platform/access.js";
import { CivicError } from "../platform/errors.js";
import { TravelApp } from "../domain/app.js";
import { seedDemo } from "../domain/seed.js";
import { renderConflicts, renderIndex, renderOperator, renderReviewer, renderSupplier, renderTraveler, } from "./views.js";
import { page } from "./html.js";
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk) => {
            raw += String(chunk);
            if (raw.length > 1_000_000)
                reject(new Error("请求体过大"));
        });
        req.on("end", () => resolve(new URLSearchParams(raw)));
        req.on("error", reject);
    });
}
function sendHtml(res, status, html) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
}
function requestKey(prefix, form) {
    const nonce = form.get("nonce") ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    return `${prefix}:${nonce}`;
}
export function createAppServer(app) {
    return createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://localhost");
            const path = url.pathname;
            if (req.method === "GET") {
                if (path === "/")
                    return sendHtml(res, 200, renderIndex(app));
                if (path === "/operator")
                    return sendHtml(res, 200, renderOperator(app));
                if (path === "/reviewer") {
                    return sendHtml(res, 200, renderReviewer(app, url.searchParams.get("actor") ?? "rv:zhao"));
                }
                if (path === "/conflicts")
                    return sendHtml(res, 200, renderConflicts(app));
                if (path === "/supplier") {
                    const org = url.searchParams.get("org");
                    if (!org)
                        return sendHtml(res, 400, page("参数缺失", "缺少 org 参数"));
                    return sendHtml(res, 200, renderSupplier(app, org));
                }
                if (path === "/traveler") {
                    const booking = url.searchParams.get("booking");
                    if (!booking)
                        return sendHtml(res, 400, page("参数缺失", "缺少 booking 参数"));
                    return sendHtml(res, 200, renderTraveler(app, booking));
                }
                if (path === "/healthz") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ ok: true }));
                }
                return sendHtml(res, 404, page("未找到", "页面不存在"));
            }
            if (req.method !== "POST") {
                return sendHtml(res, 405, page("方法不允许", ""));
            }
            const form = await parseBody(req);
            const actor = form.get("actor") ?? "op:meilin";
            const referer = req.headers.referer ?? "/";
            const redirect = (location) => {
                res.writeHead(303, { Location: location });
                res.end();
            };
            switch (path) {
                // 游客接受/拒绝替代
                case "/traveler/accept": {
                    const recovery = app.recoveries.requireRecovery(form.get("recovery") ?? "");
                    const ctx = AccessContext.traveler(actor, recovery.booking_id);
                    app.recoveries.acceptAlternative(ctx, form.get("recovery") ?? "", form.get("alternative") ?? "", Number(form.get("version") ?? "0"), requestKey("accept", form));
                    return redirect(`/traveler?booking=${encodeURIComponent(recovery.booking_id)}`);
                }
                case "/traveler/reject": {
                    const recovery = app.recoveries.requireRecovery(form.get("recovery") ?? "");
                    const ctx = AccessContext.traveler(actor, recovery.booking_id);
                    app.recoveries.rejectAlternative(ctx, recovery.entity_id, form.get("alternative") ?? "", Number(form.get("version") ?? "0"), requestKey("reject", form), form.get("reason") ?? "");
                    return redirect(`/traveler?booking=${encodeURIComponent(recovery.booking_id)}`);
                }
                // 运营动作
                case "/operator/close-retention": {
                    const ctx = AccessContext.operator(actor);
                    app.recoveries.closeRetentionOnly(ctx, form.get("recovery") ?? "", Number(form.get("version") ?? "0"), requestKey("retention", form), form.get("note") ?? "");
                    return redirect("/operator");
                }
                case "/operator/no-alternative": {
                    const ctx = AccessContext.operator(actor);
                    app.recoveries.settleWithoutAlternative(ctx, form.get("recovery") ?? "", Number(form.get("version") ?? "0"), requestKey("noalt", form), "运营在工作台确认不提供替代");
                    return redirect("/operator");
                }
                case "/operator/prepare-settlement": {
                    const ctx = AccessContext.operator(actor);
                    const recoveryId = form.get("recovery") ?? "";
                    const settlement = app.recoveries.prepareSettlement(ctx, recoveryId, [], requestKey("prepare", form));
                    return redirect(`/traveler?booking=${encodeURIComponent(settlement.booking_id)}`);
                }
                case "/operator/post-settlement": {
                    const ctx = AccessContext.operator(actor);
                    app.recoveries.postSettlement(ctx, form.get("recovery") ?? "", requestKey("post", form));
                    return redirect("/operator");
                }
                case "/operator/reconcile": {
                    const ctx = AccessContext.operator(actor);
                    const recovery = app.recoveries.requireRecovery(form.get("recovery") ?? "");
                    if (recovery.settlement_id)
                        app.recoveries.reconcile(recovery.settlement_id);
                    void ctx;
                    return redirect(referer || "/operator");
                }
                // 高额补偿双人审批
                case "/reviewer/decide": {
                    const ctx = AccessContext.reviewer(actor);
                    app.recoveries.approvals.decide(ctx, form.get("approval") ?? "", {
                        approve: form.get("approve") === "1",
                        note: form.get("note") ?? "",
                        expectedVersion: Number(form.get("version") ?? "0"),
                    }, requestKey("approve", form));
                    return redirect("/reviewer");
                }
                // 供应商回执：相同内容=duplicate；矛盾内容=挂起
                case "/supplier/receipt": {
                    const orgId = form.get("org") ?? "";
                    const kind = form.get("kind") ?? "duplicate";
                    const recoveries = app.recoveries.listForSupplier(orgId);
                    const firstRef = recoveries
                        .flatMap((r) => r.events.flatMap((e) => e.inbox_refs))[0];
                    if (!firstRef)
                        return sendHtml(res, 409, page("没有可重放的回执", "该供应商暂时没有回执。"));
                    const known = app.platform.inbox.timeline(firstRef.source, firstRef.source_key).find((row) => Number(row.sequence) === firstRef.sequence);
                    const basePayload = known ? JSON.parse(String(known.payload_json)) : {};
                    const payload = kind === "conflict" ? { ...basePayload, contradicted_at: new Date().toISOString() } : basePayload;
                    const status = app.platform.inbox.receive({
                        source: firstRef.source,
                        sourceKey: firstRef.source_key,
                        sequence: firstRef.sequence,
                        payload,
                        occurredAt: String(known?.occurred_at ?? new Date().toISOString()),
                    });
                    const note = status.status === "duplicate"
                        ? "回执为重复内容，系统返回 duplicate：未再开恢复单、未触发第二次退款。"
                        : "该序号出现内容矛盾，消息已挂起等待运营核对，业务未推进。";
                    return sendHtml(res, 200, renderSupplier(app, orgId, `${status.status}：${note}`));
                }
                // 矛盾消息核对
                case "/conflicts/resolve": {
                    const resolution = form.get("resolution");
                    app.platform.inbox.resolveConflict(Number(form.get("conflict") ?? "0"), resolution === "discard_incoming" ? "discard_incoming" : "accept_incoming", form.get("actor") ?? "op:meilin");
                    return redirect("/conflicts");
                }
                default:
                    return sendHtml(res, 404, page("未找到", "接口不存在"));
            }
        }
        catch (error) {
            if (error instanceof CivicError) {
                return sendHtml(res, 400, page("操作被拒绝", `<div class="card">${error.message}</div><p><a href="/">返回首页</a></p>`));
            }
            console.error(error);
            return sendHtml(res, 500, page("服务器错误", String(error.message ?? error)));
        }
    });
}
const DB_PATH = process.env.ITINERARY_DB ?? "itinerary.sqlite3";
const PORT = Number(process.env.PPORT ?? process.env.PORT ?? "8080");
if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
    const app = TravelApp.open(DB_PATH, process.env.FIXED_NOW);
    const hasData = app.platform.repository.list("departures", { limit: 1 }).length > 0;
    if (!hasData) {
        const summary = seedDemo(app);
        console.log("已播种演示数据", JSON.stringify(summary, null, 2));
    }
    const resume = app.resume();
    console.log("重启续接", JSON.stringify(resume));
    const server = createAppServer(app);
    server.listen(PORT, () => console.log(`线路恢复应用监听 http://127.0.0.1:${PORT}`));
}
