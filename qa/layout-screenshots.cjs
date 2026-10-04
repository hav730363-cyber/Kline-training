const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outputDir = process.env.LAYOUT_QA_OUTPUT || path.join(root, ".qa-runtime", "layout-qa");
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function makeBars(startIndex, count) {
  return Array.from({ length: count }, (_, index) => {
    const absoluteIndex = startIndex + index;
    const base = 15 + absoluteIndex * 0.012 + Math.sin(absoluteIndex / 9) * 0.45 + Math.cos(absoluteIndex / 19) * 0.3;
    const open = base + Math.sin(absoluteIndex / 4) * 0.12;
    const close = base + Math.cos(absoluteIndex / 5) * 0.16;
    const day = new Date(Date.UTC(2024, 0, absoluteIndex + 1)).toISOString().slice(0, 10);
    return {
      date: day,
      open: Number(open.toFixed(3)),
      high: Number((Math.max(open, close) + 0.18).toFixed(3)),
      low: Number((Math.min(open, close) - 0.17).toFixed(3)),
      close: Number(close.toFixed(3)),
      volume: 100000 + (absoluteIndex % 17) * 6800,
    };
  });
}

function makeDraft() {
  const bars = makeBars(250, 220);
  const warmup = makeBars(0, 250);
  const markerIndex = 112;
  const firstPrice = bars[markerIndex].close;
  const secondPrice = bars[markerIndex + 1].close;
  return {
    format: "kline-training-draft",
    savedAt: new Date().toISOString(),
    symbol: "布局验收样例",
    code: "600000",
    dataSource: "qa-fixture",
    dataMeta: { provider: "本地验收样例", adjust: "qfq", period: "daily" },
    bars,
    indicatorWarmupBars: warmup,
    trainingStartIndex: 40,
    trainingEndIndex: 219,
    currentIndex: 140,
    cash: 950000,
    lots: [{ index: markerIndex, qty: 500, price: firstPrice, feePerShare: 0.01 }],
    trades: [
      { side: "buy", qty: 300, price: firstPrice, fee: 5, commission: 5, stampDuty: 0, transferFee: 0, cash: 995000, index: markerIndex },
      { side: "buy", qty: 200, price: firstPrice, fee: 5, commission: 5, stampDuty: 0, transferFee: 0, cash: 990000, index: markerIndex },
      { side: "sell", qty: 100, price: secondPrice, fee: 5, commission: 5, stampDuty: 1, transferFee: 0, cash: 991000, index: markerIndex + 1 },
    ],
    avgCost: firstPrice,
    finished: false,
    mode: "naked",
    indicator: "both",
    showChip: true,
    showIdentity: false,
    tradingRule: "a-share",
  };
}

function serveStatic() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "静态页面验收不启用行情接口" }));
      return;
    }
    const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filename = path.resolve(root, `.${requested}`);
    const relative = path.relative(root, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      response.writeHead(403).end();
      return;
    }
    fs.readFile(filename, (error, content) => {
      if (error) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filename)] || "application/octet-stream" });
      response.end(content);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const { server, url } = await serveStatic();
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript((draft) => localStorage.setItem("kline-training-draft", JSON.stringify(draft)), makeDraft());
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);

    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 900 },
      { width: 1100, height: 900 },
      { width: 1000, height: 900 },
      { width: 390, height: 844 },
    ];
    const measurements = [];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(120);
      const layout = await page.evaluate(() => {
        const box = (selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        };
        const chart = box(".chart-panel");
        const rail = box(".side-column");
        return {
          viewport: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          chart,
          rail,
          trade: box(".trade-panel"),
          indicators: box(".indicator-panel"),
          log: box(".log-panel"),
          replay: box(".replay-panel"),
          tradeCards: document.querySelectorAll(".trade-log-item").length,
          tradeLogWidth: (() => {
            const list = document.querySelector(".trade-log-list");
            return { client: list.clientWidth, scroll: list.scrollWidth };
          })(),
          keyReadings: ["ma5Value", "ma20Value", "ma60Value", "macdValue", "kdjValue"].map((id) => document.getElementById(id).textContent),
        };
      });
      const expectedParallel = viewport.width > 760;
      if (layout.documentWidth > viewport.width + 1) throw new Error(`页面横向溢出：${viewport.width}px，内容宽 ${layout.documentWidth}px`);
      if (layout.tradeLogWidth.scroll > layout.tradeLogWidth.client + 1) throw new Error(`交易记录卡片横向溢出：${viewport.width}px`);
      if (expectedParallel && layout.rail.x <= layout.chart.x) throw new Error(`右栏未与图表并排：${viewport.width}px`);
      if (!expectedParallel && layout.rail.y <= layout.chart.y) throw new Error(`窄屏右栏未下移：${viewport.width}px`);
      if (layout.tradeCards !== 3) throw new Error(`交易记录卡片数量异常：${layout.tradeCards}`);
      if (layout.keyReadings.some((value) => value === "—")) throw new Error(`验收样例指标缺失：${layout.keyReadings.join(", ")}`);
      measurements.push(layout);
      const screenshotPath = path.join(outputDir, `layout-${viewport.width}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" });
    }

    await page.setViewportSize({ width: 1366, height: 900 });
    await page.locator('[data-quick-side="buy"][data-divisor="6"]').click();
    const quickQty = Number(await page.locator("#quantityInput").inputValue());
    if (quickQty < 100 || quickQty % 100 !== 0) throw new Error(`分仓数量不是100股整数倍：${quickQty}`);
    await page.locator("#buyButton").click();
    if (await page.locator(".trade-log-item").count() !== 4) throw new Error("买入后交易记录没有增加");

    const backup = {
      format: "kline-training-session",
      version: 2,
      symbol: "布局验收备份恢复",
      code: "600000",
      dataSource: "qa-fixture",
      dataMeta: { provider: "本地验收样例", adjust: "qfq", period: "daily" },
      bars: makeBars(250, 220),
      indicatorWarmupBars: makeBars(0, 250),
      trainingStartIndex: 40,
      trainingEndIndex: 219,
      currentIndex: 140,
      cash: 950000,
      lots: [],
      trades: [],
      avgCost: 0,
      finished: false,
      mode: "naked",
      indicator: "both",
      showChip: true,
      showIdentity: false,
      tradingRule: "a-share",
      candidateSamples: [],
      collectedSamples: [],
      activeTrainingSample: null,
      trainingArea: "indicator",
    };
    await page.locator("#backupFileInput").setInputFiles({
      name: "layout-qa-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await page.waitForFunction(() => document.getElementById("dataStatus").textContent.includes("已恢复 布局验收备份恢复"));
    if (!(await page.locator("#dataStatus").textContent()).includes("布局验收备份恢复")) throw new Error("训练备份导入后标的未恢复");
    if (pageErrors.length) throw new Error(`页面运行错误：${pageErrors.join("；")}`);

    console.log(JSON.stringify({ screenshots: outputDir, measurements, interactions: ["分仓股数", "买入记录更新", "训练备份恢复"], pageErrors }, null, 2));
    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
