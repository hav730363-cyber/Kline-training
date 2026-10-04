const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const out = path.join(root, ".qa-runtime", `research-dashboard-${process.pid}`);
const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };
const mockStatus = { state: "paused", reason: "试跑完成，可继续", counts: { complete: 5, pending: 6665 }, events: 743, intradayDays: 5, dates: { start: "2021-09-28", developmentEnd: "2024-09-27", validationEnd: "2025-09-27", end: "2026-09-27" }, ruleValidation: { state: "idle" } };
const mockReport = { status: "partial", coverage: { universe: 6670, processed: 5, excluded: { stDays: 2, unknownStatusDays: 1 }, dates: mockStatus.dates },
  intradayCoverage: { complete: 5 }, dailyCoverage: [{ kind: "stock", symbols: 3, days: 3800, firstDate: "2021-09-28", lastDate: "2026-09-25" }, { kind: "etf", symbols: 2, days: 356, firstDate: "2026-04-08", lastDate: "2026-09-25" }],
  intradaySampling: "每标的每规则每时间分段取首个候选日，最多12日。", groups: [{ ruleId: "personal-j-low", revision: 1, kind: "stock", split: "holdout", signals: 21, symbols: 3, evidence: "证据不足", missingOutcomes: 1, horizons: { 5: { count: 20, meanNet: .011, downsideRate: .4 }, 10: { count: 19, meanNet: .02, downsideRate: .35 }, 20: { count: 18, meanNet: .025, downsideRate: .3, p10Net: -.06 } } }] };
const mockRules = { rules: [{ id: "personal-j-low", revision: 1, title: "J 低位观察", approved: false, threshold: 10 }] };

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const payload = url.pathname === "/api/research/status" ? mockStatus : url.pathname === "/api/research/report" ? mockReport : url.pathname === "/api/research/rules" ? mockRules : null;
    if (payload) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
    if (url.pathname.startsWith("/api/")) return res.writeHead(404, { "Content-Type": "application/json" }).end("{}");
    const filename = path.resolve(root, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
    if (!filename.startsWith(root)) return res.writeHead(403).end();
    fs.readFile(filename, (error, content) => error ? res.writeHead(404).end() : res.writeHead(200, { "Content-Type": mime[path.extname(filename)] || "application/octet-stream" }).end(content));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    await page.getByText("试跑完成，可继续").waitFor();
    const desktop = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, text: document.querySelector("#researchPanel").innerText }));
    if (desktop.width !== desktop.viewport || !desktop.text.includes("ETF 2只/356交易日") || !desktop.text.includes("证据不足")) throw new Error(`桌面布局或状态异常：${JSON.stringify(desktop)}`);
    await page.screenshot({ path: path.join(out, "research-1366-full-page.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, buttons: [...document.querySelectorAll(".research-actions button:not([hidden])")].every((button) => button.getBoundingClientRect().width > 45) }));
    if (mobile.width !== mobile.viewport || !mobile.buttons) throw new Error(`手机布局异常：${JSON.stringify(mobile)}`);
    await page.screenshot({ path: path.join(out, "research-390-full-page.png"), fullPage: true });
    if (errors.length) throw new Error(`页面脚本错误：${errors.join(" | ")}`);
    console.log(JSON.stringify({ out, desktopWidth: desktop.width, mobile, checks: ["规则报告与覆盖缺口", "桌面手机无横向溢出", "整页截图"] }, null, 2));
  } finally { await browser.close(); server.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
