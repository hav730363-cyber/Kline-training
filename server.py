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
import threading
import time
from datetime import datetime, timedelta, timezone
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
UNIVERSE_CACHE_TTL_SECONDS = 21600
_cache: dict[tuple[str, str, int, str, str], tuple[float, dict]] = {}
_universe_cache: tuple[float, dict] | None = None
_baostock_lock = threading.Lock()
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


def _normalize_bars(rows: list, raw_count: int, provider: str, code: str, symbol_name: str, adjust: str, period: str, *, excluded_count: int = 0) -> dict:
    bars = []
    for row in rows:
        if isinstance(row, str):
            row = row.split(",")
        if not isinstance(row, (list, tuple)) or len(row) < 6:
            continue
        try:
            date = str(row[0])[:10]
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
    minimum = 10 if period == "yearly" else 70
    if len(bars) < minimum:
        raise RuntimeError(f"上游返回的有效行情不足 {minimum} 根，暂时无法显示。")
    return {
        "symbol": symbol_name or code,
        "code": code,
        "provider": provider,
        "adjust": adjust,
        "period": period,
        "bars": bars,
        "rawCount": raw_count,
        "validCount": len(bars),
        "droppedCount": raw_count - len(bars),
        "duplicateCount": duplicate_count,
        "excludedCount": excluded_count,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }


def fetch_eastmoney(symbol: str, limit: int, adjust: str, period: str) -> dict:
    key = ("eastmoney", symbol, limit, adjust, period)
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
    result = _normalize_bars(
        rows, len(rows), "东方财富", symbol.split('.', 1)[1],
        data.get("name") and f"{data.get('name')} ({symbol.split('.', 1)[1]})" or symbol.split('.', 1)[1],
        adjust, period,
    )
    _cache[key] = (now, result)
    return result


def _baostock_adjustflag(adjust: str) -> str:
    # BaoStock: 1 后复权，2 前复权，3 不复权。
    return {"qfq": "2", "hfq": "1", "none": "3"}[adjust]


def _aggregate_yearly(rows: list[dict]) -> list[dict]:
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["date"][:4], []).append(row)
    result = []
    for year, items in grouped.items():
        result.append({
            "date": items[-1]["date"],
            "open": items[0]["open"],
            "high": max(item["high"] for item in items),
            "low": min(item["low"] for item in items),
            "close": items[-1]["close"],
            "volume": sum(item["volume"] for item in items),
        })
    return result


def fetch_baostock(symbol: str, limit: int, adjust: str, period: str) -> dict:
    key = ("baostock", symbol, limit, adjust, period)
    cached = _cache.get(key)
    now = time.time()
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]
    try:
        import baostock as bs
    except ImportError as exc:
        raise RuntimeError("BaoStock 未安装，请先运行安装脚本，或改用 CSV 导入。") from exc
    code = symbol.split('.', 1)[1]
    market = "sh" if symbol.startswith("1.") else "sz"
    bs_code = f"{market}.{code}"
    frequency = {"daily": "d", "weekly": "w", "monthly": "m", "yearly": "d"}[period]
    adjustflag = _baostock_adjustflag(adjust)
    filterable = frequency == "d"
    fields = "date,open,high,low,close,volume,amount,adjustflag,tradestatus,isST" if filterable else "date,open,high,low,close,volume,amount,adjustflag"
    raw_rows = []
    excluded_count = 0
    with _baostock_lock:
        login = bs.login()
        if getattr(login, "error_code", "1") != "0":
            raise RuntimeError(f"BaoStock 登录失败：{getattr(login, 'error_msg', '未知错误')}")
        try:
            result = bs.query_history_k_data_plus(
                bs_code,
                fields,
                start_date="1990-01-01",
                end_date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                frequency=frequency,
                adjustflag=adjustflag,
            )
            if getattr(result, "error_code", "1") != "0":
                raise RuntimeError(f"BaoStock 查询失败：{getattr(result, 'error_msg', '未知错误')}")
            while result.next():
                row = result.get_row_data()
                if filterable and len(row) >= 10 and (row[8] == "0" or row[9] == "1"):
                    excluded_count += 1
                    continue
                # BaoStock order is date, open, high, low, close, volume;
                # _normalize_bars uses the Eastmoney-compatible order
                # date, open, close, high, low, volume.
                raw_rows.append([row[0], row[1], row[4], row[2], row[3], row[5]])
        finally:
            bs.logout()
    normalized = _normalize_bars(raw_rows, len(raw_rows) + excluded_count, "BaoStock", code, code, adjust, period, excluded_count=excluded_count)
    if period == "yearly":
        normalized["bars"] = _aggregate_yearly(normalized["bars"])
        normalized["validCount"] = len(normalized["bars"])
        if normalized["validCount"] < 10:
            raise RuntimeError("BaoStock 年线有效数据不足 10 根；请改用日线或导入更长的 CSV。")
    normalized["bars"] = normalized["bars"][-limit:]
    normalized["validCount"] = len(normalized["bars"])
    normalized["symbol"] = f"{code}（BaoStock）"
    _cache[key] = (now, normalized)
    return normalized


def fetch_market(symbol: str, limit: int, adjust: str, period: str, provider: str) -> dict:
    if provider == "baostock":
        return fetch_baostock(symbol, limit, adjust, period)
    if provider == "eastmoney":
        return fetch_eastmoney(symbol, limit, adjust, period)
    raise ValueError("provider 只支持 baostock 或 eastmoney；CSV 请使用页面导入。")


def fetch_baostock_universe() -> dict:
    """Return a filtered A-share/ETF universe from BaoStock's real list."""
    global _universe_cache
    now = time.time()
    if _universe_cache and now - _universe_cache[0] < UNIVERSE_CACHE_TTL_SECONDS:
        return _universe_cache[1]
    try:
        import baostock as bs
    except ImportError as exc:
        raise RuntimeError("BaoStock 未安装，请改用 CSV 导入或先安装依赖。") from exc
    rows = []
    source_date = None
    with _baostock_lock:
        login = bs.login()
        if getattr(login, "error_code", "1") != "0":
            raise RuntimeError(f"BaoStock 登录失败：{getattr(login, 'error_msg', '未知错误')}")
        try:
            for days_ago in range(0, 8):
                query_date = (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime("%Y-%m-%d")
                result = bs.query_all_stock(day=query_date)
                if getattr(result, "error_code", "1") != "0":
                    continue
                candidate_rows = []
                while result.next():
                    candidate_rows.append(result.get_row_data())
                if candidate_rows:
                    rows = candidate_rows
                    source_date = query_date
                    break
        finally:
            bs.logout()
    if not rows:
        raise RuntimeError("BaoStock 最近 7 天没有返回可用证券列表，请稍后重试。")

    instruments = []
    excluded_count = 0
    for row in rows:
        if len(row) < 3 or "." not in row[0]:
            excluded_count += 1
            continue
        market, code = row[0].lower().split(".", 1)
        name = str(row[2] or code).strip()
        if len(code) != 6 or row[1] != "1":
            excluded_count += 1
            continue
        is_stock = (market == "sh" and code.startswith("6")) or (market == "sz" and code.startswith(("0", "3")))
        is_etf = code.startswith(("5", "15", "16", "18"))
        if not (is_stock or is_etf) or re.search(r"(?:ST|退)", name.upper()):
            excluded_count += 1
            continue
        instruments.append({
            "symbol": code,
            "baostockCode": row[0],
            "name": name,
            "kind": "etf" if is_etf else "stock",
        })
    instruments.sort(key=lambda item: (item["kind"], item["symbol"]))
    if not instruments:
        raise RuntimeError("证券列表返回成功，但没有通过 A 股/场内 ETF 过滤。")
    payload = {
        "provider": "BaoStock",
        "sourceDate": source_date,
        "instruments": instruments,
        "count": len(instruments),
        "excludedCount": excluded_count,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }
    _universe_cache = (now, payload)
    return payload


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
        if parsed.path == "/api/market/universe":
            params = parse_qs(parsed.query)
            try:
                provider = params.get("provider", ["baostock"])[0].lower()
                if provider != "baostock":
                    raise ValueError("证券列表当前只支持 BaoStock；东方财富请手动输入代码。")
                self.send_json(200, fetch_baostock_universe())
            except ValueError as exc:
                self.send_json(400, {"error": str(exc)})
            except Exception as exc:
                self.send_json(502, {"error": f"自动筛选证券列表失败：{exc}"})
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
            provider = params.get("provider", ["baostock"])[0].lower()
            if adjust not in {"qfq", "hfq", "none"}:
                raise ValueError("adjust 只支持 qfq、hfq 或 none。")
            self.send_json(200, fetch_market(symbol, limit, adjust, period, provider))
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
