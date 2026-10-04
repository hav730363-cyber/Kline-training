const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const runId = `${Date.now()}-${process.pid}`;
const outputDir = path.join(root, ".qa-runtime", `review-coach-${runId}`);
const mimeTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json; charset=utf-8" };

function buildFixture() {
  const allBars = Array.from({ length: 470 }, (_, index) => {
    const x = index - 290;
    let close;
    if (x < 0) close = 20 + x * 0.004;
    else if (x < 35) close = 20 - x * 0.09;
    else if (x < 65) close = 16.85 + (x - 35) * 0.11;
    else if (x < 100) close = 20.15 - (x - 65) * 0.112;
    else if (x < 140) close = 16.23 + (x - 100) * 0.16;
    else close = 22.63 - (x - 140) * 0.08;
    close = Number(close.toFixed(3));
    const open = Number((close + Math.sin(index / 3) * 0.035).toFixed(3));
    return {
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10), open,
      high: Number((Math.max(open, close) + 0.12).toFixed(3)),
      low: Number((Math.min(open, close) - 0.12).toFixed(3)), close,
      volume: 180000 + (index % 19) * 14000,
    };
  });
  const bars = allBars.slice(250);
  const trade = (side, index, qty, fee, extra = {}) => ({
    id: `trade-${side}-${index}-${qty}`, side, index, qty, price: bars[index].close, fee, commission: fee,
    stampDuty: 0, transferFee: 0, cash: 500000, reason: "", indicators: {}, ...extra,
  });
  const trades = [
    trade("buy", 75, 5000, 25, { reason: "J低位观察", indicators: { j: 7.4, volumeRatio: 0.8 }, decision: { intent: "试探买入", certainty: "不确定", signals: ["J值"] }, lotRole: "试探" }),
    trade("buy", 94, 10000, 50, { decision: { intent: "确认加仓", certainty: "有冲突", signals: ["量价"] }, lotRole: "确认加仓" }),
    trade("sell", 115, 2500, 35, { reason: "分批减仓", indicators: { j: 82, candleDirection: "收阳", volumeSignal: "近20日天量", volumeRatio: 2.1 }, allocations: [{ lotId: "trade-buy-75-5000", qty: 2500, fee: 35 }] }),
    trade("sell", 165, 3000, 40, { allocations: [{ lotId: "trade-buy-75-5000", qty: 2500, fee: 25 }, { lotId: "trade-buy-94-10000", qty: 500, fee: 15 }] }),
  ];
  return {
    id: "review-coach-fixture", format: "kline-training-review", version: 2,
    archivedAt: new Date().toISOString(), symbol: "交互复盘验收样例", code: "600000", dataSource: "qa-fixture",
    dataMeta: { provider: "本地验收样例", adjust: "qfq", period: "daily" }, bars,
    indicatorWarmupBars: allBars.slice(0, 250), trainingStartIndex: 40, trainingEndIndex: 219,
    currentIndex: 219, cash: 700000, lots: [], trades, barNotes: [], reviewNotes: [], operationPlans: [],
    nextSessionChecklist: [], reviewSuggestionSelections: [], reviewRulesSnapshot: globalThis.__fixtureRules || null,
    reviewQuestionnaire: { answers: [], skipped: [] }, reviewConclusions: [], teachingComparisons: [], manualKeyLevels: [],
    avgCost: 0, finished: true, mode: "naked", indicator: "both", showChip: true, showIdentity: false,
    tradingRule: "a-share", trainingArea: "indicator", intradayData: {},
  };
}

function serveStatic() {
  const savedReviews = new Map();
  let failSaves = false;
  const review = buildFixture();
  const legacyReview = structuredClone(review);
  legacyReview.id = "review-coach-legacy-fixture";
  legacyReview.version = 1;
  ["reviewQuestionnaire", "reviewConclusions", "teachingComparisons", "manualKeyLevels", "reviewRulesSnapshot"].forEach((key) => delete legacyReview[key]);
  legacyReview.trades.forEach((trade) => { delete trade.decision; delete trade.reviewRuleSnapshot; });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/__toggle-save-failure" && request.method === "GET") {
      failSaves = url.searchParams.get("enabled") === "1";
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ failSaves })); return;
    }
    if (url.pathname === "/api/reviews" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ reviews: [review, legacyReview].map((item) => ({ id: item.id, symbol: item.symbol, code: item.code, archivedAt: item.archivedAt, tradeCount: item.trades.length, noteCount: 0 })) }));
      return;
    }
    if ([review.id, legacyReview.id].includes(url.pathname.slice("/api/reviews/".length)) && request.method === "GET") {
      const id = url.pathname.slice("/api/reviews/".length);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(savedReviews.get(id) || (id === review.id ? review : legacyReview))); return;
    }
    if (url.pathname === "/api/reviews/save" && request.method === "POST") {
      if (failSaves) { response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ error: "QA模拟：暂时无法连接档案库" })); return; }
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        let savedReview = null;
        try { savedReview = JSON.parse(body).review; } catch { /* test server returns a normal error below */ }
        if (savedReview?.id) savedReviews.set(savedReview.id, savedReview);
        response.writeHead(savedReview ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(savedReview ? { ok: true } : { error: "invalid JSON" }));
      });
      return;
    }
    if (url.pathname.startsWith("/api/")) { response.writeHead(404).end("{}"); return; }
    const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filename = path.resolve(root, `.${requested}`);
    const relative = path.relative(root, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
    fs.readFile(filename, (error, content) => {
      if (error) { response.writeHead(404).end("Not found"); return; }
      response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filename)] || "application/octet-stream" }); response.end(content);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

async function main() {
  if (fs.existsSync(outputDir)) throw new Error(`拒绝覆盖已有验收输出目录：${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const { server, url } = await serveStatic();
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator("#openMyReviewsButton").click();
    await page.locator(`[data-open-review="review-coach-fixture"]`).click();
    await page.locator("#reviewWorkspace").waitFor({ state: "visible" });
    await page.locator(".review-rule-details summary").filter({ hasText: "40张规则卡片" }).click();
    for (let attempt = 0; attempt < 7; attempt += 1) {
      if ((await page.locator("#reviewQuestionCard").innerText()).includes("不确定")) break;
      await page.locator("#reviewQuestionSkip").click();
    }
    const desktop = await page.evaluate(() => ({
      viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      cards: document.querySelectorAll("#reviewRuleCardCatalog .review-rule-item").length,
      waves: document.querySelectorAll(".operation-wave").length,
      suggestions: document.querySelectorAll(".operation-suggestion").length,
      hasUncertaintyQuestion: document.querySelector("#reviewQuestionCard").innerText.includes("不确定"),
      hasOutcomeNeutralBoundary: document.querySelector("#operationReviewSummary").innerText.includes("盈利不代表"),
      question: document.querySelector("#reviewQuestionCard").innerText,
      progress: document.querySelector("#reviewQuestionProgress").innerText,
      questionPrompts: window.buildReviewQuestions().map((item) => ({ id: item.id, prompt: item.prompt })),
      decisionCertainties: window.buildReviewQuestions().length ? window.operationReviewData().flatMap((wave) => wave.trades.map((trade) => trade.decision?.certainty || "missing")) : [],
    }));
    if (desktop.documentWidth !== 1366 || desktop.cards !== 40 || desktop.waves < 2 || desktop.suggestions <= 3 || !desktop.hasUncertaintyQuestion || !desktop.hasOutcomeNeutralBoundary) {
      throw new Error(`桌面复盘工作区／规则卡片异常：${JSON.stringify(desktop)}`);
    }
    if (!desktop.questionPrompts.some((item) => item.id === "J3-low-then-lower") || !desktop.questionPrompts.some((item) => item.id === "J2-high-review")) throw new Error(`低J后续下跌或高J复盘问题未按样本触发：${JSON.stringify(desktop.questionPrompts)}`);
    const causalEvidence = await page.evaluate(() => {
      const trade = state.trades[0];
      const before = operationTradeEvidence(trade).evidence.join("|");
      const futureIndex = Math.min(state.bars.length - 1, state.trainingEndIndex);
      const original = state.bars[futureIndex];
      state.bars[futureIndex] = { ...original, close: original.close * 1.5 };
      const after = operationTradeEvidence(trade).evidence.join("|");
      state.bars[futureIndex] = original;
      const missingJ = operationTradeEvidence({ ...trade, indicators: { ...trade.indicators, j: null } }).evidence.join("|");
      return { before, after, missingJ };
    });
    if (causalEvidence.before !== causalEvidence.after || !causalEvidence.missingJ.includes("J 值缺失")) throw new Error(`复盘依据被未来价格污染或缺失J被当成数值：${JSON.stringify(causalEvidence)}`);
    await page.locator(".review-rule-details summary").filter({ hasText: "40张规则卡片" }).click();
    await page.screenshot({ path: path.join(outputDir, "review-workspace-1366-full-page.png"), fullPage: true });

    const questionText = await page.locator("#reviewQuestionCard").innerText();
    if (!questionText) throw new Error("归档没有生成针对性复盘问题");
    await page.locator("[data-review-answer-option]").first().click();
    await page.locator("#reviewQuestionText").fill("这是事后补记，不是当时的原计划。");
    await page.locator("#reviewQuestionSave").click();
    await page.waitForFunction(() => document.querySelector("#reviewQuestionProgress").innerText.includes("问题"));
    await page.locator("#reviewConclusionInput").fill("保留逐笔记录；下次先写清加仓条件和可接受回撤。");
    await page.locator("#saveReviewConclusionButton").click();
    await page.waitForFunction(async () => (await (await fetch("/api/reviews/review-coach-fixture")).json()).reviewConclusions?.length === 1);
    const afterSave = await page.evaluate(async () => {
      const archive = await (await fetch("/api/reviews/review-coach-fixture")).json();
      return { answers: archive.reviewQuestionnaire?.answers?.length, currentQuestionId: archive.reviewQuestionnaire?.currentQuestionId, conclusions: archive.reviewConclusions?.length, originalReason: archive.trades[0].reason };
    });
    if (afterSave.answers < 2 || afterSave.conclusions !== 1 || afterSave.originalReason !== "J低位观察") throw new Error(`问答／结论保存或原始记录保护失败：${JSON.stringify(afterSave)}`);

    const compareOptions = await page.locator("#comparisonTradeSelect option").evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
    if (!compareOptions.length) throw new Error("归档中没有可用于教学对照的卖出批次");
    await page.locator("#comparisonTradeSelect").selectOption(compareOptions[0]);
    await page.locator("#comparisonTriggerPrice").fill("18");
    await page.locator("#runTeachingComparison").click();
    const comparison = await page.locator("#teachingComparisonResults").innerText();
    await page.waitForFunction(async () => (await (await fetch("/api/reviews/review-coach-fixture")).json()).teachingComparisons?.length === 1);
    const comparisonRecord = await page.evaluate(async () => (await (await fetch("/api/reviews/review-coach-fixture")).json()).teachingComparisons[0]);
    if (!comparison.includes("事后教学对照") || !comparison.includes("不代表原计划") || !comparison.includes("实际卖出净盈亏") || !(comparisonRecord.entryCost > 0) || !Number.isFinite(comparisonRecord.holdPnl) || !Number.isFinite(comparisonRecord.stagedPnl)) throw new Error(`教学对照未按批次成本计算净盈亏或边界缺失：${JSON.stringify({ comparison, comparisonRecord })}`);
    await page.evaluate(() => fetch("/__toggle-save-failure?enabled=1"));
    await page.locator("#reviewConclusionInput").fill("保存失败后也应保留的新结论。");
    await page.locator("#saveReviewConclusionButton").click();
    await page.waitForFunction(() => !document.querySelector("#retryReviewSaveButton").hidden && document.querySelector("#reviewArchiveStatus").innerText.includes("未同步"));
    const unsynced = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-unsynced-review-v1")));
    if (unsynced?.review?.reviewConclusions?.length !== 2) throw new Error("保存失败时没有将最新复盘完整保留在浏览器");
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#openMyReviewsButton").click();
    await page.locator(`[data-open-review="review-coach-fixture"]`).click();
    await page.locator("#reviewWorkspace").waitFor({ state: "visible" });
    if (!(await page.locator("#reviewConclusionList").innerText()).includes("保存失败后也应保留的新结论")) throw new Error("刷新后没有从本地未同步缓存恢复最新复盘");
    if ((await page.locator("#reviewQuestionProgress").innerText()).startsWith("问题 1 /")) throw new Error("刷新后问答进度没有恢复到原位置");
    const [reviewDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#exportCurrentReviewButton").click()]);
    const exportedReviewPath = path.join(outputDir, reviewDownload.suggestedFilename());
    await reviewDownload.saveAs(exportedReviewPath);
    const exportedReview = JSON.parse(fs.readFileSync(exportedReviewPath, "utf8"));
    if (exportedReview.version !== 2 || exportedReview.reviews?.[0]?.reviewConclusions?.length !== 2) throw new Error("本地复盘导出未包含未同步版本或版本号异常");
    await page.evaluate(() => fetch("/__toggle-save-failure?enabled=0"));
    await page.locator("#retryReviewSaveButton").click();
    await page.waitForFunction(() => document.querySelector("#retryReviewSaveButton").hidden && !localStorage.getItem("kline-training-unsynced-review-v1"));
    const retried = await page.evaluate(async () => (await (await fetch("/api/reviews/review-coach-fixture")).json()).reviewConclusions.length);
    if (retried !== 2) throw new Error(`恢复连接后重试保存失败：${retried}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const mobile = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, workspace: Math.round(document.querySelector("#reviewWorkspace").getBoundingClientRect().width), questions: document.querySelectorAll("#reviewQuestionOptions button").length }));
    if (mobile.documentWidth !== mobile.viewport || mobile.workspace > mobile.viewport || !mobile.questions) throw new Error(`手机复盘工作区溢出或问答不可见：${JSON.stringify(mobile)}`);
    await page.screenshot({ path: path.join(outputDir, "review-workspace-390-full-page.png"), fullPage: true });
    await page.screenshot({ path: path.join(outputDir, "review-workspace-390-viewport.png") });

    await page.locator("#closeReviewWorkspaceButton").click();
    await page.locator(`[data-open-review="review-coach-legacy-fixture"]`).click();
    await page.locator("#reviewWorkspace").waitFor({ state: "visible" });
    const legacyCompatible = await page.evaluate(() => ({
      workspaceVisible: !document.querySelector("#reviewWorkspace").hidden,
      conclusionText: document.querySelector("#reviewConclusionList").innerText,
      questionCount: document.querySelector("#reviewQuestionProgress").innerText,
      pageWidth: document.documentElement.scrollWidth,
    }));
    if (!legacyCompatible.workspaceVisible || !legacyCompatible.conclusionText.includes("尚未保存") || legacyCompatible.pageWidth !== 390) throw new Error(`旧版复盘档案兼容失败：${JSON.stringify(legacyCompatible)}`);
    await page.locator("#closeReviewWorkspaceButton").click();
    const activeFixture = buildFixture();
    const activeDraft = {
      format: "kline-training-draft", savedAt: new Date().toISOString(), symbol: "操作计划验收样例", code: "600000",
      dataSource: "qa-fixture", dataMeta: activeFixture.dataMeta, bars: activeFixture.bars, indicatorWarmupBars: activeFixture.indicatorWarmupBars,
      trainingStartIndex: 40, trainingEndIndex: 219, currentIndex: 130, cash: 1000000, lots: [], trades: [],
      barNotes: [], reviewNotes: [], operationPlans: [], nextSessionChecklist: [], reviewSuggestionSelections: [],
      finished: false, mode: "naked", indicator: "both", showChip: true, showIdentity: false, tradingRule: "a-share",
    };
    await page.evaluate((draft) => localStorage.setItem("kline-training-draft", JSON.stringify(draft)), activeDraft);
    await page.reload({ waitUntil: "networkidle" });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.locator("#operationPlanDetails summary").click();
    await page.locator("#operationPlanReason").fill("第一版计划：观察关键位");
    await page.locator("#saveOperationPlanButton").click();
    await page.locator("#operationPlanReason").fill("第二版计划：新增确认条件");
    await page.locator("#saveOperationPlanButton").click();
    let savedDraft = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (savedDraft.operationPlans.length !== 2 || savedDraft.operationPlans[1].supersedes !== savedDraft.operationPlans[0].id) throw new Error("同一K线计划修改覆盖了原版本或缺少 supersedes 关系");
    await page.locator("#operationPlanReason").fill("");
    await page.locator("#saveOperationPlanButton").click();
    savedDraft = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (savedDraft.operationPlans.length !== 3 || savedDraft.operationPlans[2].status !== "withdrawn" || savedDraft.operationPlans[0].reason !== "第一版计划：观察关键位") throw new Error("撤销计划没有以历史版本形式保留");

    await page.locator("#chartCanvas").scrollIntoViewIfNeeded();
    await page.locator("#chartNoteTool").click();
    const chartBox = await page.locator("#chartCanvas").boundingBox();
    await page.mouse.click(chartBox.x + chartBox.width * .7, chartBox.y + 80);
    await page.locator("#barNoteModal").waitFor({ state: "visible" });
    await page.locator("#barNoteInput").fill("J<10时收盘跌破20元卖出指定批次一半");
    await page.locator("#noteKeyLevelInput").fill("18.5");
    await page.locator("#noteKeyLevelUpperInput").fill("19.2");
    if (!(await page.locator("#noteParsePreview").innerText()).includes("待确认条件")) throw new Error("手写条件没有被标注为待确认解释");
    await page.locator("#confirmParsedNote").check();
    await page.locator("#saveBarNoteButton").click();
    savedDraft = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    const parsedNote = savedDraft.barNotes.at(-1);
    if (parsedNote.parsedCandidates.length !== 3 || parsedNote.parsedCandidates.some((item) => item.status !== "用户确认") || savedDraft.manualKeyLevels[0]?.lower !== 18.5 || savedDraft.manualKeyLevels[0]?.upper !== 19.2) throw new Error(`条件确认或关键价位区间保存异常：${JSON.stringify({ parsedNote, levels: savedDraft.manualKeyLevels })}`);
    await page.locator("#closeBarNoteButton").click();
    await page.mouse.click(chartBox.x + chartBox.width * .7, chartBox.y + 80);
    await page.locator("#barNoteModal").waitFor({ state: "visible" });
    if (await page.locator("#noteKeyLevelInput").inputValue() !== "18.5" || await page.locator("#noteKeyLevelUpperInput").inputValue() !== "19.2") throw new Error("重新打开K线笔记没有恢复当前标记区间供修改");
    await page.locator("#noteKeyLevelUpperInput").fill("19.4");
    await page.locator("#barNoteInput").fill("更新本人标记区间");
    await page.locator("#saveBarNoteButton").click();
    savedDraft = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    const latestLevel = savedDraft.manualKeyLevels.at(-1);
    if (savedDraft.manualKeyLevels.length !== 2 || latestLevel.revision !== 2 || latestLevel.upper !== 19.4 || latestLevel.supersedes !== savedDraft.manualKeyLevels[0].id) throw new Error("关键价位区间更新没有保留旧版本与关联关系");
    await page.locator("#barNoteInput").fill("不是J<10时买入，而是等待收盘确认");
    if (!(await page.locator("#noteParsePreview").isHidden())) throw new Error("否定句被误解析成自动条件");
    if (errors.length) throw new Error(`页面脚本错误：${errors.join(" | ")}`);
    console.log(JSON.stringify({ screenshots: outputDir, desktop, mobile, afterSave, teachingComparison: "批次买入成本与分摊买入费已纳入净盈亏；指定条件标为事后教学对照", immutablePlanHistory: savedDraft.operationPlans.length, parsedNoteCandidates: parsedNote.parsedCandidates.length, keyLevelRevisionCount: savedDraft.manualKeyLevels.length, causalEvidence, negativeSentenceIgnored: true, saveFailureRetryAndExport: "已验证未同步暂存、导出与恢复后重试", legacyCompatible, pageErrors: errors }, null, 2));
  } finally {
    await context.close(); await browser.close(); server.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
