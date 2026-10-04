const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, ".qa-runtime", `operation-review-${Date.now()}-${process.pid}`);
const mimeTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json; charset=utf-8" };

function closeAt(index) {
  const relative = index - 290;
  let close;
  if (relative < 0) close = 20 + relative * 0.004;
  else if (relative <= 35) close = 20 - relative * 0.09;
  else if (relative <= 65) close = 16.85 + (relative - 35) * 0.11;
  else if (relative <= 100) close = 20.15 - (relative - 65) * 0.112;
  else if (relative <= 140) close = 16.23 + (relative - 100) * 0.16;
  else close = 22.63 - (relative - 140) * 0.08;
  return Number(close.toFixed(3));
}

function makeBars(start, count) {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    const close = closeAt(index);
    const open = Number((close + Math.sin(index / 3) * 0.035).toFixed(3));
    return {
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      open,
      high: Number((Math.max(open, close) + 0.12).toFixed(3)),
      low: Number((Math.min(open, close) - 0.12).toFixed(3)),
      close,
      volume: 180000 + (index % 19) * 14000,
    };
  });
}

function makeDraft(finished = true) {
  const allBars = makeBars(0, 470);
  const visible = allBars.slice(250);
  const trainingStartIndex = 40;
  const trainingEndIndex = 219;
  const trade = (side, localIndex, qty, fee, reason = "") => ({
    side,
    index: localIndex,
    qty,
    price: visible[localIndex].close,
    fee,
    commission: fee,
    stampDuty: 0,
    transferFee: 0,
    cash: 500000,
    reason,
    indicators: { ma20: visible[localIndex].close * 1.025, macd: -0.04, volumeRatio: 0.82 },
  });
  return {
    format: "kline-training-draft",
    savedAt: new Date().toISOString(),
    symbol: "操作复盘验收样例",
    code: "600000",
    dataSource: "qa-fixture",
    dataMeta: { provider: "本地验收样例", adjust: "qfq", period: "daily" },
    bars: visible,
    indicatorWarmupBars: allBars.slice(0, 250),
    trainingStartIndex,
    trainingEndIndex,
    currentIndex: finished ? trainingEndIndex : 82,
    cash: 779210,
    lots: [
      { index: 75, qty: 5000, price: visible[75].close, feePerShare: 130 / 25000 },
      { index: 94, qty: 10000, price: visible[94].close, feePerShare: 55 / 10000 },
    ],
    trades: [
      trade("buy", 75, 10000, 52, "低位首笔试仓"),
      trade("buy", 75, 15000, 78, "低位追加试仓"),
      trade("buy", 94, 10000, 55),
      trade("sell", 115, 12000, 85, "反弹减仓"),
      trade("sell", 165, 8000, 70),
    ],
    operationPlans: [
      { index: 74, signals: ["均线", "MACD"], positionCap: 0.3333, reason: "观察均线与动能" , invalidationPrice: 16.5, indicators: { ma20: 19.2, macd: -0.03 }, savedAt: new Date().toISOString() },
    ],
    nextSessionChecklist: [],
    avgCost: (5000 * visible[75].close + 10000 * visible[94].close) / 15000,
    finished,
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
      response.end(JSON.stringify({ error: "操作复盘验收不启用行情接口" }));
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

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const { server, url } = await serveStatic();
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block", acceptDownloads: true });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((draft) => localStorage.setItem("kline-training-draft", JSON.stringify(draft)), makeDraft(true));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !document.querySelector("#operationReview").hidden);

    const desktop = await page.evaluate(() => {
      const waves = window.operationReviewData();
      const stats = window.sessionStats();
      const sum = (key) => waves.reduce((total, wave) => total + wave[key], 0);
      return {
        waveCount: waves.length,
        reviewCards: document.querySelectorAll(".operation-wave").length,
        focusCount: document.querySelectorAll(".operation-wave.needs-review").length,
        suggestionCount: document.querySelectorAll(".operation-suggestion").length,
        netByWaves: sum("netChange"),
        expectedNet: stats.returnRate * 10000,
        feeByWaves: sum("fees"),
        expectedFees: stats.fees,
        noScore: !document.querySelector("#operationReview").innerText.includes("评分"),
        pageWidth: document.documentElement.scrollWidth,
      };
    });
    if (desktop.waveCount < 2 || desktop.reviewCards !== desktop.waveCount) throw new Error(`波段复盘未生成：${JSON.stringify(desktop)}`);
    if (Math.abs(desktop.netByWaves - desktop.expectedNet) > 0.02) throw new Error(`波段净值变化未与整局收益对齐：${JSON.stringify(desktop)}`);
    if (Math.abs(desktop.feeByWaves - desktop.expectedFees) > 0.01) throw new Error(`波段费用未与成交记录对齐：${JSON.stringify(desktop)}`);
    if (!desktop.noScore || desktop.pageWidth !== 1366) throw new Error(`出现综合评分或横向溢出：${JSON.stringify(desktop)}`);
    const initialWaveView = await page.evaluate(() => ({
      overviewButtonHidden: document.querySelector("#allWavesButton").hidden,
      annotationVisible: !document.querySelector("#waveAnnotationControl").hidden,
      annotationChecked: document.querySelector("#waveAnnotationToggle").checked,
      zoomLabel: document.querySelector("#zoomLabel").textContent,
    }));
    if (!initialWaveView.overviewButtonHidden || !initialWaveView.annotationVisible || !initialWaveView.annotationChecked || !initialWaveView.zoomLabel.includes(String(makeDraft(true).trainingEndIndex - makeDraft(true).trainingStartIndex + 1))) {
      throw new Error(`结束后没有进入全波段总览：${JSON.stringify(initialWaveView)}`);
    }
    await page.locator('[data-focus-wave="1"]').click();
    const focusedWave = await page.evaluate(() => ({
      activeCards: document.querySelectorAll(".operation-wave.is-focused").length,
      returnToOverviewVisible: !document.querySelector("#allWavesButton").hidden,
      zoomLabel: document.querySelector("#zoomLabel").textContent,
    }));
    if (focusedWave.activeCards !== 1 || !focusedWave.returnToOverviewVisible || focusedWave.zoomLabel.includes("180 根")) throw new Error(`波段卡片未定位图表：${JSON.stringify(focusedWave)}`);
    await page.locator("[data-focus-trade]").first().click();
    const focusedTrade = await page.evaluate(() => ({
      activeTrades: document.querySelectorAll(".operation-trade-review-row.is-focused").length,
      activeWaves: document.querySelectorAll(".operation-wave.is-focused").length,
      returnToOverviewVisible: !document.querySelector("#allWavesButton").hidden,
      zoomLabel: document.querySelector("#zoomLabel").textContent,
    }));
    if (focusedTrade.activeTrades !== 1 || focusedTrade.activeWaves !== 1 || !focusedTrade.returnToOverviewVisible || focusedTrade.zoomLabel.includes("180 根")) throw new Error(`成交行未定位对应K线：${JSON.stringify(focusedTrade)}`);
    await page.locator('[data-focus-trade="1"]').click();
    const secondSameBarTrade = await page.evaluate(() => ({
      selectedTrade: document.querySelector(".operation-trade-review-row.is-focused [data-focus-trade]")?.dataset.focusTrade,
      activeTrades: document.querySelectorAll(".operation-trade-review-row.is-focused").length,
    }));
    if (secondSameBarTrade.selectedTrade !== "1" || secondSameBarTrade.activeTrades !== 1) throw new Error(`同一根K线的多笔成交无法逐笔定位：${JSON.stringify(secondSameBarTrade)}`);
    await page.screenshot({ path: path.join(outputDir, "operation-review-1366-trade-focus-full-page.png"), fullPage: true });
    await page.locator("#chartCanvas").screenshot({ path: path.join(outputDir, "operation-review-1366-trade-focus-chart.png") });
    await page.locator("#chartCanvas").hover();
    await page.mouse.wheel(0, -120);
    const afterZoom = await page.evaluate(() => ({
      activeCards: document.querySelectorAll(".operation-wave.is-focused").length,
      returnToOverviewVisible: !document.querySelector("#allWavesButton").hidden,
    }));
    if (afterZoom.activeCards !== 1 || !afterZoom.returnToOverviewVisible) throw new Error(`手动缩放后波段标记状态异常：${JSON.stringify(afterZoom)}`);
    await page.locator("#allWavesButton").click();
    if (!(await page.locator("#allWavesButton").isHidden()) || !(await page.locator("#zoomLabel").innerText()).includes("180 根")) throw new Error("返回全部波段没有恢复总览");
    await page.locator("#waveAnnotationToggle").uncheck();
    if (await page.locator("#waveAnnotationToggle").isChecked()) throw new Error("波段标注开关未能关闭");
    await page.locator("#waveAnnotationToggle").check();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => !document.querySelector("#operationReview").hidden);
    if (!(await page.locator("#allWavesButton").isHidden()) || !(await page.locator("#waveAnnotationToggle").isChecked())) throw new Error("刷新后未恢复波段总览和标注状态");

    const firstSuggestion = page.locator("[data-next-suggestion]").first();
    if (await firstSuggestion.count()) await firstSuggestion.check();
    const savedDraft = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (await firstSuggestion.count() && !savedDraft.nextSessionChecklist?.length) throw new Error("下局检查项未写入自动草稿");
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#exportSessionButton").click()]);
    const backupPath = path.join(outputDir, download.suggestedFilename());
    await download.saveAs(backupPath);
    const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    if (!Array.isArray(backup.operationPlans) || !Array.isArray(backup.nextSessionChecklist)) throw new Error("新备份缺少复盘字段");
    await page.screenshot({ path: path.join(outputDir, "operation-review-1366-full-page.png"), fullPage: true });
    await page.screenshot({ path: path.join(outputDir, "operation-review-1366-viewport.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const mobile = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      reviewWidth: Math.round(document.querySelector("#operationReview").getBoundingClientRect().width),
      waves: document.querySelectorAll(".operation-wave").length,
    }));
    if (mobile.documentWidth !== mobile.viewportWidth || mobile.waves !== desktop.waveCount) throw new Error(`手机复盘布局异常：${JSON.stringify(mobile)}`);
    await page.screenshot({ path: path.join(outputDir, "operation-review-390-viewport.png") });
    await page.screenshot({ path: path.join(outputDir, "operation-review-390-full-page.png"), fullPage: true });
    await page.locator(".chart-panel").screenshot({ path: path.join(outputDir, "operation-review-390-chart.png") });
    await page.locator('[data-focus-wave="1"]').click();
    const mobileFocus = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      activeCards: document.querySelectorAll(".operation-wave.is-focused").length,
      overviewVisible: !document.querySelector("#allWavesButton").hidden,
    }));
    if (mobileFocus.documentWidth !== mobileFocus.viewportWidth || mobileFocus.activeCards !== 1 || !mobileFocus.overviewVisible) throw new Error(`手机定位波段失败：${JSON.stringify(mobileFocus)}`);
    await page.locator("[data-focus-trade]").first().click();
    const mobileTrade = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      activeTrades: document.querySelectorAll(".operation-trade-review-row.is-focused").length,
      overviewVisible: !document.querySelector("#allWavesButton").hidden,
    }));
    if (mobileTrade.documentWidth !== mobileTrade.viewportWidth || mobileTrade.activeTrades !== 1 || !mobileTrade.overviewVisible) throw new Error(`手机定位成交失败：${JSON.stringify(mobileTrade)}`);
    await page.screenshot({ path: path.join(outputDir, "operation-review-390-trade-focus-full-page.png"), fullPage: true });
    await page.locator("#allWavesButton").click();

    const activeContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    const activePage = await activeContext.newPage();
    activePage.on("pageerror", (error) => errors.push(error.message));
    const activeDraftSeed = makeDraft(false);
    activeDraftSeed.trades = [];
    activeDraftSeed.lots = [];
    activeDraftSeed.cash = 1000000;
    activeDraftSeed.operationPlans = [];
    await activePage.addInitScript((draft) => localStorage.setItem("kline-training-draft", JSON.stringify(draft)), activeDraftSeed);
    await activePage.goto(url, { waitUntil: "networkidle" });
    const hiddenBeforeFinish = await activePage.evaluate(() => ({
      annotationHidden: document.querySelector("#waveAnnotationControl").hidden,
      reviewHidden: document.querySelector("#operationReview").hidden,
    }));
    if (!hiddenBeforeFinish.annotationHidden || !hiddenBeforeFinish.reviewHidden) throw new Error(`训练结束前泄露波段复盘：${JSON.stringify(hiddenBeforeFinish)}`);
    await activePage.locator("#operationPlanDetails summary").click();
    await activePage.locator('[data-operation-signal="KDJ"]').check();
    await activePage.locator("#operationPositionCap").selectOption("0.5");
    await activePage.locator("#operationPlanReason").fill("MACD动能回升，先小仓观察");
    await activePage.locator("#operationInvalidationPrice").fill("16.25");
    await activePage.locator("#saveOperationPlanButton").click();
    let activeDraft = await activePage.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (!activeDraft.operationPlans.some((item) => item.reason.includes("先小仓观察") && item.positionCap === 0.5 && item.invalidationPrice === 16.25)) throw new Error("本根操作计划未保存");
    await activePage.locator("#quantityInput").fill("1000");
    await activePage.locator("#tradeReasonInput").fill("收盘回到均线附近，试仓");
    await activePage.locator("#buyButton").click();
    activeDraft = await activePage.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    const savedTrade = activeDraft.trades.at(-1);
    if (savedTrade.reason !== "收盘回到均线附近，试仓" || !savedTrade.indicators?.ma20) throw new Error("成交理由或当时指标快照未保存");
    const countBeforeSameDaySell = activeDraft.trades.length;
    await activePage.locator("#sellButton").click();
    activeDraft = await activePage.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    const t1Hint = await activePage.locator("#tradeHint").innerText();
    if (activeDraft.trades.length !== countBeforeSameDaySell || !t1Hint.includes("T+1")) throw new Error(`复盘改动影响A股T+1限制：${JSON.stringify({ count: activeDraft.trades.length, expected: countBeforeSameDaySell, hint: t1Hint })}`);
    await activeContext.close();

    const oldContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    const oldPage = await oldContext.newPage();
    oldPage.on("pageerror", (error) => errors.push(error.message));
    const oldDraft = makeDraft(false);
    delete oldDraft.operationPlans;
    delete oldDraft.nextSessionChecklist;
    await oldPage.addInitScript((draft) => localStorage.setItem("kline-training-draft", JSON.stringify(draft)), oldDraft);
    await oldPage.goto(url, { waitUntil: "networkidle" });
    const compatible = await oldPage.evaluate(() => {
      const draft = JSON.parse(localStorage.getItem("kline-training-draft"));
      return { operationPlans: draft.operationPlans, nextSessionChecklist: draft.nextSessionChecklist };
    });
    if (!Array.isArray(compatible.operationPlans) || !Array.isArray(compatible.nextSessionChecklist)) throw new Error("旧草稿兼容性初始化失败");
    await oldContext.close();

    if (errors.length) throw new Error(`页面脚本错误：${errors.join(" | ")}`);
    console.log(JSON.stringify({ screenshots: outputDir, desktop, mobile, initialWaveView, focusedWave, focusedTrade, afterZoom, mobileFocus, mobileTrade, hiddenBeforeFinish, savedTrade, backup: "操作计划与下局检查项已导出", compatibility: "旧草稿缺少字段时正常恢复" }, null, 2));
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
