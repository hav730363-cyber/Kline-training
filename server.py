"""Local development server for the K-line training app.

It serves the static app and provides a small same-origin proxy endpoint for
daily A-share/ETF data. Keeping the upstream request here avoids browser CORS
problems and gives the app one stable response shape.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen


BASE_DIR = Path(__file__).resolve().parent
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
UPSTREAM = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
CACHE_TTL_SECONDS = 300
_cache: dict[tuple[str, int, str], tuple[float, dict]] = {}


def normalize_symbol(raw: str) -> str:
    symbol = raw.strip().lower()
    if not re.fullmatch(r"(?:sh|sz)?\d{6}", symbol):
        raise ValueError("代码格式不正确，请输入 6 位 A 股或场内 ETF 代码。")
    if symbol.startswith(("sh", "sz")):
        return symbol
    code = symbol
    # Shanghai stocks and the common Shanghai ETF prefixes.
    return ("sh" if code.startswith(("5", "6")) else "sz") + code


def parse_limit(raw: str) -> int:
    try:
        limit = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit 必须是整数。") from exc
    return max(70, min(limit, 2000))


def fetch_daily(symbol: str, limit: int, adjust: str) -> dict:
    key = (symbol, limit, adjust)
    cached = _cache.get(key)
    now = time.time()
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    upstream_adjust = {"qfq": "qfqday", "hfq": "hfqday", "none": "day"}[adjust]
    query = f"param={quote(symbol)},day,,,{limit},{adjust}"
    request = Request(
        f"{UPSTREAM}?{query}",
        headers={"User-Agent": "Mozilla/5.0 KLineTraining/1.0"},
    )
    with urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))

    rows = payload.get("data", {}).get(symbol, {}).get(upstream_adjust, [])
    bars = []
    for row in rows:
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
    if len(bars) < 70:
        raise RuntimeError("上游返回的有效日线不足 70 根，暂时无法建立稳定训练局。")
    result = {
        "symbol": symbol,
        "provider": "Tencent Finance",
        "adjust": adjust,
        "bars": bars,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }
    _cache[key] = (now, result)
    return result


class AppHandler(SimpleHTTPRequestHandler):
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
            symbol = normalize_symbol(params.get("symbol", [""])[0])
            limit = parse_limit(params.get("limit", ["1000"])[0])
            adjust = params.get("adjust", ["qfq"])[0].lower()
            if adjust not in {"qfq", "hfq", "none"}:
                raise ValueError("adjust 只支持 qfq、hfq 或 none。")
            self.send_json(200, fetch_daily(symbol, limit, adjust))
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
