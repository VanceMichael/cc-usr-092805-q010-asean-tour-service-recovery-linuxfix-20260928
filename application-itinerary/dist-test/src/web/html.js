/** HTML 转义与小片段。 */
export function esc(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
export function money(minor, currency) {
    const sign = minor < 0 ? "-" : "";
    const abs = Math.abs(minor);
    return `${sign}${currency} ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
export const STYLES = `
:root { --ink:#1f2933; --muted:#64707d; --line:#d9dee3; --bg:#f5f7f9; --brand:#0f6b5c; --warn:#b05400; --bad:#9c2b2b; --ok:#1c6b3b; }
* { box-sizing:border-box; }
body { margin:0; font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif; color:var(--ink); background:var(--bg); }
header { background:var(--brand); color:#fff; padding:14px 24px; display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; }
header a { color:#dff1ec; text-decoration:none; }
header a:hover { text-decoration:underline; }
main { max-width:1080px; margin:0 auto; padding:20px 24px 60px; }
h1 { font-size:20px; margin:0; }
h2 { font-size:16px; margin:26px 0 10px; border-left:4px solid var(--brand); padding-left:8px; }
h3 { font-size:14px; margin:16px 0 6px; }
table { border-collapse:collapse; width:100%; background:#fff; font-size:13px; }
th,td { border:1px solid var(--line); padding:7px 9px; text-align:left; vertical-align:top; }
th { background:#eef2f4; font-weight:600; }
.card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin:12px 0; }
.muted { color:var(--muted); font-size:12px; }
.badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; background:#e6ecef; color:var(--ink); }
.badge.warn { background:#fdebd7; color:var(--warn); }
.badge.bad { background:#f8e1e1; color:var(--bad); }
.badge.ok { background:#dff2e5; color:var(--ok); }
form { display:inline; }
button, .btn { border:1px solid var(--brand); background:var(--brand); color:#fff; padding:5px 12px; border-radius:5px; font-size:13px; cursor:pointer; }
button.secondary { background:#fff; color:var(--brand); }
button.danger { border-color:var(--bad); background:var(--bad); }
input[type=text],textarea,select { padding:4px 8px; border:1px solid var(--line); border-radius:4px; font-size:13px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
ul.tight { margin:6px 0; padding-left:18px; }
ul.tight li { margin:2px 0; }
.kvs td:first-child { width:170px; background:#fafbfc; color:var(--muted); }
.delta-pos { color:var(--bad); } .delta-neg { color:var(--ok); }
@media (max-width:760px){ .grid2{grid-template-columns:1fr} }
`;
export function page(title, body) {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLES}</style></head>
<body>
<header>
  <h1>线路版本与服务恢复平台</h1>
  <a href="/">首页</a>
  <a href="/operator">运营工作台</a>
  <a href="/reviewer">补偿审核台</a>
  <a href="/conflicts">矛盾消息核对（运营）</a>
</header>
<main>
${body}
</main></body></html>`;
}
