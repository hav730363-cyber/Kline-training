const cloud = require("wx-server-sdk");
const https = require("https");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const PERIODS = { daily: 101, weekly: 102, monthly: 103, yearly: 106 };
const UPSTREAMS = [
  "https://7.push2his.eastmoney.com/api/qt/stock/kline/get",
  "https://push2his.eastmoney.com/api/qt/stock/kline/get"
];

function normalizeSymbol(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!/^(sh|sz)?\d{6}$/.test(value)) throw new Error("代码格式不正确，请输入 6 位代码。");
  const prefix = value.slice(0, 2) === "sh" || value.slice(0, 2) === "sz" ? value.slice(0, 2) : (/^[56]/.test(value) ? "sh" : "sz");
  const code = value.replace(/^(sh|sz)/, "");
  return { secid: `${prefix === "sh" ? 1 : 0}.${code}`, code };
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 KLineTraining/mini-program" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

function parseBars(payload) {
  const rows = payload?.data?.klines || [];
  const bars = rows.map((row) => String(row).split(",")).map((row) => ({
    date: row[0], open: Number(row[1]), close: Number(row[2]), high: Number(row[3]), low: Number(row[4]), volume: Number(row[5])
  })).filter((bar) => /^\d{4}-\d{2}-\d{2}$/.test(bar.date)
    && [bar.open, bar.close, bar.high, bar.low, bar.volume].every(Number.isFinite)
    && Math.min(bar.open, bar.close, bar.high, bar.low) > 0 && bar.volume >= 0
    && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close));
  const unique = [...new Map(bars.map((bar) => [bar.date, bar])).values()].sort((a, b) => a.date.localeCompare(b.date));
  if (unique.length < 45) throw new Error(`有效 K 线只有 ${unique.length} 根，暂时无法训练。`);
  return unique;
}

exports.main = async (event) => {
  try {
    const { secid, code } = normalizeSymbol(event.symbol);
    const period = PERIODS[event.period] ? event.period : "daily";
    const limit = Math.max(70, Math.min(Number(event.limit) || 300, 1000));
    const adjust = event.adjust === "hfq" ? "2" : event.adjust === "none" ? "0" : "1";
    const query = `fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&beg=0&end=20500101&klt=${PERIODS[period]}&fqt=${adjust}&secid=${encodeURIComponent(secid)}&lmt=${limit}&rtntype=6&ut=fa5fd1943c7b386f172d6893dbbd1b5b`;
    let payload;
    let lastError;
    for (const upstream of UPSTREAMS) {
      try {
        payload = await requestJson(`${upstream}?${query}`);
        if (payload?.rc === 0) break;
        lastError = new Error(`东方财富返回错误码 ${payload?.rc}`);
      } catch (error) { lastError = error; }
    }
    if (!payload || payload.rc !== 0) throw lastError || new Error("东方财富接口暂时不可用。");
    const bars = parseBars(payload);
    return { ok: true, code, symbol: payload.data?.name ? `${payload.data.name} (${code})` : code, provider: "东方财富", adjust: event.adjust || "qfq", period, bars, fetchedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
};
