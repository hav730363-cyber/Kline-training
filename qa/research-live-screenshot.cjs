const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

async function main() {
  const url = process.env.KLINE_QA_URL || "http://127.0.0.1:8876/";
  const output = path.join(__dirname, "..", ".qa-runtime", `research-live-${process.pid}`);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator("#researchStatus").filter({ hasText: "已处理" }).waitFor();
    const desktop = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, research: document.querySelector("#researchStatus").innerText }));
    if (desktop.width !== desktop.viewport) throw new Error(`桌面横向溢出：${JSON.stringify(desktop)}`);
    await page.screenshot({ path: path.join(output, "research-live-1366-full-page.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
    if (mobile.width !== mobile.viewport || errors.length) throw new Error(`手机或脚本异常：${JSON.stringify({ mobile, errors })}`);
    await page.screenshot({ path: path.join(output, "research-live-390-full-page.png"), fullPage: true });
    console.log(JSON.stringify({ output, desktop, mobile }, null, 2));
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
