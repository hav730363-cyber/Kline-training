const initialCash = 1_000_000;
const demoSymbol = "DEMO-ETF";
const commissionRate = 0.0003;
const stampDutyRate = 0.0005;
const transferFeeRate = 0.00001;
const minCommission = 5;
const feeRuleVersion = "中国市场训练费率-v1（佣金0.03%最低5元；A股卖出印花税0.05%；过户费0.001%）";
const demoHistoryBars = 250;
const demoTrainingBars = 180;
const contextBarCount = 40;
const initialVisibleBars = 1;
const defaultChartBars = 65;
const minChartBars = 20;
const maxChartBars = 240;
const sampleContextBars = 40;
const sampleTrainingBars = 180;
const indicatorWarmupBars = 250;
const sideDecisionTrainingOffset = 90;
const sideDecisionIndex = sampleContextBars + sideDecisionTrainingOffset;
const intradayExpectedTimes5 = [
  ...Array.from({ length: 5 }, (_, index) => `09:${String(35 + index * 5).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `10:${String(index * 5).padStart(2, "0")}`),
  ...Array.from({ length: 7 }, (_, index) => `11:${String(index * 5).padStart(2, "0")}`),
  ...Array.from({ length: 11 }, (_, index) => `13:${String(5 + index * 5).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `14:${String(index * 5).padStart(2, "0")}`),
  "15:00",
];
const automaticScanLimit = 120;
const collectionRequestTimeoutMs = 15000;
const collectionUniverseTimeoutMs = 90000;
const marketRequestTimeoutMs = 90000;
const supportedAutomaticPatternIds = [
  "triple-bottom", "head-shoulders-bottom", "adam-adam-bottom",
  "adam-eve-bottom", "rectangle-bottom", "round-bottom",
];
const makeLocalId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
let reviewReturnSnapshot = null;
let reviewArchiveSaveTimer = null;
let reviewArchiveSaveQueue = Promise.resolve();
let reviewWorkspaceOrigin = null;
let reviewQuestionIndex = 0;
let noteOpenBarIndex = null;
let noteOpenTradeId = null;
let noteOpenWaveId = null;
let noteOpenSession = false;
let chartClickTimer = null;

const $ = (id) => document.getElementById(id);
function loadTrainingArea() {
  try { return localStorage.getItem("kline-training-area") === "pattern" ? "pattern" : "indicator"; }
  catch (_) { return "indicator"; }
}
const state = {
  bars: [],
  symbol: "未载入",
  dataSource: "none",
  code: "",
  dataMeta: { provider: "", adjust: "qfq", period: "daily", fetchedAt: null, rawCount: 0, droppedCount: 0 },
  trainingStartIndex: 0,
  trainingEndIndex: -1,
  indicatorWarmupBars: [],
  activeTrainingSample: null,
  currentIndex: 0,
  cash: initialCash,
  lots: [],
  trades: [],
  sellTargetLotId: "",
  tradePreviewSide: "buy",
  barNotes: [],
  reviewNotes: [],
  reviewId: null,
  reviewArchivedAt: null,
  finishedRuleSnapshot: null,
  archiveView: false,
  showRuleComparison: false,
  operationPlans: [],
  nextSessionChecklist: [],
  reviewSuggestionSelections: [],
  reviewQuestionnaire: { answers: [], skipped: [] },
  reviewConclusions: [],
  teachingComparisons: [],
  manualKeyLevels: [],
  chartMarks: [], chartMarkHistory: [], chartMarkActions: [], chartTool: "inspect", chartCursor: null, chartSelectedMarkId: null, chartMarksVisible: true, chartInspectActive: true,
  avgCost: 0,
  finished: false,
  mode: "naked",
  indicator: "both",
  showChip: true,
  showIdentity: false,
  userName: loadUserName(),
  libraryView: "training",
  libraryCategory: "all",
  patternSearch: "",
  selectedPatternId: null,
  expandedPatternIds: [],
  trainingPatternIds: loadTrainingPatternIds(),
  candidateSamples: loadCandidateSamples(),
  collectedSamples: loadCollectedSamples(),
  sideLibraryView: "all",
  trainingArea: loadTrainingArea(),
  tradingRule: "a-share",
  chartBars: defaultChartBars,
  renderedChartBars: defaultChartBars,
  chartZoomExplicit: false,
  chartLastWidth: 0,
  chartOffset: 0,
  waveOverview: false,
  focusedWaveId: null,
  focusedTradeIndex: null,
  showWaveAnnotations: (() => { try { return localStorage.getItem("kline-training-wave-annotations") !== "false"; } catch (_) { return true; } })(),
  collection: { running: false, stopRequested: false, scanned: 0, total: 0, success: 0, failed: 0 },
  sourceHealth: { loading: false, sources: [], routing: null, fetchedAt: null },
  lastFailedMarketRequest: null,
  intraday: { open: false, loading: false, date: null, bars: [], provider: "", volumeUnit: "", cached: false, fetchedAt: null, error: "", requestKey: "", hoveredIndex: null },
  intradayData: {},
  intradayRefetchKeys: [],
  retryTask: null,
  serverCatalogLoaded: false,
  sampleLibraryError: "",
  sampleLoadingKey: "",
};

function hasCompleteSampleWindow(sample) {
  if (!sample || sample.snapshot !== true || !Array.isArray(sample.bars)) return false;
  const trainingStart = Number(sample.trainingStartIndex ?? sample.startIndex);
  const trainingEnd = Number(sample.trainingEndIndex ?? sample.endIndex);
  return sample.bars.length === sampleContextBars + sampleTrainingBars
    && trainingStart === sampleContextBars
    && trainingEnd === sampleContextBars + sampleTrainingBars - 1
    && Number.isInteger(trainingStart) && Number.isInteger(trainingEnd);
}

function hasCompleteCandidateWindow(sample) {
  if (sample?.catalogOnly === true && sample.serverCandidate === true) return sample.windowComplete === true;
  if (sample?.snapshot === true) return hasCompleteSampleWindow(sample);
  const start = Number(sample?.trainingStartIndex ?? sample?.startIndex);
  const end = Number(sample?.trainingEndIndex ?? sample?.endIndex);
  const contextStart = Number(sample?.contextStartIndex);
  return Number.isInteger(start) && Number.isInteger(end) && Number.isInteger(contextStart)
    && start - contextStart === sampleContextBars
    && end - start + 1 === sampleTrainingBars;
}

function isSideTrainingSample(sample) {
  return sample?.sampleType === "side-training" || ["side-left", "side-right"].includes(sample?.patternId);
}

function sideLabel(sample) {
  return sample?.tradeTiming === "right" || sample?.patternId === "side-right" ? "右侧" : "左侧";
}

function resolvedSampleCode(sample, fallback = "LOCAL") {
  const stripPrefix = (value) => String(value || "").trim().replace(/^(?:(?:sh|sz)\.?|[01]\.)/i, "");
  const code = stripPrefix(sample.code || sample.symbol || fallback);
  if (/^\d{1,5}$/.test(code)) {
    const savedSymbol = stripPrefix(sample.activeTrainingSample?.symbol || sample.symbol);
    if (/^\d{6}$/.test(savedSymbol)) return savedSymbol;
  }
  return code || fallback;
}

function phaseLabel(sample) {
  return sample?.pivotPhase === "after-low" ? "最低点后" : sample?.pivotPhase === "before-low" ? "最低点前" : "阶段位置待确认";
}

function hasIndicatorWarmup(sample) {
  if (sample?.catalogOnly === true && sample.serverCandidate === true) return Number(sample.warmupCount) === indicatorWarmupBars;
  return Array.isArray(sample?.indicatorWarmupBars) && sample.indicatorWarmupBars.length >= indicatorWarmupBars;
}

function hasCompleteIntradaySample(sample) {
  if (sample?.catalogOnly === true && sample.serverCandidate === true) return sample.intradayComplete === true;
  if (!Array.isArray(sample?.bars) || sample.bars.length !== sampleContextBars + sampleTrainingBars) return false;
  const dates = sample.bars.map((bar) => String(bar?.date || "").slice(0, 10)).filter(Boolean);
  const byDate = sample.intradayByDate;
  if (dates.length !== sample.bars.length || new Set(dates).size !== dates.length || !byDate || typeof byDate !== "object") return false;
  return dates.every((date) => {
    const day = byDate[date];
    if (!day || String(day.date || "").slice(0, 10) !== date || !day.provider || String(day.provider).includes("演示")) return false;
    const bars = day.bars;
    if (!Array.isArray(bars) || bars.length !== intradayExpectedTimes5.length) return false;
    if (bars.some((bar, index) => {
      if (!bar || String(bar.time || "") !== intradayExpectedTimes5[index]) return true;
      const values = [bar.open, bar.high, bar.low, bar.close, bar.volume].map(Number);
      return values.some((value) => !Number.isFinite(value))
        || Math.min(values[0], values[1], values[2], values[3]) <= 0
        || values[4] < 0
        || values[1] < Math.max(values[0], values[3])
        || values[2] > Math.min(values[0], values[3]);
    })) return false;
    return true;
  });
}

function patternLibrary() {
  return Array.isArray(window.KLINE_PATTERN_LIBRARY) ? window.KLINE_PATTERN_LIBRARY : [];
}

function loadTrainingPatternIds() {
  const defaults = Array.isArray(window.KLINE_PATTERN_LIBRARY)
    ? window.KLINE_PATTERN_LIBRARY.filter((item) => item.defaultTraining).map((item) => item.id)
    : [];
  try {
    const saved = JSON.parse(localStorage.getItem("kline-training-pattern-ids"));
    return Array.isArray(saved) ? saved : defaults;
  } catch (_) {
    return defaults;
  }
}

function saveTrainingPatternIds() {
  try { localStorage.setItem("kline-training-pattern-ids", JSON.stringify(state.trainingPatternIds)); } catch (_) { /* 浏览器可能禁用本地存储 */ }
}

function loadCollectedSamples() {
  try {
    const saved = JSON.parse(localStorage.getItem("kline-collected-samples"));
    return Array.isArray(saved) ? saved : [];
  } catch (_) {
    return [];
  }
}

function saveCollectedSamples() {
  try { localStorage.setItem("kline-collected-samples", JSON.stringify(state.collectedSamples)); } catch (_) { /* 浏览器可能禁用本地存储 */ }
}

function loadCandidateSamples() {
  try {
    const saved = JSON.parse(localStorage.getItem("kline-candidate-samples"));
    return Array.isArray(saved) ? saved.filter(hasCompleteCandidateWindow).map((sample) => ({
      ...sample,
      reviewStatus: sample.reviewStatus || "pending",
      status: sample.status || "待审核",
    })) : [];
  } catch (_) {
    return [];
  }
}

function saveCandidateSamples() {
  try { localStorage.setItem("kline-candidate-samples", JSON.stringify(state.candidateSamples)); } catch (_) { /* 浏览器可能禁用本地存储 */ }
}

async function postJson(url, payload, timeoutMs = marketRequestTimeoutMs) {
  return fetchJsonWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, timeoutMs);
}

async function loadServerCandidates() {
  try {
    const { response, payload } = await fetchJsonWithTimeout("/api/sample-candidates?view=summary", { cache: "no-store" }, collectionRequestTimeoutMs);
    if (!response.ok || !Array.isArray(payload.candidates)) throw new Error(payload.error || "训练库目录返回异常");
    const serverCandidates = payload.candidates
      .filter((sample) => sample.catalogOnly === true || hasCompleteCandidateWindow(sample))
      .map((sample) => ({ ...sample, serverCandidate: true, reviewStatus: sample.reviewStatus || "pending", status: sample.status || "待审核" }));
    state.candidateSamples = state.candidateSamples.filter((sample) => !sample.serverCandidate && !sample.catalogOnly);
    state.serverCatalogLoaded = true;
    state.sampleLibraryError = "";
    mergeCandidateSamples(serverCandidates);
    renderLibrary();
    return true;
  } catch (error) {
    state.sampleLibraryError = `训练库未刷新：${error.message}。请检查本地服务后点击“刷新训练库”。`;
    renderSideTrainingLibrary();
    return false;
  }
}

async function loadRealSampleBank() {
  try {
    const response = await fetch("./sample_bank.json", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload?.format !== "kline-training-real-sample-bank" || !Array.isArray(payload.samples)) return;
    const validSamples = payload.samples.filter(hasCompleteSampleWindow);
    const knownKeys = new Set(state.candidateSamples.map((sample) => sample.key));
    const merged = [...state.candidateSamples, ...validSamples.filter((sample) => !knownKeys.has(sample.key)).map((sample) => ({
      ...sample, reviewStatus: sample.reviewStatus || "pending", status: sample.status || "待审核", snapshot: true,
    }))];
    state.candidateSamples = [...new Map(merged.map((sample) => [sample.key, sample])).values()]
      .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0)).slice(0, 400);
    saveCandidateSamples();
    const isRequestedBank = Number(payload.version) >= 3
      && Number(payload.targetPerPattern) === 2
      && Number(payload.contextBars) === 40
      && Number(payload.trainingBars) === 180;
    const rejectedCount = payload.samples.length - validSamples.length;
    $("candidateScanHint").textContent = validSamples.length
      ? `已载入 ${validSamples.length} 个完整候选样本（背景 40 根 + 训练 180 根），均需人工审核${rejectedCount ? `；已忽略 ${rejectedCount} 个旧格式片段` : ""}。`
      : `内置样本库没有符合“40 根背景 + 180 根训练区”的完整片段；旧格式样本已全部忽略。`;
    renderLibrary();
  } catch (_) { /* 静态部署尚未上传样本文件时不影响基础训练 */ }
}

function loadUserName() {
  try { return localStorage.getItem("kline-training-username") || ""; } catch (_) { return ""; }
}

function saveUserName(name) {
  try { localStorage.setItem("kline-training-username", name); } catch (_) { /* 浏览器可能禁用本地存储 */ }
}

function renderUser() {
  $("userNameLabel").textContent = state.userName ? `用户：${state.userName}` : "未登录";
  $("loginButton").textContent = state.userName ? "切换用户名" : "用户名登录";
}

function openLogin() {
  $("userNameInput").value = state.userName;
  $("loginHint").textContent = "当前为自用测试阶段，不需要手机号和密码。";
  $("loginModal").hidden = false;
  $("userNameInput").focus();
}

function closeLogin() { $("loginModal").hidden = true; }

function saveLogin() {
  const name = $("userNameInput").value.trim();
  if (!name) return $("loginHint").textContent = "请输入用户名。";
  state.userName = name.slice(0, 20);
  saveUserName(state.userName);
  closeLogin();
  $("marketDataHint").textContent = `当前用户：${state.userName} · 用户名仅保存在本机浏览器。`;
  renderUser();
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function makeDemoBars(count) {
  const random = seededRandom(20260909);
  const bars = [];
  let close = 12.8;
  const start = new Date("2024-01-02T00:00:00");
  let rangeCenter = close;
  for (let i = 0; i < count; i += 1) {
    const trainingIndex = i - demoHistoryBars;
    let trend;
    if (trainingIndex < 0) {
      trend = Math.sin(i / 24) * 0.018 + (i % 95 < 48 ? 0.016 : -0.014);
    } else if (trainingIndex < 25) {
      trend = -0.075;
      if (trainingIndex === 24) rangeCenter = close - 0.04;
    } else if (trainingIndex < 112) {
      trend = (rangeCenter - close) * 0.2 + Math.sin(trainingIndex / 5) * 0.035;
    } else if (trainingIndex < 132) {
      trend = 0.095;
    } else {
      trend = 0.045 + Math.sin(trainingIndex / 8) * 0.018;
    }
    const noise = (random() - 0.5) * 0.44;
    const open = close + (random() - 0.5) * 0.24;
    close = Math.max(7.2, open + trend + noise);
    const high = Math.max(open, close) + 0.08 + random() * 0.2;
    const low = Math.min(open, close) - 0.08 - random() * 0.2;
    const volume = Math.round(1_400_000 + random() * 1_200_000 + Math.abs(close - open) * 4_500_000);
    const date = new Date(start);
    date.setDate(start.getDate() + i + Math.floor(i / 5) * 2);
    bars.push({ date, open, high, low, close, volume });
  }
  return bars;
}

function formatMoney(value) {
  return `¥${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPrice(value) { return `¥${value.toFixed(2)}`; }
function formatIndicatorPrice(value) { return value == null ? "—" : formatPrice(value); }
// 行情日期是交易所本地日期，不是需要转换时区的时间点。
// 之前使用 toISOString() 会在东八区把本地零点变成前一天 16:00，
// 双击日 K 请求分时因此偏移一天，历史日尤其容易被判定为“无数据”。
function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function round(value, digits = 2) { return Number(value.toFixed(digits)); }

function validateBars(inputBars, minimum = 70) {
  const rawCount = Array.isArray(inputBars) ? inputBars.length : 0;
  const sorted = (Array.isArray(inputBars) ? inputBars : []).filter((bar) => bar && bar.date instanceof Date && !Number.isNaN(bar.date.getTime()))
    .map((bar) => ({
      date: new Date(bar.date),
      open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close), volume: Number(bar.volume),
    }))
    .filter((bar) => [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
      && bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0 && bar.volume >= 0
      && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close))
    .sort((a, b) => a.date - b.date);
  const unique = sorted.filter((bar, index) => index === 0 || formatDate(bar.date) !== formatDate(sorted[index - 1].date));
  const result = { bars: unique, rawCount, validCount: unique.length, droppedCount: rawCount - unique.length, duplicateCount: sorted.length - unique.length };
  if (unique.length < minimum) throw new Error(`有效 K 线只有 ${unique.length} 根，至少需要 ${minimum} 根；已拒绝不完整数据。`);
  return result;
}

function updateDataMeta(meta = {}) {
  state.dataMeta = {
    provider: meta.provider || (state.dataSource === "demo" ? "内置演示" : "本地文件"),
    adjust: meta.adjust || "qfq",
    period: meta.period || "daily",
    fetchedAt: meta.fetchedAt || new Date().toISOString(),
    rawCount: Number(meta.rawCount || state.bars.length),
    validCount: Number(meta.validCount || state.bars.length),
    droppedCount: Number(meta.droppedCount || 0),
    duplicateCount: Number(meta.duplicateCount || 0),
    volumeUnit: String(meta.volumeUnit || ""),
  };
}

function dataMetaLabel() {
  const meta = state.dataMeta || {};
  const when = meta.fetchedAt ? new Date(meta.fetchedAt).toLocaleString("zh-CN") : "—";
  const adjust = meta.adjust === "qfq" ? "前复权" : meta.adjust === "hfq" ? "后复权" : "不复权";
  const period = { daily: "日线", weekly: "周线", monthly: "月线", yearly: "年线" }[meta.period] || meta.period || "未知周期";
  return `${meta.provider || "未知来源"} · ${adjust} · ${period} · ${meta.validCount || state.bars.length} 根有效 K 线 · 更新于 ${when}`;
}

function sma(values, period, index) {
  if (index < period - 1) return null;
  const slice = values.slice(index - period + 1, index + 1);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function ema(values, period) {
  const result = [];
  const multiplier = 2 / (period + 1);
  values.forEach((value, index) => {
    if (index === 0) result.push(value);
    else result.push((value - result[index - 1]) * multiplier + result[index - 1]);
  });
  return result;
}

function indicatorData() {
  const warmup = Array.isArray(state.indicatorWarmupBars) ? state.indicatorWarmupBars : [];
  const allBars = [...warmup, ...state.bars];
  const allCloses = allBars.map((bar) => bar.close);
  const allVolumes = allBars.map((bar) => bar.volume);
  const warmupLength = warmup.length;
  const closes = allCloses.slice(warmupLength);
  const volumes = allVolumes.slice(warmupLength);
  const fast = ema(allCloses, 12);
  const slow = ema(allCloses, 26);
  const difAll = fast.map((value, index) => value - slow[index]);
  const deaAll = ema(difAll, 9);
  const macdAll = difAll.map((value, index) => (value - deaAll[index]) * 2);
  const k = [], d = [], j = [];
  let lastK = 50, lastD = 50;
  allBars.forEach((bar, index) => {
    const start = Math.max(0, index - 8);
    const window = allBars.slice(start, index + 1);
    const high = Math.max(...window.map((item) => item.high));
    const low = Math.min(...window.map((item) => item.low));
    const rsv = high === low ? 50 : ((bar.close - low) / (high - low)) * 100;
    lastK = (2 * lastK + rsv) / 3;
    lastD = (2 * lastD + lastK) / 3;
    k.push(lastK); d.push(lastD); j.push(3 * lastK - 2 * lastD);
  });
  const sliceVisible = (values) => values.slice(warmupLength);
  const ma5 = allCloses.map((_, index) => sma(allCloses, 5, index)).slice(warmupLength);
  const ma20 = allCloses.map((_, index) => sma(allCloses, 20, index)).slice(warmupLength);
  const ma60 = allCloses.map((_, index) => sma(allCloses, 60, index)).slice(warmupLength);
  const volumeMa120 = allVolumes.map((_, index) => sma(allVolumes, 120, index)).slice(warmupLength);
  const volumeMa250 = allVolumes.map((_, index) => sma(allVolumes, 250, index)).slice(warmupLength);
  return {
    closes, volumes, dif: sliceVisible(difAll), dea: sliceVisible(deaAll), macd: sliceVisible(macdAll),
    k: sliceVisible(k), d: sliceVisible(d), j: sliceVisible(j), ma5, ma20, ma60, volumeMa120, volumeMa250,
  };
}

function currentBars() {
  const chartStart = Math.max(0, state.trainingStartIndex - contextBarCount);
  return state.bars.slice(chartStart, state.currentIndex + 1);
}
function currentBar() { return state.bars[state.currentIndex]; }
function trainingLength() { return state.trainingEndIndex - state.trainingStartIndex + 1; }
function shownBarCount() { return state.currentIndex - state.trainingStartIndex + 1; }
function firstTrainingDecisionIndex() { return state.trainingStartIndex; }
function heldQty() { return state.lots.reduce((sum, lot) => sum + lot.qty, 0); }
function lotAvailableQty(lot) {
  const tPlusZero = state.tradingRule === "etf-t0";
  return tPlusZero || lot.index < state.currentIndex ? lot.qty : 0;
}
function availableQty() {
  return state.lots.reduce((sum, lot) => sum + lotAvailableQty(lot), 0);
}
function positionValue() { return heldQty() * currentBar().close; }
function equity() { return state.cash + positionValue(); }
function returnRate() { return ((equity() - initialCash) / initialCash) * 100; }
function floatingPnl() { return heldQty() * (currentBar().close - state.avgCost); }

function transactionFees(side, amount) {
  const commission = Math.max(minCommission, amount * commissionRate);
  const stampDuty = side === "sell" && state.tradingRule === "a-share" ? amount * stampDutyRate : 0;
  const transferFee = amount * transferFeeRate;
  return { commission, stampDuty, transferFee, total: commission + stampDuty + transferFee };
}

function tradingRuleLabel() {
  return state.tradingRule === "etf-t0" ? "ETF · T+0" : state.tradingRule === "etf-t1" ? "ETF · T+1" : "A股 · T+1";
}

function allocateSaleLots(lots, qty, totalFee, targetLotId = "") {
  const candidates = lots.filter((lot) => lot.qty > 0 && (!targetLotId || lot.id === targetLotId));
  let remaining = qty;
  let feeRemaining = totalFee;
  const allocations = [];
  candidates.forEach((lot) => {
    if (remaining <= 0) return;
    const used = Math.min(lot.qty, remaining);
    const fee = used === remaining ? feeRemaining : totalFee * used / qty;
    allocations.push({ lotId: lot.id, qty: used, fee });
    remaining -= used;
    feeRemaining -= fee;
  });
  return remaining > 0 ? [] : allocations;
}

function consumeTradeAllocations(lots, trade, allowFifoFallback = true) {
  let realizedBeforeSellFee = 0;
  let remaining = Math.max(0, Number(trade.qty) || 0);
  const consume = (lot, requested) => {
    const used = Math.min(lot.qty, requested);
    if (!used) return 0;
    realizedBeforeSellFee += (Number(trade.price) - lot.price - (lot.feePerShare || 0)) * used;
    lot.qty -= used;
    remaining -= used;
    return used;
  };
  if (Array.isArray(trade.allocations)) {
    trade.allocations.forEach((allocation) => {
      if (remaining <= 0) return;
      const lot = lots.find((item) => item.id === allocation.lotId && item.qty > 0);
      if (lot) consume(lot, Math.max(0, Number(allocation.qty) || 0));
    });
  }
  if (allowFifoFallback && remaining > 0) {
    lots.forEach((lot) => { if (remaining > 0) consume(lot, remaining); });
  }
  for (let index = lots.length - 1; index >= 0; index -= 1) if (lots[index].qty <= 0) lots.splice(index, 1);
  return { realizedBeforeSellFee, matchedQty: Math.max(0, Number(trade.qty) - remaining), remaining };
}

function migrateTradeLotLedger(trades, currentLots = []) {
  const ledger = [];
  trades.forEach((trade) => {
    if (!trade.id) trade.id = makeLocalId();
    if (trade.side === "buy") {
      trade.lotId ||= trade.id;
      ledger.push({
        id: trade.lotId, index: Number(trade.index), qty: Number(trade.qty) || 0,
        price: Number(trade.price) || 0, feePerShare: (Number(trade.fee) || 0) / Math.max(1, Number(trade.qty) || 0),
        role: trade.lotRole || "", purpose: trade.lotPurpose || "", exitRule: trade.lotExitRule || "",
        planUpdates: Array.isArray(trade.lotPlanUpdates) ? trade.lotPlanUpdates : [],
      });
      return;
    }
    if (!Array.isArray(trade.allocations)) trade.allocations = allocateSaleLots(ledger, Number(trade.qty) || 0, Number(trade.fee) || 0);
    consumeTradeAllocations(ledger, trade);
  });

  const unmatched = ledger.filter((lot) => lot.qty > 0);
  currentLots.forEach((lot) => {
    if (lot.id) return;
    const candidateIndex = unmatched.findIndex((item) => item.index === Number(lot.index)
      && item.qty === Number(lot.qty) && Math.abs(item.price - Number(lot.price)) < 0.011);
    const candidate = candidateIndex >= 0 ? unmatched.splice(candidateIndex, 1)[0] : null;
    lot.id = candidate?.id || makeLocalId();
    if (candidate) {
      lot.role ||= candidate.role;
      lot.purpose ||= candidate.purpose;
      lot.exitRule ||= candidate.exitRule;
      lot.planUpdates ||= candidate.planUpdates;
    }
  });
}

function lotCurrentPlan(lot) {
  const updates = Array.isArray(lot.planUpdates) ? lot.planUpdates : [];
  return updates.at(-1) || { role: lot.role || "", purpose: lot.purpose || "", exitRule: lot.exitRule || "" };
}

function tradeAllocationLabel(trade) {
  if (trade.side !== "sell" || !Array.isArray(trade.allocations) || !trade.allocations.length) return "";
  return trade.allocations.map((allocation) => {
    const buy = state.trades.find((item) => item.side === "buy" && (item.lotId || item.id) === allocation.lotId);
    const role = buy?.lotRole || "未指定批次";
    const date = buy ? state.bars[buy.index]?.date : null;
    return `${role}${date ? `（${formatDate(date)}）` : ""} ${Number(allocation.qty).toLocaleString()}股`;
  }).join("、");
}

function currentSellTarget() {
  return state.sellTargetLotId ? state.lots.find((lot) => lot.id === state.sellTargetLotId) || null : null;
}

function saleScopeQty() {
  const lot = currentSellTarget();
  return lot ? lotAvailableQty(lot) : availableQty();
}

function maximumAffordableBuyQty() {
  const price = currentBar().close;
  let qty = Math.floor(state.cash / price / 100) * 100;
  while (qty > 0 && qty * price + transactionFees("buy", qty * price).total > state.cash) qty -= 100;
  return qty;
}

function renderTradePreview() {
  const preview = $("tradePreview");
  if (!preview || !state.bars.length) return;
  const qty = Number($("quantityInput").value);
  const side = state.tradePreviewSide || "buy";
  if (!Number.isInteger(qty) || qty < 100 || qty % 100 !== 0) {
    preview.textContent = "请输入 100 股整数倍；快捷比例仅填写数量，不会自动成交。";
    return;
  }
  const price = currentBar().close;
  const amount = qty * price;
  const fees = transactionFees(side, amount).total;
  if (side === "buy") {
    const total = equity();
    const afterExposure = (positionValue() + amount) / Math.max(1, total - fees) * 100;
    const shortfall = amount + fees > state.cash;
    preview.textContent = `预计金额 ${formatMoney(amount)} · 费用 ${formatMoney(fees)} · 成交后总仓位约 ${afterExposure.toFixed(1)}%${shortfall ? ` · 超出现金，当前最多可买 ${maximumAffordableBuyQty().toLocaleString()} 股` : ""}`;
  } else {
    const target = currentSellTarget();
    const remainingTarget = target ? target.qty - qty : heldQty() - qty;
    const scope = target ? `指定批次剩余 ${Math.max(0, remainingTarget).toLocaleString()} 股` : `总持仓剩余 ${Math.max(0, remainingTarget).toLocaleString()} 股`;
    preview.textContent = `预计金额 ${formatMoney(amount)} · 费用 ${formatMoney(fees)} · ${scope}${qty > saleScopeQty() ? " · 超出当前可卖数量" : ""}`;
  }
}

function renderTrancheManager() {
  const list = $("trancheList");
  const select = $("sellLotSelect");
  if (!list || !select) return;
  const previousTarget = state.sellTargetLotId;
  const openLots = state.lots.filter((lot) => lot.qty > 0);
  select.innerHTML = `<option value="">全部可卖持仓（先买先卖 · ${availableQty().toLocaleString()} 股）</option>${openLots.map((lot, index) => {
    const plan = lotCurrentPlan(lot);
    const available = lotAvailableQty(lot);
    const date = state.bars[lot.index]?.date;
    return `<option value="${escapeHtml(lot.id)}">第 ${index + 1} 批${plan.role ? ` · ${escapeHtml(plan.role)}` : ""}${date ? ` · ${formatDate(date)}` : ""} · 可卖 ${available.toLocaleString()} / ${lot.qty.toLocaleString()} 股</option>`;
  }).join("")}`;
  state.sellTargetLotId = openLots.some((lot) => lot.id === previousTarget) ? previousTarget : "";
  select.value = state.sellTargetLotId;
  $("trancheSummary").textContent = openLots.length
    ? `${openLots.length} 个持仓批次 · 共 ${heldQty().toLocaleString()} 股 · 当前可卖 ${availableQty().toLocaleString()} 股`
    : "当前没有持仓批次";
  if (!openLots.length) {
    list.innerHTML = '<p class="tranche-empty">当前没有持仓批次</p>';
    return;
  }
  const readOnly = false;
  list.innerHTML = openLots.map((lot, index) => {
    const plan = lotCurrentPlan(lot);
    const currentDate = state.bars[lot.index]?.date;
    const value = lot.qty * currentBar().close;
    const pnl = (currentBar().close - lot.price - (lot.feePerShare || 0)) * lot.qty;
    const sellable = lotAvailableQty(lot);
    const selected = lot.id === state.sellTargetLotId;
    return `<article class="tranche-card ${selected ? "is-selected" : ""}" data-lot-id="${escapeHtml(lot.id)}">
      <div class="tranche-card-head"><strong>${escapeHtml(plan.role || `第 ${index + 1} 批 · 未指定`)} · ${lot.qty.toLocaleString()} 股</strong><time>${currentDate ? formatDate(currentDate) : "日期未知"}</time></div>
      <div class="tranche-card-grid">
        <div><span>买入价 / 含买费成本</span><b>${formatPrice(lot.price)} / ${formatPrice(lot.price + (lot.feePerShare || 0))}</b></div>
        <div><span>可卖数量 / 持仓市值</span><b>${sellable.toLocaleString()} 股 / ${formatMoney(value)}</b></div>
        <div><span>浮动盈亏</span><b class="${pnl >= 0 ? "buy-text" : "sell-text"}">${formatMoney(pnl)}</b></div>
        <div><span>用途 / 退出条件</span><b>${escapeHtml(plan.purpose || "—")} / ${escapeHtml(plan.exitRule || "—")}</b></div>
      </div>
      ${Array.isArray(lot.planUpdates) && lot.planUpdates.length ? `<p class="tranche-card-note">计划补记 ${lot.planUpdates.length} 次 · 最近更新 ${new Date(lot.planUpdates.at(-1).savedAt).toLocaleString()}</p>` : ""}
      <div class="tranche-card-actions"><button class="secondary-button" type="button" data-select-lot="${escapeHtml(lot.id)}" ${state.finished ? "disabled" : ""}>${selected ? "已选为卖出对象" : `选择此批卖出（可卖 ${sellable} 股）`}</button>${readOnly ? "" : `<button class="secondary-button" type="button" data-toggle-lot-plan="${escapeHtml(lot.id)}">补记仓位计划</button>`}</div>
      ${readOnly ? "" : `<div class="tranche-plan-editor" data-lot-plan-editor="${escapeHtml(lot.id)}" hidden>
        <label>角色<select data-lot-role><option value="">未指定</option>${["试探", "确认加仓", "趋势持有", "其他"].map((role) => `<option value="${role}" ${plan.role === role ? "selected" : ""}>${role}</option>`).join("")}</select></label>
        <label>本批用途<textarea data-lot-purpose maxlength="180" rows="2">${escapeHtml(plan.purpose || "")}</textarea></label>
        <label>退出条件<textarea data-lot-exit maxlength="180" rows="2">${escapeHtml(plan.exitRule || "")}</textarea></label>
        <button class="primary-button" type="button" data-save-lot-plan="${escapeHtml(lot.id)}">保存为带时间的补记</button>
      </div>`}
    </article>`;
  }).join("");
}

function currentInstrumentBlocked() {
  const name = String(state.symbol || "").toUpperCase();
  const bar = currentBar();
  if (/\bST|退市|退$/.test(name)) return "训练库已排除 ST/退市标的。";
  if (!bar || bar.volume <= 0) return "当前 K 线成交量为 0，按停牌处理，不能成交。";
  return "";
}

function priceLimitRate() {
  const code = String(state.code || state.symbol || "");
  if (/^(300|301|688|689)/.test(code)) return 0.2;
  if (/^8/.test(code)) return 0.3;
  return 0.1;
}

function limitLocked(side) {
  if (state.dataSource === "demo" || state.currentIndex < 1) return false;
  const bar = currentBar();
  const previous = state.bars[state.currentIndex - 1];
  if (!bar || !previous || previous.close <= 0) return false;
  const change = (bar.close - previous.close) / previous.close;
  const limit = priceLimitRate();
  const atHigh = Math.abs(bar.close - bar.high) <= Math.max(bar.close * 0.0001, 0.01);
  const atLow = Math.abs(bar.close - bar.low) <= Math.max(bar.close * 0.0001, 0.01);
  if (side === "buy" && change >= limit * 0.995 && atHigh) return true;
  if (side === "sell" && change <= -limit * 0.995 && atLow) return true;
  return false;
}

function ratioLabel(divisor) {
  if (divisor === 0) return "用完可用现金";
  return `当前总资产的 1/${divisor}`;
}

function affordableBuyQty(divisor) {
  if (divisor === 0) return maximumAffordableBuyQty();
  const price = currentBar().close;
  const budget = equity() / divisor;
  let qty = Math.floor(budget / price / 100) * 100;
  while (qty > 0 && qty * price > budget) qty -= 100;
  return qty;
}

function quickPosition(side, divisor) {
  if (state.finished) return setHint("本局已经结束，请重新开始后再设置仓位。", true);
  const targetLot = side === "sell" ? currentSellTarget() : null;
  const sellBase = targetLot ? lotAvailableQty(targetLot) : availableQty();
  const qty = side === "buy" ? affordableBuyQty(divisor) : Math.floor((sellBase / divisor) / 100) * 100;
  state.tradePreviewSide = side;
  if (qty < 100) {
    $("quantityInput").value = 0;
    renderTradePreview();
    return setHint(side === "buy" ? "当前总资产比例不足 100 股，或可用现金不足 100 股。" : "所选范围当前没有可卖的 100 股整数手。", true);
  }
  $("quantityInput").value = qty;
  renderTradePreview();
  const basis = side === "buy" ? ratioLabel(divisor) : targetLot ? "指定批次可卖持仓" : "全部可卖持仓";
  setHint(`已按${basis}填写 ${qty.toLocaleString()} 股；检查预览后点击${side === "buy" ? "买入" : "卖出"}成交。`, false);
}

function updateAverageCost() {
  const qty = heldQty();
  state.avgCost = qty === 0 ? 0 : state.lots.reduce((sum, lot) => sum + lot.price * lot.qty, 0) / qty;
}

function readDecisionForm(prefix) {
  const value = (suffix) => String($(`${prefix}${suffix}`)?.value || "").trim();
  const signals = [...document.querySelectorAll(`[data-${prefix === "trade" ? "trade" : "note"}-signal]:checked`)]
    .map((item) => item.dataset[prefix === "trade" ? "tradeSignal" : "noteSignal"]);
  const intent = value("IntentInput");
  const certainty = value("CertaintyInput");
  const confirmCondition = value("ConfirmConditionInput").slice(0, 120);
  const invalidationCondition = value("InvalidationConditionInput").slice(0, 120);
  const keyLevelValue = prefix === "note" ? Number(value("KeyLevelInput")) : NaN;
  const keyLevelUpperValue = prefix === "note" ? Number(value("KeyLevelUpperInput")) : NaN;
  const keyLevel = Number.isFinite(keyLevelValue) && keyLevelValue > 0 ? keyLevelValue : null;
  const keyLevelUpper = Number.isFinite(keyLevelUpperValue) && keyLevelUpperValue > 0 ? keyLevelUpperValue : null;
  const keyLevelRange = keyLevel != null && keyLevelUpper != null ? [Math.min(keyLevel, keyLevelUpper), Math.max(keyLevel, keyLevelUpper)] : null;
  return intent || certainty || signals.length || confirmCondition || invalidationCondition || keyLevel != null
    ? { intent, certainty, signals, confirmCondition, invalidationCondition, keyLevel, keyLevelRange, recordedAt: new Date().toISOString() }
    : null;
}

function clearDecisionForm(prefix) {
  ["IntentInput", "CertaintyInput", "ConfirmConditionInput", "InvalidationConditionInput", "KeyLevelInput", "KeyLevelUpperInput"].forEach((suffix) => {
    const element = $(`${prefix}${suffix}`);
    if (element) element.value = "";
  });
  document.querySelectorAll(`[data-${prefix === "trade" ? "trade" : "note"}-signal]`).forEach((item) => { item.checked = false; });
}

function parseExplicitNoteCandidates(text) {
  const source = String(text || "").trim();
  if (!source || /不确定|不一定|不考虑|不是|并非|没有|未必/.test(source)) return [];
  const candidates = [];
  const jMatch = source.match(/J\s*[值]?\s*(?:小于|低于|<|≤|<=)\s*(-?\d+(?:\.\d+)?)/i);
  if (jMatch) candidates.push({ kind: "indicator-threshold", field: "J", operator: "<", value: Number(jMatch[1]), status: "待确认" });
  const priceMatch = source.match(/(?:收盘|收盘价)\s*(跌破|低于|小于|<|≤|<=|站上|突破|高于|大于|>|≥|>=)\s*(\d+(?:\.\d+)?)(?:\s*元)?/);
  if (priceMatch) candidates.push({ kind: "price-threshold", field: "close", operator: /跌破|低于|小于|</.test(priceMatch[1]) ? "<" : ">=", value: Number(priceMatch[2]), status: "待确认" });
  const fractionMatch = source.match(/(?:卖出|减仓)(?:指定批次|该批)?(?:的)?(一半|1\s*\/\s*([2346]))/);
  if (fractionMatch) candidates.push({ kind: "quantity-fraction", field: "sell-qty", fraction: fractionMatch[1] === "一半" ? 0.5 : 1 / Number(fractionMatch[2]), status: "待确认", missing: "目标批次及可卖数量" });
  return candidates;
}

function renderNoteParsePreview() {
  const preview = $("noteParsePreview");
  if (!preview) return;
  const candidates = parseExplicitNoteCandidates($("barNoteInput").value);
  preview.hidden = !candidates.length;
  preview.innerHTML = candidates.length
    ? `识别到待确认条件：${candidates.map((item) => `${escapeHtml(item.field)} ${escapeHtml(item.operator || "")} ${escapeHtml(item.value ?? `${item.fraction * 100}%`)}${item.missing ? `（还需补充${escapeHtml(item.missing)}）` : ""}`).join("；")}。保存后只作为待确认标签，不自动变成交易规则。<label><input type="checkbox" id="confirmParsedNote"> 我确认这些条件表达了我的意思</label>`
    : "";
}

function confirmedNoteCandidates() {
  return $("confirmParsedNote")?.checked ? parseExplicitNoteCandidates($("barNoteInput").value).map((item) => ({ ...item, status: "用户确认", confirmedAt: new Date().toISOString() })) : [];
}

function trade(side) {
  if (state.finished) return setHint("本局已结束，请点击重新开始后再交易。", true);
  state.tradePreviewSide = side;
  const qty = Number($("quantityInput").value);
  const price = currentBar().close;
  const targetLot = side === "sell" ? currentSellTarget() : null;
  renderTradePreview();
  const blocked = currentInstrumentBlocked();
  if (blocked) return setHint(blocked, true);
  if (limitLocked(side)) return setHint(side === "buy" ? "当前收盘接近涨停且封板，按涨跌停规则不能买入。" : "当前收盘接近跌停且封板，按涨跌停规则不能卖出。", true);
  if (!Number.isInteger(qty) || qty < 100 || qty % 100 !== 0) return setHint("数量必须是 100 股的整数倍。", true);
  const sellCapacity = targetLot ? lotAvailableQty(targetLot) : availableQty();
  if (side === "sell" && sellCapacity < qty) return setHint(targetLot ? `所选批次当前可卖 ${sellCapacity.toLocaleString()} 股；T+1 买入部分需等下一根 K 线。` : `当前总可卖持仓为 ${sellCapacity.toLocaleString()} 股，${tradingRuleLabel()}规则限制了本次卖出。`, true);
  const amount = qty * price;
  const fees = transactionFees(side, amount);
  const decision = readDecisionForm("trade");
  const operationMeta = {
    reason: String($("tradeReasonInput")?.value || "").trim().slice(0, 240),
    indicators: operationIndicatorSnapshot(state.currentIndex),
    reviewRuleVersion: effectiveReviewRuleset().version,
    reviewRuleSnapshot: structuredClone(effectiveReviewRuleset()),
    decision,
  };
  if (side === "buy") {
    if (state.cash < amount + fees.total) return setHint(`可用现金不足；按当前价格最多可买 ${maximumAffordableBuyQty().toLocaleString()} 股，请调整数量。`, true);
    const lotId = makeLocalId();
    const role = String($("trancheRoleInput")?.value || "").trim();
    const purpose = String($("tranchePurposeInput")?.value || "").trim().slice(0, 180);
    const exitRule = String($("trancheExitInput")?.value || "").trim().slice(0, 180);
    state.cash -= amount + fees.total;
    state.lots.push({ id: lotId, index: state.currentIndex, qty, originalQty: qty, price, feePerShare: fees.total / qty, role, purpose, exitRule, planUpdates: [] });
    state.trades.push({ id: makeLocalId(), lotId, lotRole: role, lotPurpose: purpose, lotExitRule: exitRule, side, qty, price, fee: fees.total, commission: fees.commission, stampDuty: fees.stampDuty, transferFee: fees.transferFee, feeRuleVersion, cash: state.cash, index: state.currentIndex, ...operationMeta });
    $("trancheRoleInput").value = ""; $("tranchePurposeInput").value = ""; $("trancheExitInput").value = "";
    $("tranchePlanFields").open = false;
    setHint(`${tradingRuleLabel()}买入成功；${state.tradingRule === "etf-t0" ? "本根 K 线即可卖出。" : "下一根 K 线后可卖。"}`, false);
  } else {
    const allocations = allocateSaleLots(state.lots.filter((lot) => lotAvailableQty(lot) > 0), qty, fees.total, targetLot?.id || "");
    if (!allocations.length) return setHint("无法将本次卖出匹配到可卖持仓批次，请刷新持仓后重试。", true);
    state.cash += amount - fees.total;
    allocations.forEach((allocation) => {
      const lot = state.lots.find((item) => item.id === allocation.lotId);
      if (lot) lot.qty -= allocation.qty;
    });
    state.lots = state.lots.filter((lot) => lot.qty > 0);
    state.trades.push({ id: makeLocalId(), side, qty, price, allocations, fee: fees.total, commission: fees.commission, stampDuty: fees.stampDuty, transferFee: fees.transferFee, feeRuleVersion, cash: state.cash, index: state.currentIndex, ...operationMeta });
    setHint(`卖出成功，已扣除佣金${fees.stampDuty ? "和印花税" : ""}。`, false);
  }
  state.tradePreviewSide = side;
  $("tradeReasonInput").value = "";
  clearDecisionForm("trade");
  updateAverageCost();
  render();
}

function setHint(message, error) {
  $("tradeHint").textContent = message;
  $("tradeHint").style.color = error ? "#ff9aa6" : "var(--muted)";
}

function setMarketHint(message, error = false) {
  $("marketDataHint").textContent = message;
  $("marketDataHint").style.color = error ? "#ff9aa6" : "";
}

function showMarketRecovery(show) {
  $("marketRecoveryActions").hidden = !show;
}

function sourceLabel() {
  if (state.dataSource === "demo") return "演示标的";
  if (state.dataSource === "real") return "真实行情";
  if (state.dataSource === "none") return "未载入";
  return "已导入";
}

function resetTradingSession() {
  state.currentIndex = Math.min(firstTrainingDecisionIndex(), state.trainingEndIndex);
  state.cash = initialCash;
  state.lots = [];
  state.trades = [];
  state.sellTargetLotId = "";
  state.tradePreviewSide = "buy";
  state.barNotes = [];
  state.reviewNotes = [];
  state.reviewId = null;
  state.reviewArchivedAt = null;
  state.finishedRuleSnapshot = null;
  state.archiveView = false;
  state.showRuleComparison = false;
  state.operationPlans = [];
  state.reviewSuggestionSelections = [];
  state.reviewQuestionnaire = { answers: [], skipped: [] };
  state.reviewConclusions = [];
  state.teachingComparisons = [];
  state.manualKeyLevels = [];
  state.chartMarks = []; state.chartMarkHistory = []; state.chartMarkActions = []; state.chartCursor = null; state.chartRedo = null; state.chartSelectedMarkId = null; state.chartPendingMark = null; state.chartSecondPoint = null; state.chartTool = "inspect"; state.chartInspectActive = true;
  state.avgCost = 0;
  state.finished = false;
  state.chartBars = defaultChartBars;
  state.chartZoomExplicit = false;
  state.chartOffset = 0;
  state.waveOverview = false;
  state.focusedWaveId = null;
  state.focusedTradeIndex = null;
  state.intraday.open = false;
  state.intraday.requestKey = "";
  if ($("tradeReasonInput")) $("tradeReasonInput").value = "";
  if ($("operationPlanReason")) $("operationPlanReason").value = "";
  if ($("operationInvalidationPrice")) $("operationInvalidationPrice").value = "";
  if ($("operationPositionCap")) $("operationPositionCap").value = "";
  document.querySelectorAll("[data-operation-signal]").forEach((checkbox) => { checkbox.checked = false; });
}

function providerLabel(provider) {
  return {
    auto: "自动多源路由", baostock: "BaoStock", tushare: "Tushare Pro",
    tdx: "通达信 TQServer", akshare: "AKShare", eastmoney: "东方财富（公开分时备用）",
    sina_intraday: "新浪（公开分时备用）",
  }[provider] || provider || "未知来源";
}

async function loadSourceHealth() {
  const panel = $("sourceHealthList");
  if (!panel) return;
  state.sourceHealth.loading = true;
  panel.innerHTML = '<span class="source-health-empty">正在读取本机数据源配置…</span>';
  try {
    const { response, payload } = await fetchJsonWithTimeout("/api/market/sources", { cache: "no-store" }, 8000);
    if (!response.ok) throw new Error(payload.error || "来源状态获取失败");
    state.sourceHealth = { loading: false, sources: Array.isArray(payload.sources) ? payload.sources : [], routing: payload.routing || null, fetchedAt: payload.fetchedAt || null };
    renderSourceHealth();
  } catch (error) {
    state.sourceHealth.loading = false;
    panel.innerHTML = `<span class="source-health-empty">无法读取数据源状态：${escapeHtml(error.message)}</span>`;
  }
}

function renderSourceHealth() {
  const panel = $("sourceHealthList");
  const routing = $("sourceHealthRouting");
  if (!panel) return;
  const sources = state.sourceHealth.sources || [];
  if (routing && state.sourceHealth.routing) {
    routing.textContent = `日线：${state.sourceHealth.routing.daily.join(" → ")}　｜　5分钟：${state.sourceHealth.routing.intraday.join(" → ")}`;
  }
  panel.innerHTML = sources.map((source) => {
    const status = source.available ? "ok" : source.configured ? "warn" : "fail";
    const label = source.available ? "上次请求成功" : source.configured ? "上次请求未成功" : "未配置";
    const lastSuccess = formatSourceHealthTime(source.lastSuccess);
    const lastFailure = formatSourceHealthTime(source.lastFailure);
    const lastRequest = source.available
      ? `上次成功：${lastSuccess}`
      : source.lastFailure ? `上次失败：${lastFailure}` : "尚未请求验证";
    const previousSuccess = !source.available && source.lastSuccess ? `；此前成功：${lastSuccess}` : "";
    const error = source.error && source.error !== "尚未请求" ? `；${source.error}` : "";
    return `<div class="source-health-item ${status}"><span class="source-health-name">${escapeHtml(source.name)} · ${label}</span><span class="source-health-meta">${escapeHtml(lastRequest + previousSuccess + error)}</span></div>`;
  }).join("") || '<span class="source-health-empty">暂无数据源状态。</span>';
}

function formatSourceHealthTime(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString("zh-CN") : "未知";
}

function requestError(kind, message, status = 0) {
  const error = new Error(message);
  error.kind = kind;
  error.status = status;
  return error;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = collectionRequestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
    let payload;
    try { payload = await response.json(); }
    catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error instanceof TypeError) throw requestError("network", "响应读取中断");
      throw requestError("invalid-response", "服务返回的内容不是有效 JSON。", response.status);
    }
    return { response, payload };
  } catch (error) {
    if (error?.name === "AbortError") throw requestError("timeout", `请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回，已跳过`);
    if (!response && error instanceof TypeError) throw requestError("network", "未收到服务响应");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function marketFetchFailureMessage(error) {
  if (error.kind === "timeout") return `行情请求超时（最多等待 ${Math.round(marketRequestTimeoutMs / 1000)} 秒）。本次未替换当前训练，请稍后重试或查看数据源状态。`;
  if (error.kind === "invalid-response" || error.kind === "invalid-data") return `返回数据异常：${error.message} 当前训练未受影响。`;
  if (error.kind === "api") return `行情接口返回错误（HTTP ${error.status}）：${error.message}`;
  if (error.kind !== "network") return `获取失败：${error.message}`;
  try {
    const { response, payload } = await fetchJsonWithTimeout("/health", { cache: "no-store" }, 3000);
    if (response.ok && payload?.service === "kline-training" && payload?.status === "ok") {
      return "行情请求连接中断，但本地服务现已响应。当前训练未受影响，请重试获取；若再次失败，可查看数据源状态。";
    }
  } catch (_) { /* 本地服务可能已停止，下面给出操作提示 */ }
  return "未连接到本地行情服务。请确认应用或本机服务仍在运行，然后重试获取；当前训练未受影响。";
}

async function fetchMarketData({ collect = false, retry = false } = {}) {
  const input = $("marketSymbol");
  const button = $(collect ? "collectSamplesButton" : "fetchMarketButton");
  const previous = retry ? state.lastFailedMarketRequest : null;
  const rawSymbol = previous?.rawSymbol || input.value.trim();
  const period = previous?.period || $("periodSelect").value || "daily";
  const provider = previous?.provider || $("dataProviderSelect")?.value || "auto";
  if (!rawSymbol) return setMarketHint("请输入 6 位 A 股或场内 ETF 代码，例如 600000。", true);
  if (retry && previous) {
    input.value = rawSymbol;
    $("periodSelect").value = period;
    $("dataProviderSelect").value = provider;
  }
  if (!collect) state.lastFailedMarketRequest = null;
  showMarketRecovery(false);
  button.disabled = true;
  button.textContent = collect ? "采集中…" : "获取中…";
  const periodName = period === "daily" ? "日" : period === "weekly" ? "周" : period === "monthly" ? "月" : "年";
  setMarketHint(`正在通过${providerLabel(provider)}获取${periodName}线前复权真实数据，请稍候…`);
  try {
    const limit = collect ? 2000 : 1000;
    const { response, payload } = await fetchJsonWithTimeout(
      `/api/market/daily?symbol=${encodeURIComponent(rawSymbol)}&limit=${limit}&adjust=qfq&period=${encodeURIComponent(period)}&provider=${encodeURIComponent(provider)}`,
      { cache: "no-store" },
      collect ? collectionRequestTimeoutMs : marketRequestTimeoutMs,
    );
    if (!response.ok) throw requestError("api", payload?.error || "服务端返回错误。", response.status);
    if (!payload || !Array.isArray(payload.bars)) throw requestError("invalid-data", "缺少 K 线数组，已拒绝载入。");
    if (payload.bars.some((row) => !row || typeof row !== "object")) throw requestError("invalid-data", "K 线记录格式不正确，已拒绝载入。");
    const parsedBars = payload.bars.map((row) => ({
      date: new Date(`${row.date}T00:00:00`),
      open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    }));
    let quality;
    try { quality = validateBars(parsedBars, period === "yearly" ? 10 : 70); }
    catch (error) { throw requestError("invalid-data", error.message); }
    const bars = quality.bars;
    state.bars = bars;
    state.indicatorWarmupBars = [];
    state.activeTrainingSample = null;
    state.symbol = payload.symbol;
    state.code = payload.code || rawSymbol.replace(/^(sh|sz)/i, "");
    state.dataSource = "real";
    state.intradayData = {};
    updateDataMeta({ ...payload, ...quality, validCount: bars.length });
    state.trainingStartIndex = Math.max(0, bars.length - demoTrainingBars);
    state.trainingEndIndex = bars.length - 1;
    resetTradingSession();
    $("periodSelect").value = period;
    $("timeframeTag").textContent = { daily: "日线", weekly: "周线", monthly: "月线", yearly: "年线" }[period];
    const actualProvider = payload.provider || provider;
    $("dataStatus").textContent = `已获取 ${state.symbol}：${bars.length} 根${providerLabel(actualProvider)}真实前复权${periodName}线；`;
    const validationHint = payload.crossValidated
      ? ` 已通过 ${Array.isArray(payload.validatedSources) ? payload.validatedSources.join(" + ") : "多来源"} 交叉校验。`
      : ` ${payload.validationWarning || "仅有单一真实来源，当前仅供查看。"}`;
    setMarketHint(`${dataMetaLabel()}。${quality.droppedCount ? ` 已剔除 ${quality.droppedCount} 行异常/重复数据。` : " 数据质量检查通过。"}${validationHint}`);
    setHint(collect ? "样本采集完成，正在扫描当前代码的左右侧配对片段。" : `真实行情获取成功（${providerLabel(actualProvider)}），已重新开始一局训练。`, false);
    loadSourceHealth();
    render();
    if (collect) scanCandidateSamples();
  } catch (error) {
    if (!collect) state.lastFailedMarketRequest = { rawSymbol, period, provider };
    setMarketHint(await marketFetchFailureMessage(error), true);
    showMarketRecovery(!collect);
  } finally {
    button.disabled = false;
    button.textContent = collect ? "样本采集（联网）" : "获取真实行情";
  }
}

function nextBar() {
  if (state.currentIndex >= state.trainingEndIndex) {
    finishTraining();
    return;
  }
  state.currentIndex += 1;
  if (state.currentIndex >= state.trainingEndIndex) {
    finishTraining();
    return;
  }
  setHint("先观察当前走势，再决定是否交易。", false);
  render();
}

function finishTraining() {
  if (state.finished) return;
  state.currentIndex = state.trainingEndIndex;
  state.finished = true;
  state.finishedRuleSnapshot = structuredClone(effectiveReviewRuleset());
  // 结束后展示完整训练片段；过多 K 线由 drawChart 自动切换为连续走势线，避免挤成一团。
  state.chartBars = Math.min(maxChartBars, Math.max(defaultChartBars, trainingLength()));
  state.chartZoomExplicit = false;
  state.chartOffset = 0;
  state.waveOverview = true;
  state.focusedWaveId = null;
  state.focusedTradeIndex = null;
  state.reviewId ||= makeLocalId();
  state.reviewArchivedAt ||= new Date().toISOString();
  setHint(state.trainingArea === "pattern" ? "训练已结束，已揭晓形态答案并生成本局复盘数据。" : "训练已结束，操作记录已归档；点击“我的复盘”查看波段、笔记和针对性建议。", false);
  render();
  clearTimeout(reviewArchiveSaveTimer);
  persistCurrentReviewArchive();
}

function previousBar() {
  if (state.currentIndex <= firstTrainingDecisionIndex() || state.trades.some((tradeItem) => tradeItem.index > state.currentIndex - 1)) return setHint("已发生交易后不能回退，以保证交易记录一致。", true);
  state.currentIndex -= 1;
  render();
}

function handleKeyboardShortcut(event) {
  if (event.code !== "Space" || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  const element = target instanceof Element ? target : null;
  // 输入框、下拉框和复选框保留浏览器原生空格行为；按钮则阻止空格默认 click，
  // 否则交易后焦点仍停留在买卖按钮上，按一次空格会再次提交同一笔交易。
  if (element?.closest("input, textarea, select, [contenteditable='true']")) return;
  event.preventDefault();
  nextBar();
}

function reset() {
  resetTradingSession();
  setHint("今日买入的股票将在下一根日 K 线后可卖。", false);
  render();
}

function parseCsvLine(line, delimiter) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { fields.push(field.trim()); field = ""; }
    else field += char;
  }
  fields.push(field.trim());
  return fields;
}

function normalizeHeader(value) {
  return value.replace(/^\ufeff/, "").trim().toLowerCase().replace(/[ _-]/g, "");
}

function numberFrom(value) {
  const parsed = Number(String(value).replace(/,/g, "").replace(/%/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDailyCsv(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("文件没有足够的数据行。");
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const headers = parseCsvLine(lines[0], delimiter).map(normalizeHeader);
  const find = (...names) => names.map(normalizeHeader).map((name) => headers.indexOf(name)).find((index) => index >= 0);
  const columns = {
    date: find("date", "日期", "交易日期", "tradedate"),
    open: find("open", "开盘", "开盘价"),
    high: find("high", "最高", "最高价"),
    low: find("low", "最低", "最低价"),
    close: find("close", "收盘", "收盘价"),
    volume: find("volume", "成交量", "vol", "成交额")
  };
  if (Object.values(columns).some((value) => value === undefined)) throw new Error("缺少必要字段。需要：日期、开盘、最高、最低、收盘、成交量。");
  const bars = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line, delimiter);
    const date = new Date(cells[columns.date]);
    const open = numberFrom(cells[columns.open]); const high = numberFrom(cells[columns.high]);
    const low = numberFrom(cells[columns.low]); const close = numberFrom(cells[columns.close]);
    const volume = numberFrom(cells[columns.volume]);
    if (Number.isNaN(date.getTime()) || [open, high, low, close, volume].some((value) => value === null)) return null;
    if (low > Math.min(open, close) || high < Math.max(open, close) || low < 0) return null;
    return { date, open, high, low, close, volume };
  }).filter(Boolean).sort((a, b) => a.date - b.date);
  const unique = bars.filter((bar, index) => index === 0 || formatDate(bar.date) !== formatDate(bars[index - 1].date));
  if (unique.length < 70) throw new Error(`有效日线只有 ${unique.length} 行，至少需要 70 行才能稳定显示均线。`);
  return unique;
}

async function importCsv(file) {
  try {
    const text = await file.text();
    const bars = parseDailyCsv(text);
    const quality = validateBars(bars);
    state.bars = quality.bars; state.indicatorWarmupBars = []; state.activeTrainingSample = null; state.symbol = file.name.replace(/\.[^.]+$/, ""); state.code = "LOCAL"; state.dataSource = "imported";
    updateDataMeta({ provider: "本地 CSV", adjust: "qfq", period: "daily", ...quality, fetchedAt: new Date().toISOString() });
    state.trainingStartIndex = Math.max(0, bars.length - demoTrainingBars);
    state.trainingEndIndex = state.bars.length - 1;
    resetTradingSession();
    $("dataStatus").textContent = `已导入 ${state.symbol}：${state.bars.length} 根日线；`;
    setMarketHint(`${dataMetaLabel()}。本地文件仅用于当前浏览器训练。`, false);
    setHint("数据导入成功，已重新开始一局训练。", false);
    render();
  } catch (error) {
    setHint(`导入失败：${error.message}`, true);
  }
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSession() {
  const payload = {
    format: "kline-training-session",
    version: 2,
    exportedAt: new Date().toISOString(),
    userName: state.userName,
    symbol: state.symbol,
    code: state.code,
    dataSource: state.dataSource,
    dataMeta: state.dataMeta,
    bars: state.bars.map((bar) => ({ ...bar, date: formatDate(bar.date) })),
    indicatorWarmupBars: state.indicatorWarmupBars.map((bar) => ({ ...bar, date: formatDate(bar.date) })),
    trainingStartIndex: state.trainingStartIndex,
    trainingEndIndex: state.trainingEndIndex,
    currentIndex: state.currentIndex,
    cash: state.cash,
    lots: state.lots,
    trades: state.trades,
    barNotes: state.barNotes,
    reviewNotes: state.reviewNotes,
    reviewId: state.reviewId,
    reviewArchivedAt: state.reviewArchivedAt,
    finishedRuleSnapshot: state.finishedRuleSnapshot,
    operationPlans: state.operationPlans,
    nextSessionChecklist: state.nextSessionChecklist,
    reviewSuggestionSelections: state.reviewSuggestionSelections,
    reviewQuestionnaire: state.reviewQuestionnaire,
    reviewConclusions: state.reviewConclusions,
    teachingComparisons: state.teachingComparisons,
    manualKeyLevels: state.manualKeyLevels,
    chartMarks: state.chartMarks, chartMarkHistory: state.chartMarkHistory, chartMarkActions: state.chartMarkActions,
    avgCost: state.avgCost,
    finished: state.finished,
    mode: state.mode,
    indicator: state.indicator,
    showChip: state.showChip,
    showIdentity: state.showIdentity,
    tradingRule: state.tradingRule,
    feeRuleVersion,
    candidateSamples: state.candidateSamples,
    collectedSamples: state.collectedSamples,
    activeTrainingSample: state.activeTrainingSample,
    intradayData: state.intradayData,
    trainingArea: state.trainingArea,
  };
  downloadJson(`kline-training-${new Date().toISOString().slice(0, 10)}.json`, payload);
  setHint("训练备份已导出，可在其他浏览器通过“导入训练备份”恢复。", false);
}

function saveDraftSession() {
  if (state.archiveView) return;
  try {
    const draft = {
      format: "kline-training-draft",
      savedAt: new Date().toISOString(),
      userName: state.userName, symbol: state.symbol, code: state.code, dataSource: state.dataSource, dataMeta: state.dataMeta,
      bars: state.bars.map((bar) => ({ ...bar, date: formatDate(bar.date) })),
      indicatorWarmupBars: state.indicatorWarmupBars.map((bar) => ({ ...bar, date: formatDate(bar.date) })),
      trainingStartIndex: state.trainingStartIndex, trainingEndIndex: state.trainingEndIndex, currentIndex: state.currentIndex,
      cash: state.cash, lots: state.lots, trades: state.trades, barNotes: state.barNotes, reviewNotes: state.reviewNotes,
      reviewId: state.reviewId, reviewArchivedAt: state.reviewArchivedAt, avgCost: state.avgCost, finished: state.finished,
      finishedRuleSnapshot: state.finishedRuleSnapshot,
      operationPlans: state.operationPlans, nextSessionChecklist: state.nextSessionChecklist,
      reviewSuggestionSelections: state.reviewSuggestionSelections,
      reviewQuestionnaire: state.reviewQuestionnaire,
      reviewConclusions: state.reviewConclusions,
      teachingComparisons: state.teachingComparisons,
      manualKeyLevels: state.manualKeyLevels,
      chartMarks: state.chartMarks, chartMarkHistory: state.chartMarkHistory, chartMarkActions: state.chartMarkActions,
      mode: state.mode, indicator: state.indicator, showChip: state.showChip, showIdentity: state.showIdentity, tradingRule: state.tradingRule,
      selectedPatternId: state.selectedPatternId,
      activeTrainingSample: state.activeTrainingSample,
      intradayData: state.intradayData,
      trainingArea: state.trainingArea,
    };
    localStorage.setItem("kline-training-draft", JSON.stringify(draft));
  } catch (_) { /* 本地存储不可用时不影响训练 */ }
}

function loadDraftSession() {
  try {
    const payload = JSON.parse(localStorage.getItem("kline-training-draft"));
    if (payload?.format !== "kline-training-draft" || !Array.isArray(payload.bars)) return;
    const age = Date.now() - new Date(payload.savedAt || 0).getTime();
    if (!Number.isFinite(age) || age > 7 * 24 * 60 * 60 * 1000) return;
    const parsedBars = payload.bars.map((row) => ({ ...row, date: new Date(`${row.date}T00:00:00`) }));
    const quality = validateBars(parsedBars);
    state.bars = quality.bars; state.indicatorWarmupBars = Array.isArray(payload.indicatorWarmupBars) ? payload.indicatorWarmupBars.map((row) => ({ ...row, date: new Date(`${row.date}T00:00:00`) })) : []; state.activeTrainingSample = payload.activeTrainingSample || null; state.symbol = String(payload.symbol || demoSymbol); state.code = resolvedSampleCode(payload); state.userName = String(payload.userName || state.userName || "").slice(0, 20);
    state.intradayData = payload.intradayData || payload.activeTrainingSample?.intradayByDate || {};
    state.trainingArea = payload.trainingArea === "pattern" ? "pattern" : state.trainingArea;
    state.dataSource = payload.dataSource || "demo"; updateDataMeta({ ...(payload.dataMeta || {}), ...quality });
    state.trainingStartIndex = Math.max(0, Math.min(Number(payload.trainingStartIndex) || 0, state.bars.length - 1));
    state.trainingEndIndex = Math.max(state.trainingStartIndex, Math.min(Number(payload.trainingEndIndex) || state.bars.length - 1, state.bars.length - 1));
    state.currentIndex = Math.max(firstTrainingDecisionIndex(), Math.min(Number(payload.currentIndex) || state.trainingStartIndex, state.trainingEndIndex));
    state.cash = Number(payload.cash) || initialCash; state.lots = Array.isArray(payload.lots) ? payload.lots : []; state.trades = Array.isArray(payload.trades) ? payload.trades : [];
    migrateTradeLotLedger(state.trades, state.lots);
    state.barNotes = Array.isArray(payload.barNotes) ? payload.barNotes : [];
    state.reviewNotes = Array.isArray(payload.reviewNotes) ? payload.reviewNotes : [];
    state.reviewId = payload.reviewId || null;
    state.reviewArchivedAt = payload.reviewArchivedAt || null;
    state.finishedRuleSnapshot = payload.finishedRuleSnapshot || payload.trades?.find((trade) => trade.reviewRuleSnapshot)?.reviewRuleSnapshot || null;
    state.operationPlans = Array.isArray(payload.operationPlans) ? payload.operationPlans : [];
    state.nextSessionChecklist = Array.isArray(payload.nextSessionChecklist) ? payload.nextSessionChecklist : [];
    state.reviewSuggestionSelections = Array.isArray(payload.reviewSuggestionSelections) ? payload.reviewSuggestionSelections : [];
    state.reviewQuestionnaire = payload.reviewQuestionnaire && typeof payload.reviewQuestionnaire === "object" ? payload.reviewQuestionnaire : { answers: [], skipped: [] };
    state.reviewConclusions = Array.isArray(payload.reviewConclusions) ? payload.reviewConclusions : [];
    state.teachingComparisons = Array.isArray(payload.teachingComparisons) ? payload.teachingComparisons : [];
    state.manualKeyLevels = Array.isArray(payload.manualKeyLevels) ? payload.manualKeyLevels : [];
    state.chartMarks = Array.isArray(payload.chartMarks) ? payload.chartMarks : []; state.chartMarkHistory = Array.isArray(payload.chartMarkHistory) ? payload.chartMarkHistory : []; state.chartMarkActions = Array.isArray(payload.chartMarkActions) ? payload.chartMarkActions : [];
    state.avgCost = Number(payload.avgCost) || 0; state.finished = Boolean(payload.finished); state.waveOverview = state.finished; state.focusedWaveId = null; state.focusedTradeIndex = null;
    state.chartBars = state.finished ? Math.min(maxChartBars, Math.max(defaultChartBars, trainingLength())) : defaultChartBars;
    state.chartZoomExplicit = false; state.chartOffset = 0;
    state.mode = ["naked", "daily"].includes(payload.mode) ? payload.mode : "naked";
    state.indicator = ["none", "macd", "kdj", "both"].includes(payload.indicator) ? payload.indicator : "both"; state.showChip = payload.showChip !== false;
    state.showIdentity = Boolean(payload.showIdentity); state.tradingRule = ["a-share", "etf-t1", "etf-t0"].includes(payload.tradingRule) ? payload.tradingRule : "a-share";
    state.selectedPatternId = payload.selectedPatternId || null;
    $("modeSelect").value = state.mode; $("indicatorSelect").value = state.indicator; $("tradingRuleSelect").value = state.tradingRule;
    $("identityToggle").checked = state.showIdentity; $("chipToggle").checked = state.showChip;
    $("periodSelect").value = state.dataMeta.period || "daily";
    $("dataStatus").textContent = `已自动恢复 ${state.symbol}：${state.bars.length} 根行情；`;
    setMarketHint(`${dataMetaLabel()}。已恢复最近 7 天内的未完成训练记录。`, false);
  } catch (_) { /* 损坏的草稿忽略，用户仍可正常开始新局 */ }
}

async function importSession(file) {
  try {
    const payload = JSON.parse(await file.text());
    if (payload?.format !== "kline-training-session" || !Array.isArray(payload.bars)) throw new Error("不是有效的 K 线训练备份文件。");
    const parsedBars = payload.bars.map((row) => ({
      date: new Date(`${row.date}T00:00:00`), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    }));
    const quality = validateBars(parsedBars);
    state.bars = quality.bars;
    state.indicatorWarmupBars = Array.isArray(payload.indicatorWarmupBars) ? payload.indicatorWarmupBars.map((row) => ({ ...row, date: new Date(`${row.date}T00:00:00`) })) : [];
    state.activeTrainingSample = payload.activeTrainingSample || null;
    state.intradayData = payload.intradayData || payload.activeTrainingSample?.intradayByDate || {};
    state.trainingArea = payload.trainingArea === "pattern" ? "pattern" : "indicator";
    state.symbol = String(payload.symbol || "导入备份");
    state.userName = String(payload.userName || state.userName || "").slice(0, 20);
    state.code = resolvedSampleCode(payload);
    state.dataSource = payload.dataSource || "imported";
    updateDataMeta({ ...(payload.dataMeta || {}), ...quality, validCount: quality.validCount });
    state.trainingStartIndex = Math.max(0, Math.min(Number(payload.trainingStartIndex) || 0, state.bars.length - 1));
    state.trainingEndIndex = Math.max(state.trainingStartIndex, Math.min(Number(payload.trainingEndIndex) || state.bars.length - 1, state.bars.length - 1));
    state.currentIndex = Math.max(firstTrainingDecisionIndex(), Math.min(Number(payload.currentIndex) || state.trainingStartIndex, state.trainingEndIndex));
    state.cash = Number.isFinite(Number(payload.cash)) ? Number(payload.cash) : initialCash;
    state.lots = Array.isArray(payload.lots) ? payload.lots : [];
    state.trades = Array.isArray(payload.trades) ? payload.trades : [];
    migrateTradeLotLedger(state.trades, state.lots);
    state.barNotes = Array.isArray(payload.barNotes) ? payload.barNotes : [];
    state.reviewNotes = Array.isArray(payload.reviewNotes) ? payload.reviewNotes : [];
    state.reviewId = payload.reviewId || null;
    state.reviewArchivedAt = payload.reviewArchivedAt || null;
    state.finishedRuleSnapshot = payload.finishedRuleSnapshot || payload.trades?.find((trade) => trade.reviewRuleSnapshot)?.reviewRuleSnapshot || null;
    state.operationPlans = Array.isArray(payload.operationPlans) ? payload.operationPlans : [];
    state.nextSessionChecklist = Array.isArray(payload.nextSessionChecklist) ? payload.nextSessionChecklist : [];
    state.reviewSuggestionSelections = Array.isArray(payload.reviewSuggestionSelections) ? payload.reviewSuggestionSelections : [];
    state.reviewQuestionnaire = payload.reviewQuestionnaire && typeof payload.reviewQuestionnaire === "object" ? payload.reviewQuestionnaire : { answers: [], skipped: [] };
    state.reviewConclusions = Array.isArray(payload.reviewConclusions) ? payload.reviewConclusions : [];
    state.teachingComparisons = Array.isArray(payload.teachingComparisons) ? payload.teachingComparisons : [];
    state.manualKeyLevels = Array.isArray(payload.manualKeyLevels) ? payload.manualKeyLevels : [];
    state.chartMarks = Array.isArray(payload.chartMarks) ? payload.chartMarks : []; state.chartMarkHistory = Array.isArray(payload.chartMarkHistory) ? payload.chartMarkHistory : []; state.chartMarkActions = Array.isArray(payload.chartMarkActions) ? payload.chartMarkActions : [];
    state.avgCost = Number(payload.avgCost) || 0;
    state.finished = Boolean(payload.finished);
    state.waveOverview = state.finished;
    state.focusedWaveId = null;
    state.focusedTradeIndex = null;
    state.chartBars = state.finished ? Math.min(maxChartBars, Math.max(defaultChartBars, trainingLength())) : defaultChartBars;
    state.chartZoomExplicit = false;
    state.chartOffset = 0;
    state.mode = ["naked", "daily"].includes(payload.mode) ? payload.mode : "naked";
    state.indicator = ["none", "macd", "kdj", "both"].includes(payload.indicator) ? payload.indicator : "both";
    state.showChip = payload.showChip !== false;
    state.showIdentity = Boolean(payload.showIdentity);
    state.tradingRule = ["a-share", "etf-t1", "etf-t0"].includes(payload.tradingRule) ? payload.tradingRule : "a-share";
    state.candidateSamples = Array.isArray(payload.candidateSamples) ? payload.candidateSamples : state.candidateSamples;
    state.collectedSamples = Array.isArray(payload.collectedSamples) ? payload.collectedSamples : state.collectedSamples;
    if (state.userName) saveUserName(state.userName);
    saveCandidateSamples(); saveCollectedSamples();
    $("modeSelect").value = state.mode; $("indicatorSelect").value = state.indicator; $("tradingRuleSelect").value = state.tradingRule; $("identityToggle").checked = state.showIdentity; $("chipToggle").checked = state.showChip;
    $("periodSelect").value = state.dataMeta.period || "daily";
    $("dataStatus").textContent = `已恢复 ${state.symbol}：${state.bars.length} 根行情；`;
    setMarketHint(`${dataMetaLabel()}。训练备份恢复成功。`, false);
    renderUser(); render();
  } catch (error) {
    setHint(`备份导入失败：${error.message}`, true);
  }
}

const RULE_ENGINE_VALIDATED = false;

function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function clamp(value, low = 0, high = 1) { return Math.max(low, Math.min(high, value)); }

function localLowIndexes(segment) {
  const lows = segment.map((bar) => bar.low);
  const indexes = [];
  for (let i = 2; i < lows.length - 2; i += 1) {
    if (lows[i] <= lows[i - 1] && lows[i] <= lows[i + 1] && lows[i] <= lows[i - 2] && lows[i] <= lows[i + 2]) indexes.push(i);
  }
  return indexes;
}

function bottomLogicScore(segment) {
  const closes = segment.map((bar) => bar.close);
  const trough = Math.min(...segment.map((bar) => bar.low));
  const troughIndex = segment.findIndex((bar) => bar.low === trough);
  const left = average(closes.slice(0, Math.max(8, Math.floor(segment.length * .25))));
  const right = average(closes.slice(Math.floor(segment.length * .75)));
  const decline = clamp((left - trough) / Math.max(left * .18, .01));
  const recovery = clamp((right - trough) / Math.max(trough * .16, .01));
  const position = troughIndex > segment.length * .2 && troughIndex < segment.length * .8 ? 1 : .45;
  const earlyVolume = average(segment.slice(0, 10).map((bar) => bar.volume));
  const middleVolume = average(segment.slice(Math.floor(segment.length * .35), Math.floor(segment.length * .55)).map((bar) => bar.volume));
  const dryUp = earlyVolume ? clamp((earlyVolume - middleVolume) / earlyVolume / .45 + .45) : .5;
  const momentum = sma(closes, 5, closes.length - 1) > sma(closes, Math.min(20, closes.length), closes.length - 1) ? 1 : .35;
  return { score: .28 * decline + .28 * recovery + .16 * position + .14 * dryUp + .14 * momentum, trough };
}

function doubleBottomScore(segment, lows) {
  if (lows.length < 2) return 0;
  const first = lows.filter((index) => index < segment.length * .55).sort((a, b) => segment[a].low - segment[b].low)[0];
  const second = lows.filter((index) => index > segment.length * .42).sort((a, b) => segment[a].low - segment[b].low)[0];
  if (first == null || second == null || second - first < 7) return 0;
  const level = Math.max(segment[first].low, segment[second].low);
  const similarity = 1 - clamp(Math.abs(segment[first].low - segment[second].low) / Math.max(level * .08, .01));
  const neckline = Math.max(...segment.slice(first, second + 1).map((bar) => bar.high));
  const breakout = clamp((segment.at(-1).close / Math.max(neckline, .01) - .96) / .08);
  return .55 * similarity + .45 * breakout;
}

function tripleBottomScore(segment, lows) {
  if (lows.length < 3) return 0;
  const thirds = [
    lows.filter((index) => index < segment.length / 3),
    lows.filter((index) => index >= segment.length / 3 && index < segment.length * 2 / 3),
    lows.filter((index) => index >= segment.length * 2 / 3),
  ];
  if (thirds.some((part) => !part.length)) return 0;
  const chosen = thirds.map((part) => part.sort((a, b) => segment[a].low - segment[b].low)[0]);
  const prices = chosen.map((index) => segment[index].low);
  const averageLow = average(prices);
  const similarity = 1 - clamp(Math.max(...prices.map((price) => Math.abs(price - averageLow))) / Math.max(averageLow * .09, .01));
  const neckline = Math.max(...segment.slice(chosen[0], chosen[2] + 1).map((bar) => bar.high));
  const breakout = clamp((segment.at(-1).close / Math.max(neckline, .01) - .95) / .1);
  return .6 * similarity + .4 * breakout;
}

function roundBottomScore(segment) {
  const prices = segment.map((bar) => bar.close);
  const center = Math.min(...prices.slice(Math.floor(prices.length * .35), Math.floor(prices.length * .65)));
  const left = average(prices.slice(0, 10));
  const right = average(prices.slice(-10));
  const smooth = 1 - clamp(average(prices.slice(1).map((price, index) => Math.abs(price - prices[index]))) / Math.max(average(prices) * .035, .01));
  return .45 * clamp((left - center) / Math.max(left * .14, .01)) + .4 * clamp((right - center) / Math.max(center * .14, .01)) + .15 * smooth;
}

function rectangleBottomScore(segment) {
  const zone = segment.slice(Math.floor(segment.length * .35), Math.floor(segment.length * .8));
  const low = Math.min(...zone.map((bar) => bar.low));
  const high = Math.max(...zone.map((bar) => bar.high));
  const width = (high - low) / Math.max(low, .01);
  const breakout = clamp((segment.at(-1).close / Math.max(high, .01) - .98) / .08);
  return .55 * clamp((.24 - width) / .24) + .45 * breakout;
}

function classifyCandidate(segment) {
  const lows = localLowIndexes(segment);
  return [
    ["triple-bottom", tripleBottomScore(segment, lows)],
    ["head-shoulders-bottom", tripleBottomScore(segment, lows) * .9],
    ["adam-adam-bottom", doubleBottomScore(segment, lows)],
    ["adam-eve-bottom", doubleBottomScore(segment, lows) * .96],
    ["rectangle-bottom", rectangleBottomScore(segment)],
    ["round-bottom", roundBottomScore(segment)],
  ].sort((a, b) => b[1] - a[1])[0];
}

function detectCandidateSamples(bars, symbol, meta = {}) {
  const candidates = [];
  const patternMap = new Map(patternLibrary().map((pattern) => [pattern.id, pattern]));
  const firstEnd = sampleContextBars + sampleTrainingBars - 1;
  for (let end = firstEnd; end < bars.length; end += 5) {
    const start = end - sampleTrainingBars + 1;
    const context = bars.slice(start - sampleContextBars, start);
    const segment = bars.slice(start, end + 1);
    if (context.length !== sampleContextBars || segment.length !== sampleTrainingBars) continue;
    const bottom = bottomLogicScore(segment);
    const [patternId, patternScore] = classifyCandidate(segment);
    const confidence = clamp(bottom.score * .56 + patternScore * .44);
    if (bottom.score < .58 || patternScore < .55) continue;
    const pattern = patternMap.get(patternId);
    if (!pattern) continue;
    const startDate = formatDate(segment[0].date);
    const endDate = formatDate(segment.at(-1).date);
    const key = `${symbol}|${startDate}|${endDate}|${patternId}`;
    if (candidates.some((item) => item.key === key)) continue;
    const snapshotBars = [...context, ...segment].map((bar) => ({
      date: formatDate(bar.date), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
    }));
    candidates.push({
      key, symbol, patternId, patternName: pattern.name,
      startDate, endDate, contextStartDate: formatDate(context[0].date),
      startIndex: sampleContextBars, endIndex: sampleContextBars + sampleTrainingBars - 1,
      contextStartIndex: 0, trainingStartIndex: sampleContextBars, trainingEndIndex: sampleContextBars + sampleTrainingBars - 1,
      confidence: round(confidence, 3), bottomScore: round(bottom.score, 3), patternScore: round(patternScore, 3),
      dataSource: "real", provider: meta.provider || "BaoStock", adjust: meta.adjust || "qfq", period: meta.period || "daily",
      reviewStatus: "pending", status: "待审核", autoEligible: confidence >= .9,
      snapshot: true, bars: snapshotBars,
    });
  }
  return candidates;
}

function mergeCandidateSamples(candidates) {
  const unique = [...new Map([...state.candidateSamples, ...candidates].map((sample) => [sample.key, sample])).values()];
  const grouped = new Map();
  const sideSamples = [];
  unique.forEach((sample) => {
    if (sample.serverCandidate === true) {
      sideSamples.push(sample);
      return;
    }
    if (!hasCompleteCandidateWindow(sample)) return;
    if (isSideTrainingSample(sample)) {
      sideSamples.push(sample);
      return;
    }
    const groupKey = `${sample.collectionId || "local"}|${sample.patternId}`;
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(sample);
  });
  state.candidateSamples = [...sideSamples, ...[...grouped.values()]
    // 每轮每种形态只保留一个最高置信度候选；不同采集轮次可以同时保留。
    .flatMap((items) => items.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0)).slice(0, 1))]
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  saveCandidateSamples();
}

function scanCandidateSamples() {
  if (state.dataSource === "demo") {
    $("candidateScanHint").textContent = "候选扫描仅对真实行情或本地导入行情开放。";
    return;
  }
  const candidates = detectCandidateSamples(state.bars, state.symbol, state.dataMeta);
  mergeCandidateSamples(candidates);
  $("candidateScanHint").textContent = state.candidateSamples.length
    ? `扫描完成：发现 ${candidates.length} 个候选，当前保留 ${state.candidateSamples.length} 个完整片段；每条均为背景 40 根 + 训练 180 根，需人工审核。`
    : "未找到符合底部逻辑和形态初筛条件的完整片段。";
  renderLibrary();
}

function selectAutomaticUniverse(instruments) {
  const stocks = instruments.filter((item) => item.kind === "stock");
  const etfs = instruments.filter((item) => item.kind === "etf");
  const etfQuota = Math.min(30, etfs.length);
  const stockQuota = Math.max(0, automaticScanLimit - etfQuota);
  const pickEvenly = (items, quota) => {
    if (items.length <= quota) return items;
    const step = items.length / quota;
    return Array.from({ length: quota }, (_, index) => items[Math.min(items.length - 1, Math.floor(index * step))]);
  };
  return [...pickEvenly(stocks, stockQuota), ...pickEvenly(etfs, etfQuota)];
}

function updateCollectionModal(message, error = false) {
  const modal = $("collectionProgressModal");
  const progressBar = $("collectionModalProgressBar");
  const progressLabel = $("collectionModalProgressLabel");
  const progressPercent = $("collectionModalProgressPercent");
  const scanned = $("collectionModalScanned");
  const success = $("collectionModalSuccess");
  const failed = $("collectionModalFailed");
  const candidates = $("collectionModalCandidates");
  const intraday = $("collectionModalIntraday");
  const current = $("collectionModalCurrent");
  const stage = $("collectionModalStage");
  const status = $("collectionModalStatus");
  const stopButton = $("collectionModalStopButton");
  const closeButton = $("collectionModalCloseButton");
  if (!modal || !progressBar || !progressLabel || !progressPercent || !scanned || !success || !failed || !candidates || !current || !status || !stopButton || !closeButton) return;
  if (state.collection.running || error) modal.hidden = false;
  const total = Number(state.collection.total) || 0;
  const done = Math.min(Number(state.collection.scanned) || 0, total || 0);
  const percent = Number.isFinite(Number(state.collection.percent))
    ? Number(state.collection.percent)
    : total ? Math.round((done / total) * 100) : 0;
  progressBar.value = percent;
  progressLabel.textContent = total ? `${done}/${total} 个标的 · 入库 ${state.collection.approvedPairsTotal || 0}/${state.collection.targetPairs || 10} 组` : "正在获取证券清单";
  progressPercent.textContent = `${percent}%`;
  scanned.textContent = `${done} / ${total}`;
  success.textContent = String(state.collection.success || 0);
  failed.textContent = String(state.collection.failed || 0);
  candidates.textContent = String(state.collection.sideCandidateCount ?? 0);
  if (intraday) {
    intraday.textContent = `${Number(state.collection.intradayFetched) || 0} / ${Number(state.collection.intradayTotal) || 0}`;
  }
  const counterMap = {
    collectionModalPrefiltered: "prefiltered",
    collectionModalTencent: "tencentChecked",
    collectionModalBaoStock: "baostockChecked",
    collectionModalPending: "pending",
    collectionModalStrict: "strict",
    collectionModalWarning: "warning",
    collectionModalRejected: "rejected",
  };
  Object.entries(counterMap).forEach(([elementId, key]) => {
    const element = $(elementId);
    if (element) element.textContent = String(state.collection[key] || 0);
  });
  if (stage) stage.textContent = state.collection.stage ? "阶段：" + state.collection.stage : "";
  current.textContent = state.collection.current || message;
  const quota = `累计入库 ${state.collection.approvedPairsTotal || 0}/${state.collection.targetPairs || 10} 组 · 待复核 ${state.collection.pendingPairs || 0} 组 · 剩余 ${state.collection.remainingBefore || 0} 个标的`;
  status.textContent = `${error ? "采集出现问题" : state.collection.message || (state.collection.running ? "正在筛选真实行情" : "采集已暂停")}；${quota}`;
  status.style.color = error ? "#ff9aa6" : "";
  stopButton.hidden = !state.collection.running;
  stopButton.disabled = !state.collection.running || state.collection.stopRequested;
  closeButton.hidden = state.collection.running;
}

function requestCollectionStop() {
  if (!state.collection.running) return;
  state.collection.stopRequested = true;
  $("stopCollectionButton").disabled = true;
  $("collectionModalStopButton").disabled = true;
  updateCollectionUi("正在停止采集，请等待当前请求结束");
  if (state.collection.taskId) {
    postJson("/api/sample-collection/stop", { taskId: state.collection.taskId, reason: "用户暂停采集" }, collectionRequestTimeoutMs).catch(() => {});
  }
}

function updateCollectionUi(message, error = false) {
  const progress = state.collection.total ? `（${state.collection.scanned}/${state.collection.total}，成功 ${state.collection.success}，失败 ${state.collection.failed}）` : "";
  const target = `累计入库 ${state.collection.approvedPairsTotal || 0}/${state.collection.targetPairs || 10} 组`;
  $("candidateScanHint").textContent = `${message}${progress} · ${target}`;
  $("candidateScanHint").style.color = error ? "#ff9aa6" : "";
  const progressWrap = $("collectionProgress");
  const progressBar = $("collectionProgressBar");
  const progressLabel = $("collectionProgressLabel");
  const progressPercent = $("collectionProgressPercent");
  if (!progressWrap || !progressBar || !progressLabel || !progressPercent) return;
  const total = Number(state.collection.total) || 0;
  const scanned = Math.min(Number(state.collection.scanned) || 0, total || 0);
  const percent = total ? Math.round((scanned / total) * 100) : 0;
  progressWrap.hidden = !state.collection.running && !total;
  progressBar.value = percent;
  progressLabel.textContent = total ? `${scanned}/${total} 个标的 · ${target} · 待复核 ${state.collection.pendingPairs || 0} 组` : message;
  progressPercent.textContent = `${percent}%`;
  updateCollectionModal(message, error);
}

async function restoreCollectionStatus() {
  try {
    const { response, payload } = await fetchJsonWithTimeout("/api/sample-collection/current", { cache: "no-store" }, collectionRequestTimeoutMs);
    if (!response.ok || !payload || typeof payload !== "object") return;
    if (payload.state === "running" && payload.stopRequested) {
      payload.state = "paused";
      payload.message = "采集暂停中，可在当前请求结束后手动继续";
    }
    state.collection = { ...state.collection, ...payload, running: payload.state === "running", ownsJob: false };
    state.collection.lastLoadedCandidateRevision = payload.candidateRevision;
    $("collectSamplesButton").textContent = ["paused", "exhausted"].includes(payload.state) ? "继续采集" : "样本采集";
    $("collectSamplesButton").disabled = state.collection.running;
    updateCollectionUi(payload.message || "可开始采集左右侧指标样本");
    if (state.collection.running && payload.taskId) {
      pollCollectionTask().catch((error) => updateCollectionUi("采集状态连接中断：" + error.message, true)).finally(() => {
        state.collection.running = false;
        $("collectSamplesButton").disabled = false;
        $("collectSamplesButton").textContent = state.collection.state === "paused" ? "继续采集" : "样本采集";
        updateCollectionUi(state.collection.message || "采集已结束");
      });
    }
  } catch (_) { /* 静态预览或旧服务保持原页面状态 */ }
}

async function startAutomaticCollection() {
  if (state.trainingArea !== "indicator") return setHint("请切换到指标训练区后开始左右侧样本采集。", true);
  if (state.collection.running) return;
  state.collection = { running: true, ownsJob: true, stopRequested: false, scanned: 0, total: 0, success: 0, failed: 0, percent: 0, taskId: "", stage: "starting", message: "正在初始化样本采集", current: "", intradayTotal: 0, intradayFetched: 0 };
  const collectionButton = $("collectSamplesButton");
  collectionButton.disabled = true;
  collectionButton.textContent = "采集中…";
  $("stopCollectionButton").disabled = false;
  $("stopCollectionButton").hidden = false;
  $("collectionProgressModal").hidden = false;
  $("closeCollectionProgressButton").hidden = true;
  $("collectionModalCloseButton").hidden = true;
  $("collectionModalStopButton").hidden = false;
  updateCollectionModal("正在启动服务器采集任务：新浪证券清单 → 腾讯扫描 → BaoStock候选复核…");
  try {
    const request = { limit: automaticScanLimit, targetPairs: 10 };
    let result = await postJson("/api/sample-collection/start", request, collectionUniverseTimeoutMs);
    if (!result.response.ok) throw new Error(result.payload.error || "采集任务启动失败。");
    if (result.payload.state === "running" && result.payload.stopRequested) {
      state.collection = { ...state.collection, ...result.payload, running: true };
      updateCollectionUi("正在等待上一次采集任务完成暂停");
      await pollCollectionTask();
      result = await postJson("/api/sample-collection/start", request, collectionUniverseTimeoutMs);
      if (!result.response.ok) throw new Error(result.payload.error || "继续采集失败。");
    }
    state.collection = { ...state.collection, ...result.payload, running: result.payload.state === "running" };
    updateCollectionUi(result.payload.message || "采集任务已启动");
    await pollCollectionTask();
    await loadServerCandidates();
    loadSourceHealth();
    setHint((state.collection.message || "采集任务已结束") + "；左右侧配对通过严格数据复核后会自动进入指标训练库。", state.collection.state === "error");
  } catch (error) {
    updateCollectionUi("自动采集失败：" + error.message, true);
    setHint("样本采集失败：" + error.message, true);
  } finally {
    state.collection.running = false;
    state.collection.ownsJob = false;
    collectionButton.disabled = false;
    collectionButton.textContent = state.collection.state === "paused" || state.collection.state === "exhausted" ? "继续采集" : "样本采集";
    $("stopCollectionButton").hidden = true;
    $("closeCollectionProgressButton").hidden = false;
    updateCollectionModal($("candidateScanHint").textContent);
  }
  return;

  state.collection = { running: true, stopRequested: false, scanned: 0, total: 0, success: 0, failed: 0 };
  const button = $("collectSamplesButton");
  button.disabled = true;
  button.textContent = "采集中…";
  $("stopCollectionButton").disabled = false;
  $("stopCollectionButton").hidden = false;
  $("collectionProgressModal").hidden = false;
  $("closeCollectionProgressButton").hidden = true;
  $("collectionModalCloseButton").hidden = true;
  $("collectionModalStopButton").hidden = false;
  updateCollectionModal("正在获取证券清单（新浪股票清单，BaoStock补充ETF清单）…");
  try {
    const { response: universeResponse, payload: universe } = await fetchJsonWithTimeout(
      "/api/market/universe?provider=auto",
      { cache: "no-store" },
      collectionUniverseTimeoutMs,
    );
    if (!universeResponse.ok) throw new Error(universe.error || "证券列表获取失败。");
    const instruments = selectAutomaticUniverse(universe.instruments || []);
    if (!instruments.length) throw new Error("没有获得可扫描的 A 股或场内 ETF 清单。");
    state.collection.total = instruments.length;
    updateCollectionUi(`已自动筛选 ${universe.count} 个证券，首轮扫描 ${instruments.length} 个代表性股票/ETF`);
    const collected = [];
    let lastFailure = "";
    for (const instrument of instruments) {
      if (state.collection.stopRequested) break;
      try {
        const { response, payload } = await fetchJsonWithTimeout(
          `/api/market/daily?symbol=${encodeURIComponent(instrument.symbol)}&limit=2000&adjust=qfq&period=daily&provider=auto`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(payload.error || "行情获取失败");
        const bars = payload.bars.map((row) => ({ date: new Date(`${row.date}T00:00:00`), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }));
        const quality = validateBars(bars);
        const found = payload.crossValidated === true
          ? detectCandidateSamples(quality.bars, payload.symbol || instrument.symbol, payload)
          : [];
        collected.push(...found);
        // 每个成功标的立即合并并刷新页面，避免等整轮结束才看见样本。
        if (found.length) {
          mergeCandidateSamples(found);
          renderLibrary();
        }
        state.collection.success += 1;
        if (payload.crossValidated !== true) lastFailure = `${instrument.symbol}：仅单一来源返回，未进入候选库`;
        loadSourceHealth();
        lastFailure = "";
      } catch (error) {
        state.collection.failed += 1;
        lastFailure = `${instrument.symbol}：${error.message}`;
      } finally {
        state.collection.scanned += 1;
        updateCollectionUi(`正在自动筛选 ${instrument.symbol} · ${instrument.name || ""}`);
      }
      const foundPatternIds = new Set(state.candidateSamples.map((sample) => sample.patternId));
      if (supportedAutomaticPatternIds.every((patternId) => foundPatternIds.has(patternId))) break;
    }
    mergeCandidateSamples(collected);
    const foundPatternIds = new Set(state.candidateSamples.map((sample) => sample.patternId));
    const coveredCount = supportedAutomaticPatternIds.filter((patternId) => foundPatternIds.has(patternId)).length;
    const suffix = lastFailure ? `；最近一次失败：${lastFailure}` : "";
    const status = state.collection.stopRequested
      ? `采集已停止，当前保留 ${state.candidateSamples.length} 个完整候选`
      : `自动采集完成，当前保留 ${state.candidateSamples.length} 个完整候选，已覆盖 ${coveredCount}/${supportedAutomaticPatternIds.length} 种当前支持形态`;
    updateCollectionUi(`${status}${suffix}`);
    setHint(`样本采集完成：${state.candidateSamples.length} 个完整候选待审核；每条均为背景40根+训练180根。`, false);
    renderLibrary();
  } catch (error) {
    updateCollectionUi(`自动采集失败：${error.message}`, true);
    setHint(`样本采集失败：${error.message}`, true);
  } finally {
    state.collection.running = false;
    button.disabled = false;
    button.textContent = "样本采集";
    $("stopCollectionButton").hidden = true;
    $("closeCollectionProgressButton").hidden = false;
    updateCollectionModal($("candidateScanHint").textContent);
  }
}

async function pollCollectionTask() {
  const taskId = state.collection.taskId;
  if (!taskId) throw new Error("服务端没有返回采集任务编号。");
  while (state.collection.running || state.collection.state === "running") {
    const result = await fetchJsonWithTimeout("/api/sample-collection/status?taskId=" + encodeURIComponent(taskId), { cache: "no-store" }, collectionRequestTimeoutMs);
    if (!result.response.ok) throw new Error(result.payload.error || "采集状态获取失败。");
    state.collection = { ...state.collection, ...result.payload, running: result.payload.state === "running" };
    updateCollectionUi(result.payload.message || "正在采集");
    if (result.payload.candidateRevision !== state.collection.lastLoadedCandidateRevision && !state.collection.candidateRefreshRunning) {
      const revision = result.payload.candidateRevision;
      state.collection.candidateRefreshRunning = true;
      loadServerCandidates().then((loaded) => {
        if (loaded) state.collection.lastLoadedCandidateRevision = revision;
      }).finally(() => { state.collection.candidateRefreshRunning = false; });
    }
    if (result.payload.state !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function visibleLibraryPatterns() {
  const search = state.patternSearch.trim().toLowerCase();
  return patternLibrary().filter((pattern) => {
    const inLibrary = state.libraryView === "sample" || state.trainingPatternIds.includes(pattern.id);
    const inCategory = state.libraryCategory === "all" || pattern.category === state.libraryCategory;
    const inSearch = !search || `${pattern.name} ${pattern.rule} ${pattern.category}`.toLowerCase().includes(search);
    return inLibrary && inCategory && inSearch;
  });
}

function biasLabel(bias) {
  if (bias === "bullish") return "偏多";
  if (bias === "bearish") return "偏空";
  return "方向待确认";
}

function patternSketchSvg(patternId) {
  const sketch = window.KLINE_PATTERN_SKETCHES?.[patternId];
  if (!sketch) return "";
  const guides = (sketch.g || []).map((path) => `<path class="guide-path" d="${path}"></path>`).join("");
  return `<svg class="pattern-sketch" viewBox="0 0 90 44" role="img" aria-label="形态示意图"><path class="price-path" d="${sketch.p}"></path>${guides}</svg>`;
}

function selectPattern(patternId) {
  state.selectedPatternId = patternId;
  if (state.finished) render(); else renderLibrary();
}

function trainingLibrarySamples(patternId = null) {
  const all = [...state.candidateSamples, ...state.collectedSamples]
    .filter((sample) => sample && sample.reviewStatus === "approved"
      && !isSideTrainingSample(sample)
      && sample.dataSource !== "demo"
      && sample.provider !== "内置演示"
      && hasCompleteCandidateWindow(sample)
      && hasCompleteIntradaySample(sample));
  const unique = new Map();
  all.forEach((sample) => {
    if ((!patternId || sample.patternId === patternId) && sample.key) unique.set(sample.key, sample);
  });
  return [...unique.values()].sort((a, b) => String(b.endDate || "").localeCompare(String(a.endDate || "")));
}

function togglePatternSamples(patternId) {
  const expanded = new Set(state.expandedPatternIds || []);
  if (expanded.has(patternId)) expanded.delete(patternId); else expanded.add(patternId);
  state.expandedPatternIds = [...expanded];
  renderLibrary();
}

function toggleTrainingPattern(patternId) {
  if (state.trainingPatternIds.includes(patternId)) {
    state.trainingPatternIds = state.trainingPatternIds.filter((id) => id !== patternId);
    if (state.selectedPatternId === patternId && state.libraryView === "training") state.selectedPatternId = null;
  } else {
    state.trainingPatternIds = [...state.trainingPatternIds, patternId];
  }
  saveTrainingPatternIds();
  renderLibrary();
}

function randomPattern() {
  const candidates = visibleLibraryPatterns();
  if (!candidates.length) {
    $("selectedPattern").innerHTML = "<span>当前筛选条件下没有可选知识模板</span><small>请调整库、类型或搜索条件</small>";
    return;
  }
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  state.selectedPatternId = picked.id;
  if (state.finished) render(); else renderLibrary();
  document.querySelector(`[data-pattern-id="${picked.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function allSideTrainingSamples() {
  const all = [...state.candidateSamples, ...state.collectedSamples]
    .filter((sample) => isSideTrainingSample(sample)
      && sample.reviewStatus === "approved"
      && sample.dataSource !== "demo"
      && sample.provider !== "内置演示"
      && (sample.catalogOnly !== true || sample.trainable === true)
      && hasIndicatorWarmup(sample)
      && hasCompleteCandidateWindow(sample)
      && hasCompleteIntradaySample(sample));
  return [...new Map(all.filter((sample) => sample.key).map((sample) => [sample.key, sample])).values()]
    .sort((a, b) => String(b.decisionAnchorDate || b.endDate || "").localeCompare(String(a.decisionAnchorDate || a.endDate || "")));
}

function sideTrainingSamples(view = state.sideLibraryView || "all") {
  return allSideTrainingSamples().filter((sample) => view === "all" || sample.tradeTiming === view || sideLabel(sample) === (view === "left" ? "左侧" : "右侧"));
}

function renderSideTrainingLibrary() {
  const grid = $("sideTrainingGrid");
  if (!grid) return;
  const all = allSideTrainingSamples();
  const visible = sideTrainingSamples();
  const pairs = new Set(all.map((sample) => sample.eventId).filter(Boolean));
  $("sideTrainingCount").textContent = `${all.length} 个已入库片段`;
  $("sideTrainingPairCount").textContent = `${pairs.size} 组配对`;
  const status = $("sampleLibraryStatus");
  if (status) status.textContent = state.sampleLibraryError || (state.serverCatalogLoaded
    ? `已连接本机训练库 · ${all.length} 个可训练片段 / ${pairs.size} 组配对；选择片段后加载真实行情。`
    : "正在读取本机训练库目录…");
  if ($("startIndicatorTrainingButton")) $("startIndicatorTrainingButton").disabled = Boolean(state.sampleLoadingKey);
  if (!visible.length) {
    grid.innerHTML = '<div class="collected-empty">当前目录暂无已审核的左右侧指标训练片段。</div>';
    return;
  }
  grid.innerHTML = visible.map((sample) => {
    const score = Number(sample.sideScore ?? sample.confidence);
    const pair = all.find((item) => item.eventId && item.eventId === sample.eventId && item.key !== sample.key);
    const actions = `<button class="primary-button candidate-action" type="button" data-side-action="train" data-candidate-key="${escapeHtml(sample.key)}">训练此片段</button>`
      + (pair ? `<button class="secondary-button candidate-action" type="button" data-side-action="pair" data-candidate-key="${escapeHtml(pair.key)}">训练${sideLabel(pair)}配对</button>` : "")
      + `<button class="secondary-button candidate-action" type="button" data-side-action="remove" data-candidate-key="${escapeHtml(sample.key)}">移出训练库</button>`;
    return `<article class="collected-card side-training-card"><strong>${escapeHtml(sideLabel(sample))}训练 · ${escapeHtml(phaseLabel(sample))}</strong><span>${escapeHtml(sample.symbol || "未命名标的")} · 决策日 ${escapeHtml(sample.decisionAnchorDate || sample.startDate || "—")}</span><span>阶段低点 ${escapeHtml(sample.pivotDate || "—")} · 规则分数 ${Number.isFinite(score) ? `${(score * 100).toFixed(0)}%` : "—"}</span><span>${escapeHtml(sample.sideSignals?.summary || "指标规则已通过")} · ${escapeHtml(sample.provider || "真实数据")}</span><div class="candidate-actions">${actions}</div></article>`;
  }).join("");
}

async function randomTrainingSample() {
  if (!state.serverCatalogLoaded) await loadServerCandidates();
  const approved = sideTrainingSamples();
  if (!approved.length) {
    setHint("当前目录没有已审核的左右侧指标训练片段。请先运行样本采集。", true);
    $("candidateScanHint").textContent = "当前采集按阶段低点生成左右侧配对片段，严格复核并补齐分时后自动入库。";
    return;
  }
  const picked = approved[Math.floor(Math.random() * approved.length)];
  await trainCandidate(picked.key);
}

function initializeLibrary() {
  const categories = [...new Set(patternLibrary().map((pattern) => pattern.category))];
  $("categorySelect").innerHTML = '<option value="all">全部类型</option>' + categories.map((category) => `<option value="${category}">${category}</option>`).join("");
}

function renderTrainingArea() {
  const indicatorArea = state.trainingArea === "indicator";
  document.querySelector(".side-training-panel").hidden = !indicatorArea;
  document.querySelector(".pattern-library-panel").hidden = indicatorArea;
  const slot = $(indicatorArea ? "indicatorCandidateSlot" : "patternCandidateSlot");
  const candidateSection = $("candidateSamplesSection");
  if (candidateSection.parentElement !== slot) slot.append(candidateSection);
  $("candidateScanHint").textContent = indicatorArea
    ? "围绕阶段低点采集左右侧配对片段；数据及分时复核通过后自动进入指标训练库。"
    : "旧形态候选和识别规则仅供浏览，形态训练将在后续开放。";
  $("trainingAreaSelect").value = state.trainingArea;
  $("collectSamplesButton").disabled = !indicatorArea && !state.collection.running;
  $("collectSamplesButton").title = indicatorArea ? "采集左右侧指标训练片段" : "请切换至指标训练区采集";
}

function renderLibrary() {
  renderTrainingArea();
  const patterns = visibleLibraryPatterns();
  const approvedSamples = trainingLibrarySamples();
  $("libraryCount").textContent = `${patterns.length} 个模板 · ${approvedSamples.length} 个训练片段`;
  const selected = patternLibrary().find((pattern) => pattern.id === state.selectedPatternId);
  $("selectedPattern").innerHTML = selected
    ? `<span>知识模板：${selected.name}</span><small>${selected.category} · ${biasLabel(selected.bias)} · ${selected.rule}（不会改变当前行情）</small>`
    : "<span>当前未选择知识模板</span><small>知识模板用于学习规则；实际行情由训练样本决定</small>";
  $("libraryGrid").innerHTML = patterns.length ? patterns.map((pattern) => {
    const inTraining = state.trainingPatternIds.includes(pattern.id);
    const samples = trainingLibrarySamples(pattern.id);
    const expanded = (state.expandedPatternIds || []).includes(pattern.id);
    const sampleCards = expanded
      ? `<div class="pattern-training-list">${samples.length ? samples.map((sample) => `<div class="pattern-training-item">
          <div><strong>${escapeHtml(sample.symbol || "未命名标的")}</strong><span>${escapeHtml(sample.startDate || "—")} 至 ${escapeHtml(sample.endDate || "—")}</span></div>
          <div><span>${escapeHtml(sample.provider || "真实数据")} · 前复权</span><span>背景40 + 训练180</span></div>
          <div class="pattern-training-actions"><span>形态训练后续开放</span></div>
        </div>`).join("") : '<div class="pattern-training-empty">该形态暂无已审核训练片段。</div>'}</div>`
      : "";
    return `<article class="pattern-card${pattern.id === state.selectedPatternId ? " selected" : ""}" data-pattern-id="${pattern.id}">
      <div class="pattern-card-top"><div class="pattern-name-with-sketch"><h3>${pattern.name}</h3>${patternSketchSvg(pattern.id)}</div><span class="pattern-bias ${pattern.bias}">${biasLabel(pattern.bias)}</span></div>
      <p>${pattern.rule}</p>
      <div class="pattern-meta"><span>${pattern.category}</span><span>${pattern.source}</span><span>${inTraining ? "训练库" : "待审核"}</span><span>训练片段 ${samples.length} 个</span></div>
      <div class="pattern-actions"><button type="button" data-action="expand-training">${expanded ? "收起已有片段" : "查看已有片段"}</button></div>
      ${sampleCards}
    </article>`;
  }).join("") : '<div class="library-empty">当前筛选条件下没有模板。</div>';
  renderSideTrainingLibrary();
  renderCandidateSamples();
  renderCollectedSamples();
}

function renderCandidateSamples() {
  const isIndicatorArea = state.trainingArea === "indicator";
  const candidates = state.candidateSamples.filter((sample) => isSideTrainingSample(sample) === isIndicatorArea && (isIndicatorArea ? sample.reviewStatus !== "approved" || sample.trainable === false : true));
  const approved = state.candidateSamples.filter((sample) => isSideTrainingSample(sample) === isIndicatorArea && sample.reviewStatus === "approved").length;
  $("candidateSampleCount").textContent = `${candidates.length} 个待处理 · ${approved} 个已入库`;
  if (!candidates.length) {
    $("candidateSampleList").innerHTML = '<div class="collected-empty">暂未扫描候选片段。</div>';
    return;
  }
  $("candidateSampleList").innerHTML = candidates.map((sample) => {
    const confidence = `${(sample.confidence * 100).toFixed(0)}%`;
    const quality = sample.autoEligible ? `规则初筛 ${confidence} · 尚未回测` : `规则初筛 ${confidence}`;
    const verification = sample.verificationStatus || "prefiltered";
    const blockedReasons = (sample.trainingBlockedReasons || []).join("；");
    const completeIntraday = hasCompleteIntradaySample(sample);
    const canRefetchIntraday = !completeIntraday && (["verified_strict", "verified_warning", "pending_intraday"].includes(verification) || sample.reviewStatus === "approved");
    const refetching = (state.intradayRefetchKeys || []).includes(sample.key);
     const statusLabel = blockedReasons || (sample.reviewStatus === "approved" ? "已审核 · 训练库"
       : sample.reviewStatus === "removed" ? "已从训练库移除"
       : verification === "verified_strict" && sample.reviewStatus === "pending" ? "数据严格通过 · 待形态审核"
      : verification === "verified_warning" && sample.dataReviewAccepted !== true ? "警告待审 · 先确认数据差异"
      : verification === "pending_intraday" ? "日线已通过 · 等待完整分时补采"
      : (verification === "pending_baostock" || verification === "pending_secondary") ? "等待独立第二数据源复核"
      : "初筛候选 · 等待复核");
    let actions = '<button class="secondary-button candidate-action" type="button" data-candidate-action="diff" data-candidate-key="' + escapeHtml(sample.key) + '">查看差异</button>';
    if (!isIndicatorArea) {
      actions = '<span class="candidate-action-note">形态候选仅供浏览，训练后续开放</span>';
    } else if (verification === "pending_baostock" || verification === "pending_secondary" || verification === "pending_intraday" || verification === "prefiltered") {
      actions += '<button class="secondary-button candidate-action" type="button" data-candidate-action="retry" data-candidate-key="' + escapeHtml(sample.key) + '">重新复核</button>';
    } else if (verification === "verified_warning" && sample.dataReviewAccepted !== true) {
      actions += '<button class="primary-button candidate-action" type="button" data-candidate-action="accept-warning" data-candidate-key="' + escapeHtml(sample.key) + '">确认差异</button><button class="secondary-button candidate-action" type="button" data-candidate-action="reject" data-candidate-key="' + escapeHtml(sample.key) + '">驳回</button>';
    } else if (verification === "verified_strict" || (verification === "verified_warning" && sample.dataReviewAccepted === true)) {
      actions += '<button class="primary-button candidate-action" type="button" data-candidate-action="approve" data-candidate-key="' + escapeHtml(sample.key) + '">审核通过并入训练库</button><button class="secondary-button candidate-action" type="button" data-candidate-action="reject" data-candidate-key="' + escapeHtml(sample.key) + '">驳回</button>';
    }
    if (isIndicatorArea && canRefetchIntraday) {
      actions += `<button class="secondary-button candidate-action" type="button" data-candidate-action="refetch-intraday" data-candidate-key="${escapeHtml(sample.key)}" ${refetching ? "disabled" : ""}>${refetching ? "获取中…" : "重新获取分时"}</button>`;
    }
    if (isIndicatorArea && sample.reviewStatus === "approved" && completeIntraday) {
       actions = '<button class="primary-button candidate-action" type="button" data-candidate-action="train" data-candidate-key="' + escapeHtml(sample.key) + '">训练此片段</button><button class="secondary-button candidate-action" type="button" data-candidate-action="remove-training" data-candidate-key="' + escapeHtml(sample.key) + '">移出训练库</button>' + actions;
     } else if (isIndicatorArea && sample.reviewStatus === "approved" && !completeIntraday) {
       actions = '<span class="candidate-action-note">分时未完整，暂不可训练</span>' + actions;
     } else if (isIndicatorArea && sample.reviewStatus === "removed" && completeIntraday) {
       actions = '<button class="secondary-button candidate-action" type="button" data-candidate-action="restore-training" data-candidate-key="' + escapeHtml(sample.key) + '">恢复到训练库</button>' + actions;
    }
    const coveredDays = sample.intradayCoverage?.availableDays ?? Object.keys(sample.intradayByDate || {}).length;
    const barsPerDay = sample.intradayCoverage?.barsPerDay?.length === 1 ? sample.intradayCoverage.barsPerDay[0] : (completeIntraday ? 48 : "—");
    const intradayLabel = completeIntraday ? "分时 220/220 天，48/48 根/天" : `分时 ${coveredDays}/${sample.bars?.length || 220} 天，${barsPerDay}/48 根/天`;
    return '<article class="collected-card candidate-card"><strong>' + escapeHtml(sample.patternName) + '</strong><span>' + escapeHtml(sample.symbol) + ' · ' + escapeHtml(sample.startDate) + ' 至 ' + escapeHtml(sample.endDate) + '</span><span>背景 40 根 + 训练 180 根 · ' + intradayLabel + ' · ' + statusLabel + ' · ' + quality + '</span><div class="candidate-actions">' + actions + '</div></article>';
  }).join("");
}

function findCandidate(key) { return state.candidateSamples.find((sample) => sample.key === key); }

function updateRetryProgress(task) {
  if (!task) return;
  const modal = $("retryProgressModal");
  if (!modal) return;
  modal.hidden = false;
  const candidate = findCandidate(task.sampleKey);
  $("retryProgressMeta").textContent = candidate ? `${candidate.patternName || "候选样本"} · ${candidate.symbol || ""}` : "候选样本";
  $("retryProgressStatus").textContent = task.message || "正在处理…";
  $("retryProgressStage").textContent = task.stage || "准备";
  $("retryProgressAttempt").textContent = String(task.attempt || 0);
  $("retryProgressElapsed").textContent = `${Math.round(Number(task.elapsedMs) || 0)} ms`;
  $("retryProgressCurrent").textContent = task.current || task.error || "等待请求…";
  const running = task.state === "running";
  $("closeRetryProgressButton").disabled = running;
  $("closeRetryProgressAction").hidden = running;
}

async function pollRetryTask() {
  const taskId = state.retryTask?.taskId;
  if (!taskId) return;
  try {
    const { response, payload } = await fetchJsonWithTimeout(
      `/api/sample-candidates/retry/status?taskId=${encodeURIComponent(taskId)}`,
      { cache: "no-store" }, 15000,
    );
    if (!response.ok) throw new Error(payload.error || "复核状态获取失败");
    state.retryTask = payload;
    updateRetryProgress(payload);
    if (payload.state === "running") {
      setTimeout(pollRetryTask, 650);
      return;
    }
    await loadServerCandidates();
    renderLibrary();
    const success = payload.state === "done";
    setHint(success ? "重新复核完成：数据已更新。" : (payload.message || "重新复核未通过，请查看候选状态。"), !success);
  } catch (error) {
    state.retryTask = { ...(state.retryTask || {}), state: "failed", message: `复核状态获取失败：${error.message}`, error: error.message };
    updateRetryProgress(state.retryTask);
    setHint("重新复核状态获取失败：" + error.message, true);
  }
}

async function retryCandidate(key) {
  if (!key || state.retryTask?.state === "running") return;
  state.retryTask = { sampleKey: key, state: "running", stage: "starting", message: "正在启动重新复核…", current: "等待服务器响应" };
  updateRetryProgress(state.retryTask);
  try {
    const { response, payload } = await postJson("/api/sample-candidates/retry", { key }, collectionRequestTimeoutMs);
    if (!response.ok) throw new Error(payload.error || "重新复核启动失败");
    state.retryTask = payload;
    updateRetryProgress(payload);
    await pollRetryTask();
  } catch (error) {
    state.retryTask = { ...(state.retryTask || {}), state: "failed", message: "重新复核启动失败：" + error.message, error: error.message };
    updateRetryProgress(state.retryTask);
    setHint("重新复核失败：" + error.message, true);
  }
}

async function refetchCandidateIntraday(key) {
  if (!key || (state.intradayRefetchKeys || []).includes(key)) return;
  state.intradayRefetchKeys = [...(state.intradayRefetchKeys || []), key];
  renderLibrary();
  setHint("正在重新获取该片段 220 个交易日的真实 5 分钟分时，请稍候…", false);
  try {
    const { response, payload } = await postJson(
      "/api/sample-candidates/refetch-intraday",
      { key },
      180000,
    );
    if (!response.ok) throw new Error(payload.error || "分时重新获取失败。");
    await loadServerCandidates();
    const error = Array.isArray(payload.errors) && payload.errors[0]?.error;
    if (Number(payload.success) > 0) setHint("该片段的真实分时已重新获取完成，现在可以继续审核或训练。", false);
    else setHint(`分时重新获取未完成：${error || "没有返回可补齐的真实数据"}`, true);
  } catch (error) {
    setHint("分时重新获取失败：" + error.message, true);
  } finally {
    state.intradayRefetchKeys = (state.intradayRefetchKeys || []).filter((item) => item !== key);
    renderLibrary();
  }
}

async function reviewCandidate(key, decision) {
  const candidate = findCandidate(key);
  if (!candidate) return;
  const action = decision === "rejected" ? "reject" : decision === "accept-warning" ? "accept-warning"
    : decision === "remove-training" ? "remove-training" : decision === "restore-training" ? "restore-training" : "approve";
  try {
    const result = await postJson("/api/sample-candidates/review", { key, action, reviewer: state.userName || "本机审核" }, collectionRequestTimeoutMs);
    if (!result.response.ok) throw new Error(result.payload.error || "审核操作失败。");
    if (result.payload.deleted) {
      state.candidateSamples = state.candidateSamples.filter((sample) => sample.key !== key);
    } else {
      const index = state.candidateSamples.findIndex((sample) => sample.key === key);
      if (index >= 0) state.candidateSamples[index] = result.payload;
    }
    // Restore the lightweight index after an approval returns the full sample payload.
    await loadServerCandidates();
  } catch (error) {
    setHint("审核失败：" + error.message, true);
  }
}

async function setTrainingSampleMembership(key, enabled) {
  const candidate = findCandidate(key);
  if (candidate) return reviewCandidate(key, enabled ? "restore-training" : "remove-training");
  const sample = state.collectedSamples.find((item) => item.key === key);
  if (!sample) return setHint("没有找到这个训练片段。", true);
  sample.reviewStatus = enabled ? "approved" : "removed";
  sample.status = enabled ? "已审核 · 训练库" : "已从训练库移除";
  saveCollectedSamples();
  renderLibrary();
}

function viewCandidateDiff(key) {
  const candidate = findCandidate(key);
  if (!candidate) return;
  const report = candidate.validationReport;
  if (!report) return setHint("该候选还没有完整复核报告，当前状态：" + (candidate.status || "待复核"), true);
  const lines = [
    "复核状态：" + (report.status || candidate.verificationStatus || "未知"),
    "来源：" + (report.providers || []).join("、"),
    "原因：" + (report.reason || "无"),
  ];
  Object.entries(report.pairs || {}).forEach(([name, pair]) => {
    lines.push(name + "：共同日期 " + (pair.matched ?? 0)
      + "，OHLC P99 " + (pair.ohlcP99Percent ?? "—") + "%"
      + "，成交量P95 " + (pair.volumeP95Percent ?? "—") + "%");
  });
  window.alert(lines.join("\n"));
}

async function trainCandidate(key) {
  if (state.sampleLoadingKey) return;
  let candidate = findCandidate(key) || state.collectedSamples.find((sample) => sample.key === key);
  if (!candidate) return setHint("没有找到这个样本片段，请刷新样本库后重试。", true);
  if (candidate.serverCandidate) {
    state.sampleLoadingKey = key;
    renderSideTrainingLibrary();
    setHint("正在加载所选片段的真实日线与分时…", false);
    try {
      const { response, payload } = await fetchJsonWithTimeout(`/api/sample-candidates?key=${encodeURIComponent(key)}`, { cache: "no-store" }, collectionRequestTimeoutMs);
      if (!response.ok || !payload.candidate) throw new Error(payload.error || "样本详情返回异常");
      candidate = payload.candidate;
      if (candidate.trainable === false) throw new Error((candidate.trainingBlockedReasons || []).join("；") || "样本尚未通过入库检查");
    } catch (error) {
      setHint(`样本加载失败：${error.message}。当前训练已保留，可刷新训练库后重试。`, true);
      return;
    } finally {
      state.sampleLoadingKey = "";
      renderSideTrainingLibrary();
    }
  }
  if (!isSideTrainingSample(candidate)) return setHint("形态训练后续开放；当前请选择指标训练区的左右侧片段。", true);
  if (candidate.reviewStatus !== "approved") return setHint("该候选尚未完成数据复核与配对入库，不能训练。", true);
  if (!hasIndicatorWarmup(candidate)) return setHint("该样本缺少250根指标预热日线，不能训练。", true);
  if (!hasCompleteIntradaySample(candidate)) return setHint("该样本缺少完整220天×48根真实5分钟分时，不能训练，请先重新获取分时。", true);

  const isSnapshot = candidate.snapshot === true;
  if (isSnapshot) {
    const minimumSnapshotBars = sampleContextBars + sampleTrainingBars;
    if (!hasCompleteSampleWindow(candidate)) {
      return setHint("这个样本缺少完整 K 线数据，不能开始训练。请重新载入样本库。", true);
    }
    try {
      const normalized = candidate.bars.map((bar) => ({
        ...bar,
        date: bar.date instanceof Date ? bar.date : new Date(`${String(bar.date).slice(0, 10)}T00:00:00`),
      }));
      // 样本必须严格包含40根背景和180根训练K线，禁止旧格式片段混入。
      const quality = validateBars(normalized, minimumSnapshotBars);
      if (quality.bars.length !== minimumSnapshotBars || quality.droppedCount) throw new Error("样本存在无效或重复日线，当前训练已保留。");
      const snapshotStart = Number(candidate.trainingStartIndex ?? candidate.startIndex);
      const snapshotEnd = Number(candidate.trainingEndIndex ?? candidate.endIndex);
      if (snapshotStart !== sampleContextBars || snapshotEnd !== minimumSnapshotBars - 1) throw new Error("样本训练边界不完整，当前训练已保留。");
      const warmupQuality = validateBars(candidate.indicatorWarmupBars.map((bar) => ({ ...bar, date: bar.date instanceof Date ? bar.date : new Date(`${String(bar.date).slice(0, 10)}T00:00:00`) })), indicatorWarmupBars);
      if (warmupQuality.bars.length !== indicatorWarmupBars || warmupQuality.droppedCount
        || warmupQuality.bars.at(-1).date >= quality.bars[0].date) throw new Error("指标预热数据或时序无效，当前训练已保留。");
      state.bars = quality.bars;
      state.indicatorWarmupBars = warmupQuality.bars;
      state.symbol = candidate.symbol;
      // 服务端样本以 symbol 保存；不能回退到 LOCAL，否则双击分时会被误判为非真实行情。
      state.code = resolvedSampleCode(candidate);
      state.dataSource = "real";
      updateDataMeta({ provider: candidate.provider || "东方财富", adjust: candidate.adjust || "qfq", period: candidate.period || "daily", volumeUnit: candidate.volumeUnit || "", ...quality, fetchedAt: candidate.fetchedAt || new Date().toISOString() });
    } catch (error) {
      return setHint(`样本数据校验失败：${error.message}`, true);
    }
    const snapshotStart = Number(candidate.trainingStartIndex ?? candidate.startIndex);
    const snapshotEnd = Number(candidate.trainingEndIndex ?? candidate.endIndex);
    if (!Number.isInteger(snapshotStart) || !Number.isInteger(snapshotEnd)
      || snapshotStart !== sampleContextBars
      || snapshotEnd !== sampleContextBars + sampleTrainingBars - 1
      || snapshotEnd >= state.bars.length) {
      return setHint("这个样本的训练区间不完整，不能开始训练。请重新载入样本库。", true);
    }
    state.trainingStartIndex = snapshotStart;
    state.trainingEndIndex = snapshotEnd;
  } else {
    if (!hasCompleteCandidateWindow(candidate)) return setHint("这个样本没有完整的40根前置背景和180根训练区，已拒绝训练。", true);
    if (candidate.symbol !== state.symbol) return setHint("该样本属于其他标的，请先获取对应代码的真实行情后再训练。", true);
    const startIndex = Number(candidate.trainingStartIndex ?? candidate.startIndex);
    const endIndex = Number(candidate.trainingEndIndex ?? candidate.endIndex);
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || endIndex < startIndex || endIndex >= state.bars.length) {
      return setHint("当前行情中没有完整的该样本片段，请重新扫描。", true);
    }
    state.trainingStartIndex = startIndex;
    state.trainingEndIndex = endIndex;
    state.indicatorWarmupBars = [];
  }
  state.selectedPatternId = candidate.patternId;
  const { bars: sampleBars, indicatorWarmupBars: sampleWarmup, intradayByDate: sampleIntraday, ...sampleMeta } = candidate;
  state.activeTrainingSample = isSideTrainingSample(candidate) ? sampleMeta : null;
  state.intradayData = candidate.intradayByDate && typeof candidate.intradayByDate === "object"
    ? candidate.intradayByDate : {};
  state.showIdentity = false;
  state.mode = "naked";
  $("modeSelect").value = "naked";
  $("identityToggle").checked = false;
  resetTradingSession();
  const trainingLabel = isSideTrainingSample(candidate)
    ? `${sideLabel(candidate)}训练 · ${phaseLabel(candidate)}`
    : candidate.patternName;
  $("dataStatus").textContent = `训练片段：${trainingLabel} · ${candidate.startDate} 至 ${candidate.endDate}；`;
  setMarketHint(`已载入${candidate.provider || "真实行情"}样本：${candidate.symbol} · 前复权 · 背景40根 + 训练180根${hasIndicatorWarmup(candidate) ? " · 指标预热250根" : ""}。`, false);
  setHint(`已载入「${trainingLabel}」已审核片段，可开始独立训练。`, false);
  render();
  saveDraftSession();
  $("chartCanvas").scrollIntoView({ behavior: "smooth", block: "center" });
}

function revealedPattern() {
  if (state.activeTrainingSample && isSideTrainingSample(state.activeTrainingSample)) return null;
  if (state.dataSource === "demo") return patternLibrary().find((pattern) => pattern.id === "rectangle-bottom") || null;
  return patternLibrary().find((pattern) => pattern.id === state.selectedPatternId) || null;
}

function sampleKey(pattern) {
  const start = state.bars[state.trainingStartIndex];
  const end = state.bars[state.trainingEndIndex];
  return `${state.symbol}|${formatDate(start.date)}|${formatDate(end.date)}|${pattern.id}`;
}

function sampleReviewDecision() {
  // The built-in sample has a known label. Real/imported data remains pending
  // until the future detector is validated against a labelled set.
  return state.dataSource === "demo"
    ? { status: "自动入库（演示）", confidence: 0.99, reviewStatus: "approved" }
    : { status: "待审核", confidence: null, reviewStatus: "pending" };
}

function collectCurrentSample() {
  if (!state.finished) return;
  if (state.trainingStartIndex < sampleContextBars || trainingLength() !== sampleTrainingBars) {
    return setHint("当前训练片段不是完整的40根背景 + 180根训练区，不能收藏到训练库。", true);
  }
  const pattern = revealedPattern();
  if (!pattern) return setHint("请先在形态库选择一个知识模板，为导入行情标注形态后再收藏。", true);
  const key = sampleKey(pattern);
  if (state.collectedSamples.some((sample) => sample.key === key)) return;
  const review = sampleReviewDecision();
  const snapshotBars = state.bars.slice(state.trainingStartIndex - sampleContextBars, state.trainingEndIndex + 1).map((bar) => ({
    date: formatDate(bar.date), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
  }));
  state.collectedSamples = [{
    key,
    symbol: state.symbol,
    startDate: formatDate(state.bars[state.trainingStartIndex].date),
    endDate: formatDate(state.bars[state.trainingEndIndex].date),
    patternId: pattern.id,
    patternName: pattern.name,
    dataSource: state.dataSource,
    startIndex: sampleContextBars,
    endIndex: sampleContextBars + sampleTrainingBars - 1,
    contextStartIndex: 0,
    trainingStartIndex: sampleContextBars,
    trainingEndIndex: sampleContextBars + sampleTrainingBars - 1,
    snapshot: true,
    bars: snapshotBars,
    provider: state.dataMeta?.provider || sourceLabel(),
    adjust: state.dataMeta?.adjust || "qfq",
    period: state.dataMeta?.period || "daily",
    ...review,
  }, ...state.collectedSamples];
  saveCollectedSamples();
  render();
}

function renderCollectedSamples() {
  $("collectedSampleCount").textContent = `${state.collectedSamples.length} 个片段`;
  $("collectedSampleList").innerHTML = state.collectedSamples.length
    ? state.collectedSamples.map((sample) => `<article class="collected-card"><strong>${escapeHtml(sample.patternName)}</strong><span>${escapeHtml(sample.symbol)} · ${escapeHtml(sample.startDate)} 至 ${escapeHtml(sample.endDate)}</span><span>${escapeHtml(sample.status)}${sample.confidence ? ` · 置信度 ${(sample.confidence * 100).toFixed(0)}%` : ""} · 当前浏览器本机保存</span></article>`).join("")
    : '<div class="collected-empty">训练完成后，可将典型行情片段收藏到这里。</div>';
}

function volumeStats(index, indicators) {
  const current = indicators.volumes[index];
  const ma120 = indicators.volumeMa120?.[index] ?? sma(indicators.volumes, 120, index);
  const ma250 = indicators.volumeMa250?.[index] ?? sma(indicators.volumes, 250, index);
  const recent = indicators.volumes.slice(Math.max(0, index - 19), index + 1);
  const recentMax = Math.max(...recent);
  const recentMin = Math.min(...recent);
  const ratio = ma120 ? current / ma120 : null;
  let signal = "数据积累中";
  if (recent.length >= 10 && current >= recentMax) signal = "近20日天量";
  else if (recent.length >= 10 && current <= recentMin) signal = "近20日地量";
  else if (ratio != null && ratio >= 1.5) signal = "明显放量";
  else if (ratio != null && ratio >= 1.15) signal = "温和放量";
  else if (ratio != null && ratio <= 0.55) signal = "明显缩量";
  else if (ratio != null && ratio <= 0.85) signal = "缩量";
  else if (ratio != null) signal = "量能正常";
  return { ma120, ma250, ratio, signal };
}

function formatVolume(value) { return value == null ? "—" : `${(value / 1_000_000).toFixed(2)}M`; }

function chipDistribution(bars, currentPrice, binCount = 28) {
  if (!bars.length) return null;
  const low = Math.min(...bars.map((bar) => bar.low));
  const high = Math.max(...bars.map((bar) => bar.high));
  const range = Math.max(high - low, 0.01);
  const binSize = range / binCount;
  const weights = Array(binCount).fill(0);
  bars.forEach((bar, dayIndex) => {
    const lowBin = Math.max(0, Math.floor((bar.low - low) / binSize));
    const highBin = Math.min(binCount - 1, Math.floor((bar.high - low) / binSize));
    const typical = (bar.high + bar.low + bar.close * 2) / 4;
    const decay = Math.pow(0.994, bars.length - dayIndex - 1);
    const factors = [];
    let factorTotal = 0;
    for (let bin = lowBin; bin <= highBin; bin += 1) {
      const price = low + (bin + 0.5) * binSize;
      const factor = Math.max(0.15, 1 - Math.abs(price - typical) / Math.max(bar.high - bar.low, binSize));
      factors.push([bin, factor]); factorTotal += factor;
    }
    factors.forEach(([bin, factor]) => { weights[bin] += bar.volume * decay * (factor / factorTotal); });
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  const prices = weights.map((_, index) => low + (index + 0.5) * binSize);
  const peakIndex = weights.indexOf(Math.max(...weights));
  const average = weights.reduce((sum, value, index) => sum + value * prices[index], 0) / Math.max(total, 1);
  const quantilePrice = (target) => {
    let cumulative = 0;
    for (let index = 0; index < weights.length; index += 1) {
      cumulative += weights[index];
      if (cumulative / Math.max(total, 1) >= target) return prices[index];
    }
    return prices[prices.length - 1];
  };
  const profitable = weights.reduce((sum, value, index) => sum + (prices[index] <= currentPrice ? value : 0), 0);
  return { low, high, binSize, weights, prices, peakPrice: prices[peakIndex], average, lower70: quantilePrice(0.15), upper70: quantilePrice(0.85), profitRatio: profitable / Math.max(total, 1) };
}

function drawTextSegments(ctx, x, y, segments) {
  let cursor = x;
  ctx.font = "10px Inter, sans-serif";
  segments.forEach(({ text, color }) => {
    ctx.fillStyle = color;
    ctx.fillText(text, cursor, y);
    cursor += ctx.measureText(text).width + 7;
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function notesAt(index) {
  return (state.barNotes || []).filter((item) => Number(item.index) === Number(index));
}

function openBarNote(index, tradeId = null, waveId = null) {
  if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) > state.currentIndex) return;
  noteOpenBarIndex = Number(index);
  noteOpenTradeId = tradeId;
  noteOpenWaveId = waveId;
  noteOpenSession = false;
  const date = state.bars[noteOpenBarIndex]?.date;
  const trade = state.trades.find((item) => item.id === tradeId);
  const wave = waveId ? operationReviewData().find((item) => item.id === waveId) : null;
  const title = trade ? `${trade.side === "buy" ? "买入" : "卖出"}成交补记` : wave ? "波段复盘补记" : "K线笔记";
  $("barNoteTitle").textContent = title;
  const noteIdentity = state.showIdentity || state.finished ? `${state.symbol}${state.code ? ` · ${state.code}` : ""}` : "匿名训练标的";
  $("barNoteMeta").textContent = `${noteIdentity} · ${formatDate(date)}${trade ? ` · ${trade.qty.toLocaleString()} 股 @ ${formatPrice(trade.price)}` : ""}${wave ? ` · 波段 ${wave.id}` : ""}`;
  $("barNoteInputLabel").textContent = state.finished || noteOpenBarIndex !== state.currentIndex || trade || wave ? "追加复盘补记" : "当时判断";
  $("barNoteTimingHint").textContent = state.finished || noteOpenBarIndex !== state.currentIndex || trade || wave
    ? "这条内容会标记为事后补记，并保留添加时间。"
    : "当前这根 K 线仍在训练决策点，保存后会作为当时判断记录。";
  $("barNoteInput").value = "";
  clearDecisionForm("note");
  const levelsAtBar = (state.manualKeyLevels || []).filter((item) => Number(item.index) === noteOpenBarIndex);
  const levelRevisions = new Set(levelsAtBar.map((item) => item.supersedes).filter(Boolean));
  const currentLevel = [...levelsAtBar].reverse().find((item) => !levelRevisions.has(item.id) && item.status !== "withdrawn");
  if (currentLevel) {
    $("noteKeyLevelInput").value = String(currentLevel.lower ?? currentLevel.price ?? "");
    $("noteKeyLevelUpperInput").value = Number(currentLevel.upper ?? currentLevel.price) !== Number(currentLevel.lower ?? currentLevel.price) ? String(currentLevel.upper) : "";
  }
  if ($("noteParsePreview")) { $("noteParsePreview").hidden = true; $("noteParsePreview").innerHTML = ""; }
  renderBarNoteEntries();
  $("barNoteModal").hidden = false;
  setTimeout(() => $("barNoteInput").focus(), 0);
}

function openSessionReviewNote() {
  openBarNote(Math.max(0, state.trainingEndIndex));
  noteOpenSession = true;
  $("barNoteTitle").textContent = "整局复盘补记";
  $("barNoteInputLabel").textContent = "整局结论";
  $("barNoteTimingHint").textContent = "此处用于结束后的总结与下一局提醒，会带时间保存。";
  const entries = (state.reviewNotes || []).filter((item) => item.targetType === "session");
  if (entries.length) $("barNoteEntries").innerHTML = entries.map((item) => `<article class="bar-note-entry"><div><b>整局复盘结论</b><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time></div><p>${escapeHtml(item.text)}</p></article>`).join("");
  else $("barNoteEntries").innerHTML = '<p class="bar-note-empty">还没有整局复盘结论。</p>';
}

function renderBarNoteEntries() {
  const index = noteOpenBarIndex;
  const tradeIds = noteOpenTradeId ? new Set([noteOpenTradeId]) : new Set(state.trades.filter((item) => item.index === index).map((item) => item.id));
  const entries = [];
  state.trades.filter((item) => item.index === index && (!noteOpenTradeId || item.id === noteOpenTradeId)).forEach((item) => {
    entries.push(`<article class="bar-note-entry"><div><b>${item.side === "buy" ? "买入" : "卖出"} ${Number(item.qty).toLocaleString()} 股 · ¥${formatPrice(item.price)}</b><span>成交时记录</span></div><p>${item.reason ? escapeHtml(item.reason) : "当时未记录理由"}</p>${item.indicators?.j != null ? `<small>J ${Number(item.indicators.j).toFixed(1)}${item.indicators.volumeSignal ? ` · ${escapeHtml(item.indicators.volumeSignal)}` : ""}</small>` : ""}<button class="text-button" type="button" data-note-trade="${escapeHtml(item.id)}">为这笔成交补记</button></article>`);
  });
  notesAt(index).filter((item) => !item.targetTradeId || tradeIds.has(item.targetTradeId)).forEach((item) => {
    entries.push(`<article class="bar-note-entry"><div><b>${item.kind === "original" ? "当时判断" : "事后补记"}</b><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time></div><p>${escapeHtml(item.text)}</p></article>`);
  });
  if (noteOpenTradeId) {
    (state.reviewNotes || []).filter((item) => item.targetType === "trade" && item.targetId === noteOpenTradeId).forEach((item) => entries.push(`<article class="bar-note-entry"><div><b>成交事后补记</b><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time></div><p>${escapeHtml(item.text)}</p></article>`));
  }
  if (noteOpenWaveId) {
    (state.reviewNotes || []).filter((item) => item.targetType === "wave" && item.targetId === noteOpenWaveId).forEach((item) => entries.push(`<article class="bar-note-entry"><div><b>波段复盘补记</b><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time></div><p>${escapeHtml(item.text)}</p></article>`));
  }
  const levelAtIndex = (state.manualKeyLevels || []).filter((item) => Number(item.index) === index);
  const superseded = new Set(levelAtIndex.map((item) => item.supersedes).filter(Boolean));
  levelAtIndex.forEach((item) => entries.push(`<article class="bar-note-entry"><div><b>本人标记关键位 r${Number(item.revision) || 1}${superseded.has(item.id) ? " · 历史版本" : " · 当前"}</b><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time></div><p>${formatPrice(Number(item.lower ?? item.price))}${Number(item.upper ?? item.price) !== Number(item.lower ?? item.price) ? `–${formatPrice(Number(item.upper))}` : ""}${item.retrospective ? " · 事后补标" : " · 当时标记"}${item.supersedes ? " · 更新自上一版本" : ""}</p></article>`));
  if (!noteOpenTradeId && !noteOpenWaveId) {
    (state.reviewNotes || []).filter((item) => item.targetType === "bar" && Number(item.index) === index).forEach((item) => entries.push(`<article class="bar-note-entry"><div><b>事后补记</b><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time></div><p>${escapeHtml(item.text)}</p></article>`));
  }
  $("barNoteEntries").innerHTML = entries.join("") || '<p class="bar-note-empty">这根 K 线还没有笔记。</p>';
}

function saveBarNote() {
  const text = String($("barNoteInput").value || "").trim();
  const structured = readDecisionForm("note");
  const parsedCandidates = confirmedNoteCandidates();
  const keyLevel = structured?.keyLevel;
  if (!text && !structured && !parsedCandidates.length) return setBarNoteHint("写一句判断或选择一项结构化记录即可；也可以关闭并跳过。", true);
  const createdAt = new Date().toISOString();
  if (noteOpenTradeId || noteOpenWaveId || noteOpenSession) {
    state.reviewNotes.push({ id: makeLocalId(), targetType: noteOpenTradeId ? "trade" : noteOpenWaveId ? "wave" : "session", targetId: noteOpenTradeId || noteOpenWaveId || null, index: noteOpenBarIndex, text, structured, parsedCandidates, createdAt });
  } else if (state.finished) {
    state.reviewNotes.push({ id: makeLocalId(), targetType: "bar", index: noteOpenBarIndex, text, structured, parsedCandidates, createdAt });
  } else {
    state.barNotes.push({ id: makeLocalId(), index: noteOpenBarIndex, targetTradeId: null, kind: noteOpenBarIndex === state.currentIndex ? "original" : "postscript", text, structured, parsedCandidates, createdAt });
  }
  if (keyLevel != null) {
    const range = structured?.keyLevelRange || [keyLevel, keyLevel];
    const previous = [...state.manualKeyLevels].reverse().find((item) => Number(item.index) === noteOpenBarIndex && item.status !== "withdrawn");
    const previousRange = previous ? [Number(previous.lower ?? previous.price), Number(previous.upper ?? previous.price)] : null;
    if (!previousRange || previousRange[0] !== range[0] || previousRange[1] !== range[1]) {
      state.manualKeyLevels.push({ id: makeLocalId(), index: noteOpenBarIndex, price: keyLevel, lower: range[0], upper: range[1], label: "用户标记关键位", createdAt, retrospective: state.finished || noteOpenBarIndex !== state.currentIndex, supersedes: previous?.id || null, revision: previous ? (Number(previous.revision) || 1) + 1 : 1 });
    }
  }
  $("barNoteInput").value = "";
  clearDecisionForm("note");
  renderBarNoteEntries();
  render();
  if (noteOpenSession) openSessionReviewNote();
  if (state.finished) persistCurrentReviewArchive();
  else scheduleReviewArchiveSave();
  setBarNoteHint("已保存，原始记录不会被覆盖。", false);
}

function setBarNoteHint(message, error) {
  $("barNoteTimingHint").textContent = message;
  $("barNoteTimingHint").style.color = error ? "#ff9aa6" : "var(--muted)";
}

function reviewArchivePayload() {
  if (!state.finished) return null;
  if (!state.reviewId) state.reviewId = makeLocalId();
  if (!state.reviewArchivedAt) state.reviewArchivedAt = new Date().toISOString();
  if (!state.archiveView) saveDraftSession();
  return {
    format: "kline-training-review", version: 2, id: state.reviewId, archivedAt: state.reviewArchivedAt, modifiedAt: new Date().toISOString(),
    userName: state.userName, symbol: state.symbol, code: state.code, dataSource: state.dataSource, dataMeta: state.dataMeta,
    bars: state.bars.map((bar) => ({ ...bar, date: formatDate(bar.date) })),
    indicatorWarmupBars: state.indicatorWarmupBars.map((bar) => ({ ...bar, date: formatDate(bar.date) })),
    trainingStartIndex: state.trainingStartIndex, trainingEndIndex: state.trainingEndIndex, currentIndex: state.trainingEndIndex,
    cash: state.cash, lots: state.lots, trades: state.trades, barNotes: state.barNotes || [], reviewNotes: state.reviewNotes || [],
    operationPlans: state.operationPlans, nextSessionChecklist: state.nextSessionChecklist,
    reviewSuggestionSelections: state.reviewSuggestionSelections, reviewQuestionnaire: state.reviewQuestionnaire,
    reviewConclusions: state.reviewConclusions, teachingComparisons: state.teachingComparisons, manualKeyLevels: state.manualKeyLevels,
    chartMarks: state.chartMarks || [], chartMarkHistory: state.chartMarkHistory || [], chartMarkActions: state.chartMarkActions || [],
    analysisVersion: "review-coach-v1", avgCost: state.avgCost, finished: true,
    mode: state.mode, indicator: state.indicator, showChip: state.showChip, showIdentity: state.showIdentity,
    tradingRule: state.tradingRule, feeRuleVersion, activeTrainingSample: state.activeTrainingSample,
    trainingArea: state.trainingArea, intradayData: state.intradayData || {},
    reviewRulesSnapshot: structuredClone(state.finishedRuleSnapshot || state.archivedReviewRules || effectiveReviewRuleset()),
    reviewRuleVersion: (state.finishedRuleSnapshot || state.archivedReviewRules || effectiveReviewRuleset()).version,
  };
}

const unsyncedReviewStorageKey = "kline-training-unsynced-review-v1";

function readUnsyncedReview() {
  try { return JSON.parse(localStorage.getItem(unsyncedReviewStorageKey) || "null"); } catch (_) { return null; }
}

function clearUnsyncedReview(reviewId, writeId) {
  const cached = readUnsyncedReview();
  if (cached?.review?.id === reviewId && (!writeId || cached.writeId === writeId)) localStorage.removeItem(unsyncedReviewStorageKey);
  if (!readUnsyncedReview()) $("retryReviewSaveButton").hidden = true;
}

async function persistReviewArchive(review) {
  const snapshot = structuredClone(review);
  const writeId = makeLocalId();
  localStorage.setItem(unsyncedReviewStorageKey, JSON.stringify({ review: snapshot, writeId, cachedAt: new Date().toISOString() }));
  $("retryReviewSaveButton").hidden = false;
  // Keep rapid answers/conclusions in submission order. An older response must not
  // clear the newer unsynced snapshot or overwrite the last submitted archive.
  const task = reviewArchiveSaveQueue.catch(() => {}).then(async () => {
    const response = await fetch("/api/reviews/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ review: snapshot }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存失败");
    clearUnsyncedReview(snapshot.id, writeId);
    if (!readUnsyncedReview()) $("reviewArchiveStatus").textContent = `已保存 ${snapshot.symbol} 的复盘档案 · ${new Date(snapshot.archivedAt).toLocaleString()}`;
    await loadReviewArchiveList();
  });
  reviewArchiveSaveQueue = task;
  await task;
}

async function persistCurrentReviewArchive() {
  const review = reviewArchivePayload();
  if (!review) return;
  try { await persistReviewArchive(review); }
  catch (error) { $("retryReviewSaveButton").hidden = false; $("reviewArchiveStatus").textContent = `复盘暂未同步到本机：${error.message}。未同步版本已保留在浏览器，可重试或导出。`; }
}

async function retryUnsyncedReviewSave() {
  const cached = readUnsyncedReview();
  const review = state.archiveView && state.reviewId ? reviewArchivePayload() : cached?.review;
  if (!review) return;
  try { await persistReviewArchive(review); }
  catch (error) { $("retryReviewSaveButton").hidden = false; $("reviewArchiveStatus").textContent = `重试仍未成功：${error.message}。浏览器中的未同步版本仍保留，可导出备份。`; }
}

function exportCurrentReviewArchive() {
  const review = state.archiveView || state.finished ? reviewArchivePayload() : readUnsyncedReview()?.review;
  if (!review) return;
  downloadJson(`kline-review-${String(review.code || review.id || "archive")}-${new Date().toISOString().slice(0, 10)}.json`, {
    format: "kline-training-reviews", version: 2, exportedAt: new Date().toISOString(), reviews: [review],
  });
}

function scheduleReviewArchiveSave() {
  if (!state.finished || state.archiveView) return;
  clearTimeout(reviewArchiveSaveTimer);
  reviewArchiveSaveTimer = setTimeout(async () => {
    const review = reviewArchivePayload();
    if (!review) return;
    try { await persistReviewArchive(review); }
    catch (error) {
      $("reviewArchiveStatus").textContent = `复盘档案暂未同步到本机：${error.message}。本局草稿仍在当前浏览器，请稍后刷新重试或导出训练备份。`;
    }
  }, 500);
}

async function loadReviewArchiveList() {
  try {
    const response = await fetch("/api/reviews", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "读取失败");
    const reviews = Array.isArray(result.reviews) ? result.reviews : [];
    $("reviewArchiveList").innerHTML = reviews.length ? reviews.map((item) => `
      <article class="review-archive-item"><div><strong>${escapeHtml(item.symbol)}</strong><span>${escapeHtml(item.code || "本地样本")} · ${escapeHtml(new Date(item.archivedAt).toLocaleString())}</span><small>${Number(item.tradeCount) || 0} 笔成交 · ${Number(item.noteCount) || 0} 条笔记</small></div><button class="secondary-button" type="button" data-open-review="${escapeHtml(item.id)}">打开复盘</button></article>`).join("") : '<div class="collected-empty">还没有已结束的训练档案；结束一局后会自动保存到这里。</div>';
    if (!reviews.length && !state.finished) $("reviewArchiveStatus").textContent = "每局结束后自动保存买卖、笔记和波段数据到本机。";
    const unsynced = readUnsyncedReview();
    $("retryReviewSaveButton").hidden = !unsynced?.review;
    if (unsynced?.review && !state.archiveView) $("reviewArchiveStatus").textContent = "发现一份尚未同步的本地复盘；可重试保存或导出。";
  } catch (error) {
    $("reviewArchiveList").innerHTML = '<div class="collected-empty">当前本机服务不可用，复盘档案列表暂时无法读取。</div>';
    $("reviewArchiveStatus").textContent = `档案读取失败：${error.message}`;
    $("retryReviewSaveButton").hidden = !readUnsyncedReview()?.review;
  }
}

function buildReviewQuestions() {
  const trades = state.trades;
  const waves = operationReviewData();
  const allNotes = [...(state.barNotes || []), ...(state.reviewNotes || [])];
  const noteForTrade = (trade) => allNotes.filter((note) => note.targetType === "trade" && note.targetId === trade.id || note.targetType === "bar" && note.targetTradeId === trade.id);
  const hasStructuredBasis = (trade) => Boolean(trade.decision?.intent || trade.decision?.signals?.length || trade.decision?.confirmCondition || trade.decision?.invalidationCondition);
  const questions = [];
  const missing = trades.filter((trade) => !String(trade.reason || "").trim() && !hasStructuredBasis(trade) && !noteForTrade(trade).some((note) => String(note.text || "").trim() || note.structured?.intent || note.structured?.signals?.length));
  if (missing.length) questions.push({ id: "N1-missing-basis", category: "记录或数据不足", prompt: "有 " + missing.length + " 笔成交没有保存当时理由。你现在还记得主要依据吗？这次回答会作为事后补记。", options: ["主要是J值", "主要是量价", "主要是价格位置", "记不清了", "其他"], tradeIds: missing.map((trade) => trade.id) });
  const pendingInterpretations = allNotes.filter((note) => note.parsedCandidates?.some((candidate) => candidate.status === "待确认"));
  if (pendingInterpretations.length) questions.push({ id: "note-interpretation", category: "记录或数据不足", prompt: "有 " + pendingInterpretations.length + " 条笔记识别出条件但尚未确认。原句保留不变；这些条件表达准确吗？", options: ["基本准确", "缺触发口径", "缺目标批次或数量", "识别不准确", "仍不确定"], tradeIds: pendingInterpretations.flatMap((note) => note.targetType === "trade" ? [note.targetId] : [] ).filter(Boolean), waveIds: [...new Set(pendingInterpretations.map((note) => waves.find((wave) => wave.trades.some((trade) => trade.id === note.targetId))?.id).filter(Boolean))] });
  const confirmedInterpretations = allNotes.filter((note) => note.parsedCandidates?.some((candidate) => candidate.status === "用户确认"));
  if (confirmedInterpretations.length) questions.push({ id: "note-confirmed-rule", category: "计划变化与执行", prompt: `你确认过 ${confirmedInterpretations.length} 条笔记条件。回看它们当时的用途：观察提示、买入／减仓条件，还是仅用于记录？`, options: ["只是观察提示", "作为买入或加仓条件", "作为减仓或退出条件", "还缺批次／数量／时间口径", "事后补记，不能代表原计划", "仍不确定", "其他"], tradeIds: confirmedInterpretations.flatMap((note) => note.targetType === "trade" ? [note.targetId] : []).filter(Boolean) });
  const uncertain = trades.filter((trade) => trade.decision?.certainty === "不确定" || trade.decision?.certainty === "有冲突" || /不确定|拿不准|犹豫|看不清/.test(String(trade.reason || "")));
  const uncertainNotes = allNotes.filter((note) => note.structured?.certainty === "不确定" || note.structured?.certainty === "有冲突" || /不确定|拿不准|犹豫|看不清/.test(String(note.text || "")));
  if (uncertain.length || uncertainNotes.length) questions.push({ id: "N-uncertainty", category: "指标理解与证据冲突", prompt: `你在 ${uncertain.length} 笔成交和 ${uncertainNotes.length} 条笔记中记录了不确定或有冲突。最需要弄清什么？`, options: ["J值怎么解释", "量价信号冲突", "前低是否有支撑", "仓位大小", "持有还是退出", "仍不清楚", "其他"], tradeIds: [...new Set([...uncertain.map((trade) => trade.id), ...uncertainNotes.filter((note) => note.targetType === "trade").map((note) => note.targetId)].filter(Boolean))], waveIds: [...new Set(uncertainNotes.map((note) => waves.find((wave) => wave.trades.some((trade) => trade.id === note.targetId) || note.targetType !== "trade" && note.index >= wave.startIndex && note.index <= wave.endIndex)?.id).filter(Boolean))] });
  const lowJ = trades.filter((trade) => trade.side === "buy" && trade.indicators?.j != null && Number.isFinite(Number(trade.indicators.j)) && Number(trade.indicators.j) < (trade.indicators.jBuyThreshold == null ? 10 : Number(trade.indicators.jBuyThreshold)));
  if (lowJ.length) questions.push({ id: "J1-low-buy", category: "买入及加仓依据", prompt: "有 " + lowJ.length + " 笔买入位于个人J低位观察区。你当时把低J值当作什么信息？", options: ["允许小仓试探", "与量价一起确认", "等待价格反应", "按预定分批计划", "记不清／不确定", "其他"], tradeIds: lowJ.map((trade) => trade.id) });
  const lowJFollowThrough = lowJ.filter((trade) => state.bars.slice(Number(trade.index) + 1, state.trainingEndIndex + 1).some((bar) => Number(bar.close) < Number(trade.price)));
  if (lowJFollowThrough.length) questions.push({ id: "J3-low-then-lower", category: "买入及加仓依据", prompt: `${lowJFollowThrough.length} 笔低J买入之后，价格曾继续低于成交价。回看后续加仓时，是按原定分批条件，还是出现了新的价格／量价依据？继续下跌不自动说明首次试探错误。`, options: ["按预定分批计划", "出现新确认后加仓", "主要因价格更低", "主要因J更低", "没有继续加仓", "当时没写清条件", "仍不确定"], tradeIds: lowJFollowThrough.map((trade) => trade.id), waveIds: [...new Set(lowJFollowThrough.map((trade) => waves.find((wave) => wave.trades.includes(trade))?.id).filter(Boolean))] });
  const highJ = trades.filter((trade) => trade.indicators?.j != null && Number.isFinite(Number(trade.indicators.j)) && Number(trade.indicators.j) >= (trade.indicators.jSellThreshold == null ? 75 : Number(trade.indicators.jSellThreshold)));
  if (highJ.length) questions.push({ id: "J2-high-review", category: "持有、减仓与退出", prompt: `${highJ.length} 笔操作时J值达到个人高位观察区。你当时把它当作减仓提示、持有背景，还是其他信息？J高位不要求自动卖出。`, options: ["按预定条件分批减仓", "结合量价与价格反应", "按批次退出条件处理", "继续持有并接受计划内回撤", "没有把J高位当卖出条件", "仍不确定", "其他"], tradeIds: highJ.map((trade) => trade.id), waveIds: [...new Set(highJ.map((trade) => waves.find((wave) => wave.trades.includes(trade))?.id).filter(Boolean))] });
  const adds = trades.filter((trade) => trade.side === "buy" && ["确认加仓", "预定分批买入"].includes(trade.decision?.intent || trade.lotRole));
  if (adds.length) questions.push({ id: "R2-add-method", category: "买入及加仓依据", prompt: "有 " + adds.length + " 笔加仓或分批买入。你当时等到了新确认，还是按事先安排执行？", options: ["出现新的确认", "按预定分批计划", "主要因价格更低", "主要因J更低", "两者都有", "仍不确定"], tradeIds: adds.map((trade) => trade.id) });
  const revisedPlans = (state.operationPlans || []).filter((plan) => Number(plan.revision) > 1);
  if (revisedPlans.length) questions.push({ id: "R5-plan-change", category: "计划变化与执行", prompt: `你在训练中修改过 ${revisedPlans.length} 次计划。修改当时出现了什么新信息？本题核对调整过程，不把新计划当成旧计划。`, options: ["出现了新的价格反应", "量价或J值提供新依据", "风险承受范围改变", "原计划写得不清楚", "主要因结果或情绪改变", "仍不确定", "其他"], tradeIds: trades.filter((trade) => revisedPlans.some((plan) => Number(plan.index) === Number(trade.index))).map((trade) => trade.id) });
  const invalidationWaves = waves.filter((wave) => wave.violations.some((item) => item.type === "收盘触及计划失效价，需复核持仓处理"));
  if (invalidationWaves.length) questions.push({ id: "R4-invalidation-review", category: "持有、减仓与退出", prompt: `有 ${invalidationWaves.length} 段触及你记录的复核价格。触发时你实际能做什么？是否有T+1、可卖批次或新依据影响处理？触发提示本身不等于操作错误。`, options: ["按原计划处理", "因T+1或可卖股数受限", "出现新依据后调整", "当时没有明确处理步骤", "无法核实", "仍不确定", "其他"], tradeIds: [...new Set(invalidationWaves.flatMap((wave) => wave.trades.map((trade) => trade.id)))], waveIds: invalidationWaves.map((wave) => wave.id) });
  const intradayCited = trades.filter((trade) => trade.decision?.signals?.includes("分时量") || /分时/.test(String(trade.reason || "")));
  const intradayUnavailable = intradayCited.filter((trade) => !state.intradayData?.[formatDate(state.bars[trade.index]?.date)]);
  if (intradayUnavailable.length) questions.push({ id: "I4-missing-intraday", category: "记录或数据不足", prompt: `${intradayUnavailable.length} 笔操作提到了分时量，但档案没有可用的对应分时数据。你当时主要观察了什么？缺失数据不能由事后回答替代。`, options: ["单个放量时段", "连续量价与价格反应", "关键位的收回或守住", "只记得成交量较大", "无法回忆", "其他"], tradeIds: intradayUnavailable.map((trade) => trade.id) });
  const markedOrCitedLevels = [...trades.filter((trade) => trade.decision?.signals?.includes("前低/关键位")).map((trade) => ({ index: trade.index, tradeId: trade.id })), ...allNotes.filter((note) => note.structured?.signals?.includes("前低/关键位") || note.text && /前低|关键位/.test(note.text)).map((note) => ({ index: note.index, tradeId: note.targetType === "trade" ? note.targetId : null }))];
  const levelNeedsClarification = markedOrCitedLevels.filter((item) => !(state.manualKeyLevels || []).some((level) => Number(level.index) === Number(item.index)));
  if (levelNeedsClarification.length) questions.push({ id: "key-level-needs-user-mark", category: "指标理解与证据冲突", prompt: `${levelNeedsClarification.length} 处记录提到前低或关键位，但图上没有对应的本人标记。系统不会替你挑选前低；你可以先定位K线标价，或说明当时没有明确价位。`, options: ["我会补标关键价位", "当时没有明确价位", "依据的是一个区间", "笔记提到但未用于决策", "无法回忆"], tradeIds: levelNeedsClarification.map((item) => item.tradeId).filter(Boolean) });
  const cashNotes = allNotes.filter((note) => /空仓|等待/.test(String(note.text || "")) && !trades.some((trade) => trade.index === Number(note.index)));
  if (cashNotes.length && !questions.some((question) => question.id === "N3-cash-wait")) questions.push({ id: "N3-cash-note", category: "持有、减仓与退出", prompt: `有 ${cashNotes.length} 条空仓／等待笔记。你当时的等待条件是否明确？如果后来行情接近该条件，是否重新评估过？`, options: ["按预定条件继续等待", "行情接近后重新评估", "没有明确条件", "那只是当时观察，不是计划", "仍不确定", "其他"], tradeIds: [] });
  const soldRise = trades.filter((trade) => trade.side === "sell" && waves.some((wave, index) => wave.trades.includes(trade) && waves[index + 1] && waves[index + 1].endPrice > trade.price));
  if (soldRise.length) questions.push({ id: "N5-sold-rise", category: "持有、减仓与退出", prompt: "卖出之后的波段仍有上涨。你更想回看卖出时的哪项取舍？", options: ["当时条件是否触发", "减仓数量是否合适", "是否愿意承担后续回撤", "原计划没有明确条件", "不把后续上涨当作卖错", "其他"], tradeIds: soldRise.map((trade) => trade.id) });
  const untradedRisingWaves = waves.filter((wave) => !wave.trades.length && !wave.startQty && !wave.endQty && wave.priceChange > 0);
  if (untradedRisingWaves.length) questions.push({ id: "N3-cash-wait", category: "持有、减仓与退出", prompt: `有 ${untradedRisingWaves.length} 个上涨波段处于空仓。你当时有等待条件吗？后来是否重新检查过风险与进场理由？错过上涨本身不代表做错。`, options: ["按计划继续等待", "条件满足后未重评", "当时没有明确条件", "仍不确定", "其他"], tradeIds: [], waveIds: untradedRisingWaves.map((wave) => wave.id) });
  if (waves.some((wave) => wave.netChange < 0 || wave.maxDrawdown >= 5)) questions.push({ id: "N6-risk", category: "仓位与批次管理", prompt: "重点波段出现净值下降或较大回撤。你当时愿意承担的回撤范围是什么？哪些新证据影响了持有或加仓？", options: ["事前有明确风险范围", "有范围但后来调整", "当时没想清楚", "主要依据J和前低", "仍不确定", "其他"], tradeIds: trades.map((trade) => trade.id) });
  return questions.map((question) => ({ ...question, answered: (state.reviewQuestionnaire?.answers || []).some((answer) => answer.questionId === question.id) }));
}

function renderReviewCoach() {
  const questions = buildReviewQuestions();
  if (!questions.length) {
    state.reviewQuestionnaire.currentQuestionId = null;
    $("reviewQuestionProgress").textContent = "目前没有由记录触发的追问；你仍可补充整局结论。";
    $("reviewQuestionCard").innerHTML = "";
    $("reviewQuestionOptions").innerHTML = "";
  } else {
    const savedQuestionIndex = questions.findIndex((question) => question.id === state.reviewQuestionnaire?.currentQuestionId);
    if (savedQuestionIndex >= 0) reviewQuestionIndex = savedQuestionIndex;
    else reviewQuestionIndex = Math.min(reviewQuestionIndex, questions.length - 1);
    const question = questions[reviewQuestionIndex];
    state.reviewQuestionnaire.currentQuestionId = question.id;
    const answer = [...(state.reviewQuestionnaire?.answers || [])].reverse().find((item) => item.questionId === question.id);
    const linkedWaves = (question.waveIds || []).map((id) => operationReviewData().findIndex((wave) => wave.id === id) + 1).filter((number) => number > 0);
    $("reviewQuestionProgress").textContent = "问题 " + (reviewQuestionIndex + 1) + " / " + questions.length + " · " + question.category + (question.answered ? " · 已回答，可修改" : "");
    $("reviewQuestionCard").innerHTML = '<article class="review-question-card"><strong>' + escapeHtml(question.prompt) + '</strong><small>关联成交：' + (question.tradeIds.length ? question.tradeIds.length + "笔；" : "空仓区间；") + (linkedWaves.length ? "相关波段：" + linkedWaves.join("、") + "；" : "") + "回答不会改写原始笔记。</small></article>";
    $("reviewQuestionOptions").innerHTML = question.options.map((option) => '<button type="button" class="secondary-button ' + (answer?.choice === option ? "is-selected" : "") + '" data-review-answer-option="' + escapeHtml(option) + '">' + escapeHtml(option) + "</button>").join("");
    $("reviewQuestionText").value = answer?.text || "";
  }
  $("reviewQuestionPrevious").disabled = reviewQuestionIndex <= 0;
  $("reviewQuestionSkip").disabled = !questions.length;
  $("reviewQuestionSave").disabled = !questions.length;
  $("reviewConclusionList").innerHTML = (state.reviewConclusions || []).map((item) => '<article class="review-question-card"><small>' + escapeHtml(new Date(item.createdAt).toLocaleString()) + '</small><p>' + escapeHtml(item.text) + "</p></article>").join("") || '<p class="trade-hint">尚未保存整局结论。</p>';
  $("reviewChecklist").innerHTML = state.nextSessionChecklist?.length ? "<h5>下局检查项</h5><ul>" + state.nextSessionChecklist.map((item) => "<li>" + escapeHtml(item.text) + "</li>").join("") + "</ul>" : "";
  renderTeachingComparisonForm();
  renderTeachingComparisonResults();
}

function saveReviewQuestion(choice) {
  const question = buildReviewQuestions()[reviewQuestionIndex];
  if (!question) return;
  const text = String($("reviewQuestionText").value || "").trim();
  if (!choice && !text) return;
  state.reviewQuestionnaire.answers.push({ id: makeLocalId(), questionId: question.id, choice: choice || "", text, tradeIds: question.tradeIds, answeredAt: new Date().toISOString() });
  state.reviewQuestionnaire.skipped = (state.reviewQuestionnaire.skipped || []).filter((id) => id !== question.id);
  const nextQuestions = buildReviewQuestions();
  reviewQuestionIndex = Math.min(reviewQuestionIndex + 1, nextQuestions.length - 1);
  state.reviewQuestionnaire.currentQuestionId = nextQuestions[reviewQuestionIndex]?.id || null;
  renderReviewCoach();
  persistCurrentReviewArchive();
}

function skipReviewQuestion() {
  const question = buildReviewQuestions()[reviewQuestionIndex];
  if (!question) return;
  state.reviewQuestionnaire.skipped = [...new Set([...(state.reviewQuestionnaire.skipped || []), question.id])];
  const nextQuestions = buildReviewQuestions();
  reviewQuestionIndex = Math.min(reviewQuestionIndex + 1, nextQuestions.length - 1);
  state.reviewQuestionnaire.currentQuestionId = nextQuestions[reviewQuestionIndex]?.id || null;
  renderReviewCoach();
  persistCurrentReviewArchive();
}

function moveReviewQuestionTo(index) {
  const questions = buildReviewQuestions();
  if (!questions.length) return;
  reviewQuestionIndex = Math.max(0, Math.min(Number(index) || 0, questions.length - 1));
  state.reviewQuestionnaire.currentQuestionId = questions[reviewQuestionIndex].id;
  renderReviewCoach();
  persistCurrentReviewArchive();
}

function saveReviewConclusion() {
  const text = String($("reviewConclusionInput").value || "").trim();
  if (!text) return;
  state.reviewConclusions.push({ id: makeLocalId(), text, createdAt: new Date().toISOString(), kind: "retrospective" });
  $("reviewConclusionInput").value = "";
  renderReviewCoach();
  persistCurrentReviewArchive();
}

function renderTeachingComparisonForm() {
  const select = $("comparisonTradeSelect");
  if (!select) return;
  const previous = select.value;
  const sales = state.trades.filter((trade) => trade.side === "sell");
  select.innerHTML = '<option value="">选择一笔卖出成交</option>' + sales.flatMap((trade) => (trade.allocations || []).map((allocation) => {
    const date = formatDate(state.bars[trade.index]?.date);
    return '<option value="' + escapeHtml(trade.id + "|" + allocation.lotId) + '">' + escapeHtml(date) + " · 批次扣减 " + Number(allocation.qty).toLocaleString() + "股</option>";
  })).join("");
  if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
}

function renderTeachingComparisonResults() {
  const target = $("teachingComparisonResults");
  if (!target) return;
  target.innerHTML = (state.teachingComparisons || []).map((item) => {
    const hasCostBasis = item.entryCost != null;
    const amount = (value) => hasCostBasis ? formatMoney(value) : "无法核实";
    const variance = (value) => hasCostBasis ? formatMoney(value - item.immediatePnl) : "无法核实";
    return `<article class="review-comparison-item"><strong>事后教学对照 · 观察至 ${escapeHtml(item.endpointDate)}</strong><p>批次买入成本（含分摊买入费）${amount(item.entryCost)}；条件：收盘${item.direction === "below" ? "≤" : "≥"} ¥${formatPrice(Number(item.trigger))} 时减持 ${Number(item.reduceQty).toLocaleString()} 股；观察 ${Number(item.observationBars)} 根K线。该条件是事后输入，只用于教学，不代表原计划。</p><div class="review-comparison-result"><div><span>实际卖出净盈亏</span><strong>${amount(item.immediatePnl)}</strong></div><div><span>继续持有至终点净盈亏</span><strong>${amount(item.holdPnl)}</strong><small>相对实际 ${variance(item.holdPnl)}</small></div><div><span>条件减仓后净盈亏</span><strong>${amount(item.stagedPnl)}</strong><small>相对实际 ${variance(item.stagedPnl)}</small></div></div><p>收盘口径最大回撤 ${Number(item.maxDrawdown).toFixed(2)}%；实际卖出费 ${formatMoney(item.actualFee)}，条件持有预计卖出费 ${formatMoney(item.holdFee)}，分批方案预计卖出费 ${formatMoney(item.stagedFee)}。收盘回撤不代表盘中最大风险；未触发用户条件时，不会另选卖点。</p></article>`;
  }).join("");
}

function runTeachingComparison() {
  const parts = String($("comparisonTradeSelect").value || "").split("|");
  const sale = state.trades.find((trade) => trade.id === parts[0] && trade.side === "sell");
  const allocation = sale?.allocations?.find((item) => item.lotId === parts[1]);
  const buyTrade = allocation ? state.trades.find((trade) => trade.side === "buy" && (trade.lotId || trade.id) === allocation.lotId) : null;
  const waves = operationReviewData();
  const waveIndex = sale ? waves.findIndex((wave) => wave.trades.includes(sale)) : -1;
  const endpoint = waveIndex >= 0 ? waves[waveIndex + 1] : null;
  const trigger = Number($("comparisonTriggerPrice").value);
  if (!sale || !allocation || !buyTrade || Number(buyTrade.qty) <= 0 || !endpoint || !Number.isFinite(trigger) || trigger <= 0) {
    $("teachingComparisonResults").innerHTML = '<p class="review-question-card">请选择有批次记录的卖出、填写你自己的触发价，并确认该成交之后有完整的下一波段观察区间。</p>';
    return;
  }
  const qty = Math.floor(Number(allocation.qty) / 100) * 100;
  const fraction = Number($("comparisonReduceFraction").value);
  const reduceQty = Math.floor(qty * fraction / 100) * 100;
  const direction = $("comparisonDirection").value;
  let triggerIndex = null;
  let peak = qty * sale.price;
  let maxDrawdown = 0;
  for (let index = sale.index + 1; index <= endpoint.endIndex; index += 1) {
    const close = Number(state.bars[index]?.close);
    if (!(close > 0)) continue;
    if (triggerIndex == null && (direction === "below" ? close <= trigger : close >= trigger)) triggerIndex = index;
    const soldQty = triggerIndex == null ? 0 : reduceQty;
    const retainedQty = qty - soldQty;
    const saleCash = soldQty * (triggerIndex == null ? sale.price : Number(state.bars[triggerIndex].close));
    const marked = saleCash + retainedQty * close;
    peak = Math.max(peak, marked);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - marked) / peak);
  }
  const endPrice = Number(state.bars[endpoint.endIndex]?.close);
  const actualFee = Number(allocation.fee) || 0;
  const immediateNet = qty * sale.price - actualFee;
  const entryCost = qty * Number(buyTrade.price) + (Number(buyTrade.fee) || 0) * qty / Number(buyTrade.qty);
  const holdGross = qty * endPrice;
  const holdFee = transactionFees("sell", holdGross).total;
  const holdNet = holdGross - holdFee;
  let stagedNet;
  let stagedFee;
  if (triggerIndex == null) stagedNet = holdNet;
  else {
    const soldGross = reduceQty * Number(state.bars[triggerIndex].close);
    const remainingGross = (qty - reduceQty) * endPrice;
    const firstFee = soldGross ? transactionFees("sell", soldGross).total : 0;
    const finalFee = remainingGross ? transactionFees("sell", remainingGross).total : 0;
    stagedFee = firstFee + finalFee;
    stagedNet = soldGross - firstFee + remainingGross - finalFee;
  }
  if (triggerIndex == null) stagedFee = holdFee;
  state.teachingComparisons.push({
    id: makeLocalId(), label: "事后教学对照", saleTradeId: sale.id, lotId: allocation.lotId, qty, trigger, direction, reduceQty,
    triggerIndex, endpointIndex: endpoint.endIndex, endpointDate: formatDate(state.bars[endpoint.endIndex]?.date), observationBars: endpoint.endIndex - sale.index,
    entryCost, actualFee, holdFee, stagedFee, immediateNet, holdNet, stagedNet,
    immediatePnl: immediateNet - entryCost, holdPnl: holdNet - entryCost, stagedPnl: stagedNet - entryCost,
    maxDrawdown: maxDrawdown * 100, createdAt: new Date().toISOString(), policySource: "user-entered-retrospective-teaching",
  });
  renderTeachingComparisonResults();
  persistCurrentReviewArchive();
}

function enterReviewWorkspace() {
  const grid = document.querySelector(".workspace-grid");
  if (grid && !reviewWorkspaceOrigin) {
    const marker = document.createComment("training-workspace-position");
    grid.parentNode.insertBefore(marker, grid);
    reviewWorkspaceOrigin = { parent: grid.parentNode, marker };
    $("reviewWorkspaceBody").appendChild(grid);
  }
  $("reviewArchiveList").hidden = true;
  $("reviewWorkspace").hidden = false;
  document.body.classList.add("archive-review-mode");
  $("reviewWorkspaceTitle").textContent = state.symbol + " · " + (state.code || "本地样本");
  $("reviewWorkspaceMeta").textContent = "训练于 " + new Date(state.reviewArchivedAt || Date.now()).toLocaleString() + " · 规则版本 " + (state.archivedReviewRules?.version || state.finishedRuleSnapshot?.version || "旧版记录");
  renderReviewCoach();
  renderOperationReview();
}

function leaveReviewWorkspace() {
  const grid = $("reviewWorkspaceBody")?.querySelector(".workspace-grid");
  if (grid && reviewWorkspaceOrigin?.marker?.parentNode) {
    reviewWorkspaceOrigin.parent.insertBefore(grid, reviewWorkspaceOrigin.marker);
    reviewWorkspaceOrigin.marker.remove();
  }
  reviewWorkspaceOrigin = null;
  $("reviewWorkspace").hidden = true;
  $("reviewArchiveList").hidden = false;
  document.body.classList.remove("archive-review-mode");
}

async function openArchivedReview(reviewId) {
  try {
    const response = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}`, { cache: "no-store" });
    let payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "读取档案失败");
    const cached = readUnsyncedReview();
    if (cached?.review?.id === reviewId) {
      payload = cached.review;
      $("retryReviewSaveButton").hidden = false;
      $("reviewArchiveStatus").textContent = "当前打开的是浏览器保留的未同步版本；可重试保存或导出。";
    }
    $("barNoteModal").hidden = true;
    $("intradayVolumeModal").hidden = true;
    if (!reviewReturnSnapshot) reviewReturnSnapshot = structuredClone(state);
    state.bars = (payload.bars || []).map((bar) => ({ ...bar, date: new Date(`${String(bar.date).slice(0, 10)}T00:00:00`) }));
    state.indicatorWarmupBars = (payload.indicatorWarmupBars || []).map((bar) => ({ ...bar, date: new Date(`${String(bar.date).slice(0, 10)}T00:00:00`) }));
    state.symbol = payload.symbol || "已归档训练"; state.code = resolvedSampleCode(payload); state.dataSource = payload.dataSource || "archived";
    state.dataMeta = payload.dataMeta || { period: "daily", adjust: "qfq" };
    state.trainingStartIndex = Number(payload.trainingStartIndex) || 0;
    state.trainingEndIndex = Math.min(state.bars.length - 1, Number(payload.trainingEndIndex) || state.bars.length - 1);
    state.currentIndex = state.trainingEndIndex; state.cash = Number(payload.cash) || initialCash;
    state.lots = payload.lots || []; state.trades = payload.trades || []; migrateTradeLotLedger(state.trades, state.lots);
    state.barNotes = payload.barNotes || []; state.reviewNotes = payload.reviewNotes || []; state.reviewId = payload.id; state.reviewArchivedAt = payload.archivedAt;
    state.archivedReviewRules = payload.reviewRulesSnapshot || payload.trades?.find((trade) => trade.reviewRuleSnapshot)?.reviewRuleSnapshot || null;
    state.finishedRuleSnapshot = state.archivedReviewRules;
    state.operationPlans = payload.operationPlans || []; state.nextSessionChecklist = payload.nextSessionChecklist || [];
    state.reviewSuggestionSelections = payload.reviewSuggestionSelections || []; state.avgCost = Number(payload.avgCost) || 0;
    state.reviewQuestionnaire = payload.reviewQuestionnaire && typeof payload.reviewQuestionnaire === "object" ? payload.reviewQuestionnaire : { answers: [], skipped: [] };
    state.reviewConclusions = Array.isArray(payload.reviewConclusions) ? payload.reviewConclusions : [];
    state.teachingComparisons = Array.isArray(payload.teachingComparisons) ? payload.teachingComparisons : [];
    state.manualKeyLevels = Array.isArray(payload.manualKeyLevels) ? payload.manualKeyLevels : [];
    state.chartMarks = Array.isArray(payload.chartMarks) ? payload.chartMarks : []; state.chartMarkHistory = Array.isArray(payload.chartMarkHistory) ? payload.chartMarkHistory : []; state.chartMarkActions = Array.isArray(payload.chartMarkActions) ? payload.chartMarkActions : [];
    state.finished = true; state.archiveView = true; state.waveOverview = true; state.focusedWaveId = null; state.focusedTradeIndex = null;
    reviewQuestionIndex = 0;
    state.showRuleComparison = false;
    state.mode = payload.mode || "naked"; state.indicator = payload.indicator || "both"; state.showChip = payload.showChip !== false;
    state.showIdentity = true; state.tradingRule = payload.tradingRule || "a-share"; state.activeTrainingSample = payload.activeTrainingSample || null;
    state.trainingArea = payload.trainingArea === "pattern" ? "pattern" : "indicator"; state.intradayData = payload.intradayData || payload.activeTrainingSample?.intradayByDate || {};
    state.chartBars = Math.min(maxChartBars, Math.max(defaultChartBars, trainingLength())); state.chartZoomExplicit = false; state.chartOffset = 0;
    $("modeSelect").value = state.mode; $("indicatorSelect").value = state.indicator; $("tradingRuleSelect").value = state.tradingRule; $("trainingAreaSelect").value = state.trainingArea;
    $("identityToggle").checked = true; $("chipToggle").checked = state.showChip;
    $("archiveViewLabel").textContent = `复盘档案：${state.symbol} · ${new Date(payload.archivedAt).toLocaleString()}`;
    $("archiveViewBanner").hidden = false;
    renderUser(); render();
    enterReviewWorkspace();
    requestAnimationFrame(() => { render(); drawChart(); });
    $("myReviewsPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    $("reviewArchiveStatus").textContent = `打开复盘失败：${error.message}`;
  }
}

function returnFromArchivedReview() {
  if (!reviewReturnSnapshot) return;
  // When returning to the very same finished session, keep its newly saved
  // retrospective work. A different live training session stays untouched.
  if (reviewReturnSnapshot.finished && reviewReturnSnapshot.reviewId === state.reviewId) {
    ["reviewQuestionnaire", "reviewConclusions", "teachingComparisons", "reviewNotes", "manualKeyLevels", "nextSessionChecklist", "reviewSuggestionSelections"].forEach((field) => {
      reviewReturnSnapshot[field] = structuredClone(state[field]);
    });
  }
  leaveReviewWorkspace();
  Object.assign(state, reviewReturnSnapshot);
  reviewReturnSnapshot = null;
  $("archiveViewBanner").hidden = true;
  $("modeSelect").value = state.mode; $("indicatorSelect").value = state.indicator; $("tradingRuleSelect").value = state.tradingRule; $("trainingAreaSelect").value = state.trainingArea;
  $("identityToggle").checked = state.showIdentity; $("chipToggle").checked = state.showChip;
  renderUser(); render(); saveDraftSession();
  $("myReviewsPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function exportReviewArchives() {
  const listResponse = await fetch("/api/reviews", { cache: "no-store" });
  const list = await listResponse.json();
  if (!listResponse.ok) throw new Error(list.error || "读取档案列表失败");
  const reviews = await Promise.all((list.reviews || []).map(async (item) => {
    const response = await fetch(`/api/reviews/${encodeURIComponent(item.id)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `读取${item.symbol}失败`);
    return payload;
  }));
  downloadJson(`kline-my-reviews-${new Date().toISOString().slice(0, 10)}.json`, { format: "kline-training-reviews", version: 2, exportedAt: new Date().toISOString(), reviews });
}

async function importReviewArchives(file) {
  try {
    const backup = JSON.parse(await file.text());
    const response = await fetch("/api/reviews/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(backup) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "恢复失败");
    $("reviewArchiveStatus").textContent = `已恢复 ${Number(result.imported) || 0} 份复盘档案。`;
    await loadReviewArchiveList();
  } catch (error) {
    $("reviewArchiveStatus").textContent = `复盘档案恢复失败：${error.message}`;
  }
}

function drawChart() {
  const canvas = $("chartCanvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const parentRect = canvas.parentElement?.getBoundingClientRect();
  const width = Math.floor(rect.width || parentRect?.width || 0);
  const height = Math.floor(rect.height || parentRect?.height || 0);
  // 隐藏标签页或尚未完成布局时不重绘，避免 0 尺寸导致无限 requestAnimationFrame。
  if (width < 20 || height < 20) return;
  canvas.width = Math.max(1, Math.floor(width * ratio));
  canvas.height = Math.max(1, Math.floor(height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = "#0a1423"; ctx.fillRect(0, 0, width, height);
  const chartStartIndex = Math.max(0, state.trainingStartIndex - contextBarCount);
  const bars = state.bars.slice(chartStartIndex, state.currentIndex + 1);
  if (!bars.length) {
    ctx.fillStyle = "#71859f"; ctx.font = "13px Inter, sans-serif"; ctx.fillText("暂无可显示的 K 线", 24, 34);
    return;
  }
  $("waveAnnotationControl").hidden = !state.finished;
  $("waveAnnotationToggle").checked = state.showWaveAnnotations;
  $("allWavesButton").hidden = !state.finished || state.waveOverview;
  if (state.chartLastWidth && Math.abs(width - state.chartLastWidth) > 80) state.chartZoomExplicit = false;
  state.chartLastWidth = width;
  const requestedBars = Number.isFinite(Number(state.chartBars)) ? Math.round(Number(state.chartBars)) : defaultChartBars;
  const left = 48, right = 14, top = 22, bottom = 28;
  const chipWidth = state.showChip ? Math.min(132, Math.max(88, width * 0.17)) : 0;
  const chartRight = Math.max(left + 80, width - right);
  const plotRight = state.showChip ? Math.max(left + 80, chartRight - chipWidth - 8) : chartRight;
  const chartWidth = Math.max(80, plotRight - left);
  const readableBarLimit = width < 760 && !state.chartZoomExplicit && !(state.finished && state.waveOverview)
    ? Math.max(minChartBars, Math.floor(chartWidth / 6.5))
    : maxChartBars;
  const visibleCount = Math.max(1, Math.min(Math.max(minChartBars, requestedBars), readableBarLimit, bars.length));
  state.renderedChartBars = visibleCount;
  const maxOffset = Math.max(0, bars.length - visibleCount);
  state.chartOffset = Math.max(0, Math.min(Number(state.chartOffset) || 0, maxOffset));
  const start = Math.max(0, bars.length - visibleCount - state.chartOffset);
  const visible = bars.slice(start, start + visibleCount);
  const indicators = indicatorData();
  const firstGlobalIndex = chartStartIndex + start;
  const step = chartWidth / visible.length;
  // 当 K 线过密时保留相同画布尺寸，改用收盘价走势线，避免柱子挤成一条黑线。
  const lineOnly = step < 4.5 || visible.length >= 180;
  $("zoomLabel").textContent = `${visible.length} 根${lineOnly ? " · 走势线" : ""}${state.chartOffset ? ` · 向前 ${state.chartOffset} 根` : ""}`;
  const activeZoomLevel = state.chartZoomExplicit ? requestedBars : visibleCount;
  $("zoomInButton").disabled = activeZoomLevel <= minChartBars;
  $("zoomOutButton").disabled = activeZoomLevel >= maxChartBars;
  const indicatorHeight = state.indicator === "none" ? 0 : state.indicator === "both" ? 170 : 94;
  const volumeHeight = 72;
  const priceBottom = Math.max(top + 100, height - bottom - volumeHeight - indicatorHeight - 14);
  const showWaveAnnotations = state.finished && state.showWaveAnnotations;
  const priceTop = top + (showWaveAnnotations ? 22 : 0);
  const high = Math.max(...visible.map((bar) => bar.high));
  const low = Math.min(...visible.map((bar) => bar.low));
  const range = Math.max(high - low, 0.01);
  const candleWidth = Math.max(2, Math.min(11, step * .58));
  const yPrice = (value) => priceTop + ((high - value) / range) * (priceBottom - priceTop);
  const xBar = (index) => left + step * index + step / 2;
  window.__chartDrawLayout = { left, plotRight, priceTop, priceBottom, volumeTop: priceBottom + 20, volumeBottom: priceBottom + volumeHeight, indicatorTop: priceBottom + volumeHeight + 8, indicatorHeight: indicatorHeight - 8, chartStartIndex, firstGlobalIndex, start, visibleCount: visible.length, step, high, low, maxVolume: Math.max(...visible.map(b => b.volume), ...indicators.volumeMa120.slice(firstGlobalIndex,firstGlobalIndex+visible.length).filter(Number.isFinite), ...indicators.volumeMa250.slice(firstGlobalIndex,firstGlobalIndex+visible.length).filter(Number.isFinite), 1), visible, yPrice };
  const gridColor = "rgba(151, 178, 212, .12)";
  ctx.font = "10px Inter, sans-serif"; ctx.lineWidth = 1;
  for (let line = 0; line < 5; line += 1) {
    const y = priceTop + ((priceBottom - priceTop) / 4) * line;
    ctx.strokeStyle = gridColor; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(plotRight, y); ctx.stroke();
    ctx.fillStyle = "#71859f"; ctx.fillText((high - (range / 4) * line).toFixed(2), 6, y + 3);
  }
  if (showWaveAnnotations) {
    const waves = operationReviewData();
    ctx.save();
    ctx.beginPath(); ctx.rect(left, priceTop, chartWidth, priceBottom - priceTop); ctx.clip();
    waves.forEach((wave, waveIndex) => {
      const from = Math.max(wave.startIndex, firstGlobalIndex);
      const to = Math.min(wave.endIndex, firstGlobalIndex + visible.length - 1);
      if (to < from) return;
      const x1 = Math.max(left, xBar(from - firstGlobalIndex) - step / 2);
      const x2 = Math.min(plotRight, xBar(to - firstGlobalIndex) + step / 2);
      const focused = wave.id === state.focusedWaveId;
      ctx.fillStyle = focused ? "rgba(125,168,255,.105)" : waveIndex % 2 ? "rgba(101,215,177,.035)" : "rgba(125,168,255,.045)";
      ctx.fillRect(x1, priceTop, Math.max(0, x2 - x1), priceBottom - priceTop);
      if (wave.startIndex >= firstGlobalIndex && wave.startIndex <= firstGlobalIndex + visible.length - 1) {
        const boundaryX = xBar(wave.startIndex - firstGlobalIndex) - step / 2;
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = focused ? "rgba(169,197,255,.8)" : "rgba(125,168,255,.42)";
        ctx.lineWidth = focused ? 1.5 : 1;
        ctx.beginPath(); ctx.moveTo(boundaryX, priceTop); ctx.lineTo(boundaryX, priceBottom); ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    ctx.restore();
    const waveLabelBoxes = [];
    waves.forEach((wave, waveIndex) => {
      const from = Math.max(wave.startIndex, firstGlobalIndex);
      const to = Math.min(wave.endIndex, firstGlobalIndex + visible.length - 1);
      if (to < from) return;
      const x1 = Math.max(left, xBar(from - firstGlobalIndex) - step / 2);
      const x2 = Math.min(plotRight, xBar(to - firstGlobalIndex) + step / 2);
      const label = `波段${waveIndex + 1}`;
      ctx.font = "bold 10px 'Microsoft YaHei', sans-serif";
      const labelWidth = ctx.measureText(label).width + 12;
      if (x2 - x1 < labelWidth + 4) return;
      let labelX = Math.max(x1 + 2, Math.min(x2 - labelWidth - 2, (x1 + x2 - labelWidth) / 2));
      if (waveLabelBoxes.some((box) => labelX < box.right + 3 && labelX + labelWidth > box.left - 3)) return;
      waveLabelBoxes.push({ left: labelX, right: labelX + labelWidth });
      const focused = wave.id === state.focusedWaveId;
      ctx.fillStyle = focused ? "rgba(66,111,190,.9)" : "rgba(21,36,58,.9)";
      ctx.fillRect(labelX, top + 3, labelWidth, 15);
      ctx.strokeStyle = focused ? "rgba(169,197,255,.68)" : "rgba(125,168,255,.2)";
      ctx.strokeRect(labelX + .5, top + 3.5, labelWidth - 1, 14);
      ctx.fillStyle = "#dce8ff";
      ctx.textAlign = "center";
      ctx.fillText(label, labelX + labelWidth / 2, top + 14);
      ctx.textAlign = "left";
    });
  }
  if (lineOnly) {
    drawIndexedLine(ctx, visible.length, (index) => visible[index].close, "#dce8ff", yPrice, xBar, 1.8);
  } else {
    visible.forEach((bar, index) => {
      const x = xBar(index); const up = bar.close >= bar.open; const color = up ? "#ff7787" : "#65d7b1";
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yPrice(bar.high)); ctx.lineTo(x, yPrice(bar.low)); ctx.stroke();
      const bodyTop = yPrice(Math.max(bar.open, bar.close)); const bodyBottom = yPrice(Math.min(bar.open, bar.close));
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, Math.max(1, bodyBottom - bodyTop));
    });
  }
  drawIndexedLine(ctx, visible.length, (index) => indicators.ma5[firstGlobalIndex + index], "#f4c95d", yPrice, xBar);
  drawIndexedLine(ctx, visible.length, (index) => indicators.ma20[firstGlobalIndex + index], "#7da8ff", yPrice, xBar);
  drawIndexedLine(ctx, visible.length, (index) => indicators.ma60[firstGlobalIndex + index], "#d18cff", yPrice, xBar);
  if (state.showChip && chartRight - (plotRight + 7) > 20) drawChipProfile(ctx, chipDistribution(visible, currentBar().close), plotRight + 7, chartRight, priceTop, priceBottom, yPrice, currentBar().close);
  const keyLevels = state.manualKeyLevels || [];
  const supersededLevels = new Set(keyLevels.map((level) => level.supersedes).filter(Boolean));
  keyLevels.filter((level) => !supersededLevels.has(level.id) && level.status !== "withdrawn" && Number(level.index) <= state.currentIndex && Number(level.upper ?? level.price) >= low && Number(level.lower ?? level.price) <= high).forEach((level) => {
    const upper = Number(level.upper ?? level.price);
    const lower = Number(level.lower ?? level.price);
    const y = yPrice(Number(level.price));
    ctx.save();
    if (upper > lower) {
      const topY = Math.max(priceTop, yPrice(upper));
      const bottomY = Math.min(priceBottom, yPrice(lower));
      ctx.fillStyle = "rgba(244,201,93,.08)";
      ctx.fillRect(left, topY, plotRight - left, Math.max(1, bottomY - topY));
      ctx.strokeStyle = "rgba(244,201,93,.42)";
      ctx.beginPath(); ctx.moveTo(left, topY); ctx.lineTo(plotRight, topY); ctx.moveTo(left, bottomY); ctx.lineTo(plotRight, bottomY); ctx.stroke();
    }
    ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(244,201,93,.78)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(plotRight, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "rgba(10,20,35,.86)"; ctx.fillRect(left + 3, y - 13, 98, 12);
    ctx.fillStyle = "#f4c95d"; ctx.font = "9px Inter, sans-serif";
    const labelY = Math.max(priceTop + 12, Math.min(priceBottom - 2, y - 4));
    ctx.fillText("自标价 " + (upper > lower ? formatPrice(lower) + "–" + formatPrice(upper) : formatPrice(Number(level.price))) + (level.retrospective ? " · 补标" : ""), left + 6, labelY);
    ctx.restore();
  });
  const trainingBoundary = state.trainingStartIndex - firstGlobalIndex;
  if (trainingBoundary > 0 && trainingBoundary < visible.length) {
    const boundaryX = xBar(trainingBoundary - 0.5);
    ctx.save();
    ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(244,201,93,.85)"; ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.moveTo(boundaryX, priceTop); ctx.lineTo(boundaryX, height - bottom); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#f4c95d"; ctx.font = "bold 10px Inter, sans-serif"; ctx.fillText("训练开始", Math.min(boundaryX + 5, plotRight - 48), priceTop + 13);
    ctx.restore();
  }
  const volumeMa120 = visible.map((_, index) => indicators.volumeMa120[firstGlobalIndex + index]);
  const volumeMa250 = visible.map((_, index) => indicators.volumeMa250[firstGlobalIndex + index]);
  const maxVolume = Math.max(...visible.map((bar) => bar.volume), ...volumeMa120.filter(Number.isFinite), ...volumeMa250.filter(Number.isFinite));
  const volumeTop = priceBottom + 20;
  const volumeBottom = priceBottom + volumeHeight;
  const yVolume = (value) => volumeBottom - (value / Math.max(maxVolume, 1)) * (volumeBottom - volumeTop);
  visible.forEach((bar, index) => {
    const x = xBar(index); const y = yVolume(bar.volume);
    ctx.fillStyle = bar.close >= bar.open ? "rgba(255,119,135,.48)" : "rgba(101,215,177,.48)";
    ctx.fillRect(x - candleWidth / 2, y, candleWidth, volumeBottom - y);
  });
  drawIndexedLine(ctx, visible.length, (index) => volumeMa120[index], "#f4c95d", yVolume, xBar, 1.25);
  drawIndexedLine(ctx, visible.length, (index) => volumeMa250[index], "#7da8ff", yVolume, xBar, 1.25);
  drawTextSegments(ctx, 8, priceBottom + 22, [
    { text: `VOL ${formatVolume(currentBar().volume)}`, color: "#aebfd4" },
    { text: `MA120 ${formatVolume(volumeMa120[volumeMa120.length - 1])}`, color: "#f4c95d" },
    { text: `MA250 ${formatVolume(volumeMa250[volumeMa250.length - 1])}`, color: "#7da8ff" },
  ]);
  if (state.indicator !== "none" && indicatorHeight > 20) drawSubIndicators(ctx, visible.length, firstGlobalIndex, priceBottom + volumeHeight + 8, indicatorHeight - 8, xBar, left, plotRight, indicators);
  const sameBarTradeRows = new Map();
  const placedTradeLabels = [];
  state.trades.forEach((item, tradeIndex) => {
    if (item.index < firstGlobalIndex || item.index >= firstGlobalIndex + visible.length || item.index > state.currentIndex) return;
    const localIndex = item.index - firstGlobalIndex;
    const focusedTrade = tradeIndex === state.focusedTradeIndex;
    const rowKey = `${item.index}|${item.side}`;
    const row = sameBarTradeRows.get(rowKey) || 0;
    sameBarTradeRows.set(rowKey, row + 1);
    const x = xBar(localIndex);
    const y = item.side === "buy" ? yPrice(visible[localIndex].low) + 11 : yPrice(visible[localIndex].high) - 11;
    ctx.fillStyle = item.side === "buy" ? "#ff7787" : "#65d7b1"; ctx.beginPath();
    if (item.side === "buy") { ctx.moveTo(x, y - 7); ctx.lineTo(x - 5, y + 3); ctx.lineTo(x + 5, y + 3); }
    else { ctx.moveTo(x, y + 7); ctx.lineTo(x - 5, y - 3); ctx.lineTo(x + 5, y - 3); }
    ctx.closePath(); ctx.fill();
    if (focusedTrade) {
      ctx.strokeStyle = "#f4c95d"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    }
    const label = `${item.side === "buy" ? "买" : "卖"}${Number(item.qty).toLocaleString()}股`;
    ctx.save();
    ctx.font = "10px 'Microsoft YaHei', sans-serif";
    const labelWidth = ctx.measureText(label).width + 8;
    const clampLabelX = (value) => Math.max(left, Math.min(plotRight - labelWidth, value));
    const baseX = clampLabelX(x - labelWidth / 2 + (row % 2 ? 9 : -9));
    const proposedY = item.side === "buy" ? y + 10 + row * 15 : y - 25 - row * 15;
    const minLabelY = priceTop + 4;
    const maxLabelY = priceBottom - 13;
    const baseY = Math.max(minLabelY, Math.min(maxLabelY, proposedY));
    const yCandidates = [baseY];
    for (let offset = 14; offset <= maxLabelY - minLabelY; offset += 14) {
      yCandidates.push(baseY + offset, baseY - offset);
    }
    const xCandidates = [baseX];
    for (let step = 1; step * (labelWidth + 4) < plotRight - left; step += 1) {
      xCandidates.push(clampLabelX(baseX + step * (labelWidth + 4)), clampLabelX(baseX - step * (labelWidth + 4)));
    }
    let labelPosition = null;
    for (const labelY of yCandidates) {
      if (labelY < minLabelY || labelY > maxLabelY) continue;
      for (const labelX of xCandidates) {
        const overlaps = placedTradeLabels.some((placed) =>
          labelX < placed.x + placed.width + 2 && labelX + labelWidth + 2 > placed.x
          && labelY < placed.y + placed.height + 2 && labelY + 15 > placed.y,
        );
        if (!overlaps) {
          labelPosition = { x: labelX, y: labelY };
          break;
        }
      }
      if (labelPosition) break;
    }
    const { x: labelX, y: labelY } = labelPosition || { x: baseX, y: baseY };
    placedTradeLabels.push({ x: labelX, y: labelY, width: labelWidth, height: 13 });
    ctx.fillStyle = focusedTrade ? "rgba(91,72,22,.96)" : "rgba(8,17,31,.88)";
    ctx.fillRect(labelX, labelY, labelWidth, 13);
    if (focusedTrade) { ctx.strokeStyle = "#f4c95d"; ctx.lineWidth = 1; ctx.strokeRect(labelX + .5, labelY + .5, labelWidth - 1, 12); }
    ctx.fillStyle = focusedTrade ? "#ffe29a" : item.side === "buy" ? "#ff9aa6" : "#8ce3c7";
    ctx.fillText(label, labelX + 4, labelY + 10);
    ctx.restore();
  });
  visible.forEach((bar, index) => {
    if (index % Math.max(1, Math.floor(visible.length / 6)) === 0) { ctx.fillStyle = "#71859f"; ctx.fillText(formatDate(bar.date).slice(5), xBar(index) - 14, height - 8); }
  });
  const annotatedBars = new Set((state.barNotes || []).map((item) => Number(item.index)));
  (state.reviewNotes || []).filter((item) => item.targetType === "bar").forEach((item) => annotatedBars.add(Number(item.index)));
  state.trades.forEach((item) => {
    if (String(item.reason || "").trim() || (state.reviewNotes || []).some((note) => note.targetType === "trade" && note.targetId === item.id)) annotatedBars.add(Number(item.index));
  });
  const visibleAnnotated = [...annotatedBars].filter((index) => index >= firstGlobalIndex && index < firstGlobalIndex + visible.length && index <= state.currentIndex);
  if (step >= 18) {
    visibleAnnotated.forEach((globalIndex) => {
      const localIndex = globalIndex - firstGlobalIndex;
      const x = xBar(localIndex);
      const y = Math.max(priceTop + 9, yPrice(visible[localIndex].high) - 11);
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(14,28,47,.94)"; ctx.fill();
      ctx.strokeStyle = "rgba(244,201,93,.78)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#f4c95d"; ctx.font = "10px 'Segoe UI Symbol','Microsoft YaHei',sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("✎", x, y + .3);
      ctx.restore();
    });
  } else if (visibleAnnotated.length) {
    ctx.save();
    ctx.fillStyle = "rgba(14,28,47,.94)"; ctx.fillRect(plotRight - 57, priceTop + 3, 53, 16);
    ctx.strokeStyle = "rgba(244,201,93,.5)"; ctx.strokeRect(plotRight - 57.5, priceTop + 2.5, 53, 17);
    ctx.fillStyle = "#f4c95d"; ctx.font = "10px 'Microsoft YaHei',sans-serif";
    ctx.fillText(`✎ ${visibleAnnotated.length}`, plotRight - 52, priceTop + 14);
    ctx.restore();
  }
  drawChartMarkings(ctx, { left, plotRight, priceTop, priceBottom, volumeTop, volumeBottom, indicatorHeight, firstGlobalIndex, visible, step, xBar, yPrice, high, low, maxVolume });
}

function drawChartMarkings(ctx, layout) {
  const { left, plotRight, priceTop, priceBottom, volumeTop, volumeBottom, indicatorHeight, firstGlobalIndex, visible, step, xBar, yPrice, high, low, maxVolume } = layout;
  const yVolume = value => volumeBottom - Number(value) / maxVolume * (volumeBottom - volumeTop);
  const macdTop = priceBottom + 80, macdHeight = state.indicator === "both" ? 77 : indicatorHeight - 8;
  const kdjTop = state.indicator === "both" ? macdTop + macdHeight + 8 : macdTop;
  const series = indicatorData();
  const macdShown = [...series.dif.slice(firstGlobalIndex, firstGlobalIndex + visible.length), ...series.dea.slice(firstGlobalIndex, firstGlobalIndex + visible.length), ...series.macd.slice(firstGlobalIndex, firstGlobalIndex + visible.length)].filter(Number.isFinite);
  const macdMax = Math.max(.01, ...macdShown.map(v => Math.abs(v))), macdCenter = macdTop + macdHeight / 2;
  const yMacd = v => macdCenter - v / macdMax * macdHeight * .4;
  const jShown = series.j.slice(firstGlobalIndex, firstGlobalIndex + visible.length).filter(Number.isFinite);
  const jMin = Math.min(0, ...jShown), jMax = Math.max(100, ...jShown), yKdj = v => kdjTop + (jMax - v) / Math.max(1, jMax - jMin) * (state.indicator === "both" ? 77 : indicatorHeight - 8);
  const yFor = (panel, v) => panel === "volume" ? yVolume(v) : panel === "macd" ? yMacd(v) : panel === "kdj" ? yKdj(v) : yPrice(v);
  const panelBounds = panel => panel === "volume" ? [volumeTop, volumeBottom] : panel === "macd" ? [macdTop, macdTop + macdHeight] : panel === "kdj" ? [kdjTop, kdjTop + (state.indicator === "both" ? 77 : indicatorHeight - 8)] : [priceTop, priceBottom];
  ctx.save();
  for (const mark of (state.chartMarksVisible ? state.chartMarks : []) || []) {
    const a = mark.a, b = mark.b || a; if (a.index < firstGlobalIndex || a.index > state.currentIndex || b.index < firstGlobalIndex || b.index > state.currentIndex) continue;
    const panel = mark.panel || "price", [pt, pb] = panelBounds(panel), x1 = left + (a.index - firstGlobalIndex + .5) * step, x2 = left + (b.index - firstGlobalIndex + .5) * step;
    ctx.save(); ctx.beginPath(); ctx.rect(left, pt, plotRight - left, pb - pt); ctx.clip();
    ctx.strokeStyle = mark.color || (mark.kind === "resistance" ? "#ff9aa6" : "#f4c95d"); ctx.fillStyle = "rgba(244,201,93,.12)"; ctx.lineWidth = mark.id === state.chartSelectedMarkId ? 2.5 : 1.6;
    if (mark.kind === "range") { const ya = yPrice(a.value), yb = yPrice(b.value), xa=Math.min(x1,x2), xb=Math.max(x1,x2); ctx.fillRect(xa, Math.min(ya, yb), Math.max(2,xb-xa), Math.max(2, Math.abs(ya-yb))); ctx.strokeRect(xa, Math.min(ya, yb), Math.max(2,xb-xa), Math.max(2, Math.abs(ya-yb))); }
    else if (mark.kind === "support" || mark.kind === "resistance") { const y = yPrice(a.value); ctx.setLineDash([6,4]); ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(plotRight,y); ctx.stroke(); ctx.setLineDash([]); ctx.fillText(mark.kind === "support" ? "支撑" : "压力", left+4, Math.max(pt+11,y-4)); }
    else { ctx.beginPath(); ctx.moveTo(x1,yFor(panel,a.value)); ctx.lineTo(x2,yFor(panel,b.value)); ctx.stroke(); }
    if (mark.label || mark.reason || mark.retrospective) { ctx.font="10px 'Microsoft YaHei',sans-serif"; ctx.fillStyle="#f4c95d"; const label=[mark.label,mark.reason,mark.retrospective?"补标":""].filter(Boolean).join(" · ").slice(0,52);ctx.fillText(label,Math.max(left+4,Math.min(plotRight-ctx.measureText(label).width-4,x1+4)),Math.max(pt+12,Math.min(pb-4,yFor(panel,a.value)-5))); }
    ctx.restore();
  }
  const cursor = state.chartCursor;
  if (cursor && cursor.x >= left && cursor.x <= plotRight) {
    const [pt,pb] = panelBounds(cursor.panel); ctx.strokeStyle = "rgba(220,232,255,.7)"; ctx.lineWidth = 1; ctx.setLineDash([3,3]); ctx.beginPath(); ctx.moveTo(cursor.x,priceTop); ctx.lineTo(cursor.x,indicatorHeight > 0 ? priceBottom + 80 + indicatorHeight : volumeBottom); ctx.stroke(); ctx.beginPath(); ctx.moveTo(left,cursor.y); ctx.lineTo(plotRight,cursor.y); ctx.stroke(); ctx.setLineDash([]);
    const local = Math.max(0,Math.min(visible.length-1,Math.ceil((cursor.x-left)/step-1))), bar = visible[local], globalIndex=firstGlobalIndex+local, displayIndex=state.mode === "naked" && !state.finished ? globalIndex<state.trainingStartIndex?`背景第 ${globalIndex-Math.max(0,state.trainingStartIndex-contextBarCount)+1} 根`:`训练第 ${globalIndex-state.trainingStartIndex+1} 根` : formatDate(bar.date);
    const pct = globalIndex > 0 && Number(state.bars[globalIndex-1]?.close)>0 ? ((bar.close/state.bars[globalIndex-1].close-1)*100).toFixed(2)+"%" : "—";
    const i=globalIndex, f=v=>Number.isFinite(v)?Number(v).toFixed(2):"—";
    const volumeUnit = state.dataMeta?.volumeUnit || "单位未标明";
    const obs=$("chartObservation"); if(obs) obs.textContent=`${displayIndex}（第 ${local+1} 根可见K线） · O ${f(bar.open)} H ${f(bar.high)} L ${f(bar.low)} C ${f(bar.close)} · 涨跌 ${pct} · VOL ${formatVolume(bar.volume)} ${volumeUnit} · VOL-MA120/250 ${formatVolume(series.volumeMa120[i])}/${formatVolume(series.volumeMa250[i])} ${volumeUnit} · MA5/20/60 ${f(series.ma5[i])}/${f(series.ma20[i])}/${f(series.ma60[i])} · DIF/DEA/MACD ${f(series.dif[i])}/${f(series.dea[i])}/${f(series.macd[i])} · K/D/J ${f(series.k[i])}/${f(series.d[i])}/${f(series.j[i])}`;
  }
  ctx.restore();
}

function changeChartZoom(delta) {
  const current = state.chartZoomExplicit ? Number(state.chartBars) : Number(state.renderedChartBars || state.chartBars);
  const next = current + Number(delta);
  state.chartZoomExplicit = true;
  state.waveOverview = false;
  state.chartBars = Math.max(minChartBars, Math.min(maxChartBars, Math.round(next)));
  state.chartOffset = Math.min(state.chartOffset, Math.max(0, currentBars().length - Math.min(state.chartBars, currentBars().length)));
  window.requestAnimationFrame(drawChart);
}

function resetChartView() {
  if (state.finished) {
    showAllOperationWaves();
    return;
  }
  state.chartBars = defaultChartBars;
  state.chartZoomExplicit = false;
  state.chartOffset = 0;
  window.requestAnimationFrame(drawChart);
}

function shiftChartViewport(delta) {
  if (state.finished && state.waveOverview) {
    state.waveOverview = false;
  }
  const maxOffset = Math.max(0, currentBars().length - Math.min(state.renderedChartBars || state.chartBars, currentBars().length));
  state.chartOffset = Math.max(0, Math.min(maxOffset, state.chartOffset + delta));
  drawChart();
}

let chartPointer = null;
let chartMarkPress = null;
let chartMarkMove = null;
let chartMarkPressTimer = null;

function chartMarkScreenPoint(mark, key, layout = window.__chartDrawLayout) {
  const point = mark?.[key];
  if (!point || !layout) return null;
  const panel = mark.panel || "price";
  const x = layout.left + (point.index - layout.firstGlobalIndex + .5) * layout.step;
  let y;
  if (panel === "price") y = layout.priceTop + (layout.high - point.value) / Math.max(.01, layout.high - layout.low) * (layout.priceBottom - layout.priceTop);
  else if (panel === "volume") y = layout.volumeBottom - point.value / Math.max(1, layout.maxVolume) * (layout.volumeBottom - layout.volumeTop);
  else {
    const data = indicatorData();
    if (panel === "macd") {
      const values = [...data.dif.slice(layout.firstGlobalIndex, layout.firstGlobalIndex + layout.visibleCount), ...data.dea.slice(layout.firstGlobalIndex, layout.firstGlobalIndex + layout.visibleCount), ...data.macd.slice(layout.firstGlobalIndex, layout.firstGlobalIndex + layout.visibleCount)].filter(Number.isFinite);
      const height = state.indicator === "both" ? 77 : layout.indicatorHeight;
      const max = Math.max(.01, ...values.map(value => Math.abs(value)));
      y = layout.indicatorTop + height / 2 - point.value / max * height * .4;
    } else {
      const values = data.j.slice(layout.firstGlobalIndex, layout.firstGlobalIndex + layout.visibleCount).filter(Number.isFinite);
      const low = Math.min(0, ...values), high = Math.max(100, ...values);
      const top = state.indicator === "both" ? layout.indicatorTop + 85 : layout.indicatorTop;
      const height = state.indicator === "both" ? Math.max(1, layout.indicatorHeight - 85) : layout.indicatorHeight;
      y = top + (high - point.value) / Math.max(1, high - low) * height;
    }
  }
  return { x, y };
}

function chartMarkHit(point) {
  const layout = window.__chartDrawLayout;
  if (!layout || !state.chartMarksVisible || point.x < layout.left || point.x > layout.plotRight) return null;
  let best = null, bestDistance = 13;
  for (const mark of state.chartMarks || []) {
    if ((mark.panel || "price") !== point.panel || !mark.a || mark.a.index < layout.firstGlobalIndex || mark.a.index > state.currentIndex) continue;
    const b = mark.b || mark.a;
    if (b.index < layout.firstGlobalIndex || b.index > state.currentIndex) continue;
    const aScreen = chartMarkScreenPoint(mark, "a", layout), bScreen = chartMarkScreenPoint(mark, "b", layout) || aScreen;
    if (!aScreen || !bScreen) continue;
    const endpointA = Math.hypot(point.x - aScreen.x, point.y - aScreen.y);
    const endpointB = mark.b ? Math.hypot(point.x - bScreen.x, point.y - bScreen.y) : Infinity;
    let distance;
    if (mark.kind === "support" || mark.kind === "resistance") distance = Math.abs(point.y - aScreen.y);
    else if (mark.kind === "range") {
      const left = Math.min(aScreen.x, bScreen.x), right = Math.max(aScreen.x, bScreen.x), top = Math.min(aScreen.y, bScreen.y), bottom = Math.max(aScreen.y, bScreen.y);
      const dx = Math.max(left - point.x, 0, point.x - right), dy = Math.max(top - point.y, 0, point.y - bottom);
      distance = Math.hypot(dx, dy);
    } else {
      const dx = bScreen.x - aScreen.x, dy = bScreen.y - aScreen.y;
      const t = Math.max(0, Math.min(1, ((point.x - aScreen.x) * dx + (point.y - aScreen.y) * dy) / Math.max(1, dx * dx + dy * dy)));
      distance = Math.hypot(point.x - (aScreen.x + t * dx), point.y - (aScreen.y + t * dy));
    }
    if (distance < bestDistance) { best = { mark, key: Math.min(endpointA, endpointB) < 14 ? (endpointA <= endpointB ? "a" : "b") : null }; bestDistance = distance; }
  }
  return best;
}

function clearChartMarkPress() {
  clearTimeout(chartMarkPressTimer);
  chartMarkPressTimer = null;
  chartMarkPress = null;
}

function beginChartDrag(event) {
  if (state.chartTool === "note") { const point=chartPointFromPointer(event);if(point)state.chartNoteIndex=point.index;state.chartPointerId=event.pointerId;return; }
  if (state.chartTool === "select") {
    const point = chartPointFromPointer(event), hit = point && chartMarkHit(point);
    if (hit) {
      state.chartSelectedMarkId = hit.mark.id;
      state.chartPointerId = event.pointerId;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const before = structuredClone(state.chartMarks);
      if (event.pointerType === "touch" && !hit.key) {
        chartMarkMove = null;
        chartMarkPress = { id: hit.mark.id, pointerId: event.pointerId, start: point, before, moved: false };
        chartMarkPressTimer = setTimeout(() => {
          if (!chartMarkPress || chartMarkPress.pointerId !== event.pointerId || chartMarkPress.moved) return;
          chartMarkMove = { id: chartMarkPress.id, pointerId: event.pointerId, start: chartMarkPress.start, before: chartMarkPress.before };
          chartMarkPress = null;
          chartMarkPressTimer = null;
          drawChart();
        }, 450);
      } else if (hit.key) {
        state.chartEdit = { id: hit.mark.id, key: hit.key };
        state.chartEditBefore = before;
      } else {
        chartMarkMove = { id: hit.mark.id, pointerId: event.pointerId, start: point, before };
      }
      drawChart();
    }
    return;
  }
  if (state.chartTool !== "inspect" && state.chartTool !== "pan") { event.preventDefault(); const point = chartPointFromPointer(event); if (point) { if(state.chartPendingMark)state.chartSecondPoint=point;else {state.chartPendingMark=point;state.chartJustStarted=true;} state.chartPointerId=event.pointerId; event.currentTarget.setPointerCapture?.(event.pointerId); } return; }
  if (state.chartInspectActive) { state.chartPointerId=event.pointerId; state.chartTouchActive=event.pointerType==="touch"; chartPointer = { id:event.pointerId,x:event.clientX,y:event.clientY,moved:false,offset:state.chartOffset,inspect:true }; return; }
  chartPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, offset: state.chartOffset, pan: state.chartTool === "pan" };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveChartDrag(event) {
  if (chartMarkPress && chartMarkPress.pointerId === event.pointerId) {
    const point = chartPointFromPointer(event);
    if (point && Math.hypot(point.x - chartMarkPress.start.x, point.y - chartMarkPress.start.y) > 7) { chartMarkPress.moved = true; clearChartMarkPress(); }
    return;
  }
  if (chartMarkMove && chartMarkMove.pointerId === event.pointerId) {
    const point = chartPointFromPointer(event), mark = state.chartMarks.find(item => item.id === chartMarkMove.id);
    if (!point || !mark || point.panel !== (mark.panel || "price")) return;
    const minIndex = Math.max(0, state.trainingStartIndex - contextBarCount), maxIndex = state.currentIndex;
    const desiredIndexDelta = Math.round(point.index - chartMarkMove.start.index);
    const anchors = [mark.a, ...(mark.b ? [mark.b] : [])];
    const minDelta = Math.max(...anchors.map(anchor => minIndex - anchor.index));
    const maxDelta = Math.min(...anchors.map(anchor => maxIndex - anchor.index));
    const indexDelta = Math.max(minDelta, Math.min(maxDelta, desiredIndexDelta));
    const valueDelta = point.value - chartMarkMove.start.value;
    state.chartMarks = structuredClone(chartMarkMove.before).map(item => {
      if (item.id !== chartMarkMove.id) return item;
      item.a.index += indexDelta; item.a.value += valueDelta;
      if (item.b) { item.b.index += indexDelta; item.b.value += valueDelta; }
      return item;
    });
    drawChart();
    return;
  }
  if(state.chartEdit && state.chartPointerId===event.pointerId){const p=chartPointFromPointer(event),m=state.chartMarks.find(x=>x.id===state.chartEdit.id);if(p&&m&&p.panel===m.panel){m[state.chartEdit.key]={index:p.index,value:p.value};drawChart();}return;}
  if (state.chartTool==="inspect" && state.chartInspectActive && (event.pointerType!=="touch" || state.chartTouchActive)) { state.chartPointerId=event.pointerId; state.chartCursor = chartPointFromPointer(event); drawChart(); return; }
  if (state.chartPendingMark && event.buttons) return;
  if (!chartPointer || chartPointer.id !== event.pointerId) return;
  const pixelDelta = event.clientX - chartPointer.x;
  if (Math.abs(pixelDelta) > 5 || Math.abs(event.clientY - chartPointer.y) > 5) chartPointer.moved = true;
  if (!chartPointer.moved) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const barsPerPixel = Math.max(0.05, (state.renderedChartBars || state.chartBars) / Math.max(rect.width, 1));
  if (state.finished && state.waveOverview) {
    state.waveOverview = false;
  }
  const maxOffset = Math.max(0, currentBars().length - Math.min(state.renderedChartBars || state.chartBars, currentBars().length));
  state.chartOffset = Math.max(0, Math.min(maxOffset, Math.round(chartPointer.offset + pixelDelta * barsPerPixel)));
  drawChart();
}

function endChartDrag(event) {
  if(event.type==="pointercancel"){clearChartMarkPress();chartMarkMove=null;state.chartPendingMark=null;state.chartSecondPoint=null;state.chartJustStarted=false;state.chartPointerId=null;state.chartEdit=null;state.chartEditBefore=null;chartPointer=null;return;}
  if (chartMarkPress && chartMarkPress.pointerId === event.pointerId) { clearChartMarkPress(); state.chartPointerId=null; drawChart(); return; }
  if (chartMarkMove && chartMarkMove.pointerId === event.pointerId) { const move=chartMarkMove;chartMarkMove=null;const changed=JSON.stringify(move.before)!==JSON.stringify(state.chartMarks);if(changed){state.chartMarkHistory.push({before:move.before});recordChartMarkAction("move",move.id);state.chartRedo=null;saveDraftSession();}state.chartPointerId=null;drawChart();return; }
  if(state.chartEdit&&state.chartPointerId===event.pointerId){if(state.chartEditBefore&&JSON.stringify(state.chartEditBefore)!==JSON.stringify(state.chartMarks)){state.chartMarkHistory.push({before:state.chartEditBefore});recordChartMarkAction("edit",state.chartEdit.id);state.chartRedo=null;saveDraftSession();}state.chartEdit=null;state.chartEditBefore=null;state.chartPointerId=null;drawChart();return;}
  if (state.chartTool === "note" && state.chartPointerId===event.pointerId) {const index=state.chartNoteIndex;state.chartPointerId=null;state.chartNoteIndex=null;if(Number.isInteger(index))openBarNote(index);return;}
  if (state.chartTool !== "inspect" && state.chartPendingMark && state.chartPointerId===event.pointerId) { if(state.chartJustStarted){state.chartJustStarted=false;state.chartPointerId=null;return;} const end=state.chartSecondPoint||chartPointFromPointer(event), start=state.chartPendingMark; state.chartPendingMark=null;state.chartSecondPoint=null;state.chartPointerId=null; if(end && start.panel===end.panel) { const before=structuredClone(state.chartMarks||[]); state.chartMarkHistory.push({before,after:null}); const kind=state.chartTool; const mark={id:makeLocalId(),kind,panel:start.panel,a:{index:start.index,value:start.value},b:kind==="support"||kind==="resistance"?null:{index:end.index,value:end.value},label:$('chartMarkLabel').value.trim(),reason:$('chartMarkReason').value.trim(),createdAt:new Date().toISOString(),createdAtIndex:state.currentIndex,retrospective:state.finished||state.archiveView}; state.chartRedo=null;state.chartMarks.push(mark); state.chartSelectedMarkId=mark.id; state.chartMarkHistory.at(-1).after=structuredClone(state.chartMarks); recordChartMarkAction("create",mark.id);saveDraftSession(); drawChart(); } return; }
  if (state.chartPointerId === event.pointerId && state.chartInspectActive) { state.chartPointerId=null;state.chartTouchActive=false; return; }
  if (chartPointer?.id !== event.pointerId) return;
  const pointer = chartPointer;
  chartPointer = null;
  if (pointer.moved) return;
  if (pointer.pan) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const hit = chartHitTest(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
  if (!hit) return;
  clearTimeout(chartClickTimer);
  chartClickTimer = setTimeout(() => openBarNote(hit.index), 280);
}

function chartPointFromPointer(event) {
  const canvas=$("chartCanvas"), rect=canvas.getBoundingClientRect(), l=window.__chartDrawLayout; if(!l) return null;
  const x=event.clientX-rect.left,y=event.clientY-rect.top; if(x<l.left||x>l.plotRight) return null;
  let panel="price", min=l.priceTop,max=l.priceBottom;
  if(y>=l.volumeTop&&y<=l.volumeBottom){panel="volume";min=l.volumeTop;max=l.volumeBottom;}
  else if(y>l.volumeBottom){
    if(state.indicator==="none")return null;
    if(state.indicator==="both"){panel=y<l.indicatorTop+77?"macd":"kdj";min=panel==="macd"?l.indicatorTop:l.indicatorTop+85;max=panel==="macd"?l.indicatorTop+77:l.indicatorTop+l.indicatorHeight;}
    else {panel=state.indicator;min=l.indicatorTop;max=l.indicatorTop+l.indicatorHeight;}
  }
  const index=Math.max(l.firstGlobalIndex,Math.min(state.currentIndex,l.firstGlobalIndex+Math.max(0,Math.min(l.visibleCount-1,Math.ceil((x-l.left)/l.step-1)))));
  const frac=Math.max(0,Math.min(1,(y-min)/Math.max(1,max-min))); let value;
  if(panel==="price")value=l.high-frac*(l.high-l.low); else if(panel==="volume")value=(1-frac)*l.maxVolume; else if(panel==="macd"){const d=indicatorData(),all=[...d.dif.slice(l.firstGlobalIndex,l.firstGlobalIndex+l.visibleCount),...d.dea.slice(l.firstGlobalIndex,l.firstGlobalIndex+l.visibleCount),...d.macd.slice(l.firstGlobalIndex,l.firstGlobalIndex+l.visibleCount)].filter(Number.isFinite),scale=Math.max(.01,...all.map(v=>Math.abs(v)));value=(.5-frac)*scale/.4;}else{const d=indicatorData(),a=d.j.slice(l.firstGlobalIndex,l.firstGlobalIndex+l.visibleCount).filter(Number.isFinite),lo=Math.min(0,...a),hi=Math.max(100,...a);value=hi-frac*(hi-lo);}
  return {index,value,panel,x,y};
}

function recordChartMarkAction(action, markId = null) { state.chartMarkActions ||= []; state.chartMarkActions.push({ id: makeLocalId(), action, markId, at: new Date().toISOString(), trainingIndex: state.currentIndex, sequence: state.chartMarkActions.length + 1 }); }

function bindChartTools() {
  document.querySelectorAll("[data-chart-tool]").forEach(button=>button.addEventListener("click",()=>{state.chartPendingMark=null;state.chartSecondPoint=null;state.chartJustStarted=false;state.chartTool=button.dataset.chartTool; state.chartInspectActive=false; document.querySelectorAll("[data-chart-tool],#chartInspectTool,#chartNoteTool").forEach(b=>b.setAttribute("aria-pressed",String(b===button))); $("chartCanvas").style.cursor=button.dataset.chartTool==="pan"?"grab":"crosshair"; $("chartObservation").textContent=button.dataset.chartTool==="pan"?"平移模式 · 拖动图表查看历史":`${button.textContent}：在图表点击起点，再点终点`; }));
  $("chartInspectTool").addEventListener("click",()=>{state.chartPendingMark=null;state.chartSecondPoint=null;state.chartJustStarted=false;state.chartTool="inspect";state.chartInspectActive=true;document.querySelectorAll("[data-chart-tool],#chartInspectTool,#chartNoteTool").forEach(b=>b.setAttribute("aria-pressed",String(b.id==="chartInspectTool")));$("chartCanvas").style.cursor="crosshair";$("chartObservation").textContent="查看模式 · 移动指针观察，触屏可按住移动";});
  $("chartNoteTool").addEventListener("click",()=>{state.chartPendingMark=null;state.chartSecondPoint=null;state.chartJustStarted=false;state.chartTool="note";state.chartInspectActive=false;document.querySelectorAll("[data-chart-tool],#chartInspectTool,#chartNoteTool").forEach(b=>b.setAttribute("aria-pressed",String(b.id==="chartNoteTool")));$("chartCanvas").style.cursor="crosshair";$("chartObservation").textContent="笔记模式 · 点击目标K线记录原始观察";});
  $("chartMarksToggle").addEventListener("click",()=>{state.chartMarksVisible=!state.chartMarksVisible;$("chartMarksToggle").textContent=state.chartMarksVisible?"隐藏标记":"显示标记";$("chartMarksToggle").setAttribute("aria-pressed",String(state.chartMarksVisible));drawChart();});
  $("chartUndoTool").addEventListener("click",()=>{const h=state.chartMarkHistory.pop();if(!h)return;state.chartRedo=structuredClone(state.chartMarks);state.chartMarks=h.before;recordChartMarkAction("undo");saveDraftSession();drawChart();});
  $("chartRedoTool").addEventListener("click",()=>{if(!state.chartRedo)return;const before=structuredClone(state.chartMarks);state.chartMarks=state.chartRedo;state.chartMarkHistory.push({before,after:structuredClone(state.chartMarks)});state.chartRedo=null;recordChartMarkAction("redo");saveDraftSession();drawChart();});
  $("chartDeleteTool").addEventListener("click",()=>{const id=state.chartSelectedMarkId;if(!id)return;const before=structuredClone(state.chartMarks);state.chartMarkHistory.push({before});state.chartMarks=state.chartMarks.filter(m=>m.id!==id);recordChartMarkAction("delete",id);state.chartRedo=null;state.chartSelectedMarkId=null;saveDraftSession();drawChart();});
}

function chartHitTest(x, y, width, height) {
  if (width < 20 || !state.bars.length) return null;
  const chartStartIndex = Math.max(0, state.trainingStartIndex - contextBarCount);
  const bars = state.bars.slice(chartStartIndex, state.currentIndex + 1);
  const visibleCount = Math.max(1, Math.min(Number(state.renderedChartBars) || state.chartBars, bars.length));
  const left = 48, chipWidth = state.showChip ? Math.min(132, Math.max(88, width * .17)) : 0;
  const plotRight = state.showChip ? Math.max(left + 80, width - 14 - chipWidth - 8) : Math.max(left + 80, width - 14);
  const indicatorHeight = state.indicator === "none" ? 0 : state.indicator === "both" ? 170 : 94;
  const priceBottom = Math.max(22 + 100, height - 28 - 72 - indicatorHeight - 14);
  if (x < left || x > plotRight || y < 20 || y > priceBottom) return null;
  const offset = Math.max(0, Math.min(Number(state.chartOffset) || 0, Math.max(0, bars.length - visibleCount)));
  const start = Math.max(0, bars.length - visibleCount - offset);
  const step = Math.max(1, (plotRight - left) / visibleCount);
  const localIndex = Math.min(visibleCount - 1, Math.max(0, Math.floor((x - left) / step)));
  const index = chartStartIndex + start + localIndex;
  return index <= state.currentIndex ? { index } : null;
}

function intradayIdentity(date) {
  const privateTraining = state.mode === "naked" && !state.finished;
  const index = state.bars.findIndex((bar) => formatDate(bar.date) === formatDate(date));
  return privateTraining ? `训练第 ${Math.max(1, index - state.trainingStartIndex + 1)} 根` : `${state.symbol} · ${formatDate(date)}`;
}

function intradayReferenceClose(bars) {
  const lastBar = bars.find((bar) => String(bar.time || "").slice(-5) === "15:00");
  if (!lastBar || !(Number(lastBar.close) > 0)) return null;
  const selectedDate = formatDate(state.intraday.date);
  const selectedIndex = state.bars.findIndex((bar) => formatDate(bar.date) === selectedDate);
  if (selectedIndex < 0) return null;
  const selectedDaily = state.bars[selectedIndex];
  const previousDaily = state.bars[selectedIndex - 1] || (selectedIndex === 0 ? state.indicatorWarmupBars.at(-1) : null);
  if (!previousDaily || !(selectedDaily.close > 0) || !(previousDaily.close > 0)) return null;
  const scale = state.dataMeta?.adjust === "none" ? 1 : Number(lastBar.close) / selectedDaily.close;
  const reference = previousDaily.close * scale;
  return Number.isFinite(reference) && reference > 0 ? reference : null;
}

function intradayFormatPrice(value) {
  const code = String(state.code || "");
  const decimals = /^(15|16|18|50|51|56|58|59)/.test(code) ? 3 : 2;
  return Number(value).toFixed(decimals);
}

function intradayMinute(time) {
  const match = String(time || "").match(/(\d{2}):(\d{2})$/);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  if (minute <= 11 * 60 + 30) return minute - (9 * 60 + 30);
  if (minute >= 13 * 60) return 120 + minute - 13 * 60;
  return null;
}

function drawIntradayChart(canvas, bars, referenceClose, volumeUnit) {
  const context = canvas.getContext("2d");
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  const rootStyle = getComputedStyle(document.documentElement);
  const colors = {
    text: rootStyle.getPropertyValue("--text").trim() || "#edf4ff",
    muted: rootStyle.getPropertyValue("--muted").trim() || "#8ea2bd",
    grid: "rgba(159,183,213,.15)",
    price: "#f3f7ff",
    up: rootStyle.getPropertyValue("--red").trim() || "#ff7787",
    down: rootStyle.getPropertyValue("--green").trim() || "#65d7b1",
    accent: rootStyle.getPropertyValue("--accent-2").trim() || "#7da8ff",
  };
  const narrow = width < 520;
  const left = narrow ? 46 : 70;
  const right = narrow ? 48 : 70;
  const top = 24;
  const timeHeight = 30;
  const volumeHeight = Math.max(76, Math.round(height * .25));
  const gapBetween = 25;
  const priceBottom = height - volumeHeight - timeHeight - gapBetween;
  const volumeTop = priceBottom + gapBetween;
  const volumeBottom = height - timeHeight;
  const plotLeft = left;
  const plotRight = Math.max(plotLeft + 80, width - right);
  const plotWidth = plotRight - plotLeft;
  const lunchGap = narrow ? Math.min(54, Math.max(46, plotWidth * .16)) : Math.min(48, Math.max(36, plotWidth * .04));
  const xForMinute = (minute) => {
    const compressed = (minute / 240) * (plotWidth - lunchGap);
    return plotLeft + compressed + (minute > 120 ? lunchGap : 0);
  };
  const xForBar = (bar) => {
    const minute = intradayMinute(bar.time);
    return minute == null ? null : xForMinute(minute);
  };
  const validBars = bars.map((bar) => ({
    ...bar,
    open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close), volume: Number(bar.volume),
    minute: intradayMinute(bar.time),
  })).filter((bar) => bar.minute != null && [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
    && bar.close > 0 && bar.low > 0 && bar.high >= bar.low && bar.volume >= 0)
    .sort((a, b) => a.minute - b.minute);
  const tooltip = $("intradayTooltip");
  const clearTooltip = () => {
    tooltip.innerHTML = '<span class="intraday-tooltip-hint">悬停或点按图表查看该时段数据</span>';
    state.intraday.hoveredIndex = null;
  };

  context.clearRect(0, 0, width, height);
  context.font = "11px Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  context.textBaseline = "middle";
  context.lineWidth = 1;

  if (!validBars.length) {
    clearTooltip();
    return;
  }

  const maxVolume = Math.max(...validBars.map((bar) => bar.volume), 1);
  const hasReference = Number.isFinite(referenceClose) && referenceClose > 0;
  let yForPrice;
  let percentStep = 1;
  let percentLimit = 0;
  if (hasReference) {
    const maxChange = Math.max(...validBars.map((bar) => Math.max(Math.abs(bar.high / referenceClose - 1), Math.abs(bar.low / referenceClose - 1)))) * 100;
    const roughStep = Math.max(.1, maxChange / 3);
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const normalized = roughStep / magnitude;
    percentStep = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
    percentLimit = Math.max(percentStep, Math.ceil(maxChange / percentStep) * percentStep);
    yForPrice = (price) => top + ((percentLimit - ((price / referenceClose - 1) * 100)) / (2 * percentLimit)) * (priceBottom - top);
  } else {
    const minPrice = Math.min(...validBars.map((bar) => bar.low));
    const maxPrice = Math.max(...validBars.map((bar) => bar.high));
    const padding = Math.max((maxPrice - minPrice) * .08, maxPrice * .001);
    yForPrice = (price) => top + ((maxPrice + padding - price) / (maxPrice - minPrice + padding * 2)) * (priceBottom - top);
  }

  const tickCount = 6;
  for (let index = 0; index <= tickCount; index += 1) {
    const y = top + ((priceBottom - top) * index) / tickCount;
    context.beginPath();
    context.strokeStyle = hasReference && index === tickCount / 2 ? "rgba(125,168,255,.52)" : colors.grid;
    context.setLineDash(hasReference && index === tickCount / 2 ? [] : [3, 4]);
    context.moveTo(plotLeft, y);
    context.lineTo(plotRight, y);
    context.stroke();
    context.setLineDash([]);
    const price = hasReference ? referenceClose * (1 + ((percentLimit * (1 - (2 * index) / tickCount)) / 100)) : null;
    context.textAlign = "right";
    context.fillStyle = hasReference && index === tickCount / 2 ? colors.accent : colors.muted;
    context.fillText(hasReference ? intradayFormatPrice(price) : "", plotLeft - 8, y);
    context.textAlign = "left";
    context.fillStyle = hasReference && index === tickCount / 2 ? colors.accent : colors.muted;
    context.fillText(hasReference ? `${(percentLimit * (1 - (2 * index) / tickCount)).toFixed(2)}%` : "", plotRight + 8, y);
  }
  if (!hasReference) {
    context.fillStyle = colors.muted;
    context.textAlign = "left";
    context.fillText("基准缺失", plotRight + 8, top + 8);
    const minPrice = Math.min(...validBars.map((bar) => bar.low));
    const maxPrice = Math.max(...validBars.map((bar) => bar.high));
    for (let index = 0; index <= tickCount; index += 1) {
      const price = maxPrice - ((maxPrice - minPrice) * index) / tickCount;
      const y = top + ((priceBottom - top) * index) / tickCount;
      context.textAlign = "right";
      context.fillText(intradayFormatPrice(price), plotLeft - 8, y);
    }
  }

  const maxVolumeLabel = formatVolume(maxVolume);
  context.fillStyle = colors.muted;
  context.textAlign = "left";
  context.fillText(`成交量（${volumeUnit || "单位未标明"}）`, plotLeft, volumeTop - 12);
  for (let index = 0; index <= 2; index += 1) {
    const ratio = index / 2;
    const y = volumeTop + ratio * (volumeBottom - volumeTop);
    context.beginPath();
    context.strokeStyle = colors.grid;
    context.setLineDash([3, 4]);
    context.moveTo(plotLeft, y);
    context.lineTo(plotRight, y);
    context.stroke();
    context.setLineDash([]);
    context.textAlign = "right";
    context.fillText(index === 2 ? "0" : index === 0 ? maxVolumeLabel : formatVolume(maxVolume / 2), plotLeft - 8, y);
  }

  const timeTicks = narrow
    ? [[0, "9:30"], [60, "10:30"], [120, "11:30"], [120, "13:00"], [180, "14:00"], [240, "15:00"]]
    : [[0, "09:30"], [60, "10:30"], [120, "11:30"], [120, "13:00"], [180, "14:00"], [240, "15:00"]];
  const lunchLeft = xForMinute(120);
  const lunchRight = lunchLeft + lunchGap;
  context.beginPath();
  context.strokeStyle = "rgba(159,183,213,.36)";
  context.setLineDash([2, 4]);
  context.moveTo((lunchLeft + lunchRight) / 2, top);
  context.lineTo((lunchLeft + lunchRight) / 2, volumeBottom);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = colors.muted;
  context.textAlign = "center";
  context.font = "9px Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  context.fillText("午休", (lunchLeft + lunchRight) / 2, priceBottom + gapBetween / 2);
  context.font = narrow ? "10px Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif" : "11px Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  timeTicks.forEach(([minute, label], index) => {
    const x = label === "13:00" ? lunchRight : xForMinute(minute);
    context.textAlign = index === 0 ? "left" : index === timeTicks.length - 1 ? "right" : "center";
    context.fillText(label, x, height - 10);
  });

  const spacing = plotWidth / 48;
  const columnWidth = Math.max(2, Math.min(9, spacing * .62));
  validBars.forEach((bar) => {
    const x = xForBar(bar);
    const barHeight = bar.volume > 0 ? Math.max(1, (bar.volume / maxVolume) * (volumeBottom - volumeTop)) : 0;
    const direction = bar.close > bar.open ? "up" : bar.close < bar.open ? "down" : "flat";
    context.fillStyle = direction === "up" ? colors.up : direction === "down" ? colors.down : colors.muted;
    if (barHeight > 0) context.fillRect(x - columnWidth / 2, volumeBottom - barHeight, columnWidth, barHeight);
  });

  context.beginPath();
  context.strokeStyle = colors.price;
  context.lineWidth = 1.7;
  let previous = null;
  validBars.forEach((bar) => {
    const x = xForBar(bar);
    const y = yForPrice(bar.close);
    if (!previous || bar.minute - previous.minute > 5.1) context.moveTo(x, y);
    else context.lineTo(x, y);
    previous = bar;
  });
  context.stroke();

  const hoveredIndex = state.intraday.hoveredIndex;
  if (Number.isInteger(hoveredIndex) && validBars[hoveredIndex]) {
    const bar = validBars[hoveredIndex];
    const x = xForBar(bar);
    const y = yForPrice(bar.close);
    context.beginPath();
    context.strokeStyle = "rgba(237,244,255,.46)";
    context.setLineDash([3, 3]);
    context.moveTo(x, top);
    context.lineTo(x, volumeBottom);
    context.stroke();
    context.setLineDash([]);
    context.beginPath();
    context.fillStyle = colors.price;
    context.arc(x, y, 3.5, 0, Math.PI * 2);
    context.fill();
  }

  const selectPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    if (pointerX < plotLeft || pointerX > plotRight) return;
    let nearest = 0;
    let distance = Infinity;
    validBars.forEach((bar, index) => {
      const nextDistance = Math.abs(xForBar(bar) - pointerX);
      if (nextDistance < distance) { nearest = index; distance = nextDistance; }
    });
    state.intraday.hoveredIndex = nearest;
    const bar = validBars[nearest];
    const change = hasReference ? ((bar.close / referenceClose) - 1) * 100 : null;
    tooltip.innerHTML = `<strong>${escapeHtml(bar.time)}</strong><span>价格 <b>¥${intradayFormatPrice(bar.close)}</b></span><span>涨跌幅 <b>${change == null ? "基准缺失" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</b></span><span>成交量 <b>${escapeHtml(formatVolume(bar.volume))} ${escapeHtml(volumeUnit || "")}</b></span>`;
    drawIntradayChart(canvas, bars, referenceClose, volumeUnit);
  };
  canvas.onpointermove = (event) => { if (event.pointerType !== "touch") selectPoint(event); };
  canvas.onpointerdown = (event) => { if (event.pointerType === "touch") selectPoint(event); };
  canvas.onpointerleave = (event) => { if (event.pointerType !== "touch") { clearTooltip(); drawIntradayChart(canvas, bars, referenceClose, volumeUnit); } };
}

function renderIntradayModal() {
  const modal = $("intradayVolumeModal");
  const title = $("intradayVolumeTitle");
  const meta = $("intradayVolumeMeta");
  const status = $("intradayVolumeStatus");
  const chart = $("intradayVolumeChart");
  const close = $("closeIntradayVolumeButton");
  const retry = $("retryIntradayVolumeButton");
  if (!modal || !title || !meta || !status || !chart || !close || !retry) return;
  if (!state.intraday.open) {
    modal.hidden = true;
    return;
  }
  modal.hidden = false;
  const selectedBar = state.bars.find((bar) => bar.date?.getTime?.() === state.intraday.date?.getTime?.()) || currentBar();
  title.textContent = "分时价量";
  meta.textContent = selectedBar ? intradayIdentity(selectedBar.date) : "未选择日 K";
  retry.hidden = !state.intraday.error;
  if (state.intraday.loading) {
    status.textContent = "正在获取真实 5 分钟分时价量…";
    status.style.color = "";
    chart.innerHTML = '<div class="intraday-empty">正在加载真实数据…</div>';
    return;
  }
  if (state.intraday.error) {
    status.textContent = state.intraday.error;
    status.style.color = "#ff9aa6";
    chart.innerHTML = '<div class="intraday-empty">暂无可显示的真实分时数据</div>';
    return;
  }
  const bars = Array.isArray(state.intraday.bars) ? state.intraday.bars : [];
  const volumeUnit = state.intraday.volumeUnit || ({ BaoStock: "股", 新浪: "股", 腾讯: "手", 东方财富: "手", "Tushare Pro": "手" }[state.intraday.provider] || "");
  status.textContent = `${state.intraday.provider || "真实数据"}${state.intraday.cached ? " · 本地缓存" : ""} · ${bars.length} 个 5 分钟时段 · 成交量${volumeUnit || "单位未标明"} · 获取于 ${state.intraday.fetchedAt ? new Date(state.intraday.fetchedAt).toLocaleString("zh-CN") : "—"}`;
  status.style.color = "";
  if (!bars.length) {
    chart.innerHTML = '<div class="intraday-empty">接口没有返回真实分时数据</div>';
    return;
  }
  const referenceClose = intradayReferenceClose(bars);
  chart.innerHTML = '<div class="intraday-plot"><div class="intraday-tooltip" id="intradayTooltip" role="status" aria-live="polite"><span class="intraday-tooltip-hint">悬停或点按图表查看该时段数据</span></div><canvas id="intradayCanvas" role="img" aria-label="5分钟分时价格、涨跌幅与成交量图，鼠标悬停或触屏点按查看数值"></canvas></div>';
  if (!referenceClose) {
    status.textContent += " · 涨跌幅基准缺失（需要前一交易日收盘价和当日15:00数据）";
  }
  const canvas = $("intradayCanvas");
  drawIntradayChart(canvas, bars, referenceClose, volumeUnit);
  if (selectedBar) canvas.setAttribute("aria-label", `${intradayIdentity(selectedBar.date)}：5分钟价格走势和成交量；悬停或点按查看数值`);
  canvas.setAttribute("aria-description", referenceClose
    ? `左侧价格刻度，右侧涨跌幅刻度；上一交易日参考价 ¥${intradayFormatPrice(referenceClose)}；下方成交量单位为${volumeUnit || "未知"}；午间休市处有分界。`
    : `左侧价格刻度；右侧涨跌幅基准缺失；下方成交量单位为${volumeUnit || "未知"}；午间休市处有分界。`);
}

async function openIntradayVolume(globalIndex) {
  if (state.dataMeta?.period !== "daily") return setHint("分时成交量查看仅适用于日线训练。", true);
  const selected = state.bars[globalIndex];
  if (!selected) return;
  const date = formatDate(selected.date);
  const key = `${state.code}:${date}:5`;
  state.intraday = { open: true, loading: false, date: selected.date, bars: [], provider: "", volumeUnit: "", cached: false, fetchedAt: null, error: "", requestKey: key, hoveredIndex: null };
  renderIntradayModal();
  const stored = state.intradayData?.[date];
  if (stored && Array.isArray(stored.bars) && stored.bars.length) {
    state.intraday.bars = stored.bars;
    state.intraday.provider = stored.provider || "样本已保存 · BaoStock";
    state.intraday.volumeUnit = stored.volumeUnit || "股";
    state.intraday.cached = true;
    state.intraday.fetchedAt = stored.fetchedAt || null;
    renderIntradayModal();
    return;
  }
  if (state.dataSource !== "real" || !/^\d{6}$/.test(String(state.code || ""))) {
    state.intraday.error = "当前行情不是可查询的真实日线数据，无法获取分时成交量。";
    renderIntradayModal();
    return;
  }
  state.intraday.loading = true;
  renderIntradayModal();
  try {
    const { response, payload } = await fetchJsonWithTimeout(
      `/api/market/intraday?symbol=${encodeURIComponent(state.code)}&date=${encodeURIComponent(date)}&interval=5&provider=auto`,
      { cache: "no-store" },
      30000,
    );
    if (!response.ok) throw new Error(payload.error || "真实分时数据获取失败。");
    if (state.intraday.requestKey !== key) return;
    state.intraday.loading = false;
    state.intraday.bars = Array.isArray(payload.bars) ? payload.bars : [];
    state.intraday.provider = payload.provider || "真实数据";
    state.intraday.volumeUnit = payload.volumeUnit || "";
    state.intraday.cached = Boolean(payload.cached);
    state.intraday.fetchedAt = payload.fetchedAt || null;
    if (!state.intraday.bars.length) state.intraday.error = "接口没有返回这一天的真实分时数据。";
  } catch (error) {
    if (state.intraday.requestKey !== key) return;
    state.intraday.loading = false;
    state.intraday.error = `获取失败：${error.message}`;
  }
  loadSourceHealth();
  renderIntradayModal();
}

function handleChartDoubleClick(event) {
  clearTimeout(chartClickTimer);
  if (state.chartTool !== "inspect") return;
  if (state.dataMeta?.period !== "daily") return;
  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const hit = chartHitTest(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
  if (hit) openIntradayVolume(hit.index);
}

function drawChipProfile(ctx, profile, left, right, top, bottom, yPrice, currentPrice) {
  if (!profile) return;
  const width = Math.max(10, right - left - 5);
  const maxWeight = Math.max(...profile.weights, 1);
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
  ctx.strokeStyle = "rgba(151,178,212,.25)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left - 4, top); ctx.lineTo(left - 4, bottom); ctx.stroke();
  profile.weights.forEach((weight, index) => {
    const price = profile.prices[index];
    const y1 = yPrice(price + profile.binSize / 2);
    const y2 = yPrice(price - profile.binSize / 2);
    const barWidth = (weight / maxWeight) * width;
    const isPeak = Math.abs(price - profile.peakPrice) < profile.binSize / 2;
    ctx.fillStyle = isPeak ? "rgba(244,201,93,.88)" : "rgba(101,215,177,.72)";
    ctx.fillRect(left, y1, barWidth, Math.max(2, y2 - y1 - 1));
  });
  const currentY = yPrice(currentPrice);
  ctx.setLineDash([4, 3]); ctx.strokeStyle = "rgba(255,119,135,.85)"; ctx.beginPath(); ctx.moveTo(left, currentY); ctx.lineTo(right, currentY); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "rgba(10,20,35,.82)"; ctx.fillRect(left, top, right - left, 31);
  ctx.font = "bold 10px Inter, sans-serif"; ctx.fillStyle = "#b9c8dc"; ctx.fillText("估算成交密集区", left + 3, top + 11);
  ctx.font = "9px Inter, sans-serif"; ctx.fillStyle = "#f4c95d"; ctx.fillText(`峰 ${formatPrice(profile.peakPrice)}`, left + 3, top + 24);
  ctx.restore();
}

function drawIndexedLine(ctx, count, getter, color, yScale, xBar, width = 1.4) {
  let started = false;
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
  for (let index = 0; index < count; index += 1) {
    const value = getter(index);
    if (!Number.isFinite(value)) { started = false; continue; }
    const x = xBar(index), y = yScale(value);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  if (started) ctx.stroke();
}

function drawSubIndicators(ctx, count, firstIndex, top, height, xBar, left, right, data) {
  if (state.indicator === "both") {
    const panelHeight = (height - 8) / 2;
    drawMacdPanel(ctx, count, firstIndex, top, panelHeight, xBar, left, right, data);
    drawKdjPanel(ctx, count, firstIndex, top + panelHeight + 8, panelHeight, xBar, left, right, data);
  } else if (state.indicator === "macd") drawMacdPanel(ctx, count, firstIndex, top, height, xBar, left, right, data);
  else drawKdjPanel(ctx, count, firstIndex, top, height, xBar, left, right, data);
}

function drawMacdPanel(ctx, count, firstIndex, top, height, xBar, left, right, data) {
  const series = [data.dif, data.dea, data.macd];
  const shown = series.flatMap((values) => values.slice(firstIndex, firstIndex + count));
  const max = Math.max(...shown.map((value) => Math.abs(value)), 0.01);
  const center = top + height / 2;
  const yScale = (value) => center - (value / max) * (height * .4);
  ctx.strokeStyle = "rgba(151,178,212,.17)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, center); ctx.lineTo(right, center); ctx.stroke();
  for (let index = 0; index < count; index += 1) {
    const value = data.macd[firstIndex + index];
    const y = yScale(value);
    ctx.fillStyle = value >= 0 ? "rgba(255,119,135,.58)" : "rgba(101,215,177,.58)";
    ctx.fillRect(xBar(index) - 1.5, Math.min(center, y), 3, Math.max(1, Math.abs(center - y)));
  }
  drawIndexedLine(ctx, count, (index) => data.dif[firstIndex + index], "#f4c95d", yScale, xBar, 1.25);
  drawIndexedLine(ctx, count, (index) => data.dea[firstIndex + index], "#7da8ff", yScale, xBar, 1.25);
  const current = firstIndex + count - 1;
  drawTextSegments(ctx, 8, top + 12, [
    { text: "MACD", color: "#aebfd4" },
    { text: `DIF ${data.dif[current].toFixed(3)}`, color: "#f4c95d" },
    { text: `DEA ${data.dea[current].toFixed(3)}`, color: "#7da8ff" },
    { text: `柱 ${data.macd[current].toFixed(3)}`, color: data.macd[current] >= 0 ? "#ff7787" : "#65d7b1" },
  ]);
}

function drawKdjPanel(ctx, count, firstIndex, top, height, xBar, left, right, data) {
  const shownJ = data.j.slice(firstIndex, firstIndex + count);
  const min = Math.min(0, ...shownJ); const max = Math.max(100, ...shownJ); const range = Math.max(max - min, 1);
  const yScale = (value) => top + ((max - value) / range) * height;
  [20, 80].forEach((value) => { const y = yScale(value); ctx.strokeStyle = "rgba(151,178,212,.14)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); });
  drawIndexedLine(ctx, count, (index) => data.k[firstIndex + index], "#f4c95d", yScale, xBar, 1.2);
  drawIndexedLine(ctx, count, (index) => data.d[firstIndex + index], "#7da8ff", yScale, xBar, 1.2);
  drawIndexedLine(ctx, count, (index) => data.j[firstIndex + index], "#d18cff", yScale, xBar, 1.2);
  const current = firstIndex + count - 1;
  drawTextSegments(ctx, 8, top + 12, [
    { text: "KDJ(9,3,3)", color: "#aebfd4" },
    { text: `K ${data.k[current].toFixed(1)}`, color: "#f4c95d" },
    { text: `D ${data.d[current].toFixed(1)}`, color: "#7da8ff" },
    { text: `J ${data.j[current].toFixed(1)}`, color: "#d18cff" },
  ]);
}

function operationIndicatorSnapshot(index) {
  const indicators = indicatorData();
  const volume = volumeStats(index, indicators);
  const bar = state.bars[index];
  const chip = chipDistribution(state.bars.slice(Math.max(0, index - 249), index + 1), bar?.close);
  const intraday = state.intradayData?.[formatDate(bar?.date)];
  const intradayBars = Array.isArray(intraday?.bars) ? intraday.bars : [];
  const validIntradayVolumes = intradayBars.map((item) => Number(item.volume)).filter((value) => Number.isFinite(value) && value >= 0);
  const half = Math.floor(validIntradayVolumes.length / 2);
  const intradayFirstHalf = validIntradayVolumes.slice(0, half).reduce((sum, value) => sum + value, 0);
  const intradaySecondHalf = validIntradayVolumes.slice(half).reduce((sum, value) => sum + value, 0);
  const pick = (value, digits = 4) => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
  return {
    close: pick(bar?.close, 4),
    ma5: pick(indicators.ma5[index], 4),
    ma20: pick(indicators.ma20[index], 4),
    ma60: pick(indicators.ma60[index], 4),
    dif: pick(indicators.dif[index], 5),
    dea: pick(indicators.dea[index], 5),
    macd: pick(indicators.macd[index], 5),
    k: pick(indicators.k[index], 2),
    d: pick(indicators.d[index], 2),
    j: pick(indicators.j[index], 2),
    volumeRatio: pick(volume.ratio, 3),
    volumeSignal: String(volume.signal || ""),
    candleDirection: bar ? (bar.close > bar.open ? "收阳" : bar.close < bar.open ? "收阴" : "平收") : "",
    chipPeak: pick(chip?.peakPrice, 4),
    chipLower70: pick(chip?.lower70, 4),
    chipUpper70: pick(chip?.upper70, 4),
    chipMethod: chip ? "近250根日线OHLCV估算" : "不可用",
    intradayVolumeTotal: validIntradayVolumes.length ? pick(validIntradayVolumes.reduce((sum, value) => sum + value, 0), 2) : null,
    intradayVolumeBars: validIntradayVolumes.length,
    intradayVolumeUnit: intraday?.volumeUnit || "",
    intradayLateEarlyRatio: intradayFirstHalf > 0 ? pick(intradaySecondHalf / intradayFirstHalf, 3) : null,
    ruleVersion: effectiveReviewRuleset().version,
    jBuyThreshold: activeReviewThreshold("personal-j-low", 10),
    jSellThreshold: activeReviewThreshold("personal-j-high", 75),
  };
}

function activeReviewThreshold(id, fallback) {
  const approved = window.KLINE_RESEARCH_STATE?.approved?.[id];
  return Number.isFinite(Number(approved?.threshold)) ? Number(approved.threshold) : fallback;
}

function effectiveReviewRuleset() {
  const base = window.KLINE_REVIEW_RULESET || { version: "review-guidance-v1", rules: [] };
  const approved = Object.values(window.KLINE_RESEARCH_STATE?.approved || {});
  if (!approved.length) return base;
  const revisions = approved.map((rule) => `${rule.id}:v${rule.revision}`).sort();
  const custom = approved.filter((rule) => rule.id.startsWith("custom-")).map((rule) => ({
    id: rule.id, title: rule.title, status: `人工确认研究版本 v${rule.revision}`,
    condition: `基于 ${rule.templateId} 模板，阈值 ${rule.threshold}`,
    interpretation: "仅供复盘提示；应结合该规则的验证覆盖、量价情境和个股风险。",
    source: rule.source, url: rule.url,
  }));
  return { ...base, version: `${base.version}+${revisions.join(",")}`, rules: [...base.rules, ...custom], approvedResearch: approved.map((rule) => ({ ...rule })) };
}

function operationTradeEvidence(trade) {
  const snapshot = trade.indicators || {};
  const evidence = [];
  const j = snapshot.j == null ? NaN : Number(snapshot.j);
  const buyThreshold = snapshot.jBuyThreshold != null && Number.isFinite(Number(snapshot.jBuyThreshold)) ? Number(snapshot.jBuyThreshold) : 10;
  const sellThreshold = snapshot.jSellThreshold != null && Number.isFinite(Number(snapshot.jSellThreshold)) ? Number(snapshot.jSellThreshold) : 75;
  if (snapshot.j != null && Number.isFinite(j)) {
    if (trade.side === "buy" && j < buyThreshold) evidence.push(`J=${j.toFixed(1)}，符合当时记录的低位观察区（J<${buyThreshold}，候选）`);
    else if (trade.side === "sell" && j >= sellThreshold) evidence.push(`J=${j.toFixed(1)}，符合当时记录的高位观察区（J≥${sellThreshold}，候选）`);
    else evidence.push(`J=${j.toFixed(1)}，未触及你记录的${trade.side === "buy" ? "低位买入" : "高位卖出"}观察区`);
  } else evidence.push("当时 J 值缺失");
  const close = Number(snapshot.close);
  const ma20 = Number(snapshot.ma20);
  if (snapshot.close != null && snapshot.ma20 != null && Number.isFinite(close) && Number.isFinite(ma20) && ma20 > 0) evidence.push(close >= ma20 ? "收盘在 MA20 上方" : "收盘在 MA20 下方");
  if (snapshot.volumeSignal) evidence.push(`量能：${snapshot.volumeSignal}${snapshot.volumeRatio == null ? "" : `（${Number(snapshot.volumeRatio).toFixed(2)}倍 VOL-MA120）`}`);
  if (Number(snapshot.intradayVolumeBars) > 0) evidence.push(`分时量：${snapshot.intradayVolumeBars} 根有效数据${snapshot.intradayLateEarlyRatio == null ? "" : `，后半场/前半场 ${Number(snapshot.intradayLateEarlyRatio).toFixed(2)} 倍`}`);
  else evidence.push("当日分时量未留存");
  if (snapshot.candleDirection) evidence.push(snapshot.candleDirection);
  if (trade.decision?.intent) evidence.push("当时意图：" + trade.decision.intent);
  if (trade.decision?.certainty) evidence.push("判断状态：" + trade.decision.certainty);
  if (trade.decision?.signals?.length) evidence.push("本人选定依据：" + trade.decision.signals.join("、"));
  if (trade.decision?.confirmCondition) evidence.push("等待条件：" + trade.decision.confirmCondition);
  if (trade.decision?.invalidationCondition) evidence.push("复核条件：" + trade.decision.invalidationCondition);
  if (snapshot.chipPeak != null && Number.isFinite(Number(snapshot.chipPeak))) evidence.push(`估算成交密集峰 ¥${formatPrice(snapshot.chipPeak)}（仅背景参考）`);
  const hasReason = Boolean(String(trade.reason || "").trim());
  const plan = state.operationPlans.filter((item) => Number(item.index) <= Number(trade.index)).sort((a, b) => Number(b.index) - Number(a.index) || String(b.savedAt || "").localeCompare(String(a.savedAt || "")))[0];
  const planSignals = plan?.signals || [];
  const tags = [];
  if (hasReason) tags.push("已记录当时理由");
  if (planSignals.length) tags.push(`当时计划关注：${planSignals.join("、")}`);
  if (plan?.positionCap != null) tags.push(`计划仓位上限 ${(Number(plan.positionCap) * 100).toFixed(0)}%`);
  if (plan?.invalidationPrice != null) tags.push(`失效价 ¥${formatPrice(plan.invalidationPrice)}`);
  return { evidence, tags, hasReason, plan };
}

function renderReviewRuleReferences() {
  const ruleset = state.archiveView ? (state.archivedReviewRules || window.KLINE_REVIEW_RULESET) : state.finishedRuleSnapshot || effectiveReviewRuleset();
  const rules = ruleset?.rules || [];
  const version = ruleset?.version || "review-guidance-v1";
  const research = state.archiveView ? null : window.KLINE_RESEARCH_STATE;
  const researchStatus = state.archiveView ? "历史复盘保留当时版本，不以最新研究结果重写。" : research?.report?.status === "complete" ? "已有研究报告；请结合覆盖、留出期和幸存者偏差阅读。" : "研究数据尚未完整；当前规则均仅为候选提示。";
  const comparison = state.archiveView && state.showRuleComparison ? renderArchivedRuleComparison() : "";
  $("reviewRuleReferences").innerHTML = `<p class="review-rule-status">当前解释依据版本：${escapeHtml(version)}。${researchStatus}</p>${state.archiveView ? `<button class="secondary-button" type="button" data-compare-review-rules="true">${state.showRuleComparison ? "收起新版对照" : "与当前启用规则对照"}</button>` : ""}${comparison}${rules.map((rule) => {
    const approved = ruleset.approvedResearch?.find((item) => item.id === rule.id);
    const latest = research?.rules?.find((item) => item.id === rule.id);
    return `<article class="review-rule-item"><div><strong>${escapeHtml(rule.title)}</strong><span>${escapeHtml(approved ? `已确认研究版本 v${approved.revision}；仍须结合个股情境` : latest ? `候选研究 v${latest.revision}；未启用` : rule.status)} · ${escapeHtml(rule.condition)}</span><p>${escapeHtml(rule.interpretation)}</p><small>${escapeHtml(rule.source)}${rule.url ? ` · <a href="${escapeHtml(rule.url)}" target="_blank" rel="noopener noreferrer">查看来源</a>` : ""}</small></div></article>`;
  }).join("")}`;
}

function renderArchivedRuleComparison() {
  const approved = window.KLINE_RESEARCH_STATE?.approved || {};
  const active = Object.values(approved);
  if (!active.length) return '<p class="review-rule-status">当前没有人工确认启用的新版规则；原档案保持不变。</p>';
  const oldSnapshot = state.archivedReviewRules || { version: "旧版未记录" };
  const compareTrade = (trade) => {
    const j = Number(trade.indicators?.j);
    if (!Number.isFinite(j)) return "J 缺失，无法重评";
    const oldBuy = Number.isFinite(Number(trade.indicators?.jBuyThreshold)) ? Number(trade.indicators.jBuyThreshold) : 10;
    const oldSell = Number.isFinite(Number(trade.indicators?.jSellThreshold)) ? Number(trade.indicators.jSellThreshold) : 75;
    const newBuy = activeReviewThreshold("personal-j-low", 10);
    const newSell = activeReviewThreshold("personal-j-high", 75);
    const previous = trade.side === "buy" ? j < oldBuy : j >= oldSell;
    const current = trade.side === "buy" ? j < newBuy : j >= newSell;
    return `J=${j.toFixed(1)} · 当时${previous ? "触及" : "未触及"}观察区 → 新版${current ? "触及" : "未触及"}观察区`;
  };
  return `<div class="review-rule-item"><strong>旧版与当前启用版对照</strong><p>旧版：${escapeHtml(oldSnapshot.version)}；当前：${escapeHtml(effectiveReviewRuleset().version)}。以下仅用成交时已保存的 J 值重评观察区，不重新解释原始笔记，也不改写盈亏。</p>${state.trades.map((trade) => `<small>${escapeHtml(formatDate(state.bars[trade.index]?.date))} ${trade.side === "buy" ? "买入" : "卖出"}：${escapeHtml(compareTrade(trade))}</small>`).join("") || '<small>本局没有成交记录。</small>'}<p>量价、分时和估算密集区规则只对照研究版本与覆盖报告，不凭缺失快照追溯判断。</p></div>`;
}

function currentOperationPlan() {
  const plan = state.operationPlans.filter((item) => Number(item.index) === state.currentIndex)
    .sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")) || (Number(b.revision) || 0) - (Number(a.revision) || 0))[0] || null;
  return plan?.status === "withdrawn" ? null : plan;
}

function renderOperationPlan() {
  const plan = currentOperationPlan();
  document.querySelectorAll("[data-operation-signal]").forEach((checkbox) => {
    checkbox.checked = Boolean(plan?.signals?.includes(checkbox.dataset.operationSignal));
    checkbox.disabled = state.finished || !state.bars.length;
  });
  $("operationPositionCap").value = plan?.positionCap == null ? "" : String(plan.positionCap);
  $("operationPositionCap").disabled = state.finished || !state.bars.length;
  $("operationPlanReason").value = plan?.reason || "";
  $("operationPlanReason").disabled = state.finished || !state.bars.length;
  $("operationInvalidationPrice").value = plan?.invalidationPrice ?? "";
  $("operationInvalidationPrice").disabled = state.finished || !state.bars.length;
  $("saveOperationPlanButton").disabled = state.finished || !state.bars.length;
  $("operationPlanStatus").textContent = plan
    ? `已记录 ${plan.signals?.length || 0} 项指标${plan.positionCap == null ? "" : ` · 仓位上限 ${(plan.positionCap * 100).toFixed(0)}%`}${plan.invalidationPrice == null ? "" : ` · 失效价 ¥${formatPrice(plan.invalidationPrice)}`}`
    : "本根尚未记录计划";
  const checklist = $("nextSessionChecklist");
  checklist.hidden = !state.nextSessionChecklist.length;
  $("nextSessionChecklistItems").innerHTML = state.nextSessionChecklist.map((item) => `<li>${escapeHtml(item.text || "")}</li>`).join("");
}

function saveOperationPlan() {
  if (!state.bars.length || state.finished) return;
  const signals = [...document.querySelectorAll("[data-operation-signal]:checked")].map((item) => item.dataset.operationSignal);
  const rawCap = $("operationPositionCap").value;
  const rawInvalidation = $("operationInvalidationPrice").value.trim();
  const reason = $("operationPlanReason").value.trim().slice(0, 240);
  const positionCap = rawCap === "" ? null : Number(rawCap);
  const invalidationPrice = rawInvalidation === "" ? null : Number(rawInvalidation);
  const hasPlan = signals.length || reason || positionCap != null || (Number.isFinite(invalidationPrice) && invalidationPrice > 0);
  if (hasPlan) {
    const previous = [...state.operationPlans].reverse().find((plan) => Number(plan.index) === state.currentIndex);
    state.operationPlans.push({
      id: makeLocalId(),
      index: state.currentIndex,
      signals,
      positionCap: Number.isFinite(positionCap) ? positionCap : null,
      reason,
      invalidationPrice: Number.isFinite(invalidationPrice) && invalidationPrice > 0 ? invalidationPrice : null,
      indicators: operationIndicatorSnapshot(state.currentIndex),
      savedAt: new Date().toISOString(),
      revision: previous ? (Number(previous.revision) || 1) + 1 : 1,
      supersedes: previous?.id || null,
      status: "active",
    });
    $("operationPlanStatus").textContent = "本根计划已保存";
  } else {
    const previous = [...state.operationPlans].reverse().find((plan) => Number(plan.index) === state.currentIndex);
    if (previous && previous.status !== "withdrawn") {
      state.operationPlans.push({
        id: makeLocalId(), index: state.currentIndex, status: "withdrawn", signals: [], reason: "用户撤销本根计划",
        savedAt: new Date().toISOString(), revision: (Number(previous.revision) || 1) + 1, supersedes: previous.id,
      });
      $("operationPlanStatus").textContent = "已记录撤销本根计划；历史版本保留";
    } else {
      $("operationPlanStatus").textContent = "本根没有可撤销的计划";
    }
  }
  renderOperationPlan();
  saveDraftSession();
  if (state.finished) persistCurrentReviewArchive();
}

function atrPercentAt(index) {
  const ranges = [];
  for (let cursor = Math.max(state.trainingStartIndex, index - 13); cursor <= index; cursor += 1) {
    const bar = state.bars[cursor];
    if (!bar) continue;
    const previous = state.bars[cursor - 1] || (cursor === state.trainingStartIndex ? state.indicatorWarmupBars.at(-1) : null);
    ranges.push(Math.max(
      bar.high - bar.low,
      previous ? Math.abs(bar.high - previous.close) : 0,
      previous ? Math.abs(bar.low - previous.close) : 0,
    ));
  }
  const close = Number(state.bars[index]?.close);
  if (!ranges.length || !(close > 0)) return 0;
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length / close;
}

function operationWaveBoundaries() {
  const start = Math.max(0, state.trainingStartIndex);
  const end = Math.min(state.trainingEndIndex, state.bars.length - 1);
  if (end <= start) return [{ index: start, type: "区间起点", price: Number(state.bars[start]?.close) || 0 }];
  const candidates = [];
  for (let index = start + 3; index <= end - 3; index += 1) {
    const close = Number(state.bars[index]?.close);
    if (!(close > 0)) continue;
    const nearby = state.bars.slice(index - 3, index + 4).map((bar) => Number(bar.close));
    if (close === Math.max(...nearby) && nearby.some((value, offset) => offset !== 3 && value < close)) candidates.push({ index, type: "高点", price: close });
    if (close === Math.min(...nearby) && nearby.some((value, offset) => offset !== 3 && value > close)) candidates.push({ index, type: "低点", price: close });
  }
  candidates.sort((a, b) => a.index - b.index);
  const alternating = [];
  candidates.forEach((point) => {
    const previous = alternating.at(-1);
    if (previous?.type === point.type) {
      if ((point.type === "高点" && point.price > previous.price) || (point.type === "低点" && point.price < previous.price)) alternating[alternating.length - 1] = point;
    } else alternating.push(point);
  });
  const boundaries = [{ index: start, type: "区间起点", price: Number(state.bars[start].close) }];
  alternating.forEach((point) => {
    const previous = boundaries.at(-1);
    const amplitude = Math.abs(point.price - previous.price) / Math.max(previous.price, 0.01);
    const minimumAmplitude = Math.max(0.05, 1.5 * atrPercentAt(previous.index));
    if (point.index - previous.index >= 5 && amplitude >= minimumAmplitude) boundaries.push(point);
  });
  boundaries.push({ index: end, type: "区间终点", price: Number(state.bars[end].close) });
  return boundaries;
}

function buildOperationTimeline() {
  const start = Math.max(0, state.trainingStartIndex);
  const end = Math.min(state.trainingEndIndex, state.bars.length - 1);
  let cash = initialCash;
  let realized = 0;
  let cumulativeFees = 0;
  const lots = [];
  const timeline = new Map();
  const tradesByIndex = new Map();
  state.trades.forEach((trade) => {
    const index = Number(trade.index);
    if (!Number.isInteger(index) || index < start || index > end) return;
    if (!tradesByIndex.has(index)) tradesByIndex.set(index, []);
    tradesByIndex.get(index).push(trade);
  });
  for (let index = start; index <= end; index += 1) {
    let dayFees = 0;
    (tradesByIndex.get(index) || []).forEach((trade) => {
      const qty = Math.max(0, Number(trade.qty) || 0);
      const price = Math.max(0, Number(trade.price) || 0);
      const fee = Math.max(0, Number(trade.fee) || 0);
      dayFees += fee;
      cumulativeFees += fee;
      if (trade.side === "buy") {
        cash -= qty * price + fee;
        lots.push({ id: trade.lotId || trade.id, qty, price, feePerShare: qty ? fee / qty : 0, role: trade.lotRole || "", purpose: trade.lotPurpose || "", exitRule: trade.lotExitRule || "" });
      } else {
        cash += qty * price - fee;
        const result = consumeTradeAllocations(lots, trade);
        realized += result.realizedBeforeSellFee - fee;
      }
    });
    const bar = state.bars[index];
    const positionQty = lots.reduce((sum, lot) => sum + lot.qty, 0);
    const positionValue = positionQty * bar.close;
    const unrealized = lots.reduce((sum, lot) => sum + (bar.close - lot.price - lot.feePerShare) * lot.qty, 0);
    const equity = cash + positionValue;
    timeline.set(index, { cash, positionQty, positionValue, equity, realized, unrealized, cumulativeFees, dayFees, trades: tradesByIndex.get(index) || [] });
  }
  return timeline;
}

function operationReviewData() {
  const boundaries = operationWaveBoundaries();
  const timeline = buildOperationTimeline();
  const startIndex = Math.max(0, state.trainingStartIndex);
  const waves = [];
  for (let cursor = 0; cursor < boundaries.length - 1; cursor += 1) {
    const left = boundaries[cursor];
    const right = boundaries[cursor + 1];
    if (right.index <= left.index) continue;
    const firstWave = cursor === 0;
    const baseline = firstWave ? { equity: initialCash, realized: 0, unrealized: 0, positionQty: 0, positionValue: 0 } : timeline.get(left.index);
    const finish = timeline.get(right.index);
    if (!baseline || !finish) continue;
    const tradeStart = firstWave ? left.index : left.index + 1;
    const trades = state.trades.filter((trade) => trade.index >= tradeStart && trade.index <= right.index);
    const equitySeries = [];
    if (firstWave) equitySeries.push(initialCash);
    for (let index = tradeStart; index <= right.index; index += 1) {
      const snapshot = timeline.get(index);
      if (snapshot) equitySeries.push(snapshot.equity);
    }
    let peak = baseline.equity;
    let maxDrawdown = 0;
    equitySeries.forEach((value) => {
      peak = Math.max(peak, value);
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
    });
    const peakExposure = equitySeries.length
      ? Math.max(...Array.from({ length: right.index - tradeStart + 1 }, (_, offset) => {
        const snapshot = timeline.get(tradeStart + offset);
        return snapshot?.equity > 0 ? snapshot.positionValue / snapshot.equity : 0;
      }))
      : 0;
    const priceStart = Number(state.bars[left.index]?.close) || left.price;
    const priceEnd = Number(state.bars[right.index]?.close) || right.price;
    const netChange = finish.equity - baseline.equity;
    const realizedChange = finish.realized - baseline.realized;
    const unrealizedChange = finish.unrealized - baseline.unrealized;
    const newestPlanFirst = (a, b) => Number(b.index) - Number(a.index) || String(b.savedAt || "").localeCompare(String(a.savedAt || "")) || (Number(b.revision) || 0) - (Number(a.revision) || 0);
    const priorPlan = state.operationPlans.filter((plan) => Number(plan.index) <= left.index).sort(newestPlanFirst)[0];
    const plans = [...(priorPlan ? [priorPlan] : []), ...state.operationPlans.filter((plan) => Number(plan.index) >= tradeStart && Number(plan.index) <= right.index)];
    const violations = [];
    for (let index = tradeStart; index <= right.index; index += 1) {
      const snapshot = timeline.get(index);
      if (!snapshot) continue;
      const plan = state.operationPlans.filter((item) => Number(item.index) <= index).sort(newestPlanFirst)[0];
      if (plan?.positionCap != null && snapshot.equity > 0 && snapshot.positionValue / snapshot.equity > Number(plan.positionCap) + 0.02) {
        violations.push({ type: "仓位超过计划上限", index, actual: snapshot.positionValue / snapshot.equity, planned: Number(plan.positionCap) });
        break;
      }
      if (plan?.status !== "withdrawn" && plan?.invalidationPrice != null && snapshot.positionQty > 0 && Number(state.bars[index]?.close) <= Number(plan.invalidationPrice)) {
        violations.push({ type: "收盘触及计划失效价，需复核持仓处理", index, price: Number(plan.invalidationPrice) });
        break;
      }
    }
    const reasons = [];
    if (netChange < -0.01) reasons.push(`本段账户净值下降 ${formatMoney(Math.abs(netChange))}`);
    if (maxDrawdown >= 0.05) reasons.push(`本段最大回撤 ${(maxDrawdown * 100).toFixed(2)}%`);
    violations.forEach((item) => reasons.push(item.type));
    waves.push({
      id: `${left.index}-${right.index}`,
      startIndex: left.index, endIndex: right.index,
      startDate: formatDate(state.bars[left.index].date), endDate: formatDate(state.bars[right.index].date),
      startPrice: priceStart, endPrice: priceEnd,
      priceChange: priceStart > 0 ? (priceEnd / priceStart - 1) * 100 : 0,
      netChange, realizedChange, unrealizedChange,
      maxDrawdown: maxDrawdown * 100,
      startQty: baseline.positionQty, endQty: finish.positionQty,
      peakExposure: peakExposure * 100,
      fees: trades.reduce((sum, trade) => sum + (Number(trade.fee) || 0), 0),
      trades, plans, violations, reasons,
      trend: priceEnd > priceStart ? "上行波段" : priceEnd < priceStart ? "下行波段" : "横盘波段",
    });
  }
  return waves;
}

function buildOperationSuggestions(waves) {
  const suggestions = [];
  let activeWaveId = "";
  const add = (id, title, text, evidence, category = "操作过程") => {
    const existing = suggestions.find((item) => item.id === id);
    if (existing) {
      existing.evidence = [...new Set([...existing.evidence.split("；"), evidence])].filter(Boolean).join("；");
      if (activeWaveId && !existing.waveIds.includes(activeWaveId)) existing.waveIds.push(activeWaveId);
      return;
    }
    suggestions.push({ id, title, text, evidence, category, evidenceStatus: category === "记录或数据不足" || category === "证据核对" ? "记录不完整，限于当前可见数据" : "本局可核对事实；不代表策略有效性", waveIds: activeWaveId ? [activeWaveId] : [] });
  };
  waves.forEach((wave) => {
    activeWaveId = wave.id;
    const firstViolation = wave.violations[0];
    if (firstViolation?.type === "仓位超过计划上限") {
      add("position-cap", "核对总仓位与预设上限", `第 ${wave.startDate} 至 ${wave.endDate} 波段的最高持仓约 ${(firstViolation.actual * 100).toFixed(0)}%，高于记录的 ${(firstViolation.planned * 100).toFixed(0)}% 上限。回看触发时仓位变化及原定处理方式。`, `触发日 ${formatDate(state.bars[firstViolation.index].date)}；账户净值变化 ${formatMoney(wave.netChange)}。`, "仓位与批次管理");
    }
    if (firstViolation?.type === "收盘触及计划失效价，需复核持仓处理") {
      add("invalidation", "触发复核条件后回看处理过程", `第 ${wave.startDate} 至 ${wave.endDate} 波段中，收盘价触及记录的复核价 ¥${formatPrice(firstViolation.price)}。这表示需要回看当时可用的处理方式，不等于必须立即清仓；请结合原计划、T+1和实际可卖数量判断。`, `触发日 ${formatDate(state.bars[firstViolation.index].date)}；段内仍持有 ${timelinePositionQty(wave, firstViolation.index).toLocaleString()} 股。`, "持有、减仓与退出");
    }
    if ((wave.netChange < -0.01 || wave.maxDrawdown >= 5) && !wave.plans.some((plan) => plan.invalidationPrice != null)) {
      add("risk-plan", "下次把风险取舍写具体", `第 ${wave.startDate} 至 ${wave.endDate} 波段账户净值变化 ${formatMoney(wave.netChange)}。当前没有记录仓位或失效计划，因此无法判断风险是否超出你的预期；下一次可写下愿意承受的风险和重新评估条件。`, `段内最大回撤 ${wave.maxDrawdown.toFixed(2)}%；发生 ${wave.trades.length} 笔成交。`, "仓位与批次管理");
    }
    const unannotated = wave.trades.some((trade) => !String(trade.reason || "").trim());
    if (wave.netChange < -0.01 && unannotated) {
      add("trade-reason", "补足决策记录，避免复盘靠猜", `该波段有成交缺少当时理由。只标记为依据不足，不据此判断操作错误；下次可选意图、指标和风险条件，复盘时便能还原决策过程。`, `相关成交 ${wave.trades.filter((trade) => !String(trade.reason || "").trim()).length} 笔未填写理由。`, "记录或数据不足");
    }
    const conflictingPersonalZone = wave.trades.find((trade) => {
      const rawJ = trade.indicators?.j;
      const j = rawJ == null ? NaN : Number(rawJ);
      const buyThreshold = trade.indicators?.jBuyThreshold != null && Number.isFinite(Number(trade.indicators.jBuyThreshold)) ? Number(trade.indicators.jBuyThreshold) : 10;
      const sellThreshold = trade.indicators?.jSellThreshold != null && Number.isFinite(Number(trade.indicators.jSellThreshold)) ? Number(trade.indicators.jSellThreshold) : 75;
      return Number.isFinite(j) && ((trade.side === "buy" && j >= sellThreshold) || (trade.side === "sell" && j < buyThreshold));
    });
    if (conflictingPersonalZone) {
      const j = Number(conflictingPersonalZone.indicators.j);
      const direction = conflictingPersonalZone.side === "buy" ? "买入" : "卖出";
      const buyThreshold = conflictingPersonalZone.indicators?.jBuyThreshold ?? 10;
      const sellThreshold = conflictingPersonalZone.indicators?.jSellThreshold ?? 75;
      add("personal-j-context", "结合其他信息解释J值与操作", `${formatDate(state.bars[conflictingPersonalZone.index].date)}${direction}时 J=${j.toFixed(1)}，处于个人记录区间之外。这不自动代表操作错误；回看量价、价格位置、仓位安排及是否有新依据。`, "J阈值是个人候选观察条件，不代表已验证交易优势。", "指标理解与证据冲突");
    }
    const contradictoryVolume = wave.trades.find((trade) => {
      const snapshot = trade.indicators || {};
      return trade.side === "buy" && snapshot.candleDirection === "收阴" && /明显放量|近20日天量/.test(snapshot.volumeSignal || "")
        || trade.side === "sell" && snapshot.candleDirection === "收阳" && /明显放量|近20日天量/.test(snapshot.volumeSignal || "");
    });
    if (contradictoryVolume) {
      add("volume-context", "把量能放回价格情境中解释", `${formatDate(state.bars[contradictoryVolume.index].date)}的K线${contradictoryVolume.indicators.candleDirection}，同时相对量能为${contradictoryVolume.indicators.volumeSignal}。回看收盘位置、用户标记的关键位及当时可见的分时量；仅凭放量不能判定操作对错。`, "量价作为情境证据，不设跨标的通用买卖门槛。", "指标理解与证据冲突");
    }
    const unclear = wave.trades.find((trade) => trade.decision?.certainty === "不确定" || trade.decision?.certainty === "有冲突" || /不确定|拿不准|犹豫|看不清/.test(String(trade.reason || "")));
    if (unclear) add("decision-uncertainty", "回看当时最不确定的判断", `第 ${wave.startDate} 至 ${wave.endDate} 波段中，${formatDate(state.bars[unclear.index].date)}的记录标记了判断不确定或有冲突。可以进一步区分：指标冲突、位置判断、仓位大小或退出条件。`, "按当时记录触发针对性提问；不推测未写下的想法。", "指标理解与证据冲突");
    if (wave.trades.length && wave.trades.every((trade) => String(trade.reason || "").trim() && trade.decision?.intent)) {
      add("decision-recording-positive", "值得保持：操作理由有记录", `第 ${wave.startDate} 至 ${wave.endDate} 波段的 ${wave.trades.length} 笔成交都记录了理由和操作意图，后续可以逐笔核对当时依据与结果，而不必事后猜测。`, "记录完整度是复盘条件，不代表交易结果或策略有效。", "值得保持的做法");
    }
  });
  activeWaveId = "";
  return suggestions;
}

function timelinePositionQty(wave, index) {
  const snapshot = buildOperationTimeline().get(index);
  return snapshot?.positionQty || 0;
}

function toggleNextSessionSuggestion(suggestionId, checked) {
  const all = buildOperationSuggestions(operationReviewData());
  const suggestion = all.find((item) => item.id === suggestionId);
  if (!suggestion) return;
  const selected = new Set(state.reviewSuggestionSelections);
  if (checked) selected.add(suggestionId); else selected.delete(suggestionId);
  state.reviewSuggestionSelections = [...selected];
  state.nextSessionChecklist = all.filter((item) => selected.has(item.id)).map((item) => ({ id: item.id, text: `${item.title}：${item.text}` }));
  renderOperationPlan();
  saveDraftSession();
  if (state.finished) persistCurrentReviewArchive();
}

function renderOperationReview() {
  const panel = $("operationReview");
  panel.hidden = !state.finished;
  if (!state.finished) return;
  const waves = operationReviewData();
  const suggestions = buildOperationSuggestions(waves);
  const totalFees = state.trades.reduce((sum, trade) => sum + (Number(trade.fee) || 0), 0);
  const focused = waves.filter((wave) => wave.reasons.length).length;
  renderReviewRuleReferences();
  renderRuleCardCatalog();
  $("waveAnnotationControl").hidden = false;
  $("waveAnnotationToggle").checked = state.showWaveAnnotations;
  $("allWavesButton").hidden = state.waveOverview;
  $("operationReviewSummary").textContent = `共 ${waves.length} 个价格波段、${state.trades.length} 笔成交；累计费用 ${formatMoney(totalFees)}。重点复盘按账户变化、回撤和计划执行事实筛选；盈利不代表操作一定合理，亏损也不直接代表操作错误。${focused ? ` 当前有 ${focused} 段建议优先查看。` : " 空仓波段只展示走势，不作为操作失误。"}`;
  $("operationSuggestions").innerHTML = suggestions.length ? suggestions.map((item) => {
    const selected = state.reviewSuggestionSelections.includes(item.id);
    return `<article class="operation-suggestion"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p><small>证据状态：${escapeHtml(item.evidenceStatus)} · ${escapeHtml(item.evidence)}</small></div><label><input type="checkbox" data-next-suggestion="${escapeHtml(item.id)}" ${selected ? "checked" : ""} /> 加入下局检查项</label></article>`;
  }).join("") : '<p class="operation-review-empty">当前没有可由本局数据支持的改进建议。你仍可按波段回看交易、费用和仓位变化。</p>';
  if (suggestions.length) {
    const groupedCards = new Map();
    [...$("operationSuggestions").querySelectorAll(".operation-suggestion")].forEach((card, index) => {
      const item = suggestions[index];
      if (!groupedCards.has(item.category)) groupedCards.set(item.category, []);
      const references = item.waveIds.map((id) => waves.findIndex((wave) => wave.id === id) + 1).filter((number) => number > 0);
      if (references.length) card.querySelector("small").textContent += ` · 相关波段 ${[...new Set(references)].join("、")}`;
      groupedCards.get(item.category).push(card);
    });
    $("operationSuggestions").replaceChildren(...[...groupedCards.entries()].map(([category, cards]) => {
      const section = document.createElement("section");
      section.className = "review-category";
      const heading = document.createElement("h4");
      heading.textContent = category;
      section.append(heading, ...cards);
      return section;
    }));
  }
  $("operationWaves").innerHTML = waves.map((wave, index) => `
    <article class="operation-wave ${wave.reasons.length ? "needs-review" : ""} ${wave.id === state.focusedWaveId ? "is-focused" : ""}">
      <div class="operation-wave-heading"><div><strong>${index + 1}. ${wave.trend}</strong><span>${escapeHtml(wave.startDate)} 至 ${escapeHtml(wave.endDate)}</span></div><div class="operation-wave-actions"><em>${wave.reasons.length ? "重点复盘" : wave.trades.length ? "操作记录" : "本段无成交"}</em><button class="secondary-button wave-focus-button" type="button" data-focus-wave="${index}">定位K线</button></div></div>
      <div class="operation-wave-metrics">
        <div><span>价格变化</span><strong>${wave.priceChange >= 0 ? "+" : ""}${wave.priceChange.toFixed(2)}%</strong></div>
        <div><span>账户净值变化</span><strong>${formatMoney(wave.netChange)}</strong></div>
        <div><span>已实现 / 未实现</span><strong>${formatMoney(wave.realizedChange)} / ${formatMoney(wave.unrealizedChange)}</strong></div>
        <div><span>最大回撤</span><strong>${wave.maxDrawdown.toFixed(2)}%</strong></div>
        <div><span>持仓股数</span><strong>${wave.startQty.toLocaleString()} → ${wave.endQty.toLocaleString()}</strong></div>
        <div><span>最高仓位 / 费用</span><strong>${wave.peakExposure.toFixed(1)}% / ${formatMoney(wave.fees)}</strong></div>
      </div>
      <div class="operation-wave-trades">${wave.trades.length ? wave.trades.map((trade) => {
        const tradeIndex = state.trades.indexOf(trade);
        const tradeEvidence = operationTradeEvidence(trade);
        const trancheInfo = trade.side === "buy" ? (trade.lotRole ? ` · ${trade.lotRole}批次` : "") : tradeAllocationLabel(trade) ? ` · 扣减：${tradeAllocationLabel(trade)}` : "";
        return `<div class="operation-trade-review-row ${tradeIndex === state.focusedTradeIndex ? "is-focused" : ""}"><div class="operation-trade-review-copy"><p><b>${formatDate(state.bars[trade.index].date)} ${trade.side === "buy" ? "买入" : "卖出"}</b> ${trade.qty.toLocaleString()} 股 · ¥${formatPrice(trade.price)} · 费用 ${formatMoney(trade.fee)}${trancheInfo}${trade.reason ? ` · 当时记录：${escapeHtml(trade.reason)}` : " · 依据待补齐"}</p><small>当时可见：${tradeEvidence.evidence.map(escapeHtml).join(" · ") || "数据不足"}</small>${tradeEvidence.tags.length ? `<small class="operation-trade-process">过程记录：${tradeEvidence.tags.map(escapeHtml).join(" · ")}</small>` : ""}</div><button class="secondary-button wave-focus-button" type="button" data-focus-trade="${tradeIndex}">定位成交</button><button class="secondary-button wave-focus-button" type="button" data-note-trade="${escapeHtml(trade.id)}">笔记</button></div>`;
      }).join("") : wave.startQty || wave.endQty ? `<p>本段没有成交，持仓由 ${wave.startQty.toLocaleString()} 股变为 ${wave.endQty.toLocaleString()} 股；收益计入账户净值变化。</p>` : "<p>本段空仓；未参与上涨不自动判为失误。</p>"}</div>
      ${wave.plans.length ? `<div class="operation-wave-plans"><b>已记录计划：</b>${wave.plans.map((plan) => `<p>${formatDate(state.bars[plan.index].date)} · ${escapeHtml(plan.signals.join("、") || "未选指标")}${plan.positionCap == null ? "" : ` · 仓位上限 ${(plan.positionCap * 100).toFixed(0)}%`}${plan.invalidationPrice == null ? "" : ` · 收盘失效价 ¥${formatPrice(plan.invalidationPrice)}`} ${plan.reason ? `· ${escapeHtml(plan.reason)}` : ""}</p>`).join("")}</div>` : ""}
      ${wave.trades.length && wave.trades.every((trade) => String(trade.reason || "").trim()) ? `<p class="operation-wave-process"><b>过程记录完整：</b>本段每笔成交都保存了当时理由，判断依据可以和后续结果分开核对。</p>` : wave.trades.some((trade) => String(trade.reason || "").trim()) ? `<p class="operation-wave-process"><b>过程记录：</b>${wave.trades.filter((trade) => String(trade.reason || "").trim()).length}/${wave.trades.length} 笔成交记录了当时理由；未记录的部分无法还原主观判断。</p>` : ""}
      ${wave.reasons.length ? `<p class="operation-wave-reasons"><b>复盘依据：</b>${wave.reasons.map(escapeHtml).join("；")}</p>` : ""}
      ${(state.reviewNotes || []).filter((item) => item.targetType === "wave" && item.targetId === wave.id).map((item) => `<p class="trade-log-reason"><b>复盘补记：</b>${escapeHtml(item.text)} <small>${escapeHtml(new Date(item.createdAt).toLocaleString())}</small></p>`).join("")}
      <button class="text-button" type="button" data-note-wave="${escapeHtml(wave.id)}" data-note-index="${wave.endIndex}">追加本波段复盘</button>
    </article>`).join("") || '<p class="operation-review-empty">训练区间不足以划分价格波段。</p>';
}

function renderRuleCardCatalog() {
  const target = $("reviewRuleCardCatalog");
  if (!target) return;
  const ruleset = state.archivedReviewRules || state.finishedRuleSnapshot || window.KLINE_REVIEW_RULESET;
  const cards = Array.isArray(ruleset?.cards) ? ruleset.cards : window.KLINE_REVIEW_RULESET?.cards || [];
  const groups = new Map([["J", "KDJ"], ["V", "量价"], ["M", "均线"], ["C", "估算成交密集区"], ["I", "分时量价"], ["R", "仓位与执行"], ["N", "笔记与结果"]]);
  target.innerHTML = [...groups.entries()].map(([prefix, title]) => {
    const items = cards.filter((card) => card.id.startsWith(prefix));
    return '<section class="review-category"><h4>' + title + '（' + items.length + '）</h4>' + items.map((card) => '<article class="review-rule-item"><div><strong>' + escapeHtml(card.id + " · " + card.title) + '</strong><span>' + escapeHtml(card.status) + '</span><p>' + escapeHtml(card.interpretation) + '</p></div></article>').join("") + '</section>';
  }).join("");
}

function focusOperationWave(waveIndex) {
  if (!state.finished) return;
  const wave = operationReviewData()[Number(waveIndex)];
  if (!wave) return;
  const bars = currentBars();
  const chartStartIndex = Math.max(0, state.trainingStartIndex - contextBarCount);
  const span = wave.endIndex - wave.startIndex + 1;
  const canvasWidth = $("chartCanvas").getBoundingClientRect().width;
  const chipWidth = state.showChip ? Math.min(132, Math.max(88, canvasWidth * .17)) : 0;
  const plotWidth = Math.max(80, canvasWidth - 48 - 14 - chipWidth - (state.showChip ? 8 : 0));
  const readableFocusBars = Math.max(minChartBars, Math.floor(plotWidth / 6.5));
  const focusBars = Math.max(minChartBars, Math.min(maxChartBars, span + 12, window.innerWidth < 760 ? readableFocusBars : maxChartBars));
  const desiredStart = wave.startIndex - chartStartIndex + Math.floor((span - focusBars) / 2);
  const maxStart = Math.max(0, bars.length - Math.min(focusBars, bars.length));
  const start = Math.max(0, Math.min(maxStart, desiredStart));
  state.waveOverview = false;
  state.focusedWaveId = wave.id;
  state.focusedTradeIndex = null;
  state.chartZoomExplicit = true;
  state.chartBars = focusBars;
  state.chartOffset = Math.max(0, bars.length - Math.min(focusBars, bars.length) - start);
  renderOperationReview();
  drawChart();
  $("chartCanvas").scrollIntoView({ behavior: "smooth", block: "center" });
}

function focusOperationTrade(tradeIndex) {
  if (!state.finished) return;
  const index = Number(tradeIndex);
  const trade = state.trades[index];
  if (!trade) return;
  const bars = currentBars();
  const chartStartIndex = Math.max(0, state.trainingStartIndex - contextBarCount);
  const canvasWidth = $("chartCanvas").getBoundingClientRect().width;
  const chipWidth = state.showChip ? Math.min(132, Math.max(88, canvasWidth * .17)) : 0;
  const plotWidth = Math.max(80, canvasWidth - 48 - 14 - chipWidth - (state.showChip ? 8 : 0));
  const readableFocusBars = Math.max(minChartBars, Math.floor(plotWidth / 6.5));
  const focusBars = Math.min(maxChartBars, bars.length, window.innerWidth < 760 ? readableFocusBars : 55);
  const desiredStart = trade.index - chartStartIndex - Math.floor(focusBars / 2);
  const start = Math.max(0, Math.min(Math.max(0, bars.length - focusBars), desiredStart));
  const wave = operationReviewData().find((item) => item.trades.includes(trade));
  state.waveOverview = false;
  state.focusedWaveId = wave?.id || null;
  state.focusedTradeIndex = index;
  state.chartZoomExplicit = true;
  state.chartBars = focusBars;
  state.chartOffset = Math.max(0, bars.length - focusBars - start);
  renderOperationReview();
  drawChart();
  $("chartCanvas").scrollIntoView({ behavior: "smooth", block: "center" });
}

function showAllOperationWaves() {
  if (!state.finished) return;
  state.waveOverview = true;
  state.focusedWaveId = null;
  state.focusedTradeIndex = null;
  state.chartBars = Math.min(maxChartBars, Math.max(defaultChartBars, trainingLength()));
  state.chartZoomExplicit = false;
  state.chartOffset = 0;
  renderOperationReview();
  drawChart();
  $("chartCanvas").scrollIntoView({ behavior: "smooth", block: "center" });
}

function sessionStats() {
  let cash = initialCash;
  let lots = [];
  let realized = 0;
  let fees = 0;
  let closedTrades = 0;
  let winningTrades = 0;
  let peak = initialCash;
  let maxDrawdown = 0;
  const start = Math.max(0, state.trainingStartIndex);
  const end = Math.max(start, state.trainingEndIndex);
  for (let index = start; index <= end; index += 1) {
    state.trades.filter((tradeItem) => tradeItem.index === index).forEach((tradeItem) => {
      const tradeFee = Number(tradeItem.fee) || 0;
      fees += tradeFee;
      if (tradeItem.side === "buy") {
        cash -= tradeItem.qty * tradeItem.price + tradeFee;
        lots.push({ id: tradeItem.lotId || tradeItem.id, qty: tradeItem.qty, price: tradeItem.price, feePerShare: tradeFee / tradeItem.qty, role: tradeItem.lotRole || "", purpose: tradeItem.lotPurpose || "", exitRule: tradeItem.lotExitRule || "" });
      } else {
        cash += tradeItem.qty * tradeItem.price - tradeFee;
        const result = consumeTradeAllocations(lots, tradeItem);
        const tradePnl = result.realizedBeforeSellFee - tradeFee;
        realized += tradePnl;
        closedTrades += 1;
        if (tradePnl > 0) winningTrades += 1;
      }
    });
    const bar = state.bars[index];
    const mark = bar ? lots.reduce((sum, lot) => sum + lot.qty * bar.close, 0) : 0;
    const total = cash + mark;
    peak = Math.max(peak, total);
    maxDrawdown = Math.max(maxDrawdown, peak ? (peak - total) / peak : 0);
  }
  const finalBar = state.bars[end] || currentBar();
  const finalEquity = cash + lots.reduce((sum, lot) => sum + lot.qty * finalBar.close, 0);
  return {
    returnRate: ((finalEquity - initialCash) / initialCash) * 100,
    maxDrawdown: maxDrawdown * 100,
    winRate: closedTrades ? (winningTrades / closedTrades) * 100 : 0,
    tradeCount: state.trades.length,
    fees,
    realized,
  };
}

function renderResultStats() {
  const visible = state.finished;
  $("resultStats").hidden = !visible;
  if (!visible) return;
  const stats = sessionStats();
  $("resultReturnValue").textContent = `${stats.returnRate >= 0 ? "+" : ""}${stats.returnRate.toFixed(2)}%`;
  $("resultReturnValue").style.color = stats.returnRate >= 0 ? "var(--accent)" : "var(--red)";
  $("resultDrawdownValue").textContent = `${stats.maxDrawdown.toFixed(2)}%`;
  $("resultWinRateValue").textContent = stats.tradeCount && state.trades.some((item) => item.side === "sell") ? `${stats.winRate.toFixed(0)}%` : "—";
  $("resultTradeCountValue").textContent = `${stats.tradeCount} 笔`;
  $("resultFeeValue").textContent = formatMoney(stats.fees);
  $("resultRealizedValue").textContent = formatMoney(stats.realized);
}

function render() {
  if (!state.bars.length || state.trainingEndIndex < state.trainingStartIndex) {
    $("dataStatus").textContent = "尚未载入真实行情。";
    $("symbolTitle").textContent = "训练标的 · 未载入";
    $("dateLabel").textContent = "请先获取真实行情、导入 CSV 或从已审核样本开始训练";
    ["buyButton", "sellButton", "nextButton", "previousButton", "finishButton"].forEach((id) => { if ($(id)) $(id).disabled = true; });
    document.querySelectorAll("[data-quick-side]").forEach((button) => { button.disabled = true; });
    $("currentPrice").textContent = "—";
    $("equityValue").textContent = formatMoney(initialCash);
    $("cashValue").textContent = formatMoney(initialCash);
    $("positionValue").textContent = "¥0.00";
    $("pnlValue").textContent = "¥0.00";
    $("positionText").textContent = "0 股";
    $("availableValue").textContent = "0 股";
    renderTrancheManager();
    renderTradePreview();
    $("barProgress").textContent = "尚未开始训练";
    $("stepCount").textContent = "0 / 0";
    $("progressBar").style.width = "0%";
    $("resultReveal").hidden = true;
    $("operationReview").hidden = true;
    renderOperationPlan();
    drawChart();
    renderLibrary();
    return;
  }
  $("archiveViewBanner").hidden = !state.archiveView;
  ["fetchMarketButton", "collectSamplesButton", "importButton", "importSessionButton", "resetButton", "modeSelect", "trainingAreaSelect", "tradingRuleSelect", "indicatorSelect", "identityToggle", "chipToggle", "saveOperationPlanButton", "operationPlanReason", "operationInvalidationPrice", "operationPositionCap"].forEach((id) => { if ($(id)) $(id).disabled = Boolean(state.archiveView); });
  ["quantityInput", "sellLotSelect", "tradeReasonInput", "trancheRoleInput", "tranchePurposeInput", "trancheExitInput"].forEach((id) => { if ($(id)) $(id).disabled = Boolean(state.finished || state.archiveView); });
  const bar = currentBar(); const qty = heldQty(); const equityNow = equity();
  $("equityValue").textContent = formatMoney(equityNow); $("cashValue").textContent = formatMoney(state.cash); $("positionValue").textContent = formatMoney(positionValue());
  $("pnlValue").textContent = formatMoney(floatingPnl()); $("pnlValue").style.color = floatingPnl() >= 0 ? "var(--accent)" : "var(--red)";
  $("returnValue").textContent = `收益率 ${returnRate().toFixed(2)}%`; $("currentPrice").textContent = formatPrice(bar.close); $("positionText").textContent = `${qty.toLocaleString()} 股`;
  $("avgCostValue").textContent = state.avgCost ? formatPrice(state.avgCost) : "¥0.00"; $("availableValue").textContent = `${availableQty().toLocaleString()} 股`;
  renderTrancheManager();
  renderTradePreview();
  const progress = shownBarCount(); const total = trainingLength();
  $("barProgress").textContent = `第 ${progress} 根 / ${total} 根`; $("stepCount").textContent = `${progress} / ${total}`;
  $("progressBar").style.width = `${(progress / total) * 100}%`;
  const identityVisible = state.showIdentity || state.finished || state.mode === "daily";
  $("timeframeTag").textContent = { daily: "日线", weekly: "周线", monthly: "月线", yearly: "年线" }[state.dataMeta?.period] || "日线";
  $("symbolTitle").textContent = identityVisible ? `${state.symbol} · ${sourceLabel()}` : "训练标的 · 隐藏";
  $("dateLabel").textContent = identityVisible ? `${formatDate(bar.date)} · 当前收盘 ${formatPrice(bar.close)}` : "日期已隐藏 · 训练结束后揭晓";
  const indicators = indicatorData(); const i = state.currentIndex;
  const volume = volumeStats(i, indicators);
  const chip = chipDistribution(state.bars.slice(Math.max(0, i - 249), i + 1), bar.close);
  $("ma5Value").textContent = formatIndicatorPrice(indicators.ma5[i]); $("ma20Value").textContent = formatIndicatorPrice(indicators.ma20[i]); $("ma60Value").textContent = formatIndicatorPrice(indicators.ma60[i]);
  $("macdValue").textContent = round(indicators.macd[i], 3).toFixed(3); $("kdjValue").textContent = `${round(indicators.k[i], 1)} / ${round(indicators.d[i], 1)} / ${round(indicators.j[i], 1)}`; $("volumeValue").textContent = formatVolume(bar.volume);
  $("volumeMa120Value").textContent = formatVolume(volume.ma120); $("volumeMa250Value").textContent = formatVolume(volume.ma250);
  $("volumeSignalValue").textContent = volume.ratio == null ? volume.signal : `${volume.signal} · ${volume.ratio.toFixed(2)}倍`;
  $("volumeSignalValue").style.color = /天量|放量/.test(volume.signal) ? "var(--red)" : /地量|缩量/.test(volume.signal) ? "var(--green)" : "var(--text)";
  $("chipPeakValue").textContent = chip ? formatPrice(chip.peakPrice) : "—";
  $("chipAverageValue").textContent = chip ? `${formatPrice(chip.average)} · 现价下方估算成交量权重 ${(chip.profitRatio * 100).toFixed(0)}%` : "—";
  $("chipRangeValue").textContent = chip ? `${formatPrice(chip.lower70)}–${formatPrice(chip.upper70)}` : "—";
  $("tradeCount").textContent = `${state.trades.length} 笔`; $("nextButton").disabled = state.finished; $("previousButton").disabled = state.archiveView || state.currentIndex <= firstTrainingDecisionIndex() || state.trades.some((item) => item.index > state.currentIndex - 1);
  $("finishButton").disabled = state.finished;
  $("buyButton").disabled = state.finished;
  $("sellButton").disabled = state.finished;
  document.querySelectorAll("[data-quick-side]").forEach((button) => { button.disabled = state.finished; });
  if (state.finished) setHint("本局已结束，请点击重新开始后再交易。", true);
  $("finishOverlay").hidden = true;
  renderResultReveal();
  renderResultStats();
  renderOperationPlan();
  renderOperationReview();
  $("tradeLogBody").innerHTML = state.trades.length ? state.trades.slice().reverse().map((item) => `
    <li class="trade-log-item">
      <div class="trade-log-heading">
        <time>${formatDate(state.bars[item.index].date)}</time>
        <span class="trade-log-side ${item.side === "buy" ? "buy-text" : "sell-text"}">${item.side === "buy" ? "买入" : "卖出"}</span>
      </div>
      <div class="trade-log-values">
        <div><span>成交价格</span><strong>${formatPrice(item.price)}</strong></div>
        <div><span>成交股数</span><strong>${item.qty.toLocaleString()} 股</strong></div>
      </div>
      <div class="trade-log-meta">
        <span>费用 <strong>${formatMoney(item.fee)}</strong></span>
        <span>成交后现金 <strong>${formatMoney(item.cash)}</strong></span>
      </div>
      ${item.side === "buy" && (item.lotRole || item.lotPurpose || item.lotExitRule) ? `<p class="trade-log-reason">本批计划：${escapeHtml(item.lotRole || "未指定")}${item.lotPurpose ? ` · ${escapeHtml(item.lotPurpose)}` : ""}${item.lotExitRule ? ` · 退出：${escapeHtml(item.lotExitRule)}` : ""}${item.lotPlanUpdates?.length ? ` · 后续补记 ${item.lotPlanUpdates.length} 次` : ""}</p>` : ""}
      ${item.side === "sell" && tradeAllocationLabel(item) ? `<p class="trade-log-reason">扣减批次：${escapeHtml(tradeAllocationLabel(item))}</p>` : ""}
      ${item.reason ? `<p class="trade-log-reason">当时记录：${escapeHtml(item.reason)}</p>` : '<p class="trade-log-reason">当时未记录理由</p>'}
      <button class="text-button" type="button" data-note-trade="${escapeHtml(item.id)}">查看 / 补记</button>
    </li>`).join("") : '<li class="trade-log-empty">本局还没有交易记录</li>';
  drawChart();
  renderLibrary();
  saveDraftSession();
  // Rendering and positioning a historical view are read-only. Save only when
  // the user ends training or changes notes/answers/checklist, not on every draw.
}

function renderResultReveal() {
  $("resultReveal").hidden = !state.finished;
  if (!state.finished) return;
  if (state.activeTrainingSample && isSideTrainingSample(state.activeTrainingSample)) {
    const sample = state.activeTrainingSample;
    $("revealedPatternName").textContent = "指标训练片段";
    $("revealedPatternRule").textContent = "本局复盘聚焦实际成交、仓位变化、费用和风险控制。";
    $("revealedPatternNote").textContent = `样本区间：${sample.startDate || "—"} 至 ${sample.endDate || "—"}；采集分类仅用于样本管理，不参与操作评价。`;
    $("collectSampleButton").disabled = true;
    $("collectSampleButton").textContent = "已自动进入指标训练库";
    return;
  }
  const pattern = revealedPattern();
  const button = $("collectSampleButton");
  if (!pattern) {
    $("revealedPatternName").textContent = "答案待标注";
    $("revealedPatternRule").textContent = "导入的行情文件没有自带形态标签，请在下方知识模板库选择最符合的一种形态。";
    $("revealedPatternNote").textContent = "选择后可收藏为本机训练片段，并进入待审核状态。";
    button.disabled = true;
    button.textContent = "先选择形态模板";
    return;
  }
  const key = sampleKey(pattern);
  const collected = state.collectedSamples.some((sample) => sample.key === key);
  $("revealedPatternName").textContent = state.dataSource === "demo" ? `答案：${pattern.name}` : `已标注：${pattern.name}`;
  $("revealedPatternRule").textContent = pattern.rule;
  $("revealedPatternNote").textContent = state.dataSource === "demo" ? "这是带形态标签的合成演示样本。" : "这是你为导入行情添加的形态标签。";
  button.disabled = collected;
  button.textContent = collected ? "已收藏到训练库" : state.dataSource === "demo" ? "收藏到训练库（演示 99%）" : "收藏到训练库（待审核）";
}

$("buyButton").addEventListener("click", () => trade("buy"));
$("sellButton").addEventListener("click", () => trade("sell"));
document.querySelectorAll("[data-quick-side]").forEach((button) => button.addEventListener("click", () => quickPosition(button.dataset.quickSide, Number(button.dataset.divisor))));
$("quantityInput").addEventListener("input", renderTradePreview);
$("sellLotSelect").addEventListener("change", (event) => {
  state.sellTargetLotId = event.target.value;
  state.tradePreviewSide = "sell";
  renderTrancheManager();
  renderTradePreview();
});
$("trancheList").addEventListener("click", (event) => {
  const selectButton = event.target.closest("[data-select-lot]");
  if (selectButton && !state.finished) {
    state.sellTargetLotId = selectButton.dataset.selectLot;
    $("sellLotSelect").value = state.sellTargetLotId;
    state.tradePreviewSide = "sell";
    renderTrancheManager();
    renderTradePreview();
    return;
  }
  const toggleButton = event.target.closest("[data-toggle-lot-plan]");
  if (toggleButton) {
    const editor = $("trancheList").querySelector(`[data-lot-plan-editor="${CSS.escape(toggleButton.dataset.toggleLotPlan)}"]`);
    if (editor) editor.hidden = !editor.hidden;
    return;
  }
  const saveButton = event.target.closest("[data-save-lot-plan]");
  if (!saveButton) return;
  const lot = state.lots.find((item) => item.id === saveButton.dataset.saveLotPlan);
  const card = saveButton.closest("[data-lot-id]");
  if (!lot || !card) return;
  const update = {
    role: card.querySelector("[data-lot-role]").value,
    purpose: card.querySelector("[data-lot-purpose]").value.trim().slice(0, 180),
    exitRule: card.querySelector("[data-lot-exit]").value.trim().slice(0, 180),
    savedAt: new Date().toISOString(),
  };
  lot.planUpdates = [...(lot.planUpdates || []), update];
  const buy = state.trades.find((item) => item.side === "buy" && (item.lotId || item.id) === lot.id);
  if (buy) buy.lotPlanUpdates = lot.planUpdates;
  render();
  if (state.finished) persistCurrentReviewArchive();
  else saveDraftSession();
});
$("nextButton").addEventListener("click", nextBar); $("previousButton").addEventListener("click", previousBar); $("resetButton").addEventListener("click", reset);
$("finishButton").addEventListener("click", finishTraining);
$("saveOperationPlanButton").addEventListener("click", saveOperationPlan);
$("clearNextSessionChecklist").addEventListener("click", () => {
  state.nextSessionChecklist = [];
  state.reviewSuggestionSelections = [];
  renderOperationPlan();
  if (state.finished) renderOperationReview();
  saveDraftSession();
  if (state.finished) persistCurrentReviewArchive();
});
$("operationSuggestions").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-next-suggestion]");
  if (checkbox) toggleNextSessionSuggestion(checkbox.dataset.nextSuggestion, checkbox.checked);
});
$("operationWaves").addEventListener("click", (event) => {
  const noteTradeButton = event.target.closest("[data-note-trade]");
  if (noteTradeButton) {
    const trade = state.trades.find((item) => item.id === noteTradeButton.dataset.noteTrade);
    if (trade) openBarNote(Number(trade.index), trade.id);
    return;
  }
  const noteWaveButton = event.target.closest("[data-note-wave]");
  if (noteWaveButton) { openBarNote(Number(noteWaveButton.dataset.noteIndex), null, noteWaveButton.dataset.noteWave); return; }
  const tradeButton = event.target.closest("[data-focus-trade]");
  if (tradeButton) { focusOperationTrade(tradeButton.dataset.focusTrade); return; }
  const waveButton = event.target.closest("[data-focus-wave]");
  if (waveButton) focusOperationWave(waveButton.dataset.focusWave);
});
$("tradeLogBody").addEventListener("click", (event) => {
  const button = event.target.closest("[data-note-trade]");
  if (!button) return;
  const trade = state.trades.find((item) => item.id === button.dataset.noteTrade);
  if (trade) openBarNote(Number(trade.index), trade.id);
});
$("sessionReviewNoteButton").addEventListener("click", openSessionReviewNote);
$("reviewRuleReferences").addEventListener("click", (event) => {
  if (!event.target.closest("[data-compare-review-rules]")) return;
  state.showRuleComparison = !state.showRuleComparison;
  renderReviewRuleReferences();
});
$("closeBarNoteButton").addEventListener("click", () => { $("barNoteModal").hidden = true; });
$("cancelBarNoteButton").addEventListener("click", () => { $("barNoteModal").hidden = true; });
$("saveBarNoteButton").addEventListener("click", saveBarNote);
$("barNoteInput").addEventListener("input", renderNoteParsePreview);
$("barNoteEntries").addEventListener("click", (event) => {
  const button = event.target.closest("[data-note-trade]");
  if (!button) return;
  const trade = state.trades.find((item) => item.id === button.dataset.noteTrade);
  if (!trade) return;
  noteOpenTradeId = trade.id; noteOpenWaveId = null; noteOpenSession = false;
  $("barNoteTitle").textContent = `${trade.side === "buy" ? "买入" : "卖出"}成交补记`;
  $("barNoteInputLabel").textContent = "追加复盘补记";
  $("barNoteTimingHint").textContent = "此内容会作为事后补记保存，不会修改成交时的原始理由。";
  renderBarNoteEntries();
  $("barNoteInput").focus();
});
$("barNoteModal").addEventListener("click", (event) => { if (event.target === $("barNoteModal")) $("barNoteModal").hidden = true; });
$("openMyReviewsButton").addEventListener("click", () => { loadReviewArchiveList(); $("myReviewsPanel").scrollIntoView({ behavior: "smooth", block: "start" }); });
$("refreshReviewsButton").addEventListener("click", loadReviewArchiveList);
$("retryReviewSaveButton").addEventListener("click", retryUnsyncedReviewSave);
$("exportCurrentReviewButton").addEventListener("click", exportCurrentReviewArchive);
$("reviewArchiveList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-review]");
  if (button) openArchivedReview(button.dataset.openReview);
});
$("returnFromArchiveButton").addEventListener("click", returnFromArchivedReview);
$("closeReviewWorkspaceButton").addEventListener("click", returnFromArchivedReview);
$("reviewQuestionOptions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-review-answer-option]");
  if (button) saveReviewQuestion(button.dataset.reviewAnswerOption);
});
$("reviewQuestionSave").addEventListener("click", () => saveReviewQuestion(""));
$("reviewQuestionSkip").addEventListener("click", skipReviewQuestion);
$("reviewQuestionPrevious").addEventListener("click", () => moveReviewQuestionTo(reviewQuestionIndex - 1));
$("saveReviewConclusionButton").addEventListener("click", saveReviewConclusion);
$("runTeachingComparison").addEventListener("click", runTeachingComparison);
$("exportReviewsButton").addEventListener("click", () => exportReviewArchives().catch((error) => { $("reviewArchiveStatus").textContent = `档案导出失败：${error.message}`; }));
$("importReviewsButton").addEventListener("click", () => $("reviewArchiveFileInput").click());
$("reviewArchiveFileInput").addEventListener("change", (event) => { const [file] = event.target.files; if (file) importReviewArchives(file); event.target.value = ""; });
$("importButton").addEventListener("click", () => $("csvFileInput").click());
$("csvFileInput").addEventListener("change", (event) => { const [file] = event.target.files; if (file) importCsv(file); event.target.value = ""; });
$("exportSessionButton").addEventListener("click", exportSession);
$("importSessionButton").addEventListener("click", () => $("backupFileInput").click());
$("backupFileInput").addEventListener("change", (event) => { const [file] = event.target.files; if (file) importSession(file); event.target.value = ""; });
$("fetchMarketButton").addEventListener("click", fetchMarketData);
$("retryMarketButton").addEventListener("click", () => fetchMarketData({ retry: true }));
$("viewSourceHealthButton").addEventListener("click", () => {
  $("sourceHealthTitle").scrollIntoView({ behavior: "smooth", block: "start" });
  loadSourceHealth();
});
$("collectSamplesButton").addEventListener("click", startAutomaticCollection);
$("refreshSourceHealthButton")?.addEventListener("click", loadSourceHealth);
$("stopCollectionButton").addEventListener("click", requestCollectionStop);
$("collectionModalStopButton").addEventListener("click", requestCollectionStop);
$("closeCollectionProgressButton").addEventListener("click", () => { if (!state.collection.running) $("collectionProgressModal").hidden = true; });
$("collectionModalCloseButton").addEventListener("click", () => { $("collectionProgressModal").hidden = true; });
$("closeRetryProgressButton").addEventListener("click", () => {
  if (state.retryTask?.state !== "running") $("retryProgressModal").hidden = true;
});
$("closeRetryProgressAction").addEventListener("click", () => { $("retryProgressModal").hidden = true; });
$("closeIntradayVolumeButton").addEventListener("click", () => { state.intraday.open = false; renderIntradayModal(); });
$("closeIntradayVolumeAction").addEventListener("click", () => { state.intraday.open = false; renderIntradayModal(); });
$("retryIntradayVolumeButton").addEventListener("click", () => {
  const index = state.bars.findIndex((bar) => bar.date?.getTime?.() === state.intraday.date?.getTime?.());
  if (index >= 0) openIntradayVolume(index);
});
$("marketSymbol").addEventListener("keydown", (event) => { if (event.key === "Enter") fetchMarketData(); });
$("loginButton").addEventListener("click", openLogin);
$("closeLoginButton").addEventListener("click", closeLogin);
$("cancelLoginButton").addEventListener("click", closeLogin);
$("saveLoginButton").addEventListener("click", saveLogin);
$("loginModal").addEventListener("click", (event) => { if (event.target === $("loginModal")) closeLogin(); });
$("identityToggle").addEventListener("change", (event) => { state.showIdentity = event.target.checked; render(); });
$("chipToggle").addEventListener("change", (event) => { state.showChip = event.target.checked; drawChart(); });
$("waveAnnotationToggle").addEventListener("change", (event) => {
  state.showWaveAnnotations = event.target.checked;
  try { localStorage.setItem("kline-training-wave-annotations", String(state.showWaveAnnotations)); } catch (_) { /* 本机存储不可用时只影响当前页面 */ }
  drawChart();
});
$("allWavesButton").addEventListener("click", showAllOperationWaves);
$("indicatorSelect").addEventListener("change", (event) => { state.indicator = event.target.value; render(); });
$("modeSelect").addEventListener("change", (event) => { state.mode = event.target.value; state.showIdentity = state.mode === "daily"; $("identityToggle").checked = state.showIdentity; render(); });
$("trainingAreaSelect").addEventListener("change", (event) => {
  state.trainingArea = event.target.value === "pattern" ? "pattern" : "indicator";
  try { localStorage.setItem("kline-training-area", state.trainingArea); } catch (_) { /* 本机不允许持久化时继续使用 */ }
  renderLibrary();
  saveDraftSession();
});
$("tradingRuleSelect").addEventListener("change", (event) => { state.tradingRule = event.target.value; setHint(`${tradingRuleLabel()}已启用：${state.tradingRule === "etf-t0" ? "当根 K 线可回转交易。" : "买入后下一根 K 线可卖。"}`, false); render(); });
$("librarySelect").addEventListener("change", (event) => { state.libraryView = event.target.value; state.selectedPatternId = null; renderLibrary(); });
$("categorySelect").addEventListener("change", (event) => { state.libraryCategory = event.target.value; state.selectedPatternId = null; renderLibrary(); });
$("patternSearch").addEventListener("input", (event) => { state.patternSearch = event.target.value; renderLibrary(); });
$("randomPatternButton").addEventListener("click", randomPattern);
$("randomSampleButton").addEventListener("click", randomTrainingSample);
$("scanSamplesButton").addEventListener("click", scanCandidateSamples);
$("collectSampleButton").addEventListener("click", collectCurrentSample);
$("zoomInButton").addEventListener("click", () => changeChartZoom(-10));
$("zoomOutButton").addEventListener("click", () => changeChartZoom(10));
$("zoomResetButton").addEventListener("click", resetChartView);
$("chartCanvas").addEventListener("wheel", (event) => { event.preventDefault(); changeChartZoom(event.deltaY > 0 ? 10 : -10); }, { passive: false });
$("chartCanvas").addEventListener("pointerdown", beginChartDrag);
$("chartCanvas").addEventListener("pointermove", moveChartDrag);
$("chartCanvas").addEventListener("pointerup", endChartDrag);
$("chartCanvas").addEventListener("pointercancel", endChartDrag);
$("chartCanvas").addEventListener("pointerleave", (event) => { if(event.pointerType!=="touch" && state.chartTool==="inspect"){state.chartCursor=null;$("chartObservation").textContent="查看模式 · 移动指针观察，触屏可按住移动";drawChart();} });
$("chartCanvas").addEventListener("dblclick", handleChartDoubleClick);
bindChartTools();
$("libraryGrid").addEventListener("click", (event) => {
  const card = event.target.closest("[data-pattern-id]");
  if (!card) return;
  const action = event.target.dataset.action;
  if (action === "toggle-training") toggleTrainingPattern(card.dataset.patternId);
  else if (action === "expand-training") togglePatternSamples(card.dataset.patternId);
  else if (action === "select-training") {
    state.selectedPatternId = card.dataset.patternId;
    const expanded = new Set(state.expandedPatternIds || []);
    expanded.add(card.dataset.patternId);
    state.expandedPatternIds = [...expanded];
    renderLibrary();
  } else if (action === "train-sample") trainCandidate(event.target.dataset.sampleKey);
  else if (action === "remove-sample") setTrainingSampleMembership(event.target.dataset.sampleKey, false);
  else if (action === "refetch-intraday") refetchCandidateIntraday(event.target.dataset.sampleKey);
  else selectPattern(card.dataset.patternId);
});
$("candidateSampleList").addEventListener("click", (event) => {
  const action = event.target.dataset.candidateAction;
  const key = event.target.dataset.candidateKey;
  if (!action || !key) return;
  if (action === "approve") reviewCandidate(key, "approved");
  else if (action === "reject") reviewCandidate(key, "rejected");
  else if (action === "accept-warning") reviewCandidate(key, "accept-warning");
  else if (action === "remove-training") setTrainingSampleMembership(key, false);
  else if (action === "restore-training") setTrainingSampleMembership(key, true);
  else if (action === "refetch-intraday") refetchCandidateIntraday(key);
  else if (action === "retry") {
    retryCandidate(key);
  } else if (action === "diff") viewCandidateDiff(key);
  else if (action === "train") trainCandidate(key);
});
$("sideTrainingSelect")?.addEventListener("change", (event) => {
  state.sideLibraryView = event.target.value;
  renderSideTrainingLibrary();
});
$("randomSideSampleButton")?.addEventListener("click", randomTrainingSample);
$("refreshTrainingLibraryButton")?.addEventListener("click", loadServerCandidates);
$("startIndicatorTrainingButton")?.addEventListener("click", () => {
  state.trainingArea = "indicator";
  renderLibrary();
  randomTrainingSample();
});
$("sideTrainingGrid")?.addEventListener("click", (event) => {
  const action = event.target.dataset.sideAction;
  const key = event.target.dataset.candidateKey;
  if (!action || !key) return;
  if (action === "train" || action === "pair") trainCandidate(key);
  else if (action === "remove") setTrainingSampleMembership(key, false);
});
document.addEventListener("keydown", handleKeyboardShortcut);
window.addEventListener("resize", drawChart);
window.addEventListener("resize", () => { if (state.intraday.open) renderIntradayModal(); });
window.addEventListener("pagehide", () => {
  if (!state.collection.running || !state.collection.ownsJob || !state.collection.taskId) return;
  const body = new Blob([JSON.stringify({ taskId: state.collection.taskId, reason: "页面已关闭" })], { type: "application/json" });
  navigator.sendBeacon?.("/api/sample-collection/stop", body);
});
initializeLibrary();
loadDraftSession();
renderUser();
render();
loadReviewArchiveList();
loadSourceHealth();
loadRealSampleBank();
loadServerCandidates().finally(restoreCollectionStatus);
