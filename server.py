"""Local development server for the K-line training app.

It serves the static app and provides a small same-origin proxy endpoint for
daily A-share/ETF data. Keeping the upstream request here avoids browser CORS
problems and gives the app one stable response shape.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen


if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    BASE_DIR = Path(sys._MEIPASS)
else:
    BASE_DIR = Path(__file__).resolve().parent
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
UPSTREAMS = [
    "https://7.push2his.eastmoney.com/api/qt/stock/kline/get",
    "https://push2his.eastmoney.com/api/qt/stock/kline/get",
]
CACHE_TTL_SECONDS = 300
_cache: dict[tuple[str, int, str, str], tuple[float, dict]] = {}
PERIODS = {"daily": 101, "weekly": 102, "monthly": 103, "yearly": 106}


def normalize_symbol(raw: str) -> tuple[str, str]:
    symbol = raw.strip().lower()
    if not re.fullmatch(r"(?:sh|sz)?\d{6}", symbol):
        raise ValueError("代码格式不正确，请输入 6 位 A 股或场内 ETF 代码。")
    prefix = symbol[:2] if symbol[:2] in {"sh", "sz"} else ""
    code = symbol[2:] if prefix else symbol
    # Eastmoney uses 1 for Shanghai and 0 for Shenzhen.
    if not prefix:
        prefix = "sh" if code.startswith(("5", "6")) else "sz"
    market = "1" if prefix == "sh" else "0"
    return f"{market}.{code}", code


def parse_limit(raw: str) -> int:
    try:
        limit = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit 必须是整数。") from exc
    return max(70, min(limit, 2000))


def parse_period(raw: str) -> str:
    period = raw.strip().lower()
    if period not in PERIODS:
        raise ValueError("period 只支持 daily、weekly、monthly 或 yearly。")
    return period


def fetch_market(symbol: str, limit: int, adjust: str, period: str) -> dict:
    key = (symbol, limit, adjust, period)
    cached = _cache.get(key)
    now = time.time()
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    adjust_code = {"qfq": "1", "hfq": "2", "none": "0"}[adjust]
    query = (
        "fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13"
        "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
        f"&beg=0&end=20500101&klt={PERIODS[period]}&fqt={adjust_code}"
        f"&secid={quote(symbol)}&lmt={limit}&rtntype=6"
        "&ut=fa5fd1943c7b386f172d6893dbbd1b5b"
    )
    last_error: Exception | None = None
    payload = None
    for upstream in UPSTREAMS:
        request = Request(
            f"{upstream}?{query}",
            headers={
                "User-Agent": "Mozilla/5.0 KLineTraining/1.0",
                "Referer": "https://quote.eastmoney.com/",
                "Accept": "application/json,text/plain,*/*",
                "Connection": "close",
            },
        )
        try:
            with urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("rc") == 0:
                break
            last_error = RuntimeError(f"东方财富返回错误码 {payload.get('rc')}。")
        except Exception as exc:
            last_error = exc
    if not payload or payload.get("rc") != 0:
        raise RuntimeError(f"东方财富接口暂时不可用：{last_error}")

    data = payload.get("data") or {}
    rows = data.get("klines") or []
    bars = []
    for row in rows:
        if isinstance(row, str):
            row = row.split(",")
        if not isinstance(row, list) or len(row) < 6:
            continue
        try:
            date = str(row[0])
            open_price, close, high, low, volume = (float(value) for value in row[1:6])
        except (TypeError, ValueError):
            continue
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            continue
        if min(open_price, close, high, low) <= 0 or volume < 0:
            continue
        if low > min(open_price, close) or high < max(open_price, close):
            continue
        bars.append({
            "date": date,
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        })
    bars.sort(key=lambda bar: bar["date"])
    unique_bars = []
    for bar in bars:
        if unique_bars and unique_bars[-1]["date"] == bar["date"]:
            continue
        unique_bars.append(bar)
    duplicate_count = len(bars) - len(unique_bars)
    bars = unique_bars
    if len(bars) < 70:
        raise RuntimeError("上游返回的有效日线不足 70 根，暂时无法建立稳定训练局。")
    result = {
        "symbol": data.get("name") and f"{data.get('name')} ({symbol.split('.', 1)[1]})" or symbol.split('.', 1)[1],
        "code": symbol.split('.', 1)[1],
        "provider": "东方财富",
        "adjust": adjust,
        "period": period,
        "bars": bars,
        "rawCount": len(rows),
        "validCount": len(bars),
        "droppedCount": len(rows) - len(bars),
        "duplicateCount": duplicate_count,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }
    _cache[key] = (now, result)
    return result


class AppHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        # PyInstaller windowed builds do not provide sys.stderr. The default
        # handler logs every request there and can otherwise close responses
        # before sending them, producing ERR_EMPTY_RESPONSE in the browser.
        if sys.stderr is not None:
            super().log_message(format, *args)

    def send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"status": "ok", "service": "kline-training"})
            return
        if parsed.path != "/api/market/daily":
            super().do_GET()
            return
        params = parse_qs(parsed.query)
        try:
            symbol, code = normalize_symbol(params.get("symbol", [""])[0])
            limit = parse_limit(params.get("limit", ["1000"])[0])
            adjust = params.get("adjust", ["qfq"])[0].lower()
            period = parse_period(params.get("period", ["daily"])[0])
            if adjust not in {"qfq", "hfq", "none"}:
                raise ValueError("adjust 只支持 qfq、hfq 或 none。")
            self.send_json(200, fetch_market(symbol, limit, adjust, period))
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:  # upstream/network errors are user-facing API errors
            self.send_json(502, {"error": f"真实行情获取失败：{exc}"})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), lambda *args, **kwargs: AppHandler(*args, directory=str(BASE_DIR), **kwargs))
    print(f"K线训练服务已启动：http://{HOST}:{PORT}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nK线训练服务已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
