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

const $ = (id) => document.getElementById(id);
const state = {
  bars: makeDemoBars(demoHistoryBars + demoTrainingBars),
  symbol: demoSymbol,
  dataSource: "demo",
  code: "DEMO",
  dataMeta: { provider: "内置演示", adjust: "qfq", period: "daily", fetchedAt: null, rawCount: demoHistoryBars + demoTrainingBars, droppedCount: 0 },
  trainingStartIndex: demoHistoryBars,
  trainingEndIndex: demoHistoryBars + demoTrainingBars - 1,
  currentIndex: demoHistoryBars,
  cash: initialCash,
  lots: [],
  trades: [],
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
  trainingPatternIds: loadTrainingPatternIds(),
  candidateSamples: loadCandidateSamples(),
  collectedSamples: loadCollectedSamples(),
  tradingRule: "a-share",
  chartBars: defaultChartBars,
  chartOffset: 0,
};

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
    return Array.isArray(saved) ? saved.map((sample) => ({
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

async function loadRealSampleBank() {
  try {
    const response = await fetch("./sample_bank.json", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload?.format !== "kline-training-real-sample-bank" || !Array.isArray(payload.samples)) return;
    const merged = [...state.candidateSamples, ...payload.samples.map((sample) => ({
      ...sample, reviewStatus: sample.reviewStatus || "pending", status: sample.status || "待审核", snapshot: true,
    }))];
    state.candidateSamples = [...new Map(merged.map((sample) => [sample.key, sample])).values()]
      .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0)).slice(0, 400);
    saveCandidateSamples();
    $("candidateScanHint").textContent = `已载入东方财富真实候选样本库：${payload.sampleCount || payload.samples.length} 个片段，均需人工审核后进入训练库。`;
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
function formatDate(date) { return date.toISOString().slice(0, 10); }
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
  const closes = state.bars.map((bar) => bar.close);
  const volumes = state.bars.map((bar) => bar.volume);
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const dif = fast.map((value, index) => value - slow[index]);
  const dea = ema(dif, 9);
  const macd = dif.map((value, index) => (value - dea[index]) * 2);
  const k = [], d = [], j = [];
  let lastK = 50, lastD = 50;
  state.bars.forEach((bar, index) => {
    const start = Math.max(0, index - 8);
    const window = state.bars.slice(start, index + 1);
    const high = Math.max(...window.map((item) => item.high));
    const low = Math.min(...window.map((item) => item.low));
    const rsv = high === low ? 50 : ((bar.close - low) / (high - low)) * 100;
    lastK = (2 * lastK + rsv) / 3;
    lastD = (2 * lastD + lastK) / 3;
    k.push(lastK); d.push(lastD); j.push(3 * lastK - 2 * lastD);
  });
  return { closes, volumes, dif, dea, macd, k, d, j };
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
function availableQty() {
  const tPlusZero = state.tradingRule === "etf-t0";
  return state.lots.filter((lot) => tPlusZero ? lot.index <= state.currentIndex : lot.index < state.currentIndex).reduce((sum, lot) => sum + lot.qty, 0);
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
  if (divisor === 1) return "全仓";
  if (divisor === 2) return "半仓";
  if (divisor === 3) return "三分之一仓";
  return "六分之一仓";
}

function affordableBuyQty(divisor) {
  const price = currentBar().close;
  const budget = state.cash / divisor;
  let qty = Math.floor(budget / price / 100) * 100;
  while (qty > 0) {
    const amount = qty * price;
    const fee = transactionFees("buy", amount).total;
    if (amount + fee <= budget && amount + fee <= state.cash) return qty;
    qty -= 100;
  }
  return 0;
}

function quickPosition(side, divisor) {
  if (state.finished) return setHint("本局已经结束，请重新开始后再设置仓位。", true);
  const qty = side === "buy"
    ? affordableBuyQty(divisor)
    : Math.floor((availableQty() / divisor) / 100) * 100;
  if (qty < 100) {
    $("quantityInput").value = 0;
    return setHint(side === "buy" ? "当前资金不足以买入 100 股。" : "当前可卖持仓不足 100 股。", true);
  }
  $("quantityInput").value = qty;
  const basis = side === "buy" ? "可用现金" : "可卖持仓";
  setHint(`已按${basis}的${ratioLabel(divisor)}填写 ${qty.toLocaleString()} 股，点击${side === "buy" ? "买入" : "卖出"}后成交。`, false);
}

function updateAverageCost() {
  const qty = heldQty();
  state.avgCost = qty === 0 ? 0 : state.lots.reduce((sum, lot) => sum + lot.price * lot.qty, 0) / qty;
}

function trade(side) {
  if (state.finished) return;
  const qty = Number($("quantityInput").value);
  const price = currentBar().close;
  const blocked = currentInstrumentBlocked();
  if (blocked) return setHint(blocked, true);
  if (limitLocked(side)) return setHint(side === "buy" ? "当前收盘接近涨停且封板，按涨跌停规则不能买入。" : "当前收盘接近跌停且封板，按涨跌停规则不能卖出。", true);
  if (!Number.isInteger(qty) || qty < 100 || qty % 100 !== 0) return setHint("数量必须是 100 股的整数倍。", true);
  const amount = qty * price;
  const fees = transactionFees(side, amount);
  if (side === "buy") {
    if (state.cash < amount + fees.total) return setHint("可用现金不足，无法完成这笔买入。", true);
    state.cash -= amount + fees.total;
    state.lots.push({ index: state.currentIndex, qty, price, feePerShare: fees.total / qty });
    state.trades.push({ side, qty, price, fee: fees.total, commission: fees.commission, stampDuty: fees.stampDuty, transferFee: fees.transferFee, feeRuleVersion, cash: state.cash, index: state.currentIndex });
    setHint(`${tradingRuleLabel()}买入成功；${state.tradingRule === "etf-t0" ? "本根 K 线即可卖出。" : "下一根 K 线后可卖。"}`, false);
  } else {
    if (availableQty() < qty) return setHint(`可卖数量不足，${tradingRuleLabel()}执行${state.tradingRule === "etf-t0" ? "T+0" : "T+1"}。`, true);
    state.cash += amount - fees.total;
    let remaining = qty;
    for (const lot of state.lots) {
      const used = Math.min(lot.qty, remaining);
      lot.qty -= used;
      remaining -= used;
      if (remaining === 0) break;
    }
    state.lots = state.lots.filter((lot) => lot.qty > 0);
    state.trades.push({ side, qty, price, fee: fees.total, commission: fees.commission, stampDuty: fees.stampDuty, transferFee: fees.transferFee, feeRuleVersion, cash: state.cash, index: state.currentIndex });
    setHint(`卖出成功，已扣除佣金${fees.stampDuty ? "和印花税" : ""}。`, false);
  }
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

function sourceLabel() {
  if (state.dataSource === "demo") return "演示标的";
  if (state.dataSource === "real") return "真实行情";
  return "已导入";
}

function resetTradingSession() {
  state.currentIndex = Math.min(firstTrainingDecisionIndex(), state.trainingEndIndex);
  state.cash = initialCash;
  state.lots = [];
  state.trades = [];
  state.avgCost = 0;
  state.finished = false;
  state.chartBars = defaultChartBars;
  state.chartOffset = 0;
}

async function fetchMarketData() {
  const input = $("marketSymbol");
  const button = $("fetchMarketButton");
  const rawSymbol = input.value.trim();
  const period = $("periodSelect").value || "daily";
  if (!rawSymbol) return setMarketHint("请输入 6 位 A 股或场内 ETF 代码，例如 600000。", true);
  button.disabled = true;
  button.textContent = "获取中…";
  setMarketHint(`正在获取东方财富${period === "daily" ? "日" : period === "weekly" ? "周" : period === "monthly" ? "月" : "年"}线前复权数据，请稍候…`);
  try {
    const response = await fetch(`/api/market/daily?symbol=${encodeURIComponent(rawSymbol)}&limit=1000&adjust=qfq&period=${encodeURIComponent(period)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "服务端返回错误。");
    const parsedBars = payload.bars.map((row) => ({
      date: new Date(`${row.date}T00:00:00`),
      open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    }));
    const quality = validateBars(parsedBars);
    const bars = quality.bars;
    state.bars = bars;
    state.symbol = payload.symbol;
    state.code = payload.code || rawSymbol.replace(/^(sh|sz)/i, "");
    state.dataSource = "real";
    updateDataMeta({ ...payload, ...quality, validCount: bars.length });
    state.trainingStartIndex = Math.max(0, bars.length - demoTrainingBars);
    state.trainingEndIndex = bars.length - 1;
    resetTradingSession();
    $("periodSelect").value = period;
    $("timeframeTag").textContent = { daily: "日线", weekly: "周线", monthly: "月线", yearly: "年线" }[period];
    $("dataStatus").textContent = `已获取 ${state.symbol}：${bars.length} 根真实前复权${period === "daily" ? "日" : period === "weekly" ? "周" : period === "monthly" ? "月" : "年"}线；`;
    setMarketHint(`${dataMetaLabel()}。${quality.droppedCount ? ` 已剔除 ${quality.droppedCount} 行异常/重复数据。` : " 数据质量检查通过。"}`);
    setHint("真实行情获取成功，已重新开始一局训练。", false);
    render();
  } catch (error) {
    setMarketHint(`获取失败：${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = "获取东方财富行情";
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
  // 结束后展示完整训练片段；过多 K 线由 drawChart 自动切换为连续走势线，避免挤成一团。
  state.chartBars = Math.min(maxChartBars, Math.max(defaultChartBars, trainingLength()));
  state.chartOffset = 0;
  setHint("训练已结束，已揭晓形态答案并生成本局复盘数据。", false);
  render();
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
    state.bars = quality.bars; state.symbol = file.name.replace(/\.[^.]+$/, ""); state.code = "LOCAL"; state.dataSource = "imported";
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
    trainingStartIndex: state.trainingStartIndex,
    trainingEndIndex: state.trainingEndIndex,
    currentIndex: state.currentIndex,
    cash: state.cash,
    lots: state.lots,
    trades: state.trades,
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
  };
  downloadJson(`kline-training-${new Date().toISOString().slice(0, 10)}.json`, payload);
  setHint("训练备份已导出，可在其他浏览器通过“导入训练备份”恢复。", false);
}

function saveDraftSession() {
  try {
    const draft = {
      format: "kline-training-draft",
      savedAt: new Date().toISOString(),
      userName: state.userName, symbol: state.symbol, code: state.code, dataSource: state.dataSource, dataMeta: state.dataMeta,
      bars: state.bars.map((bar) => ({ ...bar, date: formatDate(bar.date) })),
      trainingStartIndex: state.trainingStartIndex, trainingEndIndex: state.trainingEndIndex, currentIndex: state.currentIndex,
      cash: state.cash, lots: state.lots, trades: state.trades, avgCost: state.avgCost, finished: state.finished,
      mode: state.mode, indicator: state.indicator, showChip: state.showChip, showIdentity: state.showIdentity, tradingRule: state.tradingRule,
      selectedPatternId: state.selectedPatternId,
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
    state.bars = quality.bars; state.symbol = String(payload.symbol || demoSymbol); state.code = String(payload.code || "LOCAL"); state.userName = String(payload.userName || state.userName || "").slice(0, 20);
    state.dataSource = payload.dataSource || "demo"; updateDataMeta({ ...(payload.dataMeta || {}), ...quality });
    state.trainingStartIndex = Math.max(0, Math.min(Number(payload.trainingStartIndex) || 0, state.bars.length - 1));
    state.trainingEndIndex = Math.max(state.trainingStartIndex, Math.min(Number(payload.trainingEndIndex) || state.bars.length - 1, state.bars.length - 1));
    state.currentIndex = Math.max(firstTrainingDecisionIndex(), Math.min(Number(payload.currentIndex) || state.trainingStartIndex, state.trainingEndIndex));
    state.cash = Number(payload.cash) || initialCash; state.lots = Array.isArray(payload.lots) ? payload.lots : []; state.trades = Array.isArray(payload.trades) ? payload.trades : [];
    state.avgCost = Number(payload.avgCost) || 0; state.finished = Boolean(payload.finished); state.mode = ["naked", "daily"].includes(payload.mode) ? payload.mode : "naked";
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
    state.symbol = String(payload.symbol || "导入备份");
    state.userName = String(payload.userName || state.userName || "").slice(0, 20);
    state.code = String(payload.code || "LOCAL");
    state.dataSource = payload.dataSource || "imported";
    updateDataMeta({ ...(payload.dataMeta || {}), ...quality, validCount: quality.validCount });
    state.trainingStartIndex = Math.max(0, Math.min(Number(payload.trainingStartIndex) || 0, state.bars.length - 1));
    state.trainingEndIndex = Math.max(state.trainingStartIndex, Math.min(Number(payload.trainingEndIndex) || state.bars.length - 1, state.bars.length - 1));
    state.currentIndex = Math.max(firstTrainingDecisionIndex(), Math.min(Number(payload.currentIndex) || state.trainingStartIndex, state.trainingEndIndex));
    state.cash = Number.isFinite(Number(payload.cash)) ? Number(payload.cash) : initialCash;
    state.lots = Array.isArray(payload.lots) ? payload.lots : [];
    state.trades = Array.isArray(payload.trades) ? payload.trades : [];
    state.avgCost = Number(payload.avgCost) || 0;
    state.finished = Boolean(payload.finished);
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

function scanCandidateSamples() {
  if (state.dataSource === "demo") {
    $("candidateScanHint").textContent = "候选扫描仅对真实行情或本地导入行情开放。";
    return;
  }
  const candidates = [];
  for (const size of [60, 90, 120]) {
    for (let end = Math.max(size - 1, state.trainingStartIndex); end < state.bars.length; end += 5) {
      const start = end - size + 1;
      const segment = state.bars.slice(start, end + 1);
      if (segment.length < size) continue;
      const bottom = bottomLogicScore(segment);
      const [patternId, patternScore] = classifyCandidate(segment);
      const confidence = clamp(bottom.score * .56 + patternScore * .44);
      if (bottom.score < .58 || patternScore < .55) continue;
      const pattern = patternLibrary().find((item) => item.id === patternId);
      if (!pattern) continue;
      const key = `${state.symbol}|${formatDate(segment[0].date)}|${formatDate(segment.at(-1).date)}|${patternId}`;
      if (candidates.some((item) => item.key === key)) continue;
      candidates.push({
        key, symbol: state.symbol, patternId, patternName: pattern.name,
        startDate: formatDate(segment[0].date), endDate: formatDate(segment.at(-1).date),
        startIndex: start, endIndex: end, confidence: round(confidence, 3),
        bottomScore: round(bottom.score, 3), patternScore: round(patternScore, 3),
        reviewStatus: "pending",
        status: RULE_ENGINE_VALIDATED && confidence >= .9 ? "自动入库" : "待审核",
        autoEligible: confidence >= .9,
      });
    }
  }
  const merged = [...state.candidateSamples, ...candidates];
  const unique = [...new Map(merged.map((sample) => [sample.key, sample])).values()];
  state.candidateSamples = unique.sort((a, b) => b.confidence - a.confidence).slice(0, 200);
  saveCandidateSamples();
  $("candidateScanHint").textContent = state.candidateSamples.length
    ? `扫描完成：本次新增 ${candidates.length} 个，累计 ${state.candidateSamples.length} 个候选，当前均需审核${RULE_ENGINE_VALIDATED ? "或按阈值自动入库" : "（规则尚未完成回测）"}。`
    : "未找到同时满足底部逻辑和形态初筛条件的片段，可换一只股票或 ETF。";
  renderLibrary();
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

function randomTrainingSample() {
  const storedCollected = state.collectedSamples.map((sample) => ({ ...sample, status: sample.status || "已审核" }));
  const approved = [...state.candidateSamples, ...storedCollected].filter((sample) => sample.reviewStatus === "approved"
    && sample.dataSource !== "demo" && sample.provider !== "内置演示"
    && (sample.snapshot || sample.symbol === state.symbol) && Number.isInteger(sample.startIndex) && Number.isInteger(sample.endIndex)
    && sample.startIndex >= 0 && sample.endIndex < state.bars.length);
  if (!approved.length) {
    setHint("当前没有已审核真实样本。请先获取东方财富行情，扫描候选片段并审核通过。", true);
    $("candidateScanHint").textContent = "随机训练只从已审核真实样本抽取，不会使用合成行情。";
    return;
  }
  const picked = approved[Math.floor(Math.random() * approved.length)];
  trainCandidate(picked.key);
  setHint(`已随机抽取：${picked.patternName} · ${picked.startDate} 至 ${picked.endDate}。`, false);
}

function initializeLibrary() {
  const categories = [...new Set(patternLibrary().map((pattern) => pattern.category))];
  $("categorySelect").innerHTML = '<option value="all">全部类型</option>' + categories.map((category) => `<option value="${category}">${category}</option>`).join("");
}

function renderLibrary() {
  const patterns = visibleLibraryPatterns();
  const approved = state.candidateSamples.filter((sample) => sample.reviewStatus === "approved").length
    + state.collectedSamples.filter((sample) => sample.reviewStatus === "approved").length;
  const target = patternLibrary().length * 3;
  $("libraryCount").textContent = `${patterns.length} 个模板 · ${approved}/${target} 个真实样本`;
  const selected = patternLibrary().find((pattern) => pattern.id === state.selectedPatternId);
  $("selectedPattern").innerHTML = selected
    ? `<span>知识模板：${selected.name}</span><small>${selected.category} · ${biasLabel(selected.bias)} · ${selected.rule}（不会改变当前行情）</small>`
    : "<span>当前未选择知识模板</span><small>知识模板用于学习规则；实际行情由训练样本决定</small>";
  $("libraryGrid").innerHTML = patterns.length ? patterns.map((pattern) => {
    const inTraining = state.trainingPatternIds.includes(pattern.id);
    return `<article class="pattern-card${pattern.id === state.selectedPatternId ? " selected" : ""}" data-pattern-id="${pattern.id}">
      <div class="pattern-card-top"><div class="pattern-name-with-sketch"><h3>${pattern.name}</h3>${patternSketchSvg(pattern.id)}</div><span class="pattern-bias ${pattern.bias}">${biasLabel(pattern.bias)}</span></div>
      <p>${pattern.rule}</p>
      <div class="pattern-meta"><span>${pattern.category}</span><span>${pattern.source}</span><span>${inTraining ? "训练库" : "待审核"}</span></div>
      <div class="pattern-actions"><button type="button" data-action="select">选择模板</button><button type="button" data-action="toggle-training">${inTraining ? "移出训练库" : "加入训练库"}</button></div>
    </article>`;
  }).join("") : '<div class="library-empty">当前筛选条件下没有模板。</div>';
  renderCandidateSamples();
  renderCollectedSamples();
}

function renderCandidateSamples() {
  const approved = state.candidateSamples.filter((sample) => sample.reviewStatus === "approved").length;
  $("candidateSampleCount").textContent = `${state.candidateSamples.length} 个候选 · ${approved} 个已入库`;
  if (!state.candidateSamples.length) {
    $("candidateSampleList").innerHTML = '<div class="collected-empty">暂未扫描候选片段。</div>';
    return;
  }
  $("candidateSampleList").innerHTML = state.candidateSamples.map((sample) => {
    const confidence = `${(sample.confidence * 100).toFixed(0)}%`;
    const quality = sample.autoEligible ? `规则初筛 ${confidence} · 尚未回测` : `规则初筛 ${confidence}`;
    const statusLabel = sample.reviewStatus === "approved" ? "已审核 · 训练库" : sample.reviewStatus === "rejected" ? "已驳回" : "待审核";
    const reviewActions = sample.reviewStatus === "pending"
      ? `<button class="primary-button candidate-action" type="button" data-candidate-action="approve" data-candidate-key="${escapeHtml(sample.key)}">审核通过并入训练库</button><button class="secondary-button candidate-action" type="button" data-candidate-action="reject" data-candidate-key="${escapeHtml(sample.key)}">驳回</button>`
      : `<span class="candidate-review-note">${escapeHtml(sample.reviewedBy || "本机审核")} · ${escapeHtml(sample.reviewedAt || "已处理")}</span>`;
    return `<article class="collected-card candidate-card"><strong>${escapeHtml(sample.patternName)}</strong><span>${escapeHtml(sample.symbol)} · ${escapeHtml(sample.startDate)} 至 ${escapeHtml(sample.endDate)}</span><span>${statusLabel} · ${quality}</span><div class="candidate-actions"><button class="secondary-button candidate-action" type="button" data-candidate-action="train" data-candidate-key="${escapeHtml(sample.key)}">训练此片段</button>${reviewActions}</div></article>`;
  }).join("");
}

function findCandidate(key) { return state.candidateSamples.find((sample) => sample.key === key); }

function reviewCandidate(key, decision) {
  const candidate = findCandidate(key);
  if (!candidate) return;
  candidate.reviewStatus = decision;
  candidate.status = decision === "approved" ? "已审核 · 训练库" : "已驳回";
  candidate.reviewedBy = state.userName || "本机审核";
  candidate.reviewedAt = new Date().toLocaleString("zh-CN");
  saveCandidateSamples();
  renderLibrary();
}

function trainCandidate(key) {
  const candidate = findCandidate(key) || state.collectedSamples.find((sample) => sample.key === key);
  if (!candidate) return setHint("没有找到这个样本片段，请刷新样本库后重试。", true);

  const isSnapshot = candidate.snapshot === true;
  if (isSnapshot) {
    const minimumSnapshotBars = 45;
    if (!Array.isArray(candidate.bars) || candidate.bars.length < minimumSnapshotBars) {
      return setHint("这个样本缺少完整 K 线数据，不能开始训练。请重新载入样本库。", true);
    }
    try {
      const normalized = candidate.bars.map((bar) => ({
        ...bar,
        date: bar.date instanceof Date ? bar.date : new Date(`${String(bar.date).slice(0, 10)}T00:00:00`),
      }));
      // 样本片段本身已经是经过筛选的训练窗口，最低长度按观察窗口校验；
      // 直接导入整段行情仍然使用 validateBars 的 70 根默认门槛。
      const quality = validateBars(normalized, minimumSnapshotBars);
      state.bars = quality.bars;
      state.symbol = candidate.symbol;
      state.code = candidate.code || "LOCAL";
      state.dataSource = "real";
      updateDataMeta({ provider: candidate.provider || "东方财富", adjust: candidate.adjust || "qfq", period: candidate.period || "daily", ...quality, fetchedAt: candidate.fetchedAt || new Date().toISOString() });
    } catch (error) {
      return setHint(`样本数据校验失败：${error.message}`, true);
    }
    const snapshotStart = Number(candidate.trainingStartIndex ?? candidate.startIndex);
    const snapshotEnd = Number(candidate.trainingEndIndex ?? candidate.endIndex);
    if (!Number.isInteger(snapshotStart) || !Number.isInteger(snapshotEnd)
      || snapshotStart < 0 || snapshotEnd < snapshotStart || snapshotEnd >= state.bars.length
      || snapshotEnd - snapshotStart + 1 < minimumSnapshotBars) {
      return setHint("这个样本的训练区间不完整，不能开始训练。请重新载入样本库。", true);
    }
    state.trainingStartIndex = snapshotStart;
    state.trainingEndIndex = snapshotEnd;
  } else {
    if (candidate.symbol !== state.symbol) return setHint("该样本属于其他标的，请先获取对应代码的真实行情后再训练。", true);
    const startIndex = Number(candidate.startIndex);
    const endIndex = Number(candidate.endIndex);
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || endIndex < startIndex || endIndex >= state.bars.length) {
      return setHint("当前行情中没有完整的该样本片段，请重新扫描。", true);
    }
    state.trainingStartIndex = startIndex;
    state.trainingEndIndex = endIndex;
  }
  state.selectedPatternId = candidate.patternId;
  state.showIdentity = false;
  state.mode = "naked";
  $("modeSelect").value = "naked";
  $("identityToggle").checked = false;
  resetTradingSession();
  $("dataStatus").textContent = `训练片段：${candidate.patternName} · ${candidate.startDate} 至 ${candidate.endDate}；`;
  setMarketHint(`已载入东方财富真实样本：${candidate.symbol} · 前复权 · 训练中名称和日期仍会隐藏。`, false);
  setHint(`已载入「${candidate.patternName}」候选片段，可开始独立训练。`, false);
  render();
  $("chartCanvas").scrollIntoView({ behavior: "smooth", block: "center" });
}

function revealedPattern() {
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
  const pattern = revealedPattern();
  if (!pattern) return setHint("请先在形态库选择一个知识模板，为导入行情标注形态后再收藏。", true);
  const key = sampleKey(pattern);
  if (state.collectedSamples.some((sample) => sample.key === key)) return;
  const review = sampleReviewDecision();
  state.collectedSamples = [{
    key,
    symbol: state.symbol,
    startDate: formatDate(state.bars[state.trainingStartIndex].date),
    endDate: formatDate(state.bars[state.trainingEndIndex].date),
    patternId: pattern.id,
    patternName: pattern.name,
    dataSource: state.dataSource,
    startIndex: state.trainingStartIndex,
    endIndex: state.trainingEndIndex,
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
  const ma120 = sma(indicators.volumes, 120, index);
  const ma250 = sma(indicators.volumes, 250, index);
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
  const requestedBars = Number.isFinite(Number(state.chartBars)) ? Math.round(Number(state.chartBars)) : defaultChartBars;
  const visibleCount = Math.max(1, Math.min(Math.max(Math.min(minChartBars, bars.length), requestedBars), bars.length));
  const maxOffset = Math.max(0, bars.length - visibleCount);
  state.chartOffset = Math.max(0, Math.min(Number(state.chartOffset) || 0, maxOffset));
  const start = Math.max(0, bars.length - visibleCount - state.chartOffset);
  const visible = bars.slice(start, start + visibleCount);
  const indicators = indicatorData();
  const firstGlobalIndex = chartStartIndex + start;
  const left = 48, right = 14, top = 22, bottom = 28;
  const chipWidth = state.showChip ? Math.min(132, Math.max(88, width * 0.17)) : 0;
  const chartRight = Math.max(left + 80, width - right);
  const plotRight = state.showChip ? Math.max(left + 80, chartRight - chipWidth - 8) : chartRight;
  const chartWidth = Math.max(80, plotRight - left);
  const step = chartWidth / visible.length;
  // 当 K 线过密时保留相同画布尺寸，改用收盘价走势线，避免柱子挤成一条黑线。
  const lineOnly = step < 4.5 || visible.length >= 180;
  $("zoomLabel").textContent = `${visible.length} 根${lineOnly ? " · 走势线" : ""}${state.chartOffset ? ` · 向前 ${state.chartOffset} 根` : ""}`;
  $("zoomInButton").disabled = requestedBars <= minChartBars;
  $("zoomOutButton").disabled = requestedBars >= maxChartBars;
  const indicatorHeight = state.indicator === "none" ? 0 : state.indicator === "both" ? 170 : 94;
  const volumeHeight = 72;
  const priceBottom = Math.max(top + 100, height - bottom - volumeHeight - indicatorHeight - 14);
  const priceTop = top;
  const high = Math.max(...visible.map((bar) => bar.high));
  const low = Math.min(...visible.map((bar) => bar.low));
  const range = Math.max(high - low, 0.01);
  const candleWidth = Math.max(2, Math.min(11, step * .58));
  const yPrice = (value) => priceTop + ((high - value) / range) * (priceBottom - priceTop);
  const xBar = (index) => left + step * index + step / 2;
  const gridColor = "rgba(151, 178, 212, .12)";
  ctx.font = "10px Inter, sans-serif"; ctx.lineWidth = 1;
  for (let line = 0; line < 5; line += 1) {
    const y = priceTop + ((priceBottom - priceTop) / 4) * line;
    ctx.strokeStyle = gridColor; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(plotRight, y); ctx.stroke();
    ctx.fillStyle = "#71859f"; ctx.fillText((high - (range / 4) * line).toFixed(2), 6, y + 3);
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
  drawIndexedLine(ctx, visible.length, (index) => sma(indicators.closes, 5, firstGlobalIndex + index), "#f4c95d", yPrice, xBar);
  drawIndexedLine(ctx, visible.length, (index) => sma(indicators.closes, 20, firstGlobalIndex + index), "#7da8ff", yPrice, xBar);
  drawIndexedLine(ctx, visible.length, (index) => sma(indicators.closes, 60, firstGlobalIndex + index), "#d18cff", yPrice, xBar);
  if (state.showChip && chartRight - (plotRight + 7) > 20) drawChipProfile(ctx, chipDistribution(visible, currentBar().close), plotRight + 7, chartRight, priceTop, priceBottom, yPrice, currentBar().close);
  const trainingBoundary = state.trainingStartIndex - firstGlobalIndex;
  if (trainingBoundary > 0 && trainingBoundary < visible.length) {
    const boundaryX = xBar(trainingBoundary - 0.5);
    ctx.save();
    ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(244,201,93,.85)"; ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.moveTo(boundaryX, priceTop); ctx.lineTo(boundaryX, height - bottom); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#f4c95d"; ctx.font = "bold 10px Inter, sans-serif"; ctx.fillText("训练开始", Math.min(boundaryX + 5, plotRight - 48), priceTop + 13);
    ctx.restore();
  }
  const volumeMa120 = visible.map((_, index) => sma(indicators.volumes, 120, firstGlobalIndex + index));
  const volumeMa250 = visible.map((_, index) => sma(indicators.volumes, 250, firstGlobalIndex + index));
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
  state.trades.filter((item) => item.index >= firstGlobalIndex && item.index <= state.currentIndex).forEach((item) => {
    const localIndex = item.index - firstGlobalIndex;
    const x = xBar(localIndex); const y = item.side === "buy" ? yPrice(visible[localIndex].low) + 11 : yPrice(visible[localIndex].high) - 11;
    ctx.fillStyle = item.side === "buy" ? "#ff7787" : "#65d7b1"; ctx.beginPath();
    if (item.side === "buy") { ctx.moveTo(x, y - 7); ctx.lineTo(x - 5, y + 3); ctx.lineTo(x + 5, y + 3); }
    else { ctx.moveTo(x, y + 7); ctx.lineTo(x - 5, y - 3); ctx.lineTo(x + 5, y - 3); }
    ctx.closePath(); ctx.fill();
  });
  visible.forEach((bar, index) => {
    if (index % Math.max(1, Math.floor(visible.length / 6)) === 0) { ctx.fillStyle = "#71859f"; ctx.fillText(formatDate(bar.date).slice(5), xBar(index) - 14, height - 8); }
  });
}

function changeChartZoom(delta) {
  const next = Number(state.chartBars) + Number(delta);
  state.chartBars = Math.max(minChartBars, Math.min(maxChartBars, Math.round(next)));
  state.chartOffset = Math.min(state.chartOffset, Math.max(0, currentBars().length - Math.min(state.chartBars, currentBars().length)));
  window.requestAnimationFrame(drawChart);
}

function resetChartView() {
  state.chartBars = defaultChartBars;
  state.chartOffset = 0;
  window.requestAnimationFrame(drawChart);
}

function shiftChartViewport(delta) {
  const maxOffset = Math.max(0, currentBars().length - Math.min(state.chartBars, currentBars().length));
  state.chartOffset = Math.max(0, Math.min(maxOffset, state.chartOffset + delta));
  drawChart();
}

let chartPointer = null;

function beginChartDrag(event) {
  chartPointer = { id: event.pointerId, x: event.clientX, offset: state.chartOffset };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveChartDrag(event) {
  if (!chartPointer || chartPointer.id !== event.pointerId) return;
  const pixelDelta = event.clientX - chartPointer.x;
  const rect = event.currentTarget.getBoundingClientRect();
  const barsPerPixel = Math.max(0.05, state.chartBars / Math.max(rect.width, 1));
  const maxOffset = Math.max(0, currentBars().length - Math.min(state.chartBars, currentBars().length));
  state.chartOffset = Math.max(0, Math.min(maxOffset, Math.round(chartPointer.offset + pixelDelta * barsPerPixel)));
  drawChart();
}

function endChartDrag(event) {
  if (chartPointer?.id === event.pointerId) chartPointer = null;
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
  ctx.font = "bold 10px Inter, sans-serif"; ctx.fillStyle = "#b9c8dc"; ctx.fillText("估算筹码峰", left + 3, top + 11);
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
        lots.push({ qty: tradeItem.qty, price: tradeItem.price, feePerShare: tradeFee / tradeItem.qty });
      } else {
        cash += tradeItem.qty * tradeItem.price - tradeFee;
        let remaining = tradeItem.qty;
        let tradePnl = 0;
        while (remaining > 0 && lots.length) {
          const lot = lots[0];
          const used = Math.min(lot.qty, remaining);
          tradePnl += (tradeItem.price - lot.price - lot.feePerShare) * used;
          lot.qty -= used;
          remaining -= used;
          if (lot.qty <= 0) lots.shift();
        }
        tradePnl -= tradeFee;
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
  const bar = currentBar(); const qty = heldQty(); const equityNow = equity();
  $("equityValue").textContent = formatMoney(equityNow); $("cashValue").textContent = formatMoney(state.cash); $("positionValue").textContent = formatMoney(positionValue());
  $("pnlValue").textContent = formatMoney(floatingPnl()); $("pnlValue").style.color = floatingPnl() >= 0 ? "var(--accent)" : "var(--red)";
  $("returnValue").textContent = `收益率 ${returnRate().toFixed(2)}%`; $("currentPrice").textContent = formatPrice(bar.close); $("positionText").textContent = `${qty.toLocaleString()} 股`;
  $("avgCostValue").textContent = state.avgCost ? formatPrice(state.avgCost) : "¥0.00"; $("availableValue").textContent = `${availableQty().toLocaleString()} 股`;
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
  $("ma5Value").textContent = formatIndicatorPrice(sma(indicators.closes, 5, i)); $("ma20Value").textContent = formatIndicatorPrice(sma(indicators.closes, 20, i)); $("ma60Value").textContent = formatIndicatorPrice(sma(indicators.closes, 60, i));
  $("macdValue").textContent = round(indicators.macd[i], 3).toFixed(3); $("kdjValue").textContent = `${round(indicators.k[i], 1)} / ${round(indicators.d[i], 1)} / ${round(indicators.j[i], 1)}`; $("volumeValue").textContent = formatVolume(bar.volume);
  $("volumeMa120Value").textContent = formatVolume(volume.ma120); $("volumeMa250Value").textContent = formatVolume(volume.ma250);
  $("volumeSignalValue").textContent = volume.ratio == null ? volume.signal : `${volume.signal} · ${volume.ratio.toFixed(2)}倍`;
  $("volumeSignalValue").style.color = /天量|放量/.test(volume.signal) ? "var(--red)" : /地量|缩量/.test(volume.signal) ? "var(--green)" : "var(--text)";
  $("chipPeakValue").textContent = chip ? formatPrice(chip.peakPrice) : "—";
  $("chipAverageValue").textContent = chip ? `${formatPrice(chip.average)} · 获利${(chip.profitRatio * 100).toFixed(0)}%` : "—";
  $("chipRangeValue").textContent = chip ? `${formatPrice(chip.lower70)}–${formatPrice(chip.upper70)}` : "—";
  $("tradeCount").textContent = `${state.trades.length} 笔`; $("nextButton").disabled = state.finished; $("previousButton").disabled = state.currentIndex <= firstTrainingDecisionIndex() || state.trades.some((item) => item.index > state.currentIndex - 1);
  $("finishOverlay").hidden = true;
  renderResultReveal();
  renderResultStats();
  $("tradeLogBody").innerHTML = state.trades.length ? state.trades.slice().reverse().map((item) => `<tr><td>${formatDate(state.bars[item.index].date)}</td><td class="${item.side === "buy" ? "buy-text" : "sell-text"}">${item.side === "buy" ? "买入" : "卖出"}</td><td>${formatPrice(item.price)}</td><td>${item.qty.toLocaleString()}</td><td>${formatMoney(item.fee)}</td><td>${formatMoney(item.cash)}</td></tr>`).join("") : '<tr class="empty-row"><td colspan="6">本局还没有交易记录</td></tr>';
  drawChart();
  renderLibrary();
  saveDraftSession();
}

function renderResultReveal() {
  $("resultReveal").hidden = !state.finished;
  if (!state.finished) return;
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
$("nextButton").addEventListener("click", nextBar); $("previousButton").addEventListener("click", previousBar); $("resetButton").addEventListener("click", reset);
$("finishButton").addEventListener("click", finishTraining);
$("importButton").addEventListener("click", () => $("csvFileInput").click());
$("csvFileInput").addEventListener("change", (event) => { const [file] = event.target.files; if (file) importCsv(file); event.target.value = ""; });
$("exportSessionButton").addEventListener("click", exportSession);
$("importSessionButton").addEventListener("click", () => $("backupFileInput").click());
$("backupFileInput").addEventListener("change", (event) => { const [file] = event.target.files; if (file) importSession(file); event.target.value = ""; });
$("fetchMarketButton").addEventListener("click", fetchMarketData);
$("marketSymbol").addEventListener("keydown", (event) => { if (event.key === "Enter") fetchMarketData(); });
$("loginButton").addEventListener("click", openLogin);
$("closeLoginButton").addEventListener("click", closeLogin);
$("cancelLoginButton").addEventListener("click", closeLogin);
$("saveLoginButton").addEventListener("click", saveLogin);
$("loginModal").addEventListener("click", (event) => { if (event.target === $("loginModal")) closeLogin(); });
$("identityToggle").addEventListener("change", (event) => { state.showIdentity = event.target.checked; render(); });
$("chipToggle").addEventListener("change", (event) => { state.showChip = event.target.checked; drawChart(); });
$("indicatorSelect").addEventListener("change", (event) => { state.indicator = event.target.value; render(); });
$("modeSelect").addEventListener("change", (event) => { state.mode = event.target.value; state.showIdentity = state.mode === "daily"; $("identityToggle").checked = state.showIdentity; render(); });
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
$("libraryGrid").addEventListener("click", (event) => {
  const card = event.target.closest("[data-pattern-id]");
  if (!card) return;
  if (event.target.dataset.action === "toggle-training") toggleTrainingPattern(card.dataset.patternId);
  else selectPattern(card.dataset.patternId);
});
$("candidateSampleList").addEventListener("click", (event) => {
  const action = event.target.dataset.candidateAction;
  const key = event.target.dataset.candidateKey;
  if (!action || !key) return;
  if (action === "approve") reviewCandidate(key, "approved");
  else if (action === "reject") reviewCandidate(key, "rejected");
  else if (action === "train") trainCandidate(key);
});
document.addEventListener("keydown", handleKeyboardShortcut);
window.addEventListener("resize", drawChart);
initializeLibrary();
loadDraftSession();
renderUser();
render();
loadRealSampleBank();
