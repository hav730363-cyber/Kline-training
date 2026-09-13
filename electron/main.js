const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

// Some Windows graphics drivers crash Chromium before the first window is
// created. This app is chart/data oriented, so stable software rendering is
// preferable to hardware acceleration for the portable build.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");

let service = null;
let mainWindow = null;
let servicePort = null;

function writeLog(message) {
  try {
    const logPath = path.join(app.getPath("userData"), "startup.log");
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch (_) {}
}

function findFreePort(start = 18000) {
  return new Promise((resolve, reject) => {
    let port = start;
    const probe = () => {
      if (port >= start + 100) return reject(new Error("找不到可用的本地端口。"));
      const server = net.createServer();
      server.once("error", () => { port += 1; probe(); });
      server.once("listening", () => server.close(() => resolve(port)));
      server.listen(port, "127.0.0.1");
    };
    probe();
  });
}

function waitForHealth(port, timeout = 12000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/health", timeout: 700 }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          try {
            const payload = JSON.parse(body);
            if (response.statusCode === 200 && payload.status === "ok") return resolve();
          } catch (_) {}
          retry();
        });
      });
      request.on("error", retry);
      request.on("timeout", () => request.destroy());
    };
    const retry = () => {
      if (Date.now() >= deadline) return reject(new Error("本地行情服务启动超时。"));
      setTimeout(check, 120);
    };
    check();
  });
}

function servicePath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "K线训练服务.exe");
  return path.join(__dirname, "..", "dist-sidecar", "K线训练服务.exe");
}

async function startService() {
  servicePort = await findFreePort();
  const executable = servicePath();
  writeLog(`准备启动本地服务：${executable}，端口 ${servicePort}`);
  if (!fs.existsSync(executable)) throw new Error(`找不到本地服务文件：${executable}`);
  service = spawn(executable, [], {
    cwd: path.dirname(executable),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(servicePort) },
    windowsHide: true,
    stdio: "ignore",
  });
  writeLog(`本地服务进程已创建：PID ${service.pid}`);
  service.once("error", (error) => writeLog(`本地服务启动错误：${error.message}`));
  service.once("exit", (code, signal) => writeLog(`本地服务退出：code=${code} signal=${signal}`));
  await waitForHealth(servicePort);
  writeLog("本地服务健康检查通过");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: "#0b1729",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadURL(`http://127.0.0.1:${servicePort}/`);
  mainWindow.on("closed", () => { mainWindow = null; });
}

async function boot() {
  try {
    writeLog(`应用启动，packaged=${app.isPackaged} resources=${process.resourcesPath}`);
    await startService();
    createWindow();
    writeLog("主窗口已创建");
  } catch (error) {
    writeLog(`应用启动失败：${error.stack || error.message}`);
    dialog.showErrorBox("K线训练启动失败", `${error.message}\n\n请重新双击程序；若仍失败，请把此提示截图发回。`);
    app.quit();
  }
}

app.whenReady().then(boot);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { if (service && !service.killed) service.kill(); });
