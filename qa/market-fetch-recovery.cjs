const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, ".qa-runtime", "market-fetch-recovery");
const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

function bars(base = 10) {
  return Array.from({ length: 85 }, (_, index) => {
    const close = Number((base + index * 0.02).toFixed(2));
    return { date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10), open: close, high: close + 0.1, low: close - 0.1, close, volume: 100000 + index * 100 };
  });
}

function serveStatic() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end('{"error":"fixture not configured"}');
      return;
    }
    const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filename = path.resolve(root, `.${requested}`);
    const relative = path.relative(root, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return response.writeHead(403).end();
    fs.readFile(filename, (error, content) => {
      if (error) return response.writeHead(404).end("Not found");
      response.writeHead(200, { "Content-Type": mime[path.extname(filename)] || "application/octet-stream" });
      response.end(content);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

async function waitHint(page, phrase) {
  await page.waitForFunction((value) => document.querySelector("#marketDataHint")?.textContent.includes(value), phrase);
  return page.locator("#marketDataHint").textContent();
}

async function snapshot(page) {
  return page.evaluate(() => ({ symbol: state.symbol, source: state.dataSource, barCount: state.bars.length, cash: state.cash, currentIndex: state.currentIndex, trades: JSON.stringify(state.trades) }));
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
    let scenario = "success";
    let healthAvailable = true;
    let requestCount = 0;
    let lastRequest = "";
    let sourceRefreshes = 0;
    await page.route("**/api/market/daily?*", (route) => {
      requestCount += 1;
      lastRequest = route.request().url();
      if (scenario === "offline" || scenario === "interrupted") return route.abort("failed");
      if (scenario === "upstream") return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "真实行情获取失败：腾讯：连接被拒绝；BaoStock：无可用数据" }) });
      if (scenario === "bad-json") return route.fulfill({ status: 200, contentType: "text/html", body: "<html>unexpected response</html>" });
      if (scenario === "bad-bars") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bars: null }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bars: bars(scenario === "recovered" ? 20 : 10), symbol: "验收测试标的", code: "600000", provider: "tencent", crossValidated: false, fetchedAt: "2025-06-01T00:00:00Z" }) });
    });
    await page.route("**/health", (route) => healthAvailable
      ? route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"ok","service":"kline-training"}' })
      : route.abort("failed"));
    await page.route("**/api/market/sources", (route) => {
      sourceRefreshes += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        sources: [{ id: "tencent", name: "腾讯", configured: true, available: true, lastSuccess: "2025-01-02T03:04:05Z", lastFailure: null, error: "" }],
        routing: { daily: ["腾讯"], intraday: ["BaoStock"] }, fetchedAt: "2025-06-01T00:00:00Z",
      }) });
    });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator("#marketSymbol").fill("600000");
    await page.locator("#fetchMarketButton").click();
    await waitHint(page, "数据质量检查通过");
    assert.match(await page.locator("#sourceHealthList").textContent(), /上次成功：/);

    await page.evaluate(() => { state.cash = 765432; state.trades = [{ side: "buy", qty: 100, price: 10.5, index: 3, fee: 5, cash: 765432 }]; state.currentIndex = 7; render(); });
    const original = await snapshot(page);
    scenario = "offline";
    healthAvailable = false;
    await page.locator("#fetchMarketButton").click();
    assert.match(await waitHint(page, "未连接到本地行情服务"), /当前训练未受影响/);
    assert.deepEqual(await snapshot(page), original);
    assert.equal(await page.locator("#marketRecoveryActions").isVisible(), true);
    assert.equal(requestCount, 2);
    await page.screenshot({ path: path.join(outputDir, "market-fetch-error-1366-full-page.png"), fullPage: true, animations: "disabled" });

    scenario = "interrupted";
    healthAvailable = true;
    await page.locator("#retryMarketButton").click();
    assert.match(await waitHint(page, "本地服务现已响应"), /连接中断/);
    assert.deepEqual(await snapshot(page), original);

    scenario = "upstream";
    await page.locator("#retryMarketButton").click();
    assert.match(await waitHint(page, "HTTP 502"), /腾讯：连接被拒绝/);
    assert.deepEqual(await snapshot(page), original);
    const beforeRefresh = sourceRefreshes;
    await page.locator("#viewSourceHealthButton").click();
    await page.waitForFunction(() => document.querySelector("#sourceHealthList")?.textContent.includes("上次成功："));
    assert.ok(sourceRefreshes > beforeRefresh);

    scenario = "bad-json";
    await page.locator("#retryMarketButton").click();
    assert.match(await waitHint(page, "返回数据异常"), /有效 JSON/);
    assert.deepEqual(await snapshot(page), original);

    scenario = "bad-bars";
    await page.locator("#retryMarketButton").click();
    assert.match(await waitHint(page, "缺少 K 线数组"), /当前训练未受影响/);
    assert.deepEqual(await snapshot(page), original);

    await page.evaluate(() => {
      window.__marketOriginalFetch = window.fetch;
      window.fetch = (input, options) => String(input).startsWith("/api/market/daily")
        ? Promise.reject(new DOMException("test timeout", "AbortError"))
        : window.__marketOriginalFetch(input, options);
    });
    await page.locator("#retryMarketButton").click();
    assert.match(await waitHint(page, "行情请求超时"), /当前训练/);
    assert.deepEqual(await snapshot(page), original);
    await page.evaluate(() => { window.fetch = window.__marketOriginalFetch; });

    const realTimerKind = await page.evaluate(async () => {
      const originalFetch = window.fetch;
      window.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      try { await fetchJsonWithTimeout("/test-timeout", {}, 20); return "missing-timeout"; }
      catch (error) { return error.kind; }
      finally { window.fetch = originalFetch; }
    });
    assert.equal(realTimerKind, "timeout");

    scenario = "recovered";
    await page.locator("#marketSymbol").fill("510300");
    await page.locator("#periodSelect").selectOption("weekly");
    await page.locator("#dataProviderSelect").selectOption("baostock");
    await page.locator("#retryMarketButton").click();
    await waitHint(page, "数据质量检查通过");
    assert.equal(await page.locator("#marketRecoveryActions").isVisible(), false);
    assert.equal((await snapshot(page)).cash, 1000000);
    assert.equal((await snapshot(page)).trades, "[]");
    assert.match(lastRequest, /symbol=600000.*period=daily.*provider=auto/);
    assert.equal(await page.locator("#marketSymbol").inputValue(), "600000");
    assert.equal(await page.locator("#periodSelect").inputValue(), "daily");
    assert.equal(await page.locator("#dataProviderSelect").inputValue(), "auto");
    await page.screenshot({ path: path.join(outputDir, "market-fetch-recovered-1366-full-page.png"), fullPage: true, animations: "disabled" });

    await page.setViewportSize({ width: 390, height: 844 });
    scenario = "upstream";
    await page.locator("#fetchMarketButton").click();
    await waitHint(page, "HTTP 502");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.screenshot({ path: path.join(outputDir, "market-fetch-error-390-full-page.png"), fullPage: true, animations: "disabled" });
    assert.deepEqual(pageErrors, []);
    if (process.env.KLINE_LIVE_URL) {
      const liveContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
      const livePage = await liveContext.newPage();
      const liveErrors = [];
      livePage.on("pageerror", (error) => liveErrors.push(error.message));
      await livePage.goto(process.env.KLINE_LIVE_URL, { waitUntil: "networkidle" });
      await livePage.locator("#marketSymbol").fill("600000");
      await livePage.locator("#fetchMarketButton").click();
      await livePage.waitForFunction(() => state.dataSource === "real" || document.querySelector("#marketDataHint")?.textContent.startsWith("行情接口返回错误"), null, { timeout: 95000 });
      assert.equal(await livePage.evaluate(() => state.dataSource), "real", await livePage.locator("#marketDataHint").textContent());
      assert.ok(await livePage.evaluate(() => state.bars.length) >= 70);
      assert.deepEqual(liveErrors, []);
      await livePage.screenshot({ path: path.join(outputDir, "market-fetch-live-1366-full-page.png"), fullPage: true, animations: "disabled" });
      await livePage.setViewportSize({ width: 390, height: 844 });
      assert.equal(await livePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await livePage.screenshot({ path: path.join(outputDir, "market-fetch-live-390-full-page.png"), fullPage: true, animations: "disabled" });
      await liveContext.close();
    }
    process.stdout.write(JSON.stringify({ checks: ["offline", "interrupted", "upstream", "invalid-json", "invalid-bars", "timeout", "recovery", "state-preserved", "source-timestamp", "mobile-layout"], screenshots: outputDir, requests: requestCount }, null, 2) + "\n");
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
