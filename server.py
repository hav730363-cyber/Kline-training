"""Local development server for the K-line training app.

It serves the static app and provides a small same-origin proxy endpoint for
daily A-share/ETF data. Keeping the upstream request here avoids browser CORS
problems and gives the app one stable response shape.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import sqlite3
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen

from sample_verification import detect_candidate_windows, pair_report, verify_three_sources, verify_two_sources
from side_training import INDICATOR_WARMUP_BARS, LEFT_QUOTA, RIGHT_QUOTA, DECISION_INDEX, detect_side_pairs
from research_validation import ResearchEngine


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
HISTORICAL_CACHE_TTL_SECONDS = 86400
INTRADAY_CACHE_TTL_SECONDS = 300
PERSISTENT_CACHE_MAX_ENTRIES = 180
INTRADAY_CACHE_SCHEMA_VERSION = 6
APP_VERSION = "1.9.8"
SOURCE_LABELS = {
    "auto": "自动多源路由",
    "baostock": "BaoStock",
    "tushare": "Tushare Pro",
    "tdx": "通达信 TQServer",
    "akshare": "AKShare",
    "tencent": "腾讯网页行情（主数据源）",
    "sina": "新浪网页行情（证券清单/诊断）",
    "eastmoney": "东方财富（公开分时备用）",
    "tencent_intraday": "腾讯（公开分时备用）",
    "sina_intraday": "新浪（公开分时备用）",
    "csv": "CSV 手动导入",
}
DAILY_SOURCE_ORDER = ["tencent", "baostock", "tushare", "tdx", "akshare", "sina"]
INTRADAY_SOURCE_ORDER = ["tencent_intraday", "sina_intraday", "baostock", "tdx", "tushare", "akshare", "eastmoney"]
SOURCE_FAMILIES = {
    "baostock": "sdk_baostock", "tushare": "sdk_tushare", "tdx": "official_tdx",
    "akshare": "aggregator_akshare", "tencent": "web_tencent", "sina": "web_sina",
    "eastmoney": "web_eastmoney", "csv": "local_csv",
}
SINA_UNIVERSE_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData"
SINA_KLINE_URL = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_cb=/CN_MarketDataService.getKLineData"
# web.ifzq 当前会对该历史行情请求返回 HTTP 501；无 web 子域的
# 官方公开行情入口返回相同结构，作为腾讯日线主源。
TENCENT_KLINE_URL = "https://ifzq.gtimg.cn/appstock/app/fqkline/get"
SAMPLE_CONTEXT_BARS = 40
SAMPLE_TRAINING_BARS = 180
SAMPLE_WINDOW_BARS = SAMPLE_CONTEXT_BARS + SAMPLE_TRAINING_BARS
SAMPLE_SCAN_HISTORY_BARS = 600
SAMPLE_SCAN_WORKERS = 8
SAMPLE_SCAN_DEFAULT_LIMIT = 1200
SIDE_PAIR_TARGET = 10
SAMPLE_SCAN_BATCH_SIZE = 120
COLLECTION_HEARTBEAT_TIMEOUT = 25
ACTIVE_SAMPLE_MODE = "side-paired-v1"
SUPPORTED_SIDE_TYPES = ("left", "right")
INTRADAY_EXPECTED_TIMES_5 = tuple(
    [f"09:{minute:02d}" for minute in range(35, 60, 5)]
    + [f"10:{minute:02d}" for minute in range(0, 60, 5)]
    + [f"11:{minute:02d}" for minute in range(0, 35, 5)]
    + [f"13:{minute:02d}" for minute in range(5, 60, 5)]
    + [f"14:{minute:02d}" for minute in range(0, 60, 5)]
    + [f"15:{minute:02d}" for minute in range(0, 1, 5)]
)
SUPPORTED_PATTERN_IDS = (
    "triple-bottom", "head-shoulders-bottom", "adam-adam-bottom",
    "adam-eve-bottom", "rectangle-bottom", "round-bottom",
)
PATTERN_NAMES = {
    "triple-bottom": "三重底", "head-shoulders-bottom": "头肩底",
    "adam-adam-bottom": "Adam&Adam 双底", "adam-eve-bottom": "Adam&Eve 双底",
    "rectangle-bottom": "矩形底", "round-bottom": "圆底",
}
_cache: dict[tuple[str, str, int, str, str], tuple[float, dict]] = {}
_universe_cache: tuple[float, dict] | None = None
_cache_lock = threading.RLock()
_baostock_lock = threading.RLock()
_cache_flush_timer: threading.Timer | None = None
PERIODS = {"daily": 101, "weekly": 102, "monthly": 103, "yearly": 106}
INTRADAY_FREQUENCIES = {"5": "5"}
_cache_root = os.getenv("KLINE_CACHE_DIR")
CACHE_DIR = Path(_cache_root) if _cache_root else Path(os.getenv("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "KLineTraining"
CACHE_FILE = CACHE_DIR / "market-cache.json"
CACHE_BACKUP_FILE = CACHE_DIR / "market-cache.json.bak"
SQLITE_FILE = CACHE_DIR / "market-cache.sqlite3"
SQLITE_BACKUP_FILE = CACHE_DIR / "market-cache.sqlite3.bak"
CANDIDATE_FILE = CACHE_DIR / "sample-candidates.json"
COLLECTION_STATE_FILE = CACHE_DIR / "collection-scan-state.json"
_persistent_cache: dict[str, dict] = {}
_db_lock = threading.RLock()
_source_health_lock = threading.RLock()
_source_health: dict[str, dict] = {}
_collection_lock = threading.RLock()
_collection_tasks: dict[str, dict] = {}
_collection_sequence = 0
_candidate_revision = 0
_candidate_file_lock = threading.RLock()
_retry_lock = threading.RLock()
_retry_tasks: dict[str, dict] = {}
_retry_sequence = 0
_candidate_catalog_lock = threading.RLock()
_candidate_catalog_cache: dict = {}


def _init_sqlite() -> None:
    """Create the persistent cache schema without requiring extra packages."""
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS cache_entries (
                    cache_key TEXT PRIMARY KEY, saved_at REAL NOT NULL,
                    payload TEXT NOT NULL, source TEXT, period TEXT,
                    adjust TEXT, symbol TEXT, kind TEXT
                );
                CREATE TABLE IF NOT EXISTS instruments (
                    symbol TEXT PRIMARY KEY, name TEXT, kind TEXT,
                    provider TEXT, source_date TEXT, fetched_at TEXT
                );
                CREATE TABLE IF NOT EXISTS daily_bars (
                    provider TEXT NOT NULL, symbol TEXT NOT NULL, period TEXT NOT NULL, adjust TEXT NOT NULL,
                    date TEXT NOT NULL, open REAL, high REAL, low REAL,
                    close REAL, volume REAL, fetched_at TEXT,
                    PRIMARY KEY(provider, symbol, period, adjust, date)
                );
                CREATE TABLE IF NOT EXISTS intraday_bars (
                    provider TEXT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL, date TEXT NOT NULL,
                    time TEXT NOT NULL, open REAL, close REAL, volume REAL,
                    direction TEXT, fetched_at TEXT,
                    PRIMARY KEY(provider, symbol, interval, date, time)
                );
                CREATE TABLE IF NOT EXISTS sample_candidates (
                    sample_key TEXT PRIMARY KEY, payload TEXT NOT NULL,
                    saved_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS source_health (
                    source_id TEXT PRIMARY KEY, configured INTEGER NOT NULL,
                    available INTEGER NOT NULL, last_success TEXT,
                    last_failure TEXT, failures INTEGER NOT NULL DEFAULT 0,
                    latency_ms REAL, error TEXT
                );
                CREATE TABLE IF NOT EXISTS request_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL,
                    source TEXT NOT NULL, kind TEXT NOT NULL, symbol TEXT,
                    period TEXT, status TEXT NOT NULL, latency_ms REAL,
                    error TEXT
                );
                CREATE TABLE IF NOT EXISTS sample_validations (
                    sample_key TEXT PRIMARY KEY, symbol TEXT NOT NULL,
                    pattern_id TEXT NOT NULL, status TEXT NOT NULL,
                    providers_json TEXT NOT NULL, report_json TEXT NOT NULL,
                    created_at REAL NOT NULL, updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS training_reviews (
                    review_id TEXT PRIMARY KEY, archived_at TEXT NOT NULL,
                    symbol TEXT NOT NULL, code TEXT NOT NULL,
                    trade_count INTEGER NOT NULL, note_count INTEGER NOT NULL,
                    payload TEXT NOT NULL, updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_daily_lookup
                    ON daily_bars(symbol, period, adjust, date);
                CREATE INDEX IF NOT EXISTS idx_intraday_lookup
                    ON intraday_bars(symbol, interval, date, time);
            """)
            daily_pk = [row[1] for row in sorted(db.execute("PRAGMA table_info(daily_bars)"), key=lambda row: row[5]) if row[5]]
            if daily_pk != ["provider", "symbol", "period", "adjust", "date"]:
                legacy = f"daily_bars_legacy_v16_{int(time.time())}"
                legacy_columns = {row[1] for row in db.execute("PRAGMA table_info(daily_bars)")}
                provider_expr = "COALESCE(NULLIF(provider,''),'legacy')" if "provider" in legacy_columns else "'legacy'"
                db.execute("DROP INDEX IF EXISTS idx_daily_lookup")
                db.execute(f"ALTER TABLE daily_bars RENAME TO {legacy}")
                db.execute("""
                    CREATE TABLE daily_bars (
                        provider TEXT NOT NULL, symbol TEXT NOT NULL, period TEXT NOT NULL, adjust TEXT NOT NULL,
                        date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, volume REAL, fetched_at TEXT,
                        PRIMARY KEY(provider, symbol, period, adjust, date)
                    )
                """)
                db.execute(f"""
                    INSERT OR IGNORE INTO daily_bars(provider,symbol,period,adjust,date,open,high,low,close,volume,fetched_at)
                    SELECT {provider_expr},symbol,period,adjust,date,open,high,low,close,volume,fetched_at
                    FROM {legacy}
                """)
                db.execute("CREATE INDEX idx_daily_lookup ON daily_bars(symbol, period, adjust, date)")
            intraday_pk = [row[1] for row in sorted(db.execute("PRAGMA table_info(intraday_bars)"), key=lambda row: row[5]) if row[5]]
            if intraday_pk != ["provider", "symbol", "interval", "date", "time"]:
                legacy = f"intraday_bars_legacy_v16_{int(time.time())}"
                legacy_columns = {row[1] for row in db.execute("PRAGMA table_info(intraday_bars)")}
                provider_expr = "COALESCE(NULLIF(provider,''),'legacy')" if "provider" in legacy_columns else "'legacy'"
                db.execute("DROP INDEX IF EXISTS idx_intraday_lookup")
                db.execute(f"ALTER TABLE intraday_bars RENAME TO {legacy}")
                db.execute("""
                    CREATE TABLE intraday_bars (
                        provider TEXT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL, date TEXT NOT NULL,
                        time TEXT NOT NULL, open REAL, close REAL, volume REAL, direction TEXT, fetched_at TEXT,
                        PRIMARY KEY(provider, symbol, interval, date, time)
                    )
                """)
                db.execute(f"""
                    INSERT OR IGNORE INTO intraday_bars(provider,symbol,interval,date,time,open,close,volume,direction,fetched_at)
                    SELECT {provider_expr},symbol,interval,date,time,open,close,volume,direction,fetched_at
                    FROM {legacy}
                """)
                db.execute("CREATE INDEX idx_intraday_lookup ON intraday_bars(symbol, interval, date, time)")
    except (OSError, sqlite3.Error):
        # JSON remains a recoverable fallback for read-only portable folders.
        return


def _source_configured(source_id: str) -> bool:
    if source_id in {"tencent", "sina"}:
        return True
    if source_id == "baostock":
        try:
            import baostock  # noqa: F401
            return True
        except ImportError:
            return False
    if source_id == "tushare":
        return bool(os.getenv("TUSHARE_TOKEN") or os.getenv("TUSHARE_TOKEN_FILE"))
    if source_id == "tdx":
        return any(__import__(name, fromlist=["*"]) for name in ("tqserver", "tqcenter") if _module_available(name))
    if source_id == "akshare":
        return _module_available("akshare")
    if source_id == "csv":
        return True
    return False


def _module_available(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def _record_source(source_id: str, success: bool, latency_ms: float, error: str = "") -> None:
    now = datetime.now(timezone.utc).isoformat()
    with _source_health_lock:
        item = _source_health.setdefault(source_id, {
            "id": source_id, "name": SOURCE_LABELS.get(source_id, source_id),
            "configured": _source_configured(source_id), "available": False,
            "lastSuccess": None, "lastFailure": None, "failures": 0,
            "latencyMs": None, "error": "",
            "cooldownUntil": 0,
        })
        item["configured"] = _source_configured(source_id) or success
        item["latencyMs"] = round(float(latency_ms), 1)
        if success:
            item["available"] = True
            item["lastSuccess"] = now
            item["error"] = ""
            item["failures"] = 0
            item["cooldownUntil"] = 0
        else:
            item["available"] = False
            item["lastFailure"] = now
            item["failures"] = int(item.get("failures", 0)) + 1
            item["error"] = error[:500]
            if item["failures"] >= 3:
                item["cooldownUntil"] = time.time() + 60


def _source_in_cooldown(source_id: str) -> bool:
    with _source_health_lock:
        return float((_source_health.get(source_id) or {}).get("cooldownUntil") or 0) > time.time()


def _log_request(source_id: str, kind: str, symbol: str, period: str, status: str, latency_ms: float, error: str = "") -> None:
    try:
        with closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
            db.execute(
                "INSERT INTO request_logs(started_at,source,kind,symbol,period,status,latency_ms,error) VALUES(?,?,?,?,?,?,?,?)",
                (datetime.now(timezone.utc).isoformat(), source_id, kind, symbol, period, status, round(latency_ms, 1), error[:500]),
            )
    except (OSError, sqlite3.Error):
        return


def _cache_name(key: tuple) -> str:
    return json.dumps(list(key), ensure_ascii=False, separators=(",", ":"))


def _load_persistent_cache() -> None:
    global _persistent_cache
    try:
        raw = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        entries = raw.get("entries", {}) if isinstance(raw, dict) else {}
        if isinstance(entries, dict):
            _persistent_cache = entries
    except (OSError, ValueError, TypeError):
        try:
            raw = json.loads(CACHE_BACKUP_FILE.read_text(encoding="utf-8"))
            entries = raw.get("entries", {}) if isinstance(raw, dict) else {}
            if isinstance(entries, dict):
                _persistent_cache = entries
        except (OSError, ValueError, TypeError):
            _persistent_cache = {}


def _sqlite_get(name: str) -> dict | None:
    try:
        with closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
            row = db.execute("SELECT saved_at, payload FROM cache_entries WHERE cache_key = ?", (name,)).fetchone()
        if not row:
            return None
        payload = json.loads(row[1])
        return {"savedAt": float(row[0]), "payload": payload} if isinstance(payload, dict) else None
    except (OSError, sqlite3.Error, TypeError, ValueError):
        return None


def _flush_sqlite_cache() -> None:
    try:
        with _db_lock, closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
            with _cache_lock:
                entries = list(_persistent_cache.items())[-PERSISTENT_CACHE_MAX_ENTRIES:]
            for name, entry in entries:
                payload = entry.get("payload") if isinstance(entry, dict) else None
                if not isinstance(payload, dict):
                    continue
                db.execute(
                    "INSERT OR REPLACE INTO cache_entries(cache_key,saved_at,payload,source,period,adjust,symbol,kind) VALUES(?,?,?,?,?,?,?,?)",
                    (name, float(entry.get("savedAt", time.time())), json.dumps(payload, ensure_ascii=False),
                     str(payload.get("provider", "")), str(payload.get("period", "")), str(payload.get("adjust", "")),
                     str(payload.get("code", payload.get("symbol", ""))), "intraday" if "interval" in payload else "market"),
                )
                if "bars" in payload and payload.get("period") in PERIODS:
                    for bar in payload.get("bars", []):
                        db.execute(
                            "INSERT OR REPLACE INTO daily_bars(provider,symbol,period,adjust,date,open,high,low,close,volume,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            (str(payload.get("provider", "")), str(payload.get("code", "")), str(payload.get("period", "")), str(payload.get("adjust", "")),
                             str(bar.get("date", "")), bar.get("open"), bar.get("high"), bar.get("low"), bar.get("close"),
                             bar.get("volume"), str(payload.get("fetchedAt", ""))),
                        )
                if "interval" in payload and "bars" in payload:
                    for bar in payload.get("bars", []):
                        db.execute(
                            "INSERT OR REPLACE INTO intraday_bars(provider,symbol,interval,date,time,open,close,volume,direction,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                            (str(payload.get("provider", "")), str(payload.get("code", "")), str(payload.get("interval", "")), str(payload.get("date", "")),
                             str(bar.get("time", "")), bar.get("open"), bar.get("close"), bar.get("volume"), bar.get("direction"),
                             str(payload.get("fetchedAt", ""))),
                        )
            for source_id, item in _source_health.items():
                db.execute(
                    "INSERT OR REPLACE INTO source_health(source_id,configured,available,last_success,last_failure,failures,latency_ms,error) VALUES(?,?,?,?,?,?,?,?)",
                    (source_id, int(bool(item.get("configured"))), int(bool(item.get("available"))), item.get("lastSuccess"),
                     item.get("lastFailure"), int(item.get("failures", 0)), item.get("latencyMs"), item.get("error", "")),
                )
    except (OSError, sqlite3.Error):
        return


def _flush_persistent_cache() -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        if CACHE_FILE.exists():
            shutil.copy2(CACHE_FILE, CACHE_BACKUP_FILE)
        entries = list(_persistent_cache.items())[-PERSISTENT_CACHE_MAX_ENTRIES:]
        payload = {"version": 1, "updatedAt": datetime.now(timezone.utc).isoformat(), "entries": dict(entries)}
        temp_file = CACHE_FILE.with_suffix(".tmp")
        temp_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temp_file.replace(CACHE_FILE)
    except OSError:
        # A portable build may be launched from a read-only directory. The
        # in-memory cache still works, while the UI receives the real result.
        return


def _get_cached(key: tuple, ttl_seconds: int) -> dict | None:
    now = time.time()
    name = _cache_name(key)
    with _cache_lock:
        cached = _cache.get(key)
        if cached and now - cached[0] < ttl_seconds:
            return cached[1]
        entry = _persistent_cache.get(name)
        if not isinstance(entry, dict):
            entry = _sqlite_get(name)
            if entry:
                _persistent_cache[name] = entry
        if not isinstance(entry, dict):
            return None
        saved_at = float(entry.get("savedAt", 0) or 0)
        payload = entry.get("payload")
        if saved_at <= 0 or now - saved_at >= ttl_seconds or not isinstance(payload, dict):
            return None
        _cache[key] = (saved_at, payload)
        return payload


def _set_cached(key: tuple, payload: dict) -> None:
    global _cache_flush_timer
    now = time.time()
    with _cache_lock:
        _cache[key] = (now, payload)
        _persistent_cache[_cache_name(key)] = {"savedAt": now, "payload": payload}
        # Batch disk writes during a large scan; writing a multi-megabyte JSON
        # file after every security would make collection slower than the
        # upstream requests themselves.
        if _cache_flush_timer is None or not _cache_flush_timer.is_alive():
            _cache_flush_timer = threading.Timer(1.0, _flush_cache_in_background)
            _cache_flush_timer.daemon = True
            _cache_flush_timer.start()


def _flush_cache_in_background() -> None:
    global _cache_flush_timer
    with _cache_lock:
        _cache_flush_timer = None
    _flush_persistent_cache()
    _flush_sqlite_cache()


_init_sqlite()
_load_persistent_cache()


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


def _normalize_bars(rows: list, raw_count: int, provider: str, code: str, symbol_name: str, adjust: str, period: str, *, excluded_count: int = 0, volume_unit: str = "股") -> dict:
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
        "volumeUnit": volume_unit,
        "excludedCount": excluded_count,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }


def _http_get_text(url: str, *, timeout: int = 15, retries: int = 3, headers: dict | None = None) -> str:
    request_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KLineTraining/1.7",
        "Accept": "application/json,text/plain,*/*",
        "Connection": "close",
    }
    if headers:
        request_headers.update(headers)
    last_error: Exception | None = None
    for attempt in range(max(1, retries)):
        try:
            with urlopen(Request(url, headers=request_headers), timeout=timeout) as response:
                raw = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
            try:
                return raw.decode(charset)
            except (LookupError, UnicodeDecodeError):
                return raw.decode("utf-8", errors="replace")
        except Exception as exc:
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(0.45 * (attempt + 1))
    raise RuntimeError(f"网页行情请求失败：{last_error}")


def _http_get_json(url: str, *, timeout: int = 15, retries: int = 3, headers: dict | None = None) -> dict | list:
    return json.loads(_http_get_text(url, timeout=timeout, retries=retries, headers=headers))


def _web_symbol(symbol: str) -> str:
    code = symbol.split(".", 1)[1]
    return ("sh" if symbol.startswith("1.") else "sz") + code


def fetch_sina_universe(force: bool = False) -> dict:
    key = ("universe", "sina")
    if not force:
        cached = _get_cached(key, UNIVERSE_CACHE_TTL_SECONDS)
        if cached:
            return cached
    instruments = []
    excluded_count = 0
    started = time.perf_counter()
    page_limit_seconds = 45
    for page in range(1, 91):
        if time.perf_counter() - started >= page_limit_seconds:
            break
        query = urlencode({
            "page": page, "num": 100, "sort": "symbol", "asc": 1,
            "node": "hs_a", "symbol": "", "_s_r_a": "init",
        })
        try:
            # 清单是初筛入口，不应因一个分页请求无限重试；已经取得的
            # 真实标的可以先进入后续腾讯日线扫描。
            payload = _http_get_json(f"{SINA_UNIVERSE_URL}?{query}", timeout=8, retries=1)
        except Exception:
            break
        if not isinstance(payload, list) or not payload:
            break
        for row in payload:
            code = str(row.get("code") or "").strip()
            name = str(row.get("name") or code).strip()
            is_stock = code.startswith(("6", "0", "3")) and len(code) == 6
            active = float(row.get("trade") or 0) > 0 and float(row.get("volume") or 0) > 0
            if not is_stock or not active or re.search(r"(?:ST|退)", name.upper()):
                excluded_count += 1
                continue
            instruments.append({
                "symbol": code, "name": name, "kind": "stock",
                "price": float(row.get("trade") or 0), "volume": float(row.get("volume") or 0),
            })
        if len(payload) < 100:
            break
        time.sleep(0.08)
    unique = list({item["symbol"]: item for item in instruments}.values())
    unique.sort(key=lambda item: item["symbol"])
    if not unique:
        raise RuntimeError("新浪证券列表没有返回可用的A股标的。")
    partial = page < 90 and len(unique) < 800
    result = {
        "provider": "新浪网页行情", "sourceId": "sina", "role": "prefilter",
        "sourceDate": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "instruments": unique, "count": len(unique), "excludedCount": excluded_count,
        "partial": partial,
        "warning": "证券清单采用本轮已成功返回的真实分页，后续分页暂不可用；不影响已取得标的扫描。" if partial else "",
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }
    _set_cached(key, result)
    return result


def fetch_sina(symbol: str, limit: int, adjust: str, period: str) -> dict:
    if period != "daily":
        raise RuntimeError("新浪初筛源当前只用于日线扫描。")
    key = ("sina", symbol, limit, adjust, period)
    cached = _get_cached(key, HISTORICAL_CACHE_TTL_SECONDS)
    if cached:
        return cached
    query = urlencode({"symbol": _web_symbol(symbol), "scale": 240, "ma": "no", "datalen": min(limit, SAMPLE_SCAN_HISTORY_BARS)})
    raw = _http_get_text(f"{SINA_KLINE_URL}?{query}", timeout=15, retries=3)
    match = re.search(r"\((\[.*\])\);?\s*$", raw, re.S)
    if not match:
        raise RuntimeError("新浪日线返回格式无法识别。")
    payload = json.loads(match.group(1))
    rows = [[item.get("day"), item.get("open"), item.get("close"), item.get("high"), item.get("low"), item.get("volume")] for item in payload]
    code = symbol.split(".", 1)[1]
    result = _normalize_bars(rows, len(rows), "新浪网页行情", code, code, "unknown", period, volume_unit="股")
    result["bars"] = result["bars"][-limit:]
    result["validCount"] = len(result["bars"])
    result["sourceId"] = "sina"
    result["role"] = "prefilter"
    result["adjustWarning"] = "新浪公开网页接口未声明复权基准，仅用于初筛；正式样本以腾讯前复权和BaoStock前复权复核。"
    _set_cached(key, result)
    return result


def _tencent_volume_unit(symbol: str) -> str:
    """Tencent returns 科创板 volume in shares and most other instruments in lots."""
    code = symbol.split(".", 1)[1]
    return "股" if code.startswith("688") else "手"


def _completed_daily_payload(payload: dict) -> dict:
    """Remove an in-progress current-day bar before historical training."""
    bars = [dict(bar) for bar in payload.get("bars", [])]
    now = datetime.now().astimezone()
    today = now.date().isoformat()
    session_closed = now.weekday() >= 5 or (now.hour, now.minute) >= (15, 10)
    if not session_closed:
        bars = [bar for bar in bars if str(bar.get("date", "")) < today]
    else:
        bars = [bar for bar in bars if str(bar.get("date", "")) <= today]
    result = dict(payload)
    result["bars"] = bars
    result["validCount"] = len(bars)
    result["excludedInProgressBar"] = len(payload.get("bars", [])) - len(bars)
    return result


def fetch_tencent(symbol: str, limit: int, adjust: str, period: str) -> dict:
    key = ("tencent", symbol, limit, adjust, period)
    cached = _get_cached(key, HISTORICAL_CACHE_TTL_SECONDS)
    if cached:
        return cached
    web_code = _web_symbol(symbol)
    source_period = {"daily": "day", "weekly": "week", "monthly": "month", "yearly": "day"}[period]
    source_adjust = {"qfq": "qfq", "hfq": "hfq", "none": ""}[adjust]
    param = f"{web_code},{source_period},,,{min(limit, SAMPLE_SCAN_HISTORY_BARS)},{source_adjust}"
    payload = _http_get_json(f"{TENCENT_KLINE_URL}?{urlencode({'param': param})}", timeout=15, retries=3)
    node = ((payload or {}).get("data") or {}).get(web_code) or {}
    rows = node.get(f"{source_adjust}{source_period}") or node.get(source_period) or []
    code = symbol.split(".", 1)[1]
    name = ((node.get("qt") or [None, code])[1] if isinstance(node.get("qt"), list) else code) or code
    result = _normalize_bars(
        rows, len(rows), "腾讯网页行情", code, f"{name} ({code})", adjust,
        "daily" if period == "yearly" else period, volume_unit=_tencent_volume_unit(symbol),
    )
    if period == "yearly":
        result["bars"] = _aggregate_yearly(result["bars"])
        result["period"] = "yearly"
    result["bars"] = result["bars"][-limit:]
    result["validCount"] = len(result["bars"])
    result["sourceId"] = "tencent"
    result["role"] = "prefilter"
    _set_cached(key, result)
    return result


def fetch_eastmoney(symbol: str, limit: int, adjust: str, period: str) -> dict:
    key = ("eastmoney", symbol, limit, adjust, period)
    cached = _get_cached(key, HISTORICAL_CACHE_TTL_SECONDS)
    if cached:
        return cached

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
    _set_cached(key, result)
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


def fetch_baostock(symbol: str, limit: int, adjust: str, period: str, *, start_date: str = "", end_date: str = "") -> dict:
    key = ("baostock", symbol, limit, adjust, period, start_date, end_date)
    cached = _get_cached(key, HISTORICAL_CACHE_TTL_SECONDS)
    if cached:
        return cached
    try:
        import baostock as bs
    except ImportError as exc:
        raise RuntimeError("BaoStock 未安装，请先运行安装脚本，或改用 CSV 导入。") from exc
    code = symbol.split('.', 1)[1]
    market = "sh" if symbol.startswith("1.") else "sz"
    bs_code = f"{market}.{code}"
    frequency = {"daily": "d", "weekly": "w", "monthly": "m", "yearly": "d"}[period]
    adjustflag = _baostock_adjustflag(adjust)
    is_stock = (market == "sh" and code.startswith("6")) or (market == "sz" and code.startswith(("0", "3")))
    filterable = frequency == "d" and is_stock
    fields = "date,open,high,low,close,volume,amount,adjustflag,tradestatus,isST" if filterable else "date,open,high,low,close,volume,amount,adjustflag"
    raw_rows = []
    excluded_count = 0
    query_start = start_date or "1990-01-01"
    query_end = end_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with _baostock_lock:
        login = bs.login()
        if getattr(login, "error_code", "1") != "0":
            raise RuntimeError(f"BaoStock 登录失败：{getattr(login, 'error_msg', '未知错误')}")
        try:
            result = bs.query_history_k_data_plus(
                bs_code,
                fields,
                start_date=query_start,
                end_date=query_end,
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
    if normalized["validCount"] == 0:
        raise RuntimeError(f"BaoStock 没有返回 {code} 的有效 {period} 前复权数据。")
    normalized["symbol"] = f"{code}（BaoStock）"
    _set_cached(key, normalized)
    return normalized


def _normalize_intraday_rows(rows: list, code: str, provider: str, target_date: str, interval: str) -> dict:
    bars = []
    for row in rows:
        if isinstance(row, str):
            row = row.split(",")
        if not isinstance(row, (list, tuple)):
            continue
        try:
            if provider == "BaoStock":
                # date,time,code,open,high,low,close,volume,amount
                raw_time = str(row[1])
                open_price = float(row[3])
                high_price = float(row[4])
                low_price = float(row[5])
                close_price = float(row[6])
                volume = float(row[7])
                time_label = f"{raw_time[8:10]}:{raw_time[10:12]}" if len(raw_time) >= 12 else raw_time
            else:
                # Eastmoney: time,open,close,high,low,volume,...
                raw_time = str(row[0])
                open_price = float(row[1])
                close_price = float(row[2])
                high_price = float(row[3])
                low_price = float(row[4])
                volume = float(row[5])
                time_label = raw_time[-5:] if len(raw_time) >= 5 else raw_time
        except (IndexError, TypeError, ValueError):
            continue
        if (volume < 0 or open_price <= 0 or close_price <= 0
                or high_price < max(open_price, close_price)
                or low_price > min(open_price, close_price)
                or low_price <= 0 or not time_label):
            continue
        direction = "up" if close_price > open_price else "down" if close_price < open_price else "flat"
        bars.append({
            "time": time_label, "open": open_price, "high": high_price, "low": low_price,
            "close": close_price, "volume": volume, "direction": direction,
        })
    unique = []
    seen = set()
    for bar in sorted(bars, key=lambda item: item["time"]):
        if bar["time"] in seen:
            continue
        seen.add(bar["time"])
        unique.append(bar)
    if not unique:
        raise RuntimeError(f"{provider} 没有返回 {target_date} 的真实 {interval} 分钟成交量数据。")
    return {
        "code": code,
        "date": target_date,
        "interval": interval,
        "schemaVersion": INTRADAY_CACHE_SCHEMA_VERSION,
        "provider": provider,
        "bars": unique,
        "validCount": len(unique),
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }


def _valid_intraday_day(record: dict, target_date: str, interval: str = "5") -> tuple[bool, str]:
    """Strict gate used for training samples, not for the looser popup preview."""
    if not isinstance(record, dict):
        return False, "分时记录格式无效"
    if str(record.get("date", ""))[:10] != str(target_date)[:10]:
        return False, "分时日期与日K日期不一致"
    if str(record.get("interval", interval)) != interval:
        return False, "分时粒度不是5分钟"
    if not record.get("provider") or "演示" in str(record.get("provider")) or record.get("provider") == "demo":
        return False, "分时数据源不是已确认的真实来源"
    bars = record.get("bars")
    expected = list(INTRADAY_EXPECTED_TIMES_5) if interval == "5" else []
    if not isinstance(bars, list) or len(bars) != len(expected):
        return False, f"分时应有{len(expected)}根，实际{len(bars) if isinstance(bars, list) else 0}根"
    actual = [str(item.get("time", "")) for item in bars if isinstance(item, dict)]
    if actual != expected or len(set(actual)) != len(expected):
        return False, "分时交易时间不完整、重复或顺序异常"
    for item in bars:
        if not isinstance(item, dict):
            return False, "分时柱数据格式无效"
        try:
            open_price = float(item["open"])
            high_price = float(item["high"])
            low_price = float(item["low"])
            close_price = float(item["close"])
            volume = float(item["volume"])
        except (KeyError, TypeError, ValueError):
            return False, "分时存在非数字字段"
        if min(open_price, high_price, low_price, close_price) <= 0 or volume < 0:
            return False, "分时价格或成交量无效"
        if high_price < max(open_price, close_price) or low_price > min(open_price, close_price):
            return False, "分时OHLC关系错误"
    return True, ""


def fetch_baostock_intraday(symbol: str, target_date: str, interval: str) -> dict:
    key = ("baostock-intraday", symbol, target_date, interval)
    cached = _get_cached(key, INTRADAY_CACHE_TTL_SECONDS)
    if cached and cached.get("schemaVersion") == INTRADAY_CACHE_SCHEMA_VERSION:
        return {**cached, "cached": True}
    try:
        import baostock as bs
    except ImportError as exc:
        raise RuntimeError("BaoStock 未安装，无法获取真实分时数据。") from exc
    code = symbol.split(".", 1)[1]
    market = "sh" if symbol.startswith("1.") else "sz"
    raw_rows = []
    with _baostock_lock:
        login = bs.login()
        if getattr(login, "error_code", "1") != "0":
            raise RuntimeError(f"BaoStock 登录失败：{getattr(login, 'error_msg', '未知错误')}")
        try:
            result = bs.query_history_k_data_plus(
                f"{market}.{code}",
                "date,time,code,open,high,low,close,volume,amount",
                start_date=target_date,
                end_date=target_date,
                frequency=INTRADAY_FREQUENCIES[interval],
                adjustflag="3",
            )
            if getattr(result, "error_code", "1") != "0":
                raise RuntimeError(f"BaoStock 分时查询失败：{getattr(result, 'error_msg', '未知错误')}")
            while result.next():
                raw_rows.append(result.get_row_data())
        finally:
            bs.logout()
    normalized = _normalize_intraday_rows(raw_rows, code, "BaoStock", target_date, interval)
    normalized["volumeUnit"] = "股"
    _set_cached(key, normalized)
    return normalized


def fetch_baostock_intraday_range(
    symbol: str,
    dates: list[str],
    interval: str = "5",
    progress=None,
    should_stop=None,
) -> dict[str, dict]:
    """Fetch and persist all requested trading days with a bounded number of calls.

    BaoStock limits large minute queries.  Thirty-calendar-day chunks stay below
    that limit while one login is reused for the whole candidate.  Every day is
    still normalized and cached independently, so a later retry only requests
    missing days.
    """
    if interval != "5":
        raise RuntimeError("批量分时预采集当前只支持 5 分钟。")
    wanted = sorted({str(item)[:10] for item in dates if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(item)[:10])})
    if not wanted:
        raise RuntimeError("候选没有可预采集的交易日。")
    code = symbol.split(".", 1)[1]
    market = "sh" if symbol.startswith("1.") else "sz"
    result_by_date: dict[str, dict] = {}
    missing = []
    for target_date in wanted:
        cached = _get_cached(("baostock-intraday", symbol, target_date, interval), INTRADAY_CACHE_TTL_SECONDS)
        if cached and cached.get("schemaVersion") == INTRADAY_CACHE_SCHEMA_VERSION:
            valid, _ = _valid_intraday_day(cached, target_date, interval)
            if valid:
                result_by_date[target_date] = {**cached, "cached": True}
            if progress:
                progress(len(result_by_date), len(wanted), target_date)
        if target_date not in result_by_date:
            missing.append(target_date)
    if not missing:
        return result_by_date
    try:
        import baostock as bs
    except ImportError as exc:
        raise RuntimeError("BaoStock 未安装，无法批量预采集真实分时数据。") from exc

    missing_set = set(missing)
    cursor = datetime.strptime(missing[0], "%Y-%m-%d").date()
    final_date = datetime.strptime(missing[-1], "%Y-%m-%d").date()
    raw_by_date: dict[str, list] = {}
    with _baostock_lock:
        login = bs.login()
        if getattr(login, "error_code", "1") != "0":
            raise RuntimeError(f"BaoStock 登录失败：{getattr(login, 'error_msg', '未知错误')}")
        try:
            while cursor <= final_date:
                if should_stop and should_stop():
                    raise RuntimeError("用户已停止采集，未继续发起新的分时请求。")
                chunk_end = min(cursor + timedelta(days=29), final_date)
                chunk_dates = {item for item in missing_set if cursor.isoformat() <= item <= chunk_end.isoformat()}
                if chunk_dates:
                    query = bs.query_history_k_data_plus(
                        f"{market}.{code}",
                        "date,time,code,open,high,low,close,volume,amount",
                        start_date=cursor.isoformat(), end_date=chunk_end.isoformat(),
                        frequency=INTRADAY_FREQUENCIES[interval], adjustflag="3",
                    )
                    if getattr(query, "error_code", "1") != "0":
                        raise RuntimeError(f"BaoStock 批量分时查询失败：{getattr(query, 'error_msg', '未知错误')}")
                    while query.next():
                        row = query.get_row_data()
                        if row and str(row[0]) in chunk_dates:
                            raw_by_date.setdefault(str(row[0]), []).append(row)
                cursor = chunk_end + timedelta(days=1)
        finally:
            bs.logout()

    for target_date in missing:
        rows = raw_by_date.get(target_date, [])
        if not rows:
            continue
        normalized = _normalize_intraday_rows(rows, code, "BaoStock", target_date, interval)
        normalized["volumeUnit"] = "股"
        valid, reason = _valid_intraday_day(normalized, target_date, interval)
        if not valid:
            continue
        _set_cached(("baostock-intraday", symbol, target_date, interval), normalized)
        result_by_date[target_date] = normalized
        if progress:
            progress(len(result_by_date), len(wanted), target_date)
    missing_after = [item for item in wanted if item not in result_by_date]
    if missing_after:
        raise RuntimeError(f"批量分时缺少 {len(missing_after)} 个交易日，首个缺失日期 {missing_after[0]}。")
    return result_by_date


def fetch_eastmoney_intraday(symbol: str, target_date: str, interval: str) -> dict:
    key = ("eastmoney-intraday", symbol, target_date, interval)
    cached = _get_cached(key, INTRADAY_CACHE_TTL_SECONDS)
    if cached and cached.get("schemaVersion") == INTRADAY_CACHE_SCHEMA_VERSION:
        return {**cached, "cached": True}
    day = target_date.replace("-", "")
    query = (
        "fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13"
        "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
        f"&beg={day}&end={day}&klt={interval}&fqt=0"
        f"&secid={quote(symbol)}&lmt=1000&rtntype=6"
        "&ut=fa5fd1943c7b386f172d6893dbbd1b5b"
    )
    payload = None
    last_error: Exception | None = None
    for upstream in UPSTREAMS:
        request = Request(
            f"{upstream}?{query}",
            headers={"User-Agent": "Mozilla/5.0 KLineTraining/1.0", "Referer": "https://quote.eastmoney.com/", "Connection": "close"},
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
        raise RuntimeError(f"东方财富分时接口暂时不可用：{last_error}")
    rows = (payload.get("data") or {}).get("klines") or []
    normalized = _normalize_intraday_rows(rows, symbol.split(".", 1)[1], "东方财富", target_date, interval)
    normalized["volumeUnit"] = "手"
    _set_cached(key, normalized)
    return normalized


def fetch_sina_intraday(symbol: str, target_date: str, interval: str) -> dict:
    """Use Sina's public recent-minute endpoint only when it contains the exact date.

    The endpoint is not treated as a historical archive: bars from another date
    are rejected instead of being silently substituted for the requested day.
    """
    if interval != "5":
        raise RuntimeError("新浪公开分时备用目前只支持 5 分钟。")
    key = ("sina-intraday", symbol, target_date, interval)
    cached = _get_cached(key, INTRADAY_CACHE_TTL_SECONDS)
    if cached and cached.get("schemaVersion") == INTRADAY_CACHE_SCHEMA_VERSION:
        return {**cached, "cached": True}
    code = symbol.split(".", 1)[1]
    market = "sh" if symbol.startswith("1.") else "sz"
    request = Request(
        f"https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_cb=/CN_MarketDataService.getKLineData"
        # Sina 对过大的 datalen 可能直接返回 null；1023 是公开接口较稳定的上限。
        f"?symbol={market}{code}&scale=5&ma=no&datalen=1023",
        headers={"User-Agent": "Mozilla/5.0 KLineTraining/1.8", "Referer": "https://finance.sina.com.cn/"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            text = response.read().decode("utf-8", errors="replace")
    except Exception as exc:
        raise RuntimeError(f"新浪公开分时请求失败：{exc}") from exc
    match = re.search(r"_cb=\(\s*(\[.*\])\s*\)", text, re.S)
    if not match:
        raise RuntimeError("新浪公开分时返回格式无法校验，已拒绝使用。")
    try:
        records = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise RuntimeError("新浪公开分时返回不是有效 JSON，已拒绝使用。") from exc
    rows = []
    for item in records:
        if not isinstance(item, dict) or str(item.get("day", ""))[:10] != target_date:
            continue
        rows.append([
            str(item.get("day", "")).split(" ", 1)[-1][:5], item.get("open"), item.get("close"),
            item.get("high"), item.get("low"), item.get("volume"),
        ])
    normalized = _normalize_intraday_rows(rows, code, "新浪", target_date, interval)
    normalized["volumeUnit"] = "股"
    _set_cached(key, normalized)
    return normalized


def fetch_tencent_intraday(symbol: str, target_date: str, interval: str) -> dict:
    """Fetch Tencent's public recent 5-minute bars and keep only the exact date."""
    if interval != "5":
        raise RuntimeError("腾讯公开分时备用目前只支持 5 分钟。")
    key = ("tencent-intraday", symbol, target_date, interval)
    cached = _get_cached(key, INTRADAY_CACHE_TTL_SECONDS)
    if cached and cached.get("schemaVersion") == INTRADAY_CACHE_SCHEMA_VERSION:
        return {**cached, "cached": True}
    code = symbol.split(".", 1)[1]
    market = "sh" if symbol.startswith("1.") else "sz"
    request = Request(
        f"http://ifzq.gtimg.cn/appstock/app/kline/mkline?param={market}{code},m5,,1023",
        headers={"User-Agent": "Mozilla/5.0 KLineTraining/1.8", "Referer": "https://gu.qq.com/"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except Exception as exc:
        raise RuntimeError(f"腾讯公开分时请求失败：{exc}") from exc
    if payload.get("code") != 0:
        raise RuntimeError(f"腾讯公开分时返回错误：{payload.get('msg') or payload.get('code')}")
    data = (payload.get("data") or {}).get(f"{market}{code}") or {}
    records = data.get("m5") or []
    rows = []
    for item in records:
        if not isinstance(item, (list, tuple)) or len(item) < 6:
            continue
        raw_time = str(item[0])
        if len(raw_time) < 12 or raw_time[:8] != target_date.replace("-", ""):
            continue
        rows.append([
            f"{raw_time[8:10]}:{raw_time[10:12]}",
            item[1], item[2], item[3], item[4], item[5],
        ])
    normalized = _normalize_intraday_rows(rows, code, "腾讯", target_date, interval)
    normalized["volumeUnit"] = "手"
    _set_cached(key, normalized)
    return normalized


def _tushare_token() -> str:
    token = os.getenv("TUSHARE_TOKEN", "").strip()
    if token:
        return token
    token_file = os.getenv("TUSHARE_TOKEN_FILE", "").strip()
    if token_file:
        try:
            return Path(token_file).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return ""


def _tushare_code(code: str) -> str:
    return f"{code}.SH" if code.startswith(("5", "6", "68")) else f"{code}.SZ"


def _tushare_request(api_name: str, params: dict) -> tuple[list[str], list[list]]:
    token = _tushare_token()
    if not token:
        raise RuntimeError("Tushare Pro 未配置 TUSHARE_TOKEN；请在电脑环境变量中配置，不要写入前端或公开 EXE。")
    body = json.dumps({"api_name": api_name, "token": token, "params": params, "fields": ""}).encode("utf-8")
    request = Request("https://api.tushare.pro", data=body, headers={"Content-Type": "application/json", "User-Agent": "KLineTraining/1.7"}, method="POST")
    with urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("code") != 0:
        raise RuntimeError(f"Tushare Pro 返回错误：{payload.get('msg') or payload.get('code')}")
    result = payload.get("data") or {}
    rows = result.get("items") or []
    if not rows:
        raise RuntimeError("Tushare Pro 没有返回有效行情数据。")
    return result.get("fields") or [], rows


def fetch_tushare(symbol: str, limit: int, adjust: str, period: str) -> dict:
    key = ("tushare", symbol, limit, adjust, period)
    cached = _get_cached(key, HISTORICAL_CACHE_TTL_SECONDS)
    if cached:
        return {**cached, "cached": True}
    code = symbol.split(".", 1)[1]
    freq = {"daily": "D", "weekly": "W", "monthly": "M", "yearly": "D"}[period]
    adj = {"qfq": "qfq", "hfq": "hfq", "none": ""}[adjust]
    fields, records = _tushare_request("pro_bar", {"ts_code": _tushare_code(code), "freq": freq, "adj": adj,
                                                     "start_date": "19900101", "end_date": datetime.now(timezone.utc).strftime("%Y%m%d")})
    indexes = {name: index for index, name in enumerate(fields)}
    required = {name: indexes.get(name) for name in ("trade_date", "open", "high", "low", "close", "vol")}
    if any(value is None for value in required.values()):
        raise RuntimeError("Tushare Pro 返回字段不完整，已拒绝使用。")
    rows = [[record[required["trade_date"]], record[required["open"]], record[required["close"]], record[required["high"]],
             record[required["low"]], record[required["vol"]]] for record in records]
    normalized = _normalize_bars(rows, len(rows), "Tushare Pro", code, code, adjust, period)
    if period == "yearly":
        normalized["bars"] = _aggregate_yearly(normalized["bars"])
    normalized["bars"] = normalized["bars"][-limit:]
    normalized["validCount"] = len(normalized["bars"])
    # Tushare vol is normally in hands. Keep the unit explicit so it is not
    # silently compared with BaoStock's share unit.
    normalized["volumeUnit"] = "手"
    normalized["symbol"] = f"{code}（Tushare Pro）"
    _set_cached(key, normalized)
    return normalized


def fetch_tushare_intraday(symbol: str, target_date: str, interval: str) -> dict:
    key = ("tushare-intraday", symbol, target_date, interval)
    cached = _get_cached(key, INTRADAY_CACHE_TTL_SECONDS)
    if cached and cached.get("schemaVersion") == INTRADAY_CACHE_SCHEMA_VERSION:
        return {**cached, "cached": True}
    fields, records = _tushare_request("stk_mins", {
        "ts_code": _tushare_code(symbol.split(".", 1)[1]),
        "start_date": f"{target_date} 09:30:00",
        "end_date": f"{target_date} 15:00:00",
        "freq": f"{interval}min",
    })
    indexes = {name: index for index, name in enumerate(fields)}
    required = {name: indexes.get(name) for name in ("trade_time", "open", "close", "high", "low", "vol")}
    if any(value is None for value in required.values()):
        raise RuntimeError("Tushare Pro 分钟接口返回字段不完整，已拒绝使用。")
    rows = [[record[required["trade_time"]], record[required["open"]], record[required["close"]], record[required["high"]],
             record[required["low"]], record[required["vol"]]] for record in records]
    normalized = _normalize_intraday_rows(rows, symbol.split(".", 1)[1], "Tushare Pro", target_date, interval)
    normalized["volumeUnit"] = "手"
    _set_cached(key, normalized)
    return normalized


def _rows_from_tabular(value) -> list:
    """Convert common TDX/AKShare DataFrame-like results to row lists."""
    if value is None:
        return []
    if hasattr(value, "to_dict") and hasattr(value, "columns"):
        columns = list(value.columns)
        return [[row.get(column) for column in columns] for row in value.to_dict("records")]
    if isinstance(value, dict):
        for child in value.values():
            rows = _rows_from_tabular(child)
            if rows:
                return rows
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return []


def _tabular_columns(value) -> dict[str, int]:
    if hasattr(value, "columns"):
        return {str(name).lower(): index for index, name in enumerate(value.columns)}
    return {}


def _canonical_from_named_rows(value, kind: str, target_date: str = "", interval: str = "") -> list:
    columns = _tabular_columns(value)
    rows = _rows_from_tabular(value)
    aliases = {
        "date": ("date", "日期", "trade_date", "datetime", "time", "时间"),
        "open": ("open", "开盘"), "high": ("high", "最高"), "low": ("low", "最低"),
        "close": ("close", "收盘"), "volume": ("volume", "vol", "成交量"),
    }
    def idx(names):
        for name in names:
            if name.lower() in columns:
                return columns[name.lower()]
        return None
    date_i, open_i, high_i, low_i, close_i, volume_i = (idx(aliases[name]) for name in ("date", "open", "high", "low", "close", "volume"))
    if any(index is None for index in (open_i, high_i, low_i, close_i, volume_i)):
        return []
    result = []
    for row in rows:
        try:
            raw_date = str(row[date_i]) if date_i is not None else target_date
            if target_date and raw_date[:10] != target_date:
                continue
            result.append([raw_date, row[open_i], row[close_i], row[high_i], row[low_i], row[volume_i]])
        except (IndexError, TypeError):
            continue
    return result


def fetch_tdx(symbol: str, limit: int, adjust: str, period: str) -> dict:
    key = ("tdx", symbol, limit, adjust, period)
    cached = _get_cached(key, HISTORICAL_CACHE_TTL_SECONDS)
    if cached:
        return {**cached, "cached": True}
    client = _tdx_client()
    code = symbol.split(".", 1)[1]
    source_period = "1d" if period == "yearly" else {"daily": "1d", "weekly": "1w", "monthly": "1M"}[period]
    try:
        response = client.get_market_data(
            field_list=["Open", "High", "Low", "Close", "Volume"],
            stock_list=[_tushare_code(code)], period=source_period,
            start_time="1990-01-01", end_time=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            dividend_type={"qfq": "front", "hfq": "back", "none": "none"}[adjust], fill_data=False,
        )
    except Exception as exc:
        raise RuntimeError(f"通达信 TQServer 请求失败：{exc}") from exc
    rows = _canonical_from_named_rows(response, "daily")
    normalized = _normalize_bars(rows, len(rows), "通达信 TQServer", code, code, adjust, period)
    if period == "yearly":
        normalized["bars"] = _aggregate_yearly(normalized["bars"])
    normalized["bars"] = normalized["bars"][-limit:]
    normalized["validCount"] = len(normalized["bars"])
    normalized["symbol"] = f"{code}（通达信 TQServer）"
    _set_cached(key, normalized)
    return normalized


def fetch_tdx_intraday(symbol: str, target_date: str, interval: str) -> dict:
    key = ("tdx-intraday", symbol, target_date, interval)
    cached = _get_cached(key, INTRADAY_CACHE_TTL_SECONDS)
    if cached and cached.get("schemaVersion") == INTRADAY_CACHE_SCHEMA_VERSION:
        return {**cached, "cached": True}
    client = _tdx_client()
    code = symbol.split(".", 1)[1]
    try:
        response = client.get_market_data(
            field_list=["Open", "High", "Low", "Close", "Volume"],
            stock_list=[_tushare_code(code)], period=f"{interval}m",
            start_time=f"{target_date} 09:30:00", end_time=f"{target_date} 15:00:00",
            dividend_type="none", fill_data=False,
        )
    except Exception as exc:
        raise RuntimeError(f"通达信 TQServer 分时请求失败：{exc}") from exc
    rows = _canonical_from_named_rows(response, "intraday", target_date, interval)
    normalized = _normalize_intraday_rows(rows, code, "通达信 TQServer", target_date, interval)
    _set_cached(key, normalized)
    return normalized


def _tdx_client():
    """Load only the official TQServer/TQCenter Python entry point."""
    try:
        from tqserver import tqs
        return tqs
    except ImportError:
        pass
    try:
        from tqcenter import tq
        return tq
    except ImportError as exc:
        raise RuntimeError("通达信 TQServer 未安装或未配置官方量化后台。") from exc


def fetch_akshare(symbol: str, limit: int, adjust: str, period: str) -> dict:
    if not _module_available("akshare"):
        raise RuntimeError("AKShare 未安装；它仅作为免费备用源，不影响 BaoStock 使用。")
    import akshare as ak
    code = symbol.split(".", 1)[1]
    is_etf = code.startswith(("5", "15", "16", "18"))
    source_period = "daily" if period == "yearly" else period
    if is_etf:
        frame = ak.fund_etf_hist_em(symbol=code, period={"daily": "daily", "weekly": "weekly", "monthly": "monthly"}[source_period],
                                    start_date="19900101", end_date=datetime.now(timezone.utc).strftime("%Y%m%d"), adjust="")
    else:
        frame = ak.stock_zh_a_hist(symbol=code, period={"daily": "daily", "weekly": "weekly", "monthly": "monthly"}[source_period],
                                   start_date="19900101", end_date=datetime.now(timezone.utc).strftime("%Y%m%d"), adjust=adjust if adjust != "none" else "")
    rows = _canonical_from_named_rows(frame, "daily")
    normalized = _normalize_bars(rows, len(rows), "AKShare", code, code, adjust, period)
    if period == "yearly":
        normalized["bars"] = _aggregate_yearly(normalized["bars"])
    normalized["bars"] = normalized["bars"][-limit:]
    normalized["validCount"] = len(normalized["bars"])
    normalized["symbol"] = f"{code}（AKShare）"
    _set_cached(("akshare", symbol, limit, adjust, period), normalized)
    return normalized


def fetch_akshare_intraday(symbol: str, target_date: str, interval: str) -> dict:
    if not _module_available("akshare"):
        raise RuntimeError("AKShare 未安装，无法获取真实分时数据。")
    raise RuntimeError("AKShare 已安装但当前版本未确认分时返回字段，已拒绝使用未经校验的数据。")


def _call_source(source_id: str, kind: str, symbol: str, limit: int = 0, adjust: str = "qfq", period: str = "daily", target_date: str = "", interval: str = "5", start_date: str = "", end_date: str = "") -> dict:
    started = time.perf_counter()
    if _source_in_cooldown(source_id):
        raise RuntimeError(f"{SOURCE_LABELS.get(source_id, source_id)}连续失败，已暂时降级，稍后自动恢复。")
    try:
        if kind == "intraday":
            funcs = {
                "tdx": fetch_tdx_intraday, "tushare": fetch_tushare_intraday,
                "baostock": fetch_baostock_intraday, "akshare": fetch_akshare_intraday,
                "eastmoney": fetch_eastmoney_intraday, "tencent_intraday": fetch_tencent_intraday,
                "sina_intraday": fetch_sina_intraday,
            }
            result = funcs[source_id](symbol, target_date, interval)
        else:
            funcs = {
                "baostock": fetch_baostock, "tushare": fetch_tushare, "tdx": fetch_tdx,
                "akshare": fetch_akshare, "tencent": fetch_tencent, "sina": fetch_sina,
            }
            if source_id == "baostock" and (start_date or end_date):
                result = fetch_baostock(symbol, limit, adjust, period, start_date=start_date, end_date=end_date)
            else:
                result = funcs[source_id](symbol, limit, adjust, period)
        _record_source(source_id, True, (time.perf_counter() - started) * 1000)
        _log_request(source_id, kind, symbol, period, "success", (time.perf_counter() - started) * 1000)
        return result
    except Exception as exc:
        latency = (time.perf_counter() - started) * 1000
        _record_source(source_id, False, latency, str(exc))
        _log_request(source_id, kind, symbol, period, "failure", latency, str(exc))
        raise


def _source_order(provider: str, kind: str) -> list[str]:
    if provider == "auto":
        return list(INTRADAY_SOURCE_ORDER if kind == "intraday" else DAILY_SOURCE_ORDER)
    if provider not in SOURCE_LABELS or provider == "csv" or (
        provider in {"eastmoney", "tencent_intraday", "sina_intraday"} and kind != "intraday"
    ):
        raise ValueError("provider 必须是 auto、baostock、tushare、tdx、akshare、tencent 或 sina；CSV 请使用页面导入。")
    return [provider]


def fetch_intraday(symbol: str, target_date: str, interval: str, provider: str = "auto") -> dict:
    errors = []
    order = _source_order(provider, "intraday")
    # 腾讯/新浪的公开分时覆盖近期数据且响应很快；历史样本则优先走
    # BaoStock，避免先等待多个不可能返回旧日期的公开接口。
    if provider == "auto":
        try:
            target = datetime.strptime(target_date, "%Y-%m-%d").date()
            age_days = (datetime.now().date() - target).days
            if age_days > 120:
                order = ["baostock", "tencent_intraday", "sina_intraday", "tdx", "tushare", "akshare", "eastmoney"]
        except ValueError:
            pass
    for source_id in order:
        try:
            result = _call_source(source_id, "intraday", symbol, target_date=target_date, interval=interval)
            result["routing"] = " → ".join(SOURCE_LABELS[item] for item in order)
            return result
        except Exception as exc:
            errors.append(f"{SOURCE_LABELS[source_id]}：{exc}")
    raise RuntimeError("；".join(errors))


def fetch_market(symbol: str, limit: int, adjust: str, period: str, provider: str) -> dict:
    errors = []
    order = _source_order(provider, "daily")
    for source_id in order:
        try:
            result = _call_source(source_id, "daily", symbol, limit=limit, adjust=adjust, period=period)
            result["routing"] = " → ".join(SOURCE_LABELS[item] for item in order)
            result["attemptedSources"] = order
            result["verificationMode"] = "dual_candidate_only" if provider == "auto" else "single_source"
            result["validationWarning"] = "普通行情查看使用腾讯主数据；样本采集候选会单独执行BaoStock双源复核。" if provider == "auto" else "手动指定单一数据源，未执行双源复核。"
            return result
        except Exception as exc:
            errors.append(f"{SOURCE_LABELS[source_id]}：{exc}")
    raise RuntimeError("；".join(errors))


def _compare_market_results(primary: dict, secondary: dict) -> dict:
    first = {str(item.get("date")): item for item in primary.get("bars", [])}
    second = {str(item.get("date")): item for item in secondary.get("bars", [])}
    dates = sorted(set(first) & set(second))
    if len(dates) < 30:
        return {"ok": False, "matched": len(dates), "reason": "两来源共同日期不足 30 根"}
    max_ohlc = 0.0
    max_volume = 0.0
    volume_scale = 100.0 if secondary.get("volumeUnit") == "手" and primary.get("volumeUnit", "股") == "股" else 1.0
    for date in dates:
        left, right = first[date], second[date]
        for field in ("open", "high", "low", "close"):
            a, b = float(left.get(field) or 0), float(right.get(field) or 0)
            diff = abs(a - b) / max(abs(a), abs(b), 1e-9)
            max_ohlc = max(max_ohlc, diff)
        a = float(left.get("volume") or 0)
        b = float(right.get("volume") or 0) * volume_scale
        diff = abs(a - b) / max(abs(a), abs(b), 1.0)
        max_volume = max(max_volume, diff)
    ok = max_ohlc <= 0.005 and max_volume <= 0.03
    return {"ok": ok, "matched": len(dates), "maxOhlcDiff": round(max_ohlc * 100, 4), "maxVolumeDiff": round(max_volume * 100, 4),
            "thresholds": {"ohlcPercent": 0.5, "volumePercent": 3.0}}


def _read_candidate_file() -> list[dict]:
    try:
        payload = json.loads(CANDIDATE_FILE.read_text(encoding="utf-8"))
        return payload if isinstance(payload, list) else []
    except (OSError, ValueError, TypeError):
        return []


def _write_candidate_file(candidates: list[dict]) -> bool:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        temp_file = CANDIDATE_FILE.with_suffix(".tmp")
        temp_file.write_text(json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_file.replace(CANDIDATE_FILE)
        return True
    except OSError:
        return False


def _save_candidate(candidate: dict) -> None:
    global _candidate_revision
    now = time.time()
    candidate["updatedAt"] = datetime.now(timezone.utc).isoformat()
    with _candidate_file_lock:
        file_candidates = {item.get("key"): item for item in _read_candidate_file() if isinstance(item, dict) and item.get("key")}
        is_new = candidate["key"] not in file_candidates
        file_candidates[candidate["key"]] = candidate
        file_saved = _write_candidate_file(list(file_candidates.values()))
    db_saved = False
    try:
        with _db_lock, closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
            db.execute(
                "INSERT OR REPLACE INTO sample_candidates(sample_key,payload,saved_at) VALUES(?,?,?)",
                (candidate["key"], json.dumps(candidate, ensure_ascii=False), now),
            )
        db_saved = True
    except (OSError, sqlite3.Error):
        pass
    if not file_saved and not db_saved:
        raise OSError("候选样本无法保存到本机文件或数据库")
    with _collection_lock:
        _candidate_revision += 1
        for task in _collection_tasks.values():
            if task.get("state") == "running":
                task["candidateRevision"] = _candidate_revision
                if is_new:
                    task["candidateCount"] = int(task.get("candidateCount", 0)) + 1
                    if _is_side_candidate(candidate):
                        task["sideCandidateCount"] = int(task.get("sideCandidateCount", 0)) + 1


def _save_candidate_pair(pair: list[dict]) -> None:
    """Publish both sides together so a partial write cannot enter training."""
    global _candidate_revision
    timestamp = datetime.now(timezone.utc).isoformat()
    saved_at = time.time()
    for candidate in pair:
        candidate["updatedAt"] = timestamp
    with _candidate_file_lock:
        file_candidates = {item.get("key"): item for item in _read_candidate_file() if isinstance(item, dict) and item.get("key")}
        new_keys = sum(candidate["key"] not in file_candidates for candidate in pair)
        file_candidates.update({candidate["key"]: candidate for candidate in pair})
        file_saved = _write_candidate_file(list(file_candidates.values()))
    db_saved = False
    try:
        with _db_lock, closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
            db.executemany(
                "INSERT OR REPLACE INTO sample_candidates(sample_key,payload,saved_at) VALUES(?,?,?)",
                [(candidate["key"], json.dumps(candidate, ensure_ascii=False), saved_at) for candidate in pair],
            )
        db_saved = True
    except (OSError, sqlite3.Error):
        pass
    if not file_saved and not db_saved:
        raise OSError("左右侧配对无法保存到本机文件或数据库")
    with _collection_lock:
        _candidate_revision += 1
        for task in _collection_tasks.values():
            if task.get("state") == "running":
                task["candidateRevision"] = _candidate_revision
                task["candidateCount"] = int(task.get("candidateCount", 0)) + new_keys
                task["sideCandidateCount"] = int(task.get("sideCandidateCount", 0)) + new_keys


def _delete_candidate(sample_key: str) -> None:
    global _candidate_revision
    with _candidate_file_lock:
        existing = _read_candidate_file()
        removed_item = next((item for item in existing if item.get("key") == sample_key), None)
        was_present = removed_item is not None
        file_saved = _write_candidate_file([item for item in existing if item.get("key") != sample_key])
    db_saved = False
    try:
        with _db_lock, closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
            db.execute("DELETE FROM sample_candidates WHERE sample_key = ?", (sample_key,))
        db_saved = True
    except (OSError, sqlite3.Error):
        pass
    if not file_saved and not db_saved:
        raise OSError("候选样本无法从本机文件或数据库更新")
    with _collection_lock:
        _candidate_revision += 1
        for task in _collection_tasks.values():
            if task.get("state") == "running":
                task["candidateRevision"] = _candidate_revision
                if was_present:
                    task["candidateCount"] = max(0, int(task.get("candidateCount", 0)) - 1)
                    if _is_side_candidate(removed_item):
                        task["sideCandidateCount"] = max(0, int(task.get("sideCandidateCount", 0)) - 1)


def _load_candidates() -> list[dict]:
    file_candidates = _read_candidate_file()
    try:
        with closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
            rows = db.execute("SELECT payload FROM sample_candidates ORDER BY saved_at DESC").fetchall()
        candidates = []
        for row in rows:
            try:
                payload = json.loads(row[0])
                if isinstance(payload, dict):
                    candidates.append(payload)
            except (TypeError, ValueError):
                continue
        merged = {item.get("key"): item for item in file_candidates if isinstance(item, dict) and item.get("key")}
        for item in candidates:
            key = item.get("key")
            if key and (key not in merged or str(item.get("updatedAt", "")) >= str(merged[key].get("updatedAt", ""))):
                merged[key] = item
        return list(merged.values())
    except (OSError, sqlite3.Error):
        return file_candidates


def _save_validation(candidate: dict, report: dict, status: str | None = None) -> None:
    now = time.time()
    validation_status = status or report.get("status") or candidate.get("verificationStatus") or "prefiltered"
    try:
        with _db_lock, closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
            existing = db.execute("SELECT created_at FROM sample_validations WHERE sample_key = ?", (candidate["key"],)).fetchone()
            db.execute(
                """INSERT OR REPLACE INTO sample_validations
                   (sample_key,symbol,pattern_id,status,providers_json,report_json,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (candidate["key"], candidate.get("symbol", ""), candidate.get("patternId", ""), validation_status,
                 json.dumps(report.get("providers", []), ensure_ascii=False), json.dumps(report, ensure_ascii=False),
                 float(existing[0]) if existing else now, now),
            )
    except (OSError, sqlite3.Error):
        return


def _fetch_baostock_for_verification(symbol: str, expected_dates: list[str]) -> dict:
    last_error: Exception | None = None
    for attempt, delay in enumerate((0.0, 1.0, 3.0)):
        if delay:
            time.sleep(delay)
        try:
            return _call_source(
                "baostock", "daily", symbol, limit=SAMPLE_SCAN_HISTORY_BARS,
                adjust="qfq", period="daily", start_date=expected_dates[0], end_date=expected_dates[-1],
            )
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"BaoStock连续三次请求失败：{last_error}")


def _verify_side_daily(candidate: dict, tencent: dict, baostock: dict) -> dict:
    visible = candidate.get("bars") or []
    warmup = candidate.get("indicatorWarmupBars") or []
    combined = warmup + visible
    dates = [str(bar.get("date", "")) for bar in combined]
    side = candidate.get("tradeTiming")
    pivot_date = str(candidate.get("pivotDate", ""))
    anchor_date = str(candidate.get("decisionAnchorDate", ""))
    expected_pair_key = f"{candidate.get('eventId')}|{'right' if side == 'left' else 'left'}"
    metadata_ok = (
        len(warmup) == INDICATOR_WARMUP_BARS and len(visible) == SAMPLE_WINDOW_BARS
        and len(dates) == len(set(dates)) == INDICATOR_WARMUP_BARS + SAMPLE_WINDOW_BARS
        and dates == sorted(dates) and side in SUPPORTED_SIDE_TYPES
        and candidate.get("pairedSampleKey") == expected_pair_key
        and str(candidate.get("eventId", "")).endswith(f"|{pivot_date}")
        and str(candidate.get("eventId", "")).split("|", 1)[0].split(".")[-1] == candidate.get("symbol")
        and str(visible[DECISION_INDEX].get("date", "")) == anchor_date
        and ((side == "left" and anchor_date < pivot_date and candidate.get("pivotPhase") == "before-low")
             or (side == "right" and anchor_date > pivot_date and candidate.get("pivotPhase") == "after-low"))
    )
    tencent_by_date = {str(bar.get("date")): bar for bar in tencent.get("bars", [])}
    bao_by_date = {str(bar.get("date")): bar for bar in baostock.get("bars", [])}
    complete = metadata_ok and all(date in tencent_by_date and date in bao_by_date for date in dates)
    comparison = pair_report(tencent, baostock, dates) if complete else {}
    strict = complete and comparison.get("matched") == len(dates) and comparison.get("invalidValueCount") == 0 and (
        comparison.get("ohlcP99Percent", 999) <= 1.2
        and comparison.get("maxOhlcPercent", 999) <= 1.5
        and comparison.get("returnP99Points", 999) <= 0.30
        and comparison.get("volumeMedianPercent", 999) <= 1.0
        and comparison.get("volumeP95Percent", 999) <= 3.0
    )
    return {
        "status": "verified_strict" if strict else "pending_secondary",
        "verificationMode": "side-paired-dual", "providers": ["tencent", "baostock"],
        "pairs": {"tencentBaoStock": comparison},
        "warmupMatched": len(warmup) if complete else 0,
        "visibleMatched": len(visible) if complete else 0,
        "reason": "470根日线和配对元数据双源严格一致" if strict else "左右侧配对、预热日线或双源数据未通过完整复核",
        "canonicalBars": [dict(tencent_by_date[date]) for date in dates[-SAMPLE_WINDOW_BARS:]] if strict else [],
        "canonicalWarmupBars": [dict(tencent_by_date[date]) for date in dates[:INDICATOR_WARMUP_BARS]] if strict else [],
    }


def _verify_prefiltered_candidate(candidate: dict) -> dict:
    symbol, code = normalize_symbol(candidate.get("symbol", ""))
    candidate = dict(candidate)
    candidate["symbol"] = code
    candidate.setdefault("collectionId", "manual-retry")
    is_side = _is_side_candidate(candidate)
    try:
        if candidate.get("sourceId") == "tencent" and candidate.get("adjust") == "qfq":
            tencent = candidate
        else:
            tencent = _completed_daily_payload(
                _call_source("tencent", "daily", symbol, limit=SAMPLE_SCAN_HISTORY_BARS, adjust="qfq", period="daily")
            )
            previous_dates = [str(bar.get("date")) for bar in candidate.get("bars", [])]
            tencent_by_date = {str(bar.get("date")): bar for bar in tencent.get("bars", [])}
            if len(previous_dates) == SAMPLE_WINDOW_BARS and all(date in tencent_by_date for date in previous_dates):
                candidate["bars"] = [dict(tencent_by_date[date]) for date in previous_dates]
            else:
                if is_side:
                    raise RuntimeError("腾讯行情缺少原左右侧片段日期，保留候选等待复核。")
                candidate["bars"] = [dict(bar) for bar in tencent.get("bars", [])[-SAMPLE_WINDOW_BARS:]]
            if is_side:
                warmup_dates = [str(bar.get("date")) for bar in candidate.get("indicatorWarmupBars") or []]
                if len(warmup_dates) != INDICATOR_WARMUP_BARS or any(date not in tencent_by_date for date in warmup_dates):
                    raise RuntimeError("腾讯行情缺少250根指标预热日期，保留候选等待复核。")
                candidate["indicatorWarmupBars"] = [dict(tencent_by_date[date]) for date in warmup_dates]
            candidate["provider"] = tencent.get("provider", "腾讯网页行情")
            candidate["sourceId"] = "tencent"
            candidate["adjust"] = "qfq"
            candidate["volumeUnit"] = tencent.get("volumeUnit", "股")
        if len(candidate.get("bars", [])) == SAMPLE_WINDOW_BARS:
            candidate["contextStartDate"] = candidate["bars"][0]["date"]
            candidate["startDate"] = candidate["bars"][SAMPLE_CONTEXT_BARS]["date"]
            candidate["endDate"] = candidate["bars"][-1]["date"]
        expected_dates = [str(bar["date"]) for bar in candidate.get("bars", [])]
        if len(expected_dates) != SAMPLE_WINDOW_BARS:
            raise RuntimeError(f"候选样本必须包含{SAMPLE_WINDOW_BARS}根日K，实际{len(expected_dates)}根。")
        candidate["verificationMode"] = "dual"
        if candidate.get("kind") == "etf":
            raise RuntimeError("ETF等待独立第二数据源接入，当前不使用BaoStock作为ETF复核源。")
        verification_dates = ([str(bar["date"]) for bar in candidate.get("indicatorWarmupBars") or []] + expected_dates) if is_side else expected_dates
        baostock = _fetch_baostock_for_verification(symbol, verification_dates)
    except Exception as exc:
        candidate.update({
            "verificationStatus": "pending_secondary", "reviewStatus": "blocked",
            "status": "腾讯候选已保存 · 等待独立第二数据源复核", "verificationError": str(exc),
            "verifiedSources": ["tencent"],
        })
        report = {"status": "pending_secondary", "verificationMode": "dual", "providers": ["tencent"], "reason": str(exc)}
        candidate["validationReport"] = report
        _save_candidate(candidate)
        _save_validation(candidate, report)
        return candidate
    if is_side:
        tencent = {**tencent, "bars": (candidate.get("indicatorWarmupBars") or []) + candidate["bars"], "volumeUnit": candidate.get("volumeUnit", "股")}
        report = _verify_side_daily(candidate, tencent, baostock)
    else:
        report = verify_two_sources(candidate, tencent, baostock)
    canonical = report.pop("canonicalBars", [])
    canonical_warmup = report.pop("canonicalWarmupBars", [])
    status = report["status"]
    third_source_used = []
    if not is_side and status in {"verified_warning", "rejected"}:
        try:
            sina = _call_source("sina", "daily", symbol, limit=SAMPLE_SCAN_HISTORY_BARS, adjust="qfq", period="daily")
            diagnostic = verify_three_sources(candidate, sina, tencent, baostock)
            diagnostic.pop("canonicalBars", None)
            report["thirdSourceDiagnostic"] = diagnostic
            third_source_used = ["sina"]
        except Exception as exc:
            report["thirdSourceDiagnosticError"] = str(exc)
    candidate["validationReport"] = report
    candidate["verifiedSources"] = report.get("providers", [])
    candidate["thirdSourceUsed"] = third_source_used
    candidate["verificationMode"] = "dual"
    candidate["conflictReason"] = report.get("reason", "") if status != "verified_strict" else ""
    candidate["verificationError"] = "" if status != "rejected" else report.get("reason", "复核不通过")
    candidate["verificationStatus"] = status
    if status in {"verified_strict", "verified_warning"}:
        # 分时是训练样本的一部分：日线复核通过后必须把整段 220 个
        # 交易日的真实 5 分钟数据一并保存，之后才允许人工审核。
        try:
            collection_id = str(candidate.get("collectionId") or "")

            def update_intraday_progress(done: int, total: int, current_date: str) -> None:
                if collection_id.startswith("collection-"):
                    _task_update(
                        collection_id,
                        stage="intraday_prefetch",
                        message=f"正在补采 {candidate.get('patternName', '候选')} 的真实5分钟数据",
                        current=f"{symbol} · 分时 {done}/{total} 个交易日 · {current_date}",
                        intradayFetched=done,
                        intradayTotal=total,
                    )

            candidate["intradayByDate"] = fetch_baostock_intraday_range(
                symbol,
                expected_dates,
                "5",
                progress=update_intraday_progress,
                should_stop=(lambda: _task_stopped(collection_id)) if collection_id.startswith("collection-") else None,
            )
            candidate["intradayCoverage"] = {
                "requestedDays": len(expected_dates),
                "availableDays": len(candidate["intradayByDate"]),
                "barsPerDay": sorted({item.get("validCount", 0) for item in candidate["intradayByDate"].values()}),
                "provider": "BaoStock",
                "interval": "5",
            }
            candidate["intradayStatus"] = "complete"
        except Exception as exc:
            candidate.update({
                "verificationStatus": "pending_intraday", "reviewStatus": "blocked",
                "status": "日线复核通过 · 等待完整分时补采", "verificationError": str(exc),
                "intradayStatus": "pending", "intradayError": str(exc),
            })
            report["intradayStatus"] = "pending_intraday"
            report["intradayError"] = str(exc)
            candidate["validationReport"] = report
            _save_candidate(candidate)
            _save_validation(candidate, report, "pending_intraday")
            return candidate
    if status == "verified_strict":
        candidate.update({
            "bars": canonical, "provider": "腾讯＋BaoStock（双源严格复核）", "adjust": "qfq",
            "reviewStatus": "pending", "status": "左右侧数据严格通过 · 待配对" if is_side else "数据已双源严格验证 · 待形态审核",
            "dataReviewAccepted": True,
        })
        if is_side:
            candidate["indicatorWarmupBars"] = canonical_warmup
        _save_candidate(candidate)
    elif status == "verified_warning":
        candidate.update({
            "bars": canonical, "provider": "腾讯＋BaoStock（双源警告复核）", "adjust": "qfq",
            "reviewStatus": "data_warning", "status": "数据存在孤立差异 · 待确认",
            "dataReviewAccepted": False,
        })
        _save_candidate(candidate)
    elif is_side:
        candidate.update({"reviewStatus": "blocked", "status": "左右侧数据待复核", "verificationError": report.get("reason", "")})
        _save_candidate(candidate)
    else:
        _delete_candidate(candidate["key"])
    _save_validation(candidate, report)
    return candidate


def _retry_pending_candidates(sample_key: str | None = None) -> list[dict]:
    results = []
    for candidate in _load_candidates():
        if sample_key and candidate.get("key") != sample_key:
            continue
        if candidate.get("verificationStatus") not in {"prefiltered", "pending_baostock", "pending_secondary", "pending_intraday"}:
            continue
        results.append(_verify_prefiltered_candidate(candidate))
    return results


def _retry_snapshot(task_id: str) -> dict | None:
    with _retry_lock:
        task = _retry_tasks.get(task_id)
        return json.loads(json.dumps(task, ensure_ascii=False)) if task else None


def _retry_update(task_id: str, **changes) -> None:
    with _retry_lock:
        task = _retry_tasks.get(task_id)
        if task:
            task.update(changes)
            task["updatedAt"] = datetime.now(timezone.utc).isoformat()


def _run_retry_task(task_id: str, sample_key: str) -> None:
    started = time.perf_counter()
    try:
        candidate = next((item for item in _load_candidates() if item.get("key") == sample_key), None)
        if not candidate:
            raise RuntimeError("没有找到该候选样本。")
        status = candidate.get("verificationStatus")
        if status == "pending_intraday":
            _retry_update(task_id, stage="intraday", current="正在重新获取缺失的真实5分钟分时", attempt=1)
            result = _backfill_existing_intraday(sample_key=sample_key)
            candidate = next((item for item in _load_candidates() if item.get("key") == sample_key), candidate)
            pair = _try_auto_approve_side_event(candidate.get("eventId")) if _is_side_candidate(candidate) else []
            if _has_complete_intraday(candidate):
                approved = any(item.get("reviewStatus") == "approved" for item in pair)
                _retry_update(task_id, state="done", stage="complete", resultStatus="complete", message="220天×48根分时已完整获取" + ("，左右侧配对已自动入库" if approved else ""), result=result)
            else:
                _retry_update(task_id, state="waiting", stage="waiting", resultStatus="pending_intraday", message=(result.get("errors") or [{"error": "分时仍不完整"}])[0].get("error", "分时仍不完整"), result=result)
            return
        _retry_update(task_id, stage="daily_and_secondary", current="正在重新获取腾讯日线并复核第二数据源", attempt=1)
        result = _verify_prefiltered_candidate(candidate)
        pair = _try_auto_approve_side_event(result.get("eventId")) if _is_side_candidate(result) else []
        if pair:
            result = next((item for item in pair if item.get("key") == sample_key), result)
        new_status = result.get("verificationStatus")
        if new_status in {"verified_strict", "verified_warning"} and _has_complete_intraday(result):
            _retry_update(task_id, state="done", stage="complete", resultStatus=new_status, message="日线、第二数据源和220天分时均已通过" + ("，左右侧配对已自动入库" if result.get("reviewStatus") == "approved" else ""), result=result)
        elif new_status in {"pending_baostock", "pending_secondary", "pending_intraday", "prefiltered"}:
            _retry_update(task_id, state="waiting", stage="waiting", resultStatus=new_status, message=result.get("status", "仍等待第二数据源或分时"), result=result)
        else:
            _retry_update(task_id, state="failed", stage="failed", resultStatus=new_status or "rejected", message=result.get("verificationError", "复核不通过"), result=result)
    except Exception as exc:
        _retry_update(task_id, state="failed", stage="failed", resultStatus="error", error=str(exc), message=f"重新复核失败：{exc}")
    finally:
        _retry_update(task_id, elapsedMs=round((time.perf_counter() - started) * 1000, 1), current="")


def _start_retry_task(sample_key: str) -> dict:
    global _retry_sequence
    if not sample_key:
        raise ValueError("缺少候选编号。")
    candidate = next((item for item in _load_candidates() if item.get("key") == sample_key), None)
    if not candidate:
        raise ValueError("没有找到该候选样本。")
    eligible = {"prefiltered", "pending_baostock", "pending_secondary", "pending_intraday"}
    if candidate.get("verificationStatus") not in eligible:
        raise ValueError("该候选当前不需要重新复核。")
    with _retry_lock:
        for task in _retry_tasks.values():
            if task.get("sampleKey") == sample_key and task.get("state") == "running":
                return task
        _retry_sequence += 1
        task_id = f"retry-{int(time.time())}-{_retry_sequence}"
        task = {
            "taskId": task_id, "sampleKey": sample_key, "state": "running",
            "stage": "starting", "current": "正在启动重新复核", "attempt": 0,
            "message": "重新复核任务已创建", "resultStatus": "", "error": "",
            "startedAt": datetime.now(timezone.utc).isoformat(), "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        _retry_tasks[task_id] = task
    threading.Thread(target=_run_retry_task, args=(task_id, sample_key), daemon=True, name=task_id).start()
    return task


def _has_complete_intraday(candidate: dict) -> bool:
    bars = candidate.get("bars") or []
    intraday = candidate.get("intradayByDate")
    if len(bars) != SAMPLE_WINDOW_BARS or not isinstance(intraday, dict):
        return False
    dates = {str(item.get("date")) for item in bars if item.get("date")}
    if len(dates) != SAMPLE_WINDOW_BARS or set(intraday) != dates:
        return False
    return all(_valid_intraday_day(intraday.get(date), date, "5")[0] for date in dates)


def _backfill_existing_intraday(task_id: str | None = None, sample_key: str | None = None, side_only: bool = False) -> dict:
    """Backfill legacy verified samples before they can be trained again."""
    candidates = _load_candidates()
    targets = [
        item for item in candidates
        if not sample_key or item.get("key") == sample_key
        if not side_only or _is_side_candidate(item)
        if (
            item.get("verificationStatus") in {"verified_strict", "verified_warning", "pending_intraday"}
            or item.get("reviewStatus") == "approved"
        )
        and len(item.get("bars") or []) == SAMPLE_WINDOW_BARS
        and not _has_complete_intraday(item)
    ]
    summary = {"total": len(targets), "done": 0, "success": 0, "failed": 0, "errors": []}
    for source_candidate in targets:
        if task_id and _task_stopped(task_id):
            break
        candidate = dict(source_candidate)
        previous_review = candidate.get("reviewStatus")
        dates = [str(bar.get("date")) for bar in candidate.get("bars", [])]
        symbol, code = normalize_symbol(candidate.get("symbol", ""))
        candidate["symbol"] = code
        candidate["reviewStatus"] = "blocked"
        candidate["verificationStatus"] = "pending_intraday"
        candidate["intradayStatus"] = "pending"
        candidate["status"] = "日线已验证 · 等待补齐 220 天真实分时"
        _save_candidate(candidate)
        if task_id:
            _task_update(
                task_id,
                stage="intraday_backfill",
                message="正在补齐旧样本的真实5分钟分时数据",
                current=f"{code} · {candidate.get('patternName', '样本')} · 分时 0/{len(dates)}",
                intradayFetched=0,
                intradayTotal=len(dates),
            )

        def update_progress(done: int, total: int, current_date: str) -> None:
            if task_id:
                _task_update(
                    task_id,
                    stage="intraday_backfill",
                    message="正在补齐旧样本的真实5分钟分时数据",
                    current=f"{code} · {candidate.get('patternName', '样本')} · 分时 {done}/{total} · {current_date}",
                    intradayFetched=done,
                    intradayTotal=total,
                )

        try:
            intraday = fetch_baostock_intraday_range(
                symbol,
                dates,
                "5",
                progress=update_progress,
                should_stop=(lambda: _task_stopped(task_id)) if task_id else None,
            )
            candidate["intradayByDate"] = intraday
            candidate["intradayCoverage"] = {
                "requestedDays": len(dates),
                "availableDays": len(intraday),
                "barsPerDay": sorted({item.get("validCount", 0) for item in intraday.values()}),
                "provider": "BaoStock",
                "interval": "5",
            }
            candidate["intradayStatus"] = "complete"
            candidate["verificationStatus"] = source_candidate.get("verificationStatus")
            candidate["reviewStatus"] = previous_review or "pending"
            candidate["status"] = "已审核 · 训练库" if previous_review == "approved" else "数据已验证 · 待形态审核"
            candidate["intradayError"] = ""
            summary["success"] += 1
        except Exception as exc:
            candidate["intradayStatus"] = "pending"
            candidate["intradayError"] = str(exc)
            candidate["verificationError"] = str(exc)
            candidate["validationReport"] = {
                **(candidate.get("validationReport") or {}),
                "intradayStatus": "pending_intraday",
                "intradayError": str(exc),
            }
            summary["failed"] += 1
            summary["errors"].append({"key": candidate.get("key", ""), "error": str(exc)})
        _save_candidate(candidate)
        summary["done"] += 1
        if task_id:
            _task_update(
                task_id,
                backfillCandidatesDone=summary["done"],
                backfillCandidatesTotal=summary["total"],
            )
    return summary


def _task_update(task_id: str, **changes) -> None:
    with _collection_lock:
        task = _collection_tasks.get(task_id)
        if task:
            task.update(changes)
            task["updatedAt"] = datetime.now(timezone.utc).isoformat()


def _task_increment(task_id: str, **increments) -> None:
    with _collection_lock:
        task = _collection_tasks.get(task_id)
        if not task:
            return
        for key, value in increments.items():
            task[key] = int(task.get(key, 0)) + int(value)
        task["updatedAt"] = datetime.now(timezone.utc).isoformat()


def _task_stopped(task_id: str) -> bool:
    with _collection_lock:
        task = _collection_tasks.get(task_id)
        if not task:
            return True
        if task.get("state") == "running" and time.monotonic() - task.get("lastHeartbeat", time.monotonic()) > COLLECTION_HEARTBEAT_TIMEOUT:
            task["stopRequested"] = True
            task["pauseReason"] = "页面已关闭或进度连接已中断"
        return bool(task.get("stopRequested"))


def _task_snapshot(task_id: str) -> dict | None:
    with _collection_lock:
        task = _collection_tasks.get(task_id)
        if not task:
            return None
        snapshot = json.loads(json.dumps(task, ensure_ascii=False))
    total = int(snapshot.get("total") or 0)
    scanned = int(snapshot.get("scanned") or 0)
    if total:
        intraday_total = int(snapshot.get("intradayTotal") or 0)
        intraday_done = min(int(snapshot.get("intradayFetched") or 0), intraday_total or 0)
        # 把当前证券的分时补采作为当前扫描标的的子进度，避免在
        # 220 天分时补采期间进度条长时间停留在 0%。
        sub_progress = min(1.0, intraday_done / intraday_total) if intraday_total else 0.0
        snapshot["percent"] = round(min(total, scanned + sub_progress) / total * 100, 1)
    else:
        snapshot["percent"] = 0
    snapshot.pop("lastHeartbeat", None)
    snapshot["remainingTarget"] = max(0, int(snapshot.get("targetPairs", SIDE_PAIR_TARGET)) - int(snapshot.get("approvedPairsTotal", 0)))
    return snapshot


def _checkpoint_collection_task(task_id: str) -> None:
    with _collection_lock:
        task = _collection_tasks.get(task_id)
        if not task:
            return
        summary = {key: value for key, value in task.items() if key != "lastHeartbeat"}
        state = _collection_state_read()
        state["latestTask"] = summary
        _collection_state_write(state)


def _approved_side_events(candidates: list[dict]) -> set[str]:
    events: dict[str, list[dict]] = {}
    for candidate in candidates:
        if _is_side_candidate(candidate) and candidate.get("reviewStatus") == "approved":
            events.setdefault(str(candidate.get("eventId", "")), []).append(candidate)
    return {event_id for event_id, pair in events.items() if event_id and _side_pair_ready(pair)}


def _pending_side_events(candidates: list[dict]) -> set[str]:
    events: dict[str, list[dict]] = {}
    for candidate in candidates:
        if _is_side_candidate(candidate) and candidate.get("reviewStatus") != "removed":
            events.setdefault(str(candidate.get("eventId", "")), []).append(candidate)
    waiting = {"prefiltered", "pending_baostock", "pending_secondary", "pending_intraday", "verified_warning", "verified_strict"}
    return {event_id for event_id, pair in events.items()
            if event_id and {item.get("tradeTiming") for item in pair} == set(SUPPORTED_SIDE_TYPES)
            and not all(item.get("reviewStatus") == "approved" for item in pair)
            and any(item.get("verificationStatus") in waiting for item in pair)}


def _current_collection_status() -> dict:
    with _collection_lock:
        running = next((task for task in _collection_tasks.values() if task.get("state") == "running"), None)
        if running:
            return _task_snapshot(running["taskId"]) or {}
        state = _collection_state_read()
        previous = dict(state.get("latestTask") or {})
        if previous:
            if previous.get("state") == "running":
                previous.update(state="paused", stopRequested=True, pauseReason="本地服务已重新启动", message="采集已暂停，可手动继续")
            previous["running"] = False
            previous["candidateRevision"] = _candidate_revision
            previous["scanned"] = len(state.get("scannedSymbols") or [])
            previous["total"] = int(state.get("universeTotal") or previous.get("total") or 0)
            previous["remainingBefore"] = max(0, previous["total"] - previous["scanned"])
            previous.update(_candidate_catalog()["summary"])
            return previous
    candidates = _load_candidates()
    events = _approved_side_events(candidates)
    state = _collection_state_read()
    scanned = len(state.get("scannedSymbols") or [])
    total = int(state.get("universeTotal") or 0)
    return {"state": "idle", "running": False, "targetPairs": SIDE_PAIR_TARGET, "approvedPairsTotal": len(events),
            "candidateCount": len(candidates), "sideCandidateCount": sum(_is_side_candidate(item) for item in candidates),
            "pendingPairs": len(_pending_side_events(candidates)),
            "candidateRevision": _candidate_revision,
            "scanned": scanned, "total": total, "remainingBefore": max(0, total - scanned),
            "message": "可继续采集左右侧指标样本"}


def _prefilter_instrument(instrument: dict) -> tuple[dict, list[dict]]:
    symbol, _ = normalize_symbol(instrument["symbol"])
    source_id = "tencent"
    try:
        payload = _call_source("tencent", "daily", symbol, limit=SAMPLE_SCAN_HISTORY_BARS, adjust="qfq", period="daily")
    except Exception as primary_error:
        # 腾讯公开入口波动时先用响应更快的新浪做形态初筛；新浪不声明
        # 复权基准，所以只能生成待复核候选，不能直接成为训练数据。
        try:
            source_id = "sina"
            payload = _call_source("sina", "daily", symbol, limit=SAMPLE_SCAN_HISTORY_BARS, adjust="qfq", period="daily")
        except Exception as fallback_error:
            # 两个网页初筛源都不可用时才使用BaoStock，保证离线/故障场景仍有
            # 一个真实数据兜底，但后续仍必须经过独立复核。
            source_id = "baostock"
            payload = _call_source("baostock", "daily", symbol, limit=SAMPLE_SCAN_HISTORY_BARS, adjust="qfq", period="daily")
            payload["prefilterFallbackReason"] = f"腾讯：{primary_error}；新浪：{fallback_error}"
        payload["prefilterFallbackReason"] = payload.get("prefilterFallbackReason") or str(primary_error)
    payload = _completed_daily_payload(payload)
    candidates = detect_side_pairs(payload["bars"], instrument["symbol"], payload.get("provider", "新浪网页行情"))
    for candidate in candidates:
        candidate.update({
            "kind": instrument.get("kind", "stock"),
            "provider": payload.get("provider", SOURCE_LABELS.get(source_id, source_id)),
            "sourceId": source_id, "adjust": "qfq", "volumeUnit": payload.get("volumeUnit", "股"),
            "status": "腾讯主数据扫描命中 · 等待BaoStock复核" if source_id == "tencent" else "腾讯不可用 · BaoStock备用初筛 · 等待独立复核",
            "prefilterSource": source_id,
            "prefilterFallbackReason": payload.get("prefilterFallbackReason", ""),
        })
    return payload, candidates


def _evenly_select(items: list[dict], limit: int) -> list[dict]:
    if len(items) <= limit:
        return items
    step = len(items) / limit
    return [items[min(len(items) - 1, int(index * step))] for index in range(limit)]


def _collection_state_read() -> dict:
    try:
        payload = json.loads(COLLECTION_STATE_FILE.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _collection_state_write(payload: dict) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        temp_file = COLLECTION_STATE_FILE.with_suffix(".tmp")
        temp_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_file.replace(COLLECTION_STATE_FILE)
    except OSError as exc:
        raise OSError(f"采集进度无法保存：{exc}") from exc


def _collection_fingerprint(instruments: list[dict]) -> str:
    material = "\n".join(
        f"{item.get('kind', 'stock')}|{str(item.get('symbol', '')).strip()}"
        for item in instruments
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _select_rotating_batch(instruments: list[dict], limit: int) -> tuple[list[dict], dict]:
    """Select unseen securities for this cycle and persist the rotation cursor."""
    ordered = []
    seen = set()
    for item in sorted(instruments, key=lambda value: (0 if value.get("kind", "stock") == "stock" else 1, str(value.get("symbol", "")))):
        symbol = str(item.get("symbol", "")).strip()
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        ordered.append(item)
    if not ordered:
        raise RuntimeError("没有获得可轮换扫描的真实证券列表。")
    fingerprint = _collection_fingerprint(ordered)
    with _collection_lock:
        state = _collection_state_read()
        if state.get("universeFingerprint") != fingerprint:
            state["scannedSymbols"] = sorted({str(item) for item in state.get("scannedSymbols", []) if str(item) in seen})
            state["cursor"] = 0
            state["universeFingerprint"] = fingerprint
        scanned = {str(item) for item in state.get("scannedSymbols", []) if str(item) in seen}
        cursor = int(state.get("cursor") or 0) % len(ordered)
        selected = []
        visited = 0
        while len(selected) < min(limit, len(ordered)) and visited < len(ordered):
            index = (cursor + visited) % len(ordered)
            item = ordered[index]
            symbol = str(item["symbol"])
            if symbol not in scanned:
                selected.append(item)
            visited += 1
        remaining = max(0, len(ordered) - len(scanned) - len(selected))
        metadata = {
            "universeFingerprint": fingerprint,
            "cycle": int(state.get("cycle") or 1),
            "cursor": cursor,
            "selectedCount": len(selected),
            "skippedDuplicates": visited - len(selected),
            "remainingBefore": max(0, len(ordered) - len(scanned)),
            "remainingAfter": remaining,
            "universeTotal": len(ordered),
        }
        state.update({"universeFingerprint": fingerprint, "universeTotal": len(ordered), "cycle": metadata["cycle"],
                      "cursor": cursor, "scannedSymbols": sorted(scanned)})
        _collection_state_write(state)
    return selected, metadata


def _mark_rotating_symbol(instrument: dict) -> None:
    symbol = str(instrument.get("symbol", "")).strip()
    if not symbol:
        return
    with _collection_lock:
        state = _collection_state_read()
        scanned = {str(item) for item in state.get("scannedSymbols", [])}
        scanned.add(symbol)
        state["scannedSymbols"] = sorted(scanned)
        state["cursor"] = (int(state.get("cursor") or 0) + 1)
        state["lastScannedAt"] = datetime.now(timezone.utc).isoformat()
        _collection_state_write(state)


def _is_side_candidate(candidate: dict) -> bool:
    return candidate.get("sampleType") == "side-training" and candidate.get("tradeTiming") in {"left", "right"}


def _auto_approve_side_pair(pair: list[dict]) -> None:
    """Promote a fully verified left/right pair into the active training library."""
    for candidate in pair:
        side_name = "左侧" if candidate.get("tradeTiming") == "left" else "右侧"
        candidate.update({
            "reviewStatus": "approved",
            "status": f"已审核 · {side_name}训练库",
            "autoApproved": True,
            "dataReviewAccepted": True,
        })
    _save_candidate_pair(pair)
    for candidate in pair:
        _save_validation(candidate, candidate.get("validationReport", {}), candidate.get("verificationStatus") or "verified_strict")


def _side_pair_ready(pair: list[dict]) -> bool:
    if len(pair) != 2 or {item.get("tradeTiming") for item in pair} != set(SUPPORTED_SIDE_TYPES):
        return False
    left, right = sorted(pair, key=lambda item: item.get("tradeTiming", ""))
    if any(item.get("reviewStatus") == "removed" for item in pair):
        return False
    if (left.get("eventId") != right.get("eventId") or left.get("pivotDate") != right.get("pivotDate")
            or left.get("pairedSampleKey") != right.get("key")
            or right.get("pairedSampleKey") != left.get("key")):
        return False
    return all(
        _is_side_candidate(item) and item.get("verificationStatus") == "verified_strict"
        and item.get("validationReport", {}).get("warmupMatched") == INDICATOR_WARMUP_BARS
        and item.get("validationReport", {}).get("visibleMatched") == SAMPLE_WINDOW_BARS
        and item.get("dataReviewAccepted") is True
        and len(item.get("indicatorWarmupBars") or []) == INDICATOR_WARMUP_BARS
        and _has_complete_intraday(item)
        for item in pair
    )


def _try_auto_approve_side_event(event_id: str) -> list[dict]:
    if not event_id:
        return []
    pair = [item for item in _load_candidates() if _is_side_candidate(item) and item.get("eventId") == event_id]
    if _side_pair_ready(pair):
        _auto_approve_side_pair(pair)
    return pair


def _candidate_catalog() -> dict:
    """Cache small list entries; load a complete sample only when training it."""
    global _candidate_catalog_cache
    paths = (CANDIDATE_FILE, SQLITE_FILE, Path(str(SQLITE_FILE) + "-wal"))
    signature = [_candidate_revision]
    for path in paths:
        try:
            stat = path.stat()
            signature.append((stat.st_mtime_ns, stat.st_size))
        except OSError:
            signature.append(None)
    with _candidate_catalog_lock:
        if _candidate_catalog_cache.get("signature") == signature:
            return _candidate_catalog_cache
        candidates = _load_candidates()
        events: dict[str, list[dict]] = {}
        for candidate in candidates:
            if _is_side_candidate(candidate):
                events.setdefault(str(candidate.get("eventId", "")), []).append(candidate)
        ready_events = {
            event for event, pair in events.items() if event
            and all(item.get("reviewStatus") == "approved" for item in pair)
            and _side_pair_ready(pair)
        }
        entries = []
        for item in candidates:
            bars = item.get("bars") or []
            warmup = item.get("indicatorWarmupBars") or []
            window_ok = (item.get("snapshot") is True and len(bars) == SAMPLE_WINDOW_BARS
                         and item.get("trainingStartIndex") == SAMPLE_CONTEXT_BARS
                         and item.get("trainingEndIndex") == SAMPLE_WINDOW_BARS - 1)
            complete = _has_complete_intraday(item)
            reasons = []
            if not window_ok:
                reasons.append("缺少完整40根背景与180根训练日线")
            if _is_side_candidate(item):
                if len(warmup) != INDICATOR_WARMUP_BARS:
                    reasons.append("缺少250根指标预热日线")
                if item.get("verificationStatus") != "verified_strict":
                    reasons.append("等待独立第二数据源日线复核")
                if item.get("eventId") not in ready_events:
                    reasons.append("左右侧尚未同时通过并入库")
            else:
                reasons.append("形态训练尚未开放")
            if not complete:
                reasons.append("未补齐220天×48根真实5分钟分时")
            if item.get("reviewStatus") != "approved":
                reasons.append("已移出训练库" if item.get("reviewStatus") == "removed" else "尚未入库")
            entry = {key: value for key, value in item.items()
                     if key not in {"bars", "indicatorWarmupBars", "intradayByDate"}}
            entry.update(catalogOnly=True, serverCandidate=True, windowComplete=window_ok,
                         barCount=len(bars), warmupCount=len(warmup), intradayComplete=complete,
                         trainable=not reasons, trainingBlockedReasons=reasons)
            entries.append(entry)
        summary = {
            "candidateCount": len(entries), "sideCandidateCount": sum(_is_side_candidate(item) for item in entries),
            "trainableSamples": sum(item["trainable"] for item in entries),
            "approvedPairsTotal": len(ready_events),
            "pendingPairs": len(_pending_side_events(candidates)),
        }
        _candidate_catalog_cache = {"signature": signature, "entries": entries, "summary": summary,
                                    "byKey": {item["key"]: item for item in candidates if item.get("key")}}
        return _candidate_catalog_cache


def _run_collection_task(task_id: str, requested_limit: int) -> None:
    try:
        _task_update(task_id, stage="intraday_backfill", message="正在检查左右侧候选的分时完整性", current="左右侧候选分时检查")
        backfill = _backfill_existing_intraday(task_id, side_only=True)
        _task_update(
            task_id,
            message=f"左右侧候选检查完成：成功 {backfill['success']}，失败 {backfill['failed']}，共 {backfill['total']} 条",
            backfillCandidatesDone=backfill["done"],
            backfillCandidatesTotal=backfill["total"],
        )
        existing_candidates = _load_candidates()
        existing_events: dict[str, list[dict]] = {}
        for candidate in existing_candidates:
            if _is_side_candidate(candidate):
                existing_events.setdefault(str(candidate.get("eventId", "")), []).append(candidate)
        for pair in existing_events.values():
            if _side_pair_ready(pair) and any(item.get("reviewStatus") != "approved" for item in pair):
                _auto_approve_side_pair(pair)
        approved = _approved_side_events(existing_candidates)
        pending_events = _pending_side_events(existing_candidates)
        _task_update(task_id, approvedEventIds=sorted(approved), approvedPairsTotal=len(approved),
                     pendingEventIds=sorted(pending_events), pendingPairs=len(pending_events))
        if not _task_stopped(task_id) and len(approved) < SIDE_PAIR_TARGET:
            _task_update(task_id, stage="universe", message="正在获取A股及场内ETF证券清单", current="证券清单")
            universe = fetch_sina_universe()
            instruments = list(universe.get("instruments", []))
            if universe.get("warning"):
                _task_update(task_id, universeWarning=universe["warning"])
            try:
                etfs = [item for item in fetch_baostock_universe().get("instruments", []) if item.get("kind") == "etf"]
                known = {item["symbol"] for item in instruments}
                instruments.extend(item for item in etfs if item["symbol"] not in known)
            except Exception as exc:
                _task_update(task_id, universeWarning=f"场内ETF清单暂时无法补充：{exc}")
            batch_size = min(max(requested_limit, 1), SAMPLE_SCAN_BATCH_SIZE)
            while not _task_stopped(task_id) and len(approved) < SIDE_PAIR_TARGET:
                selected, rotation = _select_rotating_batch(instruments, batch_size)
                _task_update(task_id, total=rotation["universeTotal"], scanned=rotation["universeTotal"] - rotation["remainingBefore"],
                             plannedTotal=rotation["universeTotal"], stage="tencent_scan",
                             message=f"第{rotation['cycle']}轮左右侧配对扫描中，累计入库 {len(approved)}/{SIDE_PAIR_TARGET} 组",
                             collectionRound=rotation["cycle"], skippedDuplicates=rotation["skippedDuplicates"],
                             remainingBefore=rotation["remainingBefore"], remainingAfter=rotation["remainingBefore"],
                             universeTotal=rotation["universeTotal"], selectedCount=rotation["selectedCount"])
                _checkpoint_collection_task(task_id)
                if not selected:
                    break
                for batch_start in range(0, len(selected), SAMPLE_SCAN_WORKERS):
                    if _task_stopped(task_id) or len(approved) >= SIDE_PAIR_TARGET:
                        break
                    batch = selected[batch_start:batch_start + SAMPLE_SCAN_WORKERS]
                    with ThreadPoolExecutor(max_workers=SAMPLE_SCAN_WORKERS, thread_name_prefix="side-prefilter") as executor:
                        futures = {executor.submit(_prefilter_instrument, instrument): instrument for instrument in batch}
                        for future in as_completed(futures):
                            if _task_stopped(task_id) or len(approved) >= SIDE_PAIR_TARGET:
                                break
                            instrument = futures[future]
                            _task_update(task_id, current=f"{instrument['symbol']} · {instrument.get('name', '')}")
                            completed = False
                            try:
                                _, candidates = future.result()
                                if _task_stopped(task_id):
                                    break
                                _task_increment(task_id, success=1)
                                _task_update(task_id, consecutiveFailures=0)
                                pairs: dict[str, list[dict]] = {}
                                for candidate in candidates:
                                    pairs.setdefault(candidate.get("eventId", ""), []).append(candidate)
                                for event_id, pair in pairs.items():
                                    if _task_stopped(task_id) or len(approved) >= SIDE_PAIR_TARGET:
                                        break
                                    if not event_id or event_id in approved or {item.get("tradeTiming") for item in pair} != set(SUPPORTED_SIDE_TYPES):
                                        continue
                                    verified_pair = []
                                    for candidate in sorted(pair, key=lambda item: item.get("tradeTiming", "")):
                                        if _task_stopped(task_id):
                                            break
                                        candidate["collectionId"] = task_id
                                        _task_increment(task_id, prefiltered=1)
                                        _task_update(task_id, stage="baostock_verify", message=f"正在复核{candidate['patternName']}",
                                                     intradayFetched=0, intradayTotal=0)
                                        verified_pair.append(_verify_prefiltered_candidate(candidate))
                                    if len(verified_pair) != 2:
                                        break
                                    statuses = {item.get("verificationStatus") for item in verified_pair}
                                    if statuses == {"verified_strict"} and _side_pair_ready(verified_pair):
                                        _auto_approve_side_pair(verified_pair)
                                        approved.add(event_id)
                                        pending_events.discard(event_id)
                                        _task_increment(task_id, tencentChecked=2, baostockChecked=2, strict=2,
                                                        pairedAccepted=1, leftAccepted=1, rightAccepted=1)
                                        _task_update(task_id, approvedEventIds=sorted(approved), approvedPairsTotal=len(approved))
                                    elif "verified_warning" in statuses:
                                        pending_events.add(event_id)
                                        _task_increment(task_id, tencentChecked=2, baostockChecked=2, warning=2)
                                    elif statuses & {"pending_baostock", "pending_secondary", "pending_intraday", "prefiltered"}:
                                        pending_events.add(event_id)
                                        _task_increment(task_id, tencentChecked=2, pending=2)
                                    else:
                                        pending_events.discard(event_id)
                                        _task_increment(task_id, tencentChecked=2, baostockChecked=2, rejected=2)
                                    _task_update(task_id, pendingEventIds=sorted(pending_events), pendingPairs=len(pending_events))
                                completed = not _task_stopped(task_id)
                            except Exception as exc:
                                if not _task_stopped(task_id):
                                    _task_increment(task_id, failed=1, consecutiveFailures=1)
                                    _task_update(task_id, lastError=f"{instrument['symbol']}：{exc}")
                                    completed = True
                                    if (_task_snapshot(task_id) or {}).get("consecutiveFailures", 0) >= 20:
                                        _request_collection_pause(task_id, "连续20个标的获取失败，请检查行情数据源")
                            finally:
                                if completed:
                                    _mark_rotating_symbol(instrument)
                                    _task_increment(task_id, scanned=1)
                                    _task_update(task_id, remainingBefore=max(0, int((_task_snapshot(task_id) or {}).get("total", 0)) - int((_task_snapshot(task_id) or {}).get("scanned", 0))))
                                    _checkpoint_collection_task(task_id)
                if _task_stopped(task_id) or len(approved) >= SIDE_PAIR_TARGET:
                    break
        snapshot = _task_snapshot(task_id) or {}
        if _task_stopped(task_id):
            state = "paused"
            message = f"采集已暂停，累计入库 {len(approved)}/{SIDE_PAIR_TARGET} 组；{snapshot.get('pauseReason') or '可手动继续'}"
        elif len(approved) >= SIDE_PAIR_TARGET:
            state = "done"
            message = f"已达到目标：累计入库 {len(approved)}/{SIDE_PAIR_TARGET} 组左右侧配对"
        else:
            state = "exhausted"
            message = f"本轮名单已扫完，累计入库 {len(approved)}/{SIDE_PAIR_TARGET} 组；待复核 {snapshot.get('pendingPairs', 0)} 组，失败 {snapshot.get('failed', 0)} 个标的"
        _task_update(task_id, state=state, stage="complete", message=message, current="")
        _checkpoint_collection_task(task_id)
    except Exception as exc:
        _task_update(task_id, state="error", stage="error", message=f"采集任务失败：{exc}", lastError=str(exc))
        try:
            _checkpoint_collection_task(task_id)
        except OSError:
            pass


def _request_collection_pause(task_id: str, reason: str) -> dict:
    with _collection_lock:
        task = _collection_tasks.get(task_id)
        if not task:
            raise ValueError("采集任务不存在或已过期。")
        if task.get("state") == "running":
            task.update(stopRequested=True, pauseReason=reason, message="已请求暂停，正在等待当前证券处理结束")
    _checkpoint_collection_task(task_id)
    return _task_snapshot(task_id) or {"taskId": task_id}


def _backup_collection_inputs() -> None:
    state = _collection_state_read()
    if state.get("collectionBackupPath"):
        return
    backup_dir = CACHE_DIR / "backups" / f"side-collection-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}"
    backup_dir.mkdir(parents=True, exist_ok=False)
    with _candidate_file_lock, _db_lock:
        if CANDIDATE_FILE.exists():
            shutil.copy2(CANDIDATE_FILE, backup_dir / CANDIDATE_FILE.name)
        if SQLITE_FILE.exists():
            source_db = sqlite3.connect(SQLITE_FILE, timeout=10)
            backup_db = sqlite3.connect(backup_dir / SQLITE_FILE.name)
            try:
                source_db.backup(backup_db)
            finally:
                backup_db.close()
                source_db.close()
        if COLLECTION_STATE_FILE.exists():
            shutil.copy2(COLLECTION_STATE_FILE, backup_dir / COLLECTION_STATE_FILE.name)
    state["collectionBackupPath"] = str(backup_dir)
    _collection_state_write(state)


def _start_collection_task(limit: int, launch: bool = True) -> dict:
    global _collection_sequence
    with _collection_lock:
        for task in _collection_tasks.values():
            if task.get("state") == "running":
                return _task_snapshot(task["taskId"]) or task
        _backup_collection_inputs()
        state = _collection_state_read()
        previous = state.get("latestTask") or {}
        candidates = _load_candidates()
        approved_events = _approved_side_events(candidates)
        pending_events = _pending_side_events(candidates)
        _collection_sequence += 1
        task_id = f"collection-{int(time.time())}-{_collection_sequence}"
        total = int(state.get("universeTotal") or 0)
        scanned = len(state.get("scannedSymbols") or [])
        task = {
            "taskId": task_id, "state": "running", "stage": "starting", "stopRequested": False,
            "targetPairs": SIDE_PAIR_TARGET, "approvedPairsTotal": len(approved_events),
            "approvedEventIds": sorted(approved_events), "candidateRevision": _candidate_revision,
            "pendingEventIds": sorted(pending_events),
            "candidateCount": len(candidates), "sideCandidateCount": sum(_is_side_candidate(item) for item in candidates),
            "lastHeartbeat": time.monotonic(),
            "sampleMode": ACTIVE_SAMPLE_MODE, "leftQuota": LEFT_QUOTA, "rightQuota": RIGHT_QUOTA,
            "total": total, "plannedTotal": total, "scanned": scanned,
            "success": int(previous.get("success") or 0), "failed": int(previous.get("failed") or 0),
            "prefiltered": int(previous.get("prefiltered") or 0),
            "tencentChecked": int(previous.get("tencentChecked") or 0),
            "baostockChecked": int(previous.get("baostockChecked") or 0),
            "pending": int(previous.get("pending") or 0), "strict": int(previous.get("strict") or 0),
            "warning": int(previous.get("warning") or 0), "rejected": int(previous.get("rejected") or 0),
            "pendingPairs": len(pending_events),
            "pairedAccepted": len(approved_events), "leftAccepted": len(approved_events), "rightAccepted": len(approved_events),
            "consecutiveFailures": 0,
            "intradayTotal": 0, "intradayFetched": 0,
            "collectionRound": int(state.get("cycle") or 1), "skippedDuplicates": 0,
            "remainingBefore": max(0, total - scanned), "remainingAfter": max(0, total - scanned),
            "universeTotal": total, "selectedCount": 0,
            "percent": 0, "current": "", "message": "正在初始化样本采集",
            "startedAt": datetime.now(timezone.utc).isoformat(),
        }
        if len(approved_events) >= SIDE_PAIR_TARGET:
            task.update(state="done", stage="complete", message=f"已达到目标：累计入库 {len(approved_events)}/{SIDE_PAIR_TARGET} 组")
        _collection_tasks[task_id] = task
    _checkpoint_collection_task(task_id)
    if task["state"] == "running" and launch:
        threading.Thread(target=_run_collection_task, args=(task_id, limit), daemon=True, name=task_id).start()
    return _task_snapshot(task_id) or task


def _review_candidate(sample_key: str, action: str, reviewer: str = "本机审核") -> dict:
    candidate = next((item for item in _load_candidates() if item.get("key") == sample_key), None)
    if not candidate:
        raise ValueError("没有找到该候选样本。")
    if action == "reject":
        _delete_candidate(sample_key)
        _save_validation(candidate, candidate.get("validationReport", {}), "rejected")
        return {"deleted": True, "key": sample_key}
    if action == "remove-training":
        if candidate.get("reviewStatus") != "approved":
            raise ValueError("只有已经进入训练库的样本才能移出训练库。")
        candidate.update({
            "reviewStatus": "removed",
            "status": "已从训练库移除",
            "removedBy": reviewer[:20] or "本机操作",
            "removedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        })
    elif action == "restore-training":
        if candidate.get("reviewStatus") != "removed":
            raise ValueError("只有已移出的样本才能恢复到训练库。")
        allowed = _has_complete_intraday(candidate) and (
            candidate.get("verificationStatus") == "verified_strict" or (
            candidate.get("verificationStatus") == "verified_warning" and candidate.get("dataReviewAccepted") is True
            )
        )
        if not allowed:
            raise ValueError("数据复核状态已变化，不能恢复到训练库。")
        candidate.update({
            "reviewStatus": "approved",
            "status": "已审核 · 训练库",
            "reviewedBy": reviewer[:20] or "本机操作",
            "reviewedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        })
    elif action == "accept-warning":
        if candidate.get("verificationStatus") != "verified_warning":
            raise ValueError("只有警告样本需要确认数据差异。")
        candidate.update({"dataReviewAccepted": True, "reviewStatus": "pending", "status": "数据差异已确认 · 待形态审核"})
    elif action == "approve":
        if _is_side_candidate(candidate):
            raise ValueError("左右侧片段需两侧数据和分时均严格通过后成对自动入库。")
        allowed = _has_complete_intraday(candidate) and (
            candidate.get("verificationStatus") == "verified_strict" or (
            candidate.get("verificationStatus") == "verified_warning" and candidate.get("dataReviewAccepted") is True
            )
        )
        if not allowed:
            raise ValueError("数据复核或220天×48根真实分时尚未完成，不能进入训练库。")
        candidate.update({
            "reviewStatus": "approved", "status": "已审核 · 训练库",
            "reviewedBy": reviewer[:20] or "本机审核", "reviewedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        })
    else:
        raise ValueError("不支持的审核操作。")
    _save_candidate(candidate)
    if _is_side_candidate(candidate) and action in {"accept-warning", "approve"}:
        pair = _try_auto_approve_side_event(candidate.get("eventId"))
        if pair:
            candidate = next((item for item in pair if item.get("key") == sample_key), candidate)
    return candidate


def fetch_baostock_universe() -> dict:
    """Return a filtered A-share/ETF universe from BaoStock's real list."""
    global _universe_cache
    now = time.time()
    if _universe_cache and now - _universe_cache[0] < UNIVERSE_CACHE_TTL_SECONDS:
        return _universe_cache[1]
    cached_universe = _get_cached(("universe", "baostock"), UNIVERSE_CACHE_TTL_SECONDS)
    if cached_universe:
        _universe_cache = (now, cached_universe)
        return cached_universe
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
    _set_cached(("universe", "baostock"), payload)
    return payload


RESEARCH_ENGINE = ResearchEngine(CACHE_DIR, fetch_baostock_universe, _baostock_lock)


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

    def source_health_payload(self) -> dict:
        with _source_health_lock:
            items = {key: dict(value) for key, value in _source_health.items()}
        for source_id in ("baostock", "tushare", "tdx", "akshare", "tencent", "sina", "csv"):
            items.setdefault(source_id, {
                "id": source_id, "name": SOURCE_LABELS[source_id], "configured": _source_configured(source_id),
                "available": False, "lastSuccess": None, "lastFailure": None,
                "failures": 0, "latencyMs": None, "error": "尚未请求",
            })
        return {
            "version": APP_VERSION,
            "sources": list(items.values()),
            "routing": {
                "daily": [SOURCE_LABELS[item] for item in DAILY_SOURCE_ORDER],
                "intraday": [SOURCE_LABELS[item] for item in INTRADAY_SOURCE_ORDER],
            },
            "cache": {"sqlite": str(SQLITE_FILE), "json": str(CACHE_FILE)},
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        parsed = urlparse(self.path)
        if parsed.path == "/api/research/status":
            self.send_json(200, RESEARCH_ENGINE.status())
            return
        if parsed.path == "/api/research/report":
            self.send_json(200, RESEARCH_ENGINE.report())
            return
        if parsed.path == "/api/research/rules":
            self.send_json(200, {"rules": RESEARCH_ENGINE.rules()})
            return
        if parsed.path == "/api/reviews":
            with _db_lock, closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db:
                rows = db.execute("""
                    SELECT review_id, archived_at, symbol, code, trade_count, note_count
                    FROM training_reviews ORDER BY archived_at DESC
                """).fetchall()
            self.send_json(200, {"reviews": [
                {"id": row[0], "archivedAt": row[1], "symbol": row[2], "code": row[3], "tradeCount": row[4], "noteCount": row[5]}
                for row in rows
            ]})
            return
        if parsed.path.startswith("/api/reviews/"):
            review_id = parsed.path.rsplit("/", 1)[-1]
            if not re.fullmatch(r"[0-9a-fA-F-]{36}", review_id):
                self.send_json(400, {"error": "复盘编号无效。"})
                return
            with _db_lock, closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db:
                row = db.execute("SELECT payload FROM training_reviews WHERE review_id=?", (review_id,)).fetchone()
            if not row:
                self.send_json(404, {"error": "没有找到这份复盘档案。"})
            else:
                self.send_json(200, json.loads(row[0]))
            return
        if parsed.path == "/health":
            self.send_json(200, {"status": "ok", "service": "kline-training", "version": APP_VERSION})
            return
        if parsed.path == "/api/market/sources":
            self.send_json(200, self.source_health_payload())
            return
        if parsed.path == "/api/sample-collection/status":
            params = parse_qs(parsed.query)
            task_id = params.get("taskId", [""])[0]
            with _collection_lock:
                task = _collection_tasks.get(task_id)
                if task and task.get("state") == "running":
                    task["lastHeartbeat"] = time.monotonic()
            snapshot = _task_snapshot(task_id) if task_id else None
            if not snapshot:
                self.send_json(404, {"error": "采集任务不存在或已过期。"})
            else:
                self.send_json(200, snapshot)
            return
        if parsed.path == "/api/sample-collection/current":
            self.send_json(200, _current_collection_status())
            return
        if parsed.path == "/api/sample-candidates/retry/status":
            params = parse_qs(parsed.query)
            task_id = params.get("taskId", [""])[0]
            snapshot = _retry_snapshot(task_id) if task_id else None
            if not snapshot:
                self.send_json(404, {"error": "重新复核任务不存在或已过期。"})
            else:
                self.send_json(200, snapshot)
            return
        if parsed.path == "/api/sample-candidates":
            params = parse_qs(parsed.query)
            if params.get("view") == ["summary"] or "key" in params:
                catalog = _candidate_catalog()
                key = params.get("key", [""])[0]
                if "key" in params:
                    candidate = catalog["byKey"].get(key)
                    if not candidate:
                        self.send_json(404, {"error": "样本已不存在，请刷新训练库。"})
                    else:
                        entry = next(item for item in catalog["entries"] if item.get("key") == key)
                        self.send_json(200, {"candidate": {**candidate, "serverCandidate": True,
                            "trainable": entry["trainable"], "trainingBlockedReasons": entry["trainingBlockedReasons"]}})
                else:
                    self.send_json(200, {"candidates": catalog["entries"], "catalog": catalog["summary"],
                        "revision": str(catalog["signature"]), "fetchedAt": datetime.now(timezone.utc).isoformat()})
            else:
                self.send_json(200, {"candidates": _load_candidates(), "fetchedAt": datetime.now(timezone.utc).isoformat()})
            return
        if parsed.path == "/api/market/universe":
            params = parse_qs(parsed.query)
            try:
                provider = params.get("provider", ["baostock"])[0].lower()
                if provider == "sina":
                    self.send_json(200, fetch_sina_universe())
                elif provider in {"auto", "baostock"}:
                    self.send_json(200, fetch_baostock_universe())
                else:
                    raise ValueError("证券列表仅支持 auto、sina 或 baostock。")
            except ValueError as exc:
                self.send_json(400, {"error": str(exc)})
            except Exception as exc:
                self.send_json(502, {"error": f"自动筛选证券列表失败：{exc}"})
            return
        if parsed.path == "/api/market/intraday":
            params = parse_qs(parsed.query)
            try:
                symbol, code = normalize_symbol(params.get("symbol", [""])[0])
                target_date = params.get("date", [""])[0]
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", target_date):
                    raise ValueError("date 必须是 YYYY-MM-DD 格式。")
                interval = params.get("interval", ["5"])[0]
                if interval not in INTRADAY_FREQUENCIES:
                    raise ValueError("分时粒度当前只支持 5 分钟。")
                provider = params.get("provider", ["auto"])[0].lower()
                result = fetch_intraday(symbol, target_date, interval, provider)
                result["code"] = code
                self.send_json(200, result)
            except ValueError as exc:
                self.send_json(400, {"error": str(exc)})
            except Exception as exc:
                self.send_json(502, {"error": f"真实分时数据获取失败：{exc}"})
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
            provider = params.get("provider", ["auto"])[0].lower()
            if adjust not in {"qfq", "hfq", "none"}:
                raise ValueError("adjust 只支持 qfq、hfq 或 none。")
            self.send_json(200, fetch_market(symbol, limit, adjust, period, provider))
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:  # upstream/network errors are user-facing API errors
            self.send_json(502, {"error": f"真实行情获取失败：{exc}"})

    def _read_json_body(self, max_bytes: int = 2_000_000) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("请求体长度无效。") from exc
        if length < 0 or length > max_bytes:
            raise ValueError("请求体过大。")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("请求体必须是合法 JSON。") from exc
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象。")
        return payload

    def do_POST(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        try:
            if self.path.startswith("/api/research/"):
                payload = self._read_json_body()
                if self.path == "/api/research/start":
                    raw_limit = payload.get("maxSymbols")
                    limit = None if raw_limit in (None, "") else int(raw_limit)
                    self.send_json(202, RESEARCH_ENGINE.start(limit))
                elif self.path == "/api/research/pause":
                    self.send_json(200, RESEARCH_ENGINE.pause())
                elif self.path == "/api/research/propose":
                    self.send_json(200, RESEARCH_ENGINE.propose(str(payload.get("ruleId", "")), float(payload.get("threshold", "nan")),
                                                                str(payload.get("source", "")), str(payload.get("url", "")), str(payload.get("title", ""))))
                elif self.path == "/api/research/retry-validation":
                    self.send_json(202, RESEARCH_ENGINE.retry_validation())
                elif self.path == "/api/research/approve":
                    self.send_json(200, RESEARCH_ENGINE.approve(str(payload.get("ruleId", "")), int(payload.get("revision", 0))))
                else:
                    self.send_json(404, {"error": "未知研究接口。"})
                return
            if self.path == "/api/reviews/save":
                payload = self._read_json_body(5_000_000)
                review = payload.get("review")
                if not isinstance(review, dict) or review.get("format") != "kline-training-review" or not review.get("finished"):
                    raise ValueError("只能保存已结束的完整训练复盘。")
                review_id = str(review.get("id", ""))
                bars = review.get("bars")
                if not re.fullmatch(r"[0-9a-fA-F-]{36}", review_id) or not isinstance(bars, list) or not bars or len(bars) > 2000:
                    raise ValueError("复盘编号或行情数据无效。")
                archived_at = str(review.get("archivedAt") or datetime.now(timezone.utc).isoformat())[:40]
                symbol = str(review.get("symbol") or "未知标的")[:100]
                code = str(review.get("code") or "")[:30]
                trades = review.get("trades") if isinstance(review.get("trades"), list) else []
                bar_notes = review.get("barNotes") if isinstance(review.get("barNotes"), list) else []
                review_notes = review.get("reviewNotes") if isinstance(review.get("reviewNotes"), list) else []
                note_count = len(bar_notes) + len(review_notes) + sum(bool(str(item.get("reason") or "").strip()) for item in trades if isinstance(item, dict))
                serialized = json.dumps(review, ensure_ascii=False, separators=(",", ":"))
                with _db_lock, closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
                    db.execute("""
                        INSERT INTO training_reviews(review_id,archived_at,symbol,code,trade_count,note_count,payload,updated_at)
                        VALUES(?,?,?,?,?,?,?,?)
                        ON CONFLICT(review_id) DO UPDATE SET archived_at=excluded.archived_at,
                        symbol=excluded.symbol,code=excluded.code,trade_count=excluded.trade_count,
                        note_count=excluded.note_count,payload=excluded.payload,updated_at=excluded.updated_at
                    """, (review_id, archived_at, symbol, code, len(trades), note_count, serialized, time.time()))
                self.send_json(200, {"saved": True, "id": review_id, "noteCount": note_count})
                return
            if self.path == "/api/reviews/import":
                payload = self._read_json_body(20_000_000)
                reviews = payload.get("reviews")
                if payload.get("format") != "kline-training-reviews" or not isinstance(reviews, list) or len(reviews) > 1000:
                    raise ValueError("不是有效的“我的复盘”档案备份。")
                imported = 0
                for review in reviews:
                    if not isinstance(review, dict) or review.get("format") != "kline-training-review" or not review.get("finished"):
                        continue
                    review_id = str(review.get("id", ""))
                    if not re.fullmatch(r"[0-9a-fA-F-]{36}", review_id) or not isinstance(review.get("bars"), list):
                        continue
                    review["bars"] = review["bars"][:2000]
                    serialized = json.dumps(review, ensure_ascii=False, separators=(",", ":"))
                    trades = review.get("trades") if isinstance(review.get("trades"), list) else []
                    notes = list(review.get("barNotes")) if isinstance(review.get("barNotes"), list) else []
                    notes += review.get("reviewNotes") if isinstance(review.get("reviewNotes"), list) else []
                    archived_at = str(review.get("archivedAt") or datetime.now(timezone.utc).isoformat())[:40]
                    with _db_lock, closing(sqlite3.connect(SQLITE_FILE, timeout=10)) as db, db:
                        db.execute("""
                            INSERT INTO training_reviews(review_id,archived_at,symbol,code,trade_count,note_count,payload,updated_at)
                            VALUES(?,?,?,?,?,?,?,?)
                            ON CONFLICT(review_id) DO UPDATE SET archived_at=excluded.archived_at,
                            symbol=excluded.symbol,code=excluded.code,trade_count=excluded.trade_count,
                            note_count=excluded.note_count,payload=excluded.payload,updated_at=excluded.updated_at
                        """, (review_id, archived_at, str(review.get("symbol") or "未知标的")[:100], str(review.get("code") or "")[:30], len(trades), len(notes), serialized, time.time()))
                    imported += 1
                self.send_json(200, {"imported": imported})
                return
            payload = self._read_json_body()
            if self.path == "/api/sample-collection/start":
                raw_limit = payload.get("limit", 120)
                limit = max(100, min(6000, int(raw_limit)))
                if int(payload.get("targetPairs", SIDE_PAIR_TARGET)) != SIDE_PAIR_TARGET:
                    raise ValueError(f"当前指标训练采集目标固定为 {SIDE_PAIR_TARGET} 组配对。")
                self.send_json(202, _start_collection_task(limit))
                return
            if self.path == "/api/sample-collection/stop":
                task_id = str(payload.get("taskId", ""))
                if not task_id:
                    raise ValueError("缺少 taskId。")
                reason = str(payload.get("reason") or "用户暂停采集")[:100]
                self.send_json(200, _request_collection_pause(task_id, reason))
                return
            if self.path == "/api/sample-candidates/retry":
                sample_key = str(payload.get("key", ""))
                self.send_json(202, _start_retry_task(sample_key))
                return
            if self.path == "/api/sample-candidates/refetch-intraday":
                sample_key = str(payload.get("key", ""))
                if not sample_key:
                    raise ValueError("缺少候选编号。")
                result = _backfill_existing_intraday(sample_key=sample_key)
                if not result["total"]:
                    candidate = next((item for item in _load_candidates() if item.get("key") == sample_key), None)
                    if not candidate:
                        raise ValueError("没有找到该候选样本。")
                    if _has_complete_intraday(candidate):
                        raise ValueError("该片段已经具备完整 220 天分时，无需重复获取。")
                    raise ValueError("该片段尚未通过日线独立数据复核，暂不能补采分时。")
                self.send_json(200, result)
                return
            if self.path == "/api/sample-candidates/review":
                sample_key = str(payload.get("key", ""))
                action = str(payload.get("action", ""))
                reviewer = str(payload.get("reviewer", "本机审核"))
                if not sample_key or not action:
                    raise ValueError("缺少候选编号或审核操作。")
                self.send_json(200, _review_candidate(sample_key, action, reviewer))
                return
            self.send_json(404, {"error": "未知 POST 接口。"})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            self.send_json(502, {"error": str(exc)})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), lambda *args, **kwargs: AppHandler(*args, directory=str(BASE_DIR), **kwargs))
    print(f"K线训练服务已启动：http://{HOST}:{PORT}/")
    # Pending samples resume only through explicit retry/collection actions.
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nK线训练服务已停止。")
    finally:
        _flush_persistent_cache()
        _flush_sqlite_cache()
        server.server_close()


if __name__ == "__main__":
    main()
