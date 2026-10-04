const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, ".qa-runtime", `review-guidance-${process.pid}`);
const mime = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json; charset=utf-8" };

function makeBars(count) {
  return Array.from({ length: count }, (_, index) => {
    const close = 20 + Math.sin(index / 17) * 1.5 + index * 0.002;
    const open = close + Math.sin(index / 3) * 0.08;
    return { date: new Date(Date.UTC(2021, 0, index + 1)).toISOString().slice(0, 10), open, high: Math.max(open, close) + 0.12, low: Math.min(open, close) - 0.12, close, volume: 180000 + index % 17 * 12000 };
  });
}

function makeDraft() {
  const bars = makeBars(470);
  const trade = (side, index, j, reason) => ({
    id: `qa-${side}-${index}`, side, index, qty: 1000, price: bars[index].close, fee: 5, cash: 900000,
    reason, indicators: { close: bars[index].close, ma20: bars[index].close * 1.01, k: 12, d: 16, j, volumeRatio: 1.7, volumeSignal: "明显放量", candleDirection: "收阴", chipPeak: bars[index].close * 0.97, chipLower70: bars[index].close * 0.94, chipUpper70: bars[index].close * 1.03, intradayVolumeBars: 0 },
  });
  return {
    format: "kline-training-draft", savedAt: new Date().toISOString(), symbol: "复盘依据验收样例", code: "600000", dataSource: "qa-fixture",
    dataMeta: { provider: "本地验收样例", adjust: "qfq", period: "daily" }, bars, indicatorWarmupBars: [], trainingStartIndex: 40, trainingEndIndex: 219, currentIndex: 219,
    cash: 990000, lots: [], trades: [trade("buy", 80, 6, "低位观察，分批试仓"), trade("sell", 145, 82, "达到计划观察区，先减仓")],
    operationPlans: [{ index: 78, signals: ["KDJ", "量能"], positionCap: 0.1667, reason: "先小仓确认" }], nextSessionChecklist: [], reviewSuggestionSelections: [],
    barNotes: [], reviewNotes: [], avgCost: 20, finished: true, mode: "naked", indicator: "both", showChip: true, showIdentity: false, tradingRule: "a-share",
  };
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) return response.writeHead(404, { "Content-Type": "application/json" }).end("{}");
    const filename = path.resolve(root, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
    if (!filename.startsWith(root)) return response.writeHead(403).end();
    fs.readFile(filename, (error, content) => error ? response.writeHead(404).end() : response.writeHead(200, { "Content-Type": mime[path.extname(filename)] || "application/octet-stream" }).end(content));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((draft) => localStorage.setItem("kline-training-draft", JSON.stringify(draft)), makeDraft());
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    await page.getByText("查看复盘依据与证据状态", { exact: true }).click();
    const evidenceText = await page.locator("#operationReview").innerText();
    if (!evidenceText.includes("个人候选") || !evidenceText.includes("J=6.0") || !evidenceText.includes("J=82.0") || !evidenceText.includes("分时量") || !evidenceText.includes("过程记录")) {
      throw new Error(`复盘依据显示不完整：${evidenceText.slice(0, 1200)}`);
    }
    const desktopWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    if (desktopWidth !== 1366) throw new Error(`桌面出现横向溢出：${desktopWidth}`);
    await page.screenshot({ path: path.join(outputDir, "review-guidance-1366-full-page.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const mobile = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, reviewRules: document.querySelectorAll("#reviewRuleReferences .review-rule-item").length }));
    if (mobile.width !== mobile.viewport || mobile.reviewRules !== 4) throw new Error(`手机布局或依据条目异常：${JSON.stringify(mobile)}`);
    await page.screenshot({ path: path.join(outputDir, "review-guidance-390-full-page.png"), fullPage: true });
    await page.evaluate(() => {
      state.archiveView = true;
      state.archivedReviewRules = { ...window.KLINE_REVIEW_RULESET, version: "old-review-v1" };
      state.finishedRuleSnapshot = state.archivedReviewRules;
      window.KLINE_RESEARCH_STATE = { approved: { "personal-j-low": { id: "personal-j-low", revision: 2, threshold: 5 } } };
      renderReviewRuleReferences();
    });
    await page.locator("[data-compare-review-rules]").click();
    const comparison = await page.locator("#reviewRuleReferences").innerText();
    if (!comparison.includes("old-review-v1") || !comparison.includes("当时触及观察区 → 新版未触及观察区")) throw new Error("历史复盘与新版观察区对照异常");
    if (errors.length) throw new Error(`页面脚本报错：${errors.join(" | ")}`);
    console.log(JSON.stringify({ outputDir, desktopWidth, mobile, checks: ["个人 J 观察区有明确状态", "逐笔显示成交时证据", "分时缺失被明确标示", "桌面与手机无横向溢出", "整页截图已生成"] }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
