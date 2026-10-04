const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, ".qa-runtime", `review-notes-${process.pid}`);
const baseUrl = process.env.KLINE_REVIEW_QA_URL || "http://127.0.0.1:18765/";

function closeAt(index) {
  const relative = index - 290;
  if (relative < 0) return 20 + relative * 0.004;
  if (relative <= 35) return 20 - relative * 0.09;
  if (relative <= 65) return 16.85 + (relative - 35) * 0.11;
  if (relative <= 100) return 20.15 - (relative - 65) * 0.112;
  if (relative <= 140) return 16.23 + (relative - 100) * 0.16;
  return 22.63 - (relative - 140) * 0.08;
}

function bars(start, count) {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    const close = Number(closeAt(index).toFixed(3));
    const open = Number((close + Math.sin(index / 3) * 0.035).toFixed(3));
    return {
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10), open,
      high: Number((Math.max(open, close) + 0.12).toFixed(3)),
      low: Number((Math.min(open, close) - 0.12).toFixed(3)), close,
      volume: 180000 + (index % 19) * 14000,
    };
  });
}

function makeDraft() {
  const full = bars(0, 470);
  const visible = full.slice(250);
  return {
    format: "kline-training-draft", savedAt: new Date().toISOString(), symbol: "复盘档案验收样例", code: "600000",
    dataSource: "qa-fixture", dataMeta: { provider: "本地验收样例", adjust: "qfq", period: "daily" },
    bars: visible, indicatorWarmupBars: full.slice(0, 250), trainingStartIndex: 40, trainingEndIndex: 219,
    currentIndex: 82, cash: 1000000, lots: [], trades: [], barNotes: [], reviewNotes: [], operationPlans: [],
    nextSessionChecklist: [], reviewSuggestionSelections: [], avgCost: 0, finished: false, mode: "naked", indicator: "both",
    showChip: true, showIdentity: false, tradingRule: "a-share", trainingArea: "indicator", intradayData: {},
  };
}

async function main() {
  if (fs.existsSync(outputDir)) throw new Error(`拒绝覆盖已有验收输出目录：${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block", acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((draft) => localStorage.setItem("kline-training-draft", JSON.stringify(draft)), makeDraft());
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector("#chartCanvas")?.width > 0, null, { timeout: 10000 });

    await page.locator("#chartCanvas").scrollIntoViewIfNeeded();
    await page.locator("#chartNoteTool").click();
    const canvas = await page.locator("#chartCanvas").boundingBox();
    const chartGeometry = await page.locator("#chartCanvas").evaluate((element) => {
      const width = element.getBoundingClientRect().width;
      const chipWidth = Math.min(132, Math.max(88, width * 0.17));
      return { x: width - 14 - chipWidth - 8 - 2, y: 120 };
    });
    await page.mouse.click(canvas.x + chartGeometry.x, canvas.y + chartGeometry.y);
    await page.waitForTimeout(450);
    const noteDialogOpened = await page.locator("#barNoteModal").isVisible();
    if (!noteDialogOpened) {
      const debug = await page.locator("#chartCanvas").evaluate((element) => ({ rect: element.getBoundingClientRect().toJSON(), canvas: { width: element.width, height: element.height }, pointer: getComputedStyle(element).pointerEvents }));
      await page.screenshot({ path: path.join(outputDir, "debug-note-click.png") });
      throw new Error(`K线点击未打开笔记：${JSON.stringify({ chartGeometry, debug })}`);
    }
    await page.locator("#barNoteInput").fill("量价缩量，J值接近低位；先观察阶段低点是否守住。");
    await page.locator("#saveBarNoteButton").click();
    let draft = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (draft.barNotes.length !== 1 || draft.barNotes[0].kind !== "original") throw new Error(`当前K线当时笔记未正确保存：${JSON.stringify(draft.barNotes)}`);
    await page.locator("#closeBarNoteButton").click();

    const historicalCanvas = await page.locator("#chartCanvas").boundingBox();
    await page.mouse.click(historicalCanvas.x + historicalCanvas.width / 2, historicalCanvas.y + 120);
    await page.waitForFunction(() => !document.querySelector("#barNoteModal").hidden, null, { timeout: 3000 });
    await page.locator("#barNoteInput").fill("回看补记：这根K线当时还没有阶段低点确认。");
    await page.locator("#saveBarNoteButton").click();
    draft = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (!draft.barNotes.some((item) => item.kind === "postscript")) throw new Error("历史K线补记没有标记为事后补记");
    await page.locator("#closeBarNoteButton").click();

    const chartBox = await page.locator("#chartCanvas").boundingBox();
    await page.locator("#chartInspectTool").click();
    const intradayChartBox = await page.locator("#chartCanvas").boundingBox();
    await page.mouse.dblclick(intradayChartBox.x + intradayChartBox.width / 2, intradayChartBox.y + 120);
    await page.waitForFunction(() => !document.querySelector("#intradayVolumeModal").hidden, null, { timeout: 3000 });
    await page.locator("#closeIntradayVolumeAction").click();

    await page.locator("#quantityInput").fill("1000");
    await page.locator("#tradeReasonInput").fill("J值低位，日线缩量，分时卖压减弱后试仓。");
    await page.locator("#buyButton").click();
    draft = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    const originalReason = draft.trades.at(-1)?.reason;
    if (!originalReason || !draft.trades.at(-1)?.id) throw new Error("成交时想法或逐笔标识没有保存");

    await page.locator("#finishButton").click();
    await page.waitForFunction(async () => (await (await fetch("/api/reviews")).json()).reviews?.length === 1, { timeout: 10000 });
    let archiveList = await page.evaluate(async () => (await (await fetch("/api/reviews")).json()).reviews);
    const reviewId = archiveList[0].id;
    let archive = await page.evaluate(async (id) => await (await fetch(`/api/reviews/${id}`)).json(), reviewId);
    if (archive.barNotes.length !== 2 || !archive.barNotes.some((item) => item.kind === "postscript") || archive.trades[0]?.reason !== originalReason) throw new Error("归档丢失了原始K线笔记、历史补记或成交理由");

    await page.locator("#tradeLogBody [data-note-trade]").first().click();
    if (await page.locator("#barNoteEntries").innerText().then((text) => !text.includes(originalReason))) throw new Error("交易点笔记没有显示成交时原始理由");
    await page.locator("#barNoteEntries [data-note-trade]").click();
    await page.locator("#barNoteInput").fill("复盘补记：试仓前还应确认分时量缩减不是停牌或数据缺失。");
    await page.locator("#saveBarNoteButton").click();
    const noteDraft = await page.evaluate(() => JSON.parse(localStorage.getItem("kline-training-draft")));
    if (!noteDraft.reviewNotes?.some((item) => item.text.startsWith("复盘补记"))) throw new Error(`复盘补记没有进入训练记录：${JSON.stringify(noteDraft.reviewNotes)}`);
    await page.waitForFunction(async (id) => {
      const record = await (await fetch(`/api/reviews/${id}`)).json();
      return record.reviewNotes?.some((item) => item.targetType === "trade" && item.text.startsWith("复盘补记"));
    }, reviewId, { timeout: 10000 });
    archive = await page.evaluate(async (id) => await (await fetch(`/api/reviews/${id}`)).json(), reviewId);
    if (archive.trades[0].reason !== originalReason || archive.reviewNotes.length !== 1) throw new Error(`补记覆盖了原始成交想法或未被归档：${JSON.stringify({ reason: archive.trades[0].reason, originalReason, notes: archive.reviewNotes })}`);

    await page.screenshot({ path: path.join(outputDir, "my-reviews-1366-notes-open-full-page.png"), fullPage: true });
    await page.locator("#closeBarNoteButton").click();
    await page.screenshot({ path: path.join(outputDir, "my-reviews-1366-full-page.png"), fullPage: true });
    await page.screenshot({ path: path.join(outputDir, "my-reviews-1366-viewport.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    if (mobile.viewport !== mobile.document) throw new Error(`手机页面横向溢出：${JSON.stringify(mobile)}`);
    await page.locator("#tradeLogBody [data-note-trade]").first().click();
    await page.screenshot({ path: path.join(outputDir, "my-reviews-390-notes-open-full-page.png"), fullPage: true });
    await page.locator("#closeBarNoteButton").click();
    await page.screenshot({ path: path.join(outputDir, "my-reviews-390-full-page.png"), fullPage: true });
    await page.screenshot({ path: path.join(outputDir, "my-reviews-390-viewport.png") });

    await page.locator("#resetButton").click();
    const liveProgress = await page.locator("#barProgress").innerText();
    await page.locator("#openMyReviewsButton").click();
    await page.waitForSelector("#reviewArchiveList [data-open-review]");
    await page.locator(`#reviewArchiveList [data-open-review="${reviewId}"]`).click();
    await page.waitForFunction(() => !document.querySelector("#archiveViewBanner").hidden);
    if (await page.locator("#buyButton").isEnabled()) throw new Error("打开历史档案时交易按钮没有锁定");
    await page.locator("#returnFromArchiveButton").click();
    if ((await page.locator("#barProgress").innerText()) !== liveProgress) throw new Error("查看历史复盘后未恢复当前训练草稿");

    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#exportReviewsButton").click()]);
    const backupPath = path.join(outputDir, download.suggestedFilename());
    await download.saveAs(backupPath);
    const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    if (backup.format !== "kline-training-reviews" || backup.reviews?.length !== 1) throw new Error("复盘档案导出内容无效");
    await page.locator("#importReviewsButton").click();
    await page.locator("#reviewArchiveFileInput").setInputFiles(backupPath);
    await page.waitForFunction(() => document.querySelector("#reviewArchiveStatus").innerText.includes("已恢复"));
    archiveList = await page.evaluate(async () => (await (await fetch("/api/reviews")).json()).reviews);
    if (archiveList.length !== 1) throw new Error("导入同一档案后产生重复记录");

    const oldContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    const oldPage = await oldContext.newPage();
    const oldDraft = makeDraft();
    delete oldDraft.barNotes; delete oldDraft.reviewNotes; delete oldDraft.reviewId; delete oldDraft.reviewArchivedAt;
    await oldPage.addInitScript((draft) => localStorage.setItem("kline-training-draft", JSON.stringify(draft)), oldDraft);
    await oldPage.goto(baseUrl, { waitUntil: "networkidle" });
    const oldBackupCompatibility = await oldPage.evaluate(() => {
      const draft = JSON.parse(localStorage.getItem("kline-training-draft"));
      return Array.isArray(draft.barNotes) && Array.isArray(draft.reviewNotes);
    });
    await oldContext.close();
    if (!oldBackupCompatibility) throw new Error("旧草稿没有兼容初始化新笔记字段");

    if (errors.length) throw new Error(`页面脚本错误：${errors.join(" | ")}`);
    console.log(JSON.stringify({ outputDir, reviewId, archivedTrades: archive.trades.length, barNotes: archive.barNotes.length, reviewNotes: archive.reviewNotes.length, mobile, draftRestored: liveProgress, oldBackupCompatibility, errors }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
