const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, ".qa-runtime", `tranche-management-${process.pid}`);
const mimeTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json; charset=utf-8" };

function makeBars(start, count) {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    const close = Number((12 + index * 0.004 + Math.sin(index / 7) * 0.07).toFixed(3));
    const open = Number((close + Math.sin(index / 3) * 0.025).toFixed(3));
    return {
      date: new Date(Date.UTC(2023, 0, index + 1)).toISOString().slice(0, 10),
      open,
      high: Number((Math.max(open, close) + 0.1).toFixed(3)),
      low: Number((Math.min(open, close) - 0.1).toFixed(3)),
      close,
      volume: 180000 + (index % 13) * 12000,
    };
  });
}

function draft({ trades = [], lots = [], currentIndex = 40, cash = 1000000, overrides = {} } = {}) {
  const all = makeBars(0, 470);
  return {
    format: "kline-training-draft", savedAt: new Date().toISOString(), symbol: "逐批分仓验收样例", code: "DEMO",
    dataSource: "demo", dataMeta: { provider: "本地验收样例", adjust: "qfq", period: "daily" },
    bars: all.slice(250), indicatorWarmupBars: all.slice(0, 250), trainingStartIndex: 40, trainingEndIndex: 219,
    currentIndex, cash, lots, trades, avgCost: 0, finished: false, mode: "naked", indicator: "both", showChip: true,
    showIdentity: false, tradingRule: "a-share", barNotes: [], reviewNotes: [], operationPlans: [], nextSessionChecklist: [],
    reviewSuggestionSelections: [], ...overrides,
  };
}

function serveStatic() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
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
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname === "/api/reviews" ? { reviews: [] }
        : pathname === "/api/sample-candidates" ? { candidates: [] }
          : pathname === "/api/market/sources" ? { sources: [], routing: null }
            : pathname === "/api/sample-collection/current" ? { running: false }
              : { ok: true };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.addInitScript((value) => {
      if (!sessionStorage.getItem("tranche-qa-seeded")) {
        localStorage.setItem("kline-training-draft", JSON.stringify(value));
        sessionStorage.setItem("tranche-qa-seeded", "1");
      }
    }, draft());
    await page.goto(url, { waitUntil: "networkidle" });

    await page.locator(".tranche-plan-fields summary").click();
    await page.locator("#trancheRoleInput").selectOption("试探");
    await page.locator("#tranchePurposeInput").fill("低确定性信号先小仓观察");
    await page.locator("#trancheExitInput").fill("收盘跌破观察低点退出");
    await page.locator('[data-quick-side="buy"][data-divisor="6"]').click();
    const firstQty = Number(await page.locator("#quantityInput").inputValue());
    if (firstQty < 100 || !Number((firstQty / 100) % 1 === 0)) throw new Error(`1/6 快捷买入股数无效：${firstQty}`);
    const firstPreview = await page.locator("#tradePreview").innerText();
    if (!firstPreview.includes("总仓位")) throw new Error(`买入预览缺少总仓位：${firstPreview}`);
    await page.locator("#buyButton").click();
    let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    const firstLotId = saved.trades.at(-1).lotId;
    if (!firstLotId || saved.lots[0].role !== "试探" || saved.lots[0].purpose !== "低确定性信号先小仓观察") throw new Error("首批仓位身份或原始计划未保存");

    await page.locator("#sellLotSelect").selectOption(firstLotId);
    await page.locator('[data-quick-side="sell"][data-divisor="2"]').click();
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (saved.trades.length !== 1 || !((await page.locator("#tradeHint").innerText()).includes("没有可卖"))) throw new Error("T+1 当日买入批次被错误放行");

    await page.locator("#nextButton").click();
    await page.locator(".tranche-plan-fields summary").click();
    await page.locator("#trancheRoleInput").selectOption("确认加仓");
    await page.locator("#tranchePurposeInput").fill("指标确认后补仓");
    await page.locator('[data-quick-side="buy"][data-divisor="3"]').click();
    const secondQty = Number(await page.locator("#quantityInput").inputValue());
    await page.locator("#buyButton").click();
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    const secondLotId = saved.trades.at(-1).lotId;
    if (saved.lots.length !== 2 || saved.lots[1].role !== "确认加仓" || saved.lots[1].qty !== secondQty) throw new Error("1/3 确认仓未独立成批");

    await page.locator("#sellLotSelect").selectOption(firstLotId);
    await page.locator('[data-quick-side="sell"][data-divisor="2"]').click();
    const firstSellQty = Number(await page.locator("#quantityInput").inputValue());
    await page.locator("#sellButton").click();
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    const firstSale = saved.trades.at(-1);
    const firstLotRemaining = saved.lots.find((lot) => lot.id === firstLotId)?.qty || 0;
    if (firstSale.allocations?.length !== 1 || firstSale.allocations[0].lotId !== firstLotId || firstSale.qty !== firstSellQty || firstLotRemaining !== firstQty - firstSellQty) {
      throw new Error(`试探仓没有按批次准确减半：${JSON.stringify({ firstSale, firstQty, firstSellQty, firstLotRemaining })}`);
    }

    await page.locator("#nextButton").click();
    await page.locator("#sellLotSelect").selectOption(secondLotId);
    await page.locator('[data-quick-side="sell"][data-divisor="2"]').click();
    const secondSellQty = Number(await page.locator("#quantityInput").inputValue());
    await page.locator("#sellButton").click();
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    const secondSale = saved.trades.at(-1);
    const secondLotRemaining = saved.lots.find((lot) => lot.id === secondLotId)?.qty || 0;
    if (secondSale.allocations?.length !== 1 || secondSale.allocations[0].lotId !== secondLotId || secondSale.qty !== secondSellQty || secondLotRemaining !== secondQty - secondSellQty) {
      throw new Error(`确认仓没有按批次准确减半：${JSON.stringify({ secondSale, secondQty, secondSellQty, secondLotRemaining })}`);
    }
    const amounts = saved.trades.reduce((result, trade) => {
      result.cash += trade.side === "buy" ? -(trade.qty * trade.price + trade.fee) : trade.qty * trade.price - trade.fee;
      result.fees += trade.fee;
      return result;
    }, { cash: 1000000, fees: 0 });
    if (Math.abs(amounts.cash - saved.cash) > 0.02 || !(amounts.fees > 0)) throw new Error(`现金与费用账不一致：${JSON.stringify({ amounts, cash: saved.cash })}`);

    const secondCard = page.locator(`.tranche-card[data-lot-id="${secondLotId}"]`);
    await secondCard.locator("[data-toggle-lot-plan]").click();
    await secondCard.locator("[data-lot-purpose]").fill("回踩确认后继续持有");
    await secondCard.locator("[data-lot-exit]").fill("跌破回踩低点分批退出");
    await secondCard.locator("[data-save-lot-plan]").click();
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (saved.lots.find((lot) => lot.id === secondLotId)?.planUpdates?.at(-1)?.purpose !== "回踩确认后继续持有") throw new Error("后续仓位计划补记没有保留时间线");
    const [backupDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#exportSessionButton").click()]);
    const backupPath = path.join(outputDir, backupDownload.suggestedFilename());
    await backupDownload.saveAs(backupPath);
    const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    if (backup.lots.find((lot) => lot.id === secondLotId)?.planUpdates?.length !== 1 || backup.trades.at(-1).allocations?.[0]?.lotId !== secondLotId) {
      throw new Error("训练备份没有包含批次计划补记或卖出扣减批次");
    }

    await page.evaluate(() => { state.finished = true; render(); });
    const archivePayload = await page.evaluate(() => reviewArchivePayload());
    if (archivePayload.lots.find((lot) => lot.id === secondLotId)?.planUpdates?.length !== 1 || archivePayload.trades.at(-1).allocations?.[0]?.lotId !== secondLotId) {
      throw new Error("复盘档案没有包含持仓计划补记和卖出批次明细");
    }
    const review = await page.evaluate(() => ({
      stats: sessionStats(),
      waveFees: operationReviewData().reduce((sum, wave) => sum + wave.fees, 0),
      waveNet: operationReviewData().reduce((sum, wave) => sum + wave.netChange, 0),
      tradeLabels: [...document.querySelectorAll(".trade-log-item")].map((item) => item.innerText),
    }));
    if (Math.abs(review.waveFees - amounts.fees) > 0.02 || Math.abs(review.waveNet - (review.stats.returnRate * 10000)) > 0.05) {
      throw new Error(`波段复盘没有沿用批次成交账：${JSON.stringify({ review, amounts })}`);
    }
    if (!review.tradeLabels.some((label) => label.includes("扣减批次"))) throw new Error("交易记录没有显示卖出批次归属");
    const desktop = await page.evaluate(() => {
      const chart = document.querySelector(".chart-panel").getBoundingClientRect();
      const side = document.querySelector(".side-column").getBoundingClientRect();
      return { viewport: innerWidth, document: document.documentElement.scrollWidth, chartWidth: Math.round(chart.width), sideStartsRight: side.left >= chart.right };
    });
    if (desktop.viewport !== desktop.document || desktop.chartWidth < 760 || !desktop.sideStartsRight) throw new Error(`桌面图表与分仓右栏布局异常：${JSON.stringify(desktop)}`);
    await page.screenshot({ path: path.join(outputDir, "tranche-management-1366-full-page.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, trancheCards: document.querySelectorAll(".tranche-card").length }));
    if (mobile.viewport !== mobile.document || mobile.trancheCards !== 2) throw new Error(`手机分仓布局横向溢出或仓位批次缺失：${JSON.stringify(mobile)}`);
    await page.screenshot({ path: path.join(outputDir, "tranche-management-390-full-page.png"), fullPage: true });

    await page.reload({ waitUntil: "networkidle" });
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (saved.trades.at(-1).allocations?.[0]?.lotId !== secondLotId || saved.lots.find((lot) => lot.id === secondLotId)?.qty !== secondLotRemaining) throw new Error("刷新后批次归属或剩余股数没有恢复");

    const legacyContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    const legacyPage = await legacyContext.newPage();
    legacyPage.on("pageerror", (error) => errors.push(error.message));
    const oldBuy1 = { id: "legacy-buy-1", side: "buy", qty: 300, price: 10, fee: 5, index: 40, cash: 996995 };
    const oldBuy2 = { id: "legacy-buy-2", side: "buy", qty: 200, price: 11, fee: 5, index: 41, cash: 994790 };
    const oldSell = { id: "legacy-sell", side: "sell", qty: 200, price: 12, fee: 5, index: 42, cash: 997185 };
    await legacyPage.addInitScript((value) => localStorage.setItem("kline-training-draft", JSON.stringify(value)), draft({
      currentIndex: 42, cash: 997185,
      lots: [{ index: 40, qty: 100, price: 10, feePerShare: 5 / 300 }, { index: 41, qty: 200, price: 11, feePerShare: 5 / 200 }],
      trades: [oldBuy1, oldBuy2, oldSell],
    }));
    await legacyPage.goto(url, { waitUntil: "networkidle" });
    const migrated = await legacyPage.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (!migrated.trades[2].allocations?.length || migrated.trades[2].allocations[0].lotId !== migrated.trades[0].lotId || migrated.lots.some((lot) => !lot.id)) {
      throw new Error(`旧备份没有保持历史 FIFO 并生成批次标识：${JSON.stringify(migrated.trades)}`);
    }
    await legacyPage.locator("#backupFileInput").setInputFiles(backupPath);
    await legacyPage.waitForFunction(() => JSON.parse(localStorage.getItem("kline-training-draft"))?.trades?.length === 4);
    const importedBackup = await legacyPage.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (importedBackup.trades.at(-1).allocations?.[0]?.lotId !== secondLotId || importedBackup.lots.find((lot) => lot.id === secondLotId)?.qty !== secondLotRemaining) {
      throw new Error("新版训练备份导入后批次股数或卖出归属发生变化");
    }
    await legacyContext.close();

    const mixResults = {};
    for (const [name, divisors] of Object.entries({ quarters: [4, 4, 4, 4], sixthsAndThirds: [6, 6, 3, 3] })) {
      const mixContext = await browser.newContext({ viewport: { width: 900, height: 800 }, serviceWorkers: "block" });
      const mixPage = await mixContext.newPage();
      mixPage.on("pageerror", (error) => errors.push(error.message));
      await mixPage.addInitScript((value) => localStorage.setItem("kline-training-draft", JSON.stringify(value)), draft());
      await mixPage.goto(url, { waitUntil: "networkidle" });
      const shares = [];
      for (const divisor of divisors) {
        await mixPage.locator(`[data-quick-side="buy"][data-divisor="${divisor}"]`).click();
        let targetQty = Number(await mixPage.locator("#quantityInput").inputValue());
        await mixPage.locator("#buyButton").click();
        let hint = await mixPage.locator("#tradeHint").innerText();
        if (hint.includes("可用现金不足")) {
          targetQty = await mixPage.evaluate(() => maximumAffordableBuyQty());
          if (targetQty < 100) throw new Error(`${name} 分仓序列没有可用的 100 股买入上限`);
          await mixPage.locator("#quantityInput").fill(String(targetQty));
          await mixPage.locator("#buyButton").click();
          hint = await mixPage.locator("#tradeHint").innerText();
          if (!hint.includes("买入成功")) throw new Error(`${name} 分仓序列调整到现金上限后仍未能成交：${hint}`);
        }
        shares.push(targetQty);
      }
      const batchCount = await mixPage.evaluate(() => state.lots.length);
      if (batchCount !== 4 || shares.some((qty) => qty < 100 || qty % 100 !== 0)) throw new Error(`${name}分仓序列批次或股数异常：${JSON.stringify({ shares, batchCount })}`);
      mixResults[name] = { shares, batchCount };
      await mixContext.close();
    }

    const t0Context = await browser.newContext({ viewport: { width: 900, height: 800 }, serviceWorkers: "block" });
    const t0Page = await t0Context.newPage();
    t0Page.on("pageerror", (error) => errors.push(error.message));
    await t0Page.addInitScript((value) => localStorage.setItem("kline-training-draft", JSON.stringify(value)), draft({ overrides: { tradingRule: "etf-t0" } }));
    await t0Page.goto(url, { waitUntil: "networkidle" });
    await t0Page.locator("#tradingRuleSelect").selectOption("etf-t0");
    await t0Page.locator("#quantityInput").fill("100");
    await t0Page.locator("#buyButton").click();
    const t0LotId = await t0Page.evaluate(() => state.lots[0].id);
    await t0Page.locator("#sellLotSelect").selectOption(t0LotId);
    await t0Page.locator('[data-quick-side="sell"][data-divisor="1"]').click();
    await t0Page.locator("#sellButton").click();
    const t0Trades = await t0Page.evaluate(() => state.trades);
    if (t0Trades.length !== 2 || t0Trades[1].allocations?.[0]?.lotId !== t0LotId) throw new Error("ETF T+0 同根买卖或批次分配错误");
    await t0Context.close();

    if (errors.length) throw new Error(`浏览器脚本错误：${errors.join(" | ")}`);
    console.log(JSON.stringify({ outputDir, firstQty, secondQty, firstSellQty, secondSellQty, firstLotRemaining, secondLotRemaining, cash: saved.cash, fees: amounts.fees, reviewNet: review.waveNet, desktop, mobile, legacyFifoMigration: true, mixResults, etfT0TargetedSale: true, browserErrors: errors }, null, 2));
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
