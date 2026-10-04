const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, ".qa-runtime", "intraday-price-volume");
const mimeTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json; charset=utf-8" };
const times = [
  ...Array.from({ length: 5 }, (_, i) => `09:${String(35 + i * 5).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, i) => `10:${String(i * 5).padStart(2, "0")}`),
  ...Array.from({ length: 7 }, (_, i) => `11:${String(i * 5).padStart(2, "0")}`),
  ...Array.from({ length: 11 }, (_, i) => `13:${String(5 + i * 5).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, i) => `14:${String(i * 5).padStart(2, "0")}`),
  "15:00",
];

function makeDailyBars(count = 220) {
  const dates = [];
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (let i = 0; i < count; i += 1) {
    dates.unshift(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates.map((date, index) => {
    const close = index === count - 2 ? 10 : index === count - 1 ? 10.1 : 9.8 + index * 0.001;
    return { date, open: close - .04, high: close + .12, low: close - .12, close, volume: 600000 + index * 1300 };
  });
}

function makeIntradayBars({ omitClose = false, zeroVolumeIndex = 20, finalClose = 10.1 } = {}) {
  const close = finalClose;
  return times.filter((time) => !(omitClose && time === "15:00")).map((time, index) => {
    const price = close - .12 + (index / (times.length - 1)) * .12 + Math.sin(index / 4) * .025;
    const barClose = time === "15:00" ? close : price;
    const open = barClose + (index % 2 ? -.012 : .012);
    return {
      time,
      open: Number(open.toFixed(3)),
      high: Number((Math.max(open, barClose) + .015).toFixed(3)),
      low: Number((Math.min(open, barClose) - .015).toFixed(3)),
      close: Number(barClose.toFixed(3)),
      volume: index === zeroVolumeIndex ? 0 : 28000 + (index % 9) * 7500,
    };
  });
}

function makeDraft({ adjustedCurrentClose = 10.1, adjustedPreviousClose = 10 } = {}) {
  const bars = makeDailyBars();
  for (const [bar, close] of [[bars.at(-2), adjustedPreviousClose], [bars.at(-1), adjustedCurrentClose]]) {
    bar.open = close - .04;
    bar.high = close + .12;
    bar.low = close - .12;
    bar.close = close;
  }
  return {
    format: "kline-training-draft", savedAt: new Date().toISOString(), symbol: "分时价量验收", code: "600000",
    dataSource: "real", dataMeta: { provider: "验收样例", adjust: "qfq", period: "daily" }, bars,
    indicatorWarmupBars: [], trainingStartIndex: 40, trainingEndIndex: bars.length - 1, currentIndex: bars.length - 1,
    cash: 1000000, lots: [], trades: [], avgCost: 0, finished: true, mode: "daily", indicator: "both",
    showChip: false, showIdentity: true, tradingRule: "a-share",
  };
}

function serveStatic() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "验收样例没有真实行情接口" }));
      return;
    }
    const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filename = path.resolve(root, `.${requested}`);
    const relative = path.relative(root, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return response.writeHead(403).end();
    fs.readFile(filename, (error, content) => {
      if (error) return response.writeHead(404).end("Not found");
      response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filename)] || "application/octet-stream" });
      response.end(content);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

async function openModal(browser, url, intradayBars, draft = makeDraft()) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block", hasTouch: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript((payload) => localStorage.setItem("kline-training-draft", JSON.stringify(payload)), draft);
  await page.route("**/api/market/intraday*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ bars: intradayBars, provider: "验收行情", volumeUnit: "股", fetchedAt: new Date().toISOString() }),
  }));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator("#chartCanvas").waitFor();
  const canvasBox = await page.locator("#chartCanvas").boundingBox();
  await page.locator("#chartCanvas").dblclick({ position: { x: Math.max(100, canvasBox.width - 15), y: Math.round(canvasBox.height / 2) } });
  await page.locator("#intradayCanvas").waitFor();
  return { context, page, pageErrors };
}

async function runStoredSampleCheck(browser, url, apiOrigin) {
  const response = await fetch(`${apiOrigin}/api/sample-candidates`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`读取本机真实样本失败：HTTP ${response.status}`);
  const payload = await response.json();
  const sample = (payload.candidates || []).find((candidate) => {
    if (candidate.reviewStatus !== "approved" || candidate.sampleType !== "side-training" || !Array.isArray(candidate.bars)) return false;
    const date = String(candidate.bars[Number(candidate.trainingStartIndex ?? candidate.startIndex)]?.date || "").slice(0, 10);
    return candidate.intradayByDate?.[date]?.bars?.length === 48;
  });
  if (!sample) throw new Error("本机没有找到已审核且包含完整48根分时的左右侧样本。");

  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block", hasTouch: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript((candidate) => {
    localStorage.removeItem("kline-training-draft");
    localStorage.setItem("kline-candidate-samples", JSON.stringify([candidate]));
    localStorage.setItem("kline-training-area", "indicator");
  }, sample);
  await page.route("**/api/sample-candidates", (route) => route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ candidates: [sample] }),
  }));
  await page.goto(url, { waitUntil: "networkidle" });
  const trainButton = page.locator('[data-side-action="train"]').first();
  await trainButton.waitFor();
  await trainButton.click();
  await page.waitForFunction(() => document.getElementById("dataStatus").textContent.includes("训练片段："));
  const canvas = page.locator("#chartCanvas");
  const box = await canvas.boundingBox();
  await canvas.dblclick({ position: { x: Math.max(100, box.width - 170), y: Math.round(box.height / 2) } });
  await page.locator("#intradayCanvas").waitFor();
  const status = await page.locator("#intradayVolumeStatus").innerText();
  const reference = await page.locator("#intradayCanvas").getAttribute("aria-description");
  if (!status.includes("48 个 5 分钟时段") || !status.includes("本地缓存")) throw new Error(`真实样本没有从保存数据读取分时：${status}`);
  if (reference.includes("基准缺失")) throw new Error(`完整真实样本没有可用的涨跌幅基准：${reference}`);
  await page.screenshot({ path: path.join(outputDir, "intraday-real-sample-1366-viewport.png"), fullPage: false, animations: "disabled" });
  await page.screenshot({ path: path.join(outputDir, "intraday-real-sample-1366-full-page.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  if (mobile.documentWidth > mobile.viewportWidth + 1) throw new Error(`真实样本手机视图横向溢出：${JSON.stringify(mobile)}`);
  await page.screenshot({ path: path.join(outputDir, "intraday-real-sample-390.png"), fullPage: false, animations: "disabled" });
  if (pageErrors.length) throw new Error(`真实样本页面错误：${pageErrors.join("；")}`);
  await context.close();
  return { scenario: "本机已审核真实样本打开保存的完整48根分时", status, reference, mobile };
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const { server, url } = await serveStatic();
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
    const complete = await openModal(browser, url, makeIntradayBars());
    const { page } = complete;
    const reference = await page.locator("#intradayCanvas").getAttribute("aria-description");
    if (!reference.includes("参考价 ¥10.00")) throw new Error(`前收换算错误：${reference}`);
    if (!reference.includes("成交量单位为股") || !reference.includes("午间休市")) throw new Error(`图表说明缺失：${reference}`);
    await page.locator("#intradayCanvas").hover({ position: { x: 260, y: 120 } });
    await page.locator("#intradayTooltip").waitFor({ state: "visible" });
    const tooltipText = await page.locator("#intradayTooltip").innerText();
    for (const field of ["价格", "涨跌幅", "成交量"]) if (!tooltipText.includes(field)) throw new Error(`提示框缺少${field}：${tooltipText}`);

    await page.screenshot({ path: path.join(outputDir, "intraday-price-volume-1366-viewport.png"), fullPage: false, animations: "disabled" });
    await page.screenshot({ path: path.join(outputDir, "intraday-price-volume-1366-full-page.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#intradayCanvas").tap({ position: { x: 150, y: 110 } });
    const mobileTooltip = await page.locator("#intradayTooltip").innerText();
    if (mobileTooltip.includes("悬停或点按") || !mobileTooltip.includes("涨跌幅")) throw new Error(`手机点按没有更新分时数值：${mobileTooltip}`);
    const mobile = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      card: document.querySelector(".intraday-volume-card").getBoundingClientRect().toJSON(),
      canvas: document.querySelector("#intradayCanvas").getBoundingClientRect().toJSON(),
      plotScrollWidth: document.querySelector(".intraday-volume-chart").scrollWidth,
      plotClientWidth: document.querySelector(".intraday-volume-chart").clientWidth,
    }));
    if (mobile.documentWidth > mobile.viewportWidth + 1) throw new Error(`手机页面横向溢出：${JSON.stringify(mobile)}`);
    if (mobile.card.width > mobile.viewportWidth || mobile.plotScrollWidth > mobile.plotClientWidth + 1) throw new Error(`手机分时图横向溢出：${JSON.stringify(mobile)}`);
    await page.screenshot({ path: path.join(outputDir, "intraday-price-volume-390.png"), fullPage: false, animations: "disabled" });
    await page.locator("#closeIntradayVolumeButton").click();
    if (!(await page.locator("#intradayVolumeModal").isHidden())) throw new Error("关闭按钮未关闭分时图");
    if (complete.pageErrors.length) throw new Error(`页面错误：${complete.pageErrors.join("；")}`);
    results.push({ scenario: "完整48根、前收换算、悬停与手机点按、手机布局、关闭", reference, tooltip: tooltipText, mobile });
    await complete.context.close();

    const missing = await openModal(browser, url, makeIntradayBars({ omitClose: true }));
    const missingReference = await missing.page.locator("#intradayCanvas").getAttribute("aria-description");
    const status = await missing.page.locator("#intradayVolumeStatus").innerText();
    if (!missingReference.includes("涨跌幅基准缺失") || !status.includes("基准缺失")) throw new Error("缺少15:00数据时没有提示涨跌幅基准缺失");
    if (!(await missing.page.locator("#intradayTooltip").innerText()).includes("悬停或点按")) throw new Error("缺少15:00时数值提示状态异常");
    await missing.context.close();
    results.push({ scenario: "缺少15:00数据时保留价量并隐藏百分比基准", reference: missingReference, status });

    const adjusted = await openModal(
      browser,
      url,
      makeIntradayBars({ finalClose: 10.1 }),
      makeDraft({ adjustedCurrentClose: 9.1, adjustedPreviousClose: 9 }),
    );
    const adjustedReference = await adjusted.page.locator("#intradayCanvas").getAttribute("aria-description");
    if (!adjustedReference.includes("参考价 ¥9.99")) throw new Error(`复权口径换算错误：${adjustedReference}`);
    results.push({ scenario: "前复权日线与不复权分时的价格口径换算", reference: adjustedReference });
    await adjusted.context.close();

    if (process.env.KLINE_SAMPLE_API_ORIGIN) {
      results.push(await runStoredSampleCheck(browser, url, process.env.KLINE_SAMPLE_API_ORIGIN));
    }

    console.log(JSON.stringify({ screenshots: outputDir, results }, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
