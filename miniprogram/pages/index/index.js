Page({
  data: {
    symbol: "600000",
    periodLabels: ["日线", "周线", "月线", "年线"],
    periods: ["daily", "weekly", "monthly", "yearly"],
    periodIndex: 0,
    loading: false,
    error: false,
    status: "请输入代码并获取真实行情。"
  },

  onReady() {
    this.initCanvas();
  },

  onSymbolInput(event) {
    this.setData({ symbol: String(event.detail.value || "").replace(/\D/g, "").slice(0, 6) });
  },

  onPeriodChange(event) {
    this.setData({ periodIndex: Number(event.detail.value) || 0 });
  },

  async initCanvas() {
    const query = wx.createSelectorQuery().in(this);
    query.select("#klineCanvas").fields({ node: true, size: true }).exec((result) => {
      const item = result && result[0];
      if (!item || !item.node) return;
      const canvas = item.node;
      const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2;
      canvas.width = item.width * dpr;
      canvas.height = item.height * dpr;
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "#0a1423";
      ctx.fillRect(0, 0, item.width, item.height);
      ctx.fillStyle = "#71859f";
      ctx.font = "13px sans-serif";
      ctx.fillText("等待真实行情", 24, 34);
      this.canvas = { canvas, ctx, width: item.width, height: item.height };
    });
  },

  async loadMarketData() {
    const symbol = this.data.symbol.trim();
    if (!/^\d{6}$/.test(symbol)) {
      this.setData({ error: true, status: "请输入 6 位 A 股或场内 ETF 代码。" });
      return;
    }
    if (!wx.cloud) {
      this.setData({ error: true, status: "当前基础库未启用 CloudBase，请使用微信开发者工具打开本项目。" });
      return;
    }
    this.setData({ loading: true, error: false, status: "正在通过腾讯云获取东方财富真实行情…" });
    try {
      const response = await wx.cloud.callFunction({
        name: "getMarketData",
        data: { symbol, period: this.data.periods[this.data.periodIndex], limit: 300, adjust: "qfq" }
      });
      const result = response.result || {};
      if (!result.ok) throw new Error(result.error || "云函数返回错误。");
      this.setData({ loading: false, status: `${result.symbol || symbol} · 东方财富 · 前复权 · ${result.bars.length} 根有效 K 线` });
      this.drawCloseLine(result.bars);
    } catch (error) {
      this.setData({ loading: false, error: true, status: `获取失败：${error.message || error}` });
    }
  },

  drawCloseLine(bars) {
    if (!this.canvas || !bars.length) return;
    const { ctx, width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0a1423";
    ctx.fillRect(0, 0, width, height);
    const closes = bars.map((bar) => Number(bar.close)).filter(Number.isFinite);
    const high = Math.max(...closes);
    const low = Math.min(...closes);
    const range = Math.max(high - low, 0.01);
    ctx.strokeStyle = "#dce8ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    closes.forEach((value, index) => {
      const x = 18 + (width - 36) * index / Math.max(closes.length - 1, 1);
      const y = 20 + (height - 48) * (high - value) / range;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
});
