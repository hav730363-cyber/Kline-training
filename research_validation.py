"""Independent, resumable research for review hints; never writes training samples."""

from __future__ import annotations

import json
import math
import sqlite3
import statistics
import threading
import uuid
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HORIZONS = (5, 10, 20)
VERSION = "research-v1"
RULES = {
    "personal-j-low": {"title": "J 低位观察", "side": "buy", "threshold": 10.0, "source": "用户个人观察，未经文献验证", "url": ""},
    "personal-j-high": {"title": "J 高位观察", "side": "sell", "threshold": 75.0, "source": "用户个人观察，未经文献验证", "url": ""},
    "price-volume-context": {"title": "放量向上突破", "side": "buy", "threshold": 1.5, "source": "Blume, Easley & O'Hara (1994); 1.5倍为待验证的实现假设", "url": "https://onlinelibrary.wiley.com/doi/pdf/10.1111/j.1540-6261.1994.tb04424.x"},
    "estimated-volume-profile": {"title": "价格站上估算成交密集区", "side": "buy", "threshold": 60.0, "source": "TradingView Volume Profile 方法；本项目使用历史收盘价和量近似", "url": "https://www.tradingview.com/support/solutions/43000502040-volume-profile-indicators-basic-concepts/"},
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def period_dates(today: date | None = None) -> dict:
    end = today or date.today()
    start = end - timedelta(days=365 * 5)
    return {"start": start.isoformat(), "developmentEnd": (start + timedelta(days=365 * 3)).isoformat(),
            "validationEnd": (start + timedelta(days=365 * 4)).isoformat(), "end": end.isoformat()}


def parse_history_rows(rows: list[list[str]], kind: str) -> tuple[list[dict], dict]:
    """Keep raw status evidence. Unknown stock status is never eligible."""
    bars, reasons = [], {"st": 0, "suspended": 0, "unknownStatus": 0, "invalid": 0}
    for row in rows:
        try:
            day = date.fromisoformat(row[0]).isoformat()
            op, hi, lo, close, volume = (float(row[i]) for i in (1, 2, 3, 4, 5))
            if not all(math.isfinite(x) for x in (op, hi, lo, close, volume)) or min(op, hi, lo, close) <= 0 or volume < 0:
                raise ValueError("invalid OHLCV")
        except (ValueError, TypeError, IndexError):
            reasons["invalid"] += 1
            continue
        if kind == "stock":
            if len(row) < 10 or row[8] not in ("0", "1") or row[9] not in ("0", "1"):
                status = "unknownStatus"
            elif row[9] == "1":
                status = "st"
            elif row[8] == "0" or volume == 0:
                status = "suspended"
            else:
                status = "eligible"
        else:
            status = "eligible" if volume > 0 else "suspended"
        if status != "eligible":
            reasons[status] += 1
        bars.append({"date": day, "open": op, "high": hi, "low": lo, "close": close, "volume": volume, "status": status})
    bars.sort(key=lambda bar: bar["date"])
    return bars, reasons


def _kdj_j(bars: list[dict]) -> list[float | None]:
    result, k, d = [], 50.0, 50.0
    for i, bar in enumerate(bars):
        lookback = bars[max(0, i - 8): i + 1]
        high, low = max(x["high"] for x in lookback), min(x["low"] for x in lookback)
        rsv = (bar["close"] - low) / (high - low) * 100 if high > low else 50.0
        k = (2 * k + rsv) / 3
        d = (2 * d + k) / 3
        result.append(3 * k - 2 * d if i >= 8 else None)
    return result


def _profile_peak(history: list[dict]) -> float | None:
    if len(history) < 40:
        return None
    low, high = min(x["low"] for x in history), max(x["high"] for x in history)
    if high <= low:
        return None
    buckets = [0.0] * 20
    for bar in history:
        pos = min(19, int((bar["close"] - low) / (high - low) * 20))
        buckets[max(0, pos)] += bar["volume"]
    return low + (buckets.index(max(buckets)) + .5) * (high - low) / 20


def event_flags(bars: list[dict], index: int, config: dict, j_values: list[float | None]) -> bool:
    """Only read bars up through index; all tests are made at the decision close."""
    rule_id, threshold = config.get("templateId", config["id"]), float(config["threshold"])
    bar = bars[index]
    if bar["status"] != "eligible" or index < 60:
        return False
    if rule_id == "personal-j-low":
        return j_values[index] is not None and j_values[index] < threshold
    if rule_id == "personal-j-high":
        return j_values[index] is not None and j_values[index] >= threshold
    if rule_id == "price-volume-context":
        previous = bars[index - 20:index]
        average = statistics.mean(x["volume"] for x in previous)
        return average > 0 and bar["close"] > max(x["high"] for x in previous) and bar["close"] > bar["open"] and bar["volume"] / average >= threshold
    if rule_id == "estimated-volume-profile":
        window = min(250, max(40, int(threshold)))
        previous = bars[max(0, index - window):index]
        peak = _profile_peak(previous)
        return peak is not None and bars[index - 1]["close"] <= peak < bar["close"]
    return False


def build_events(bars: list[dict], kind: str, configs: list[dict], dates: dict) -> list[dict]:
    """Outcome bars may follow a signal, but cannot affect signal selection."""
    j_values = _kdj_j(bars)
    events = []
    previous = {}
    for index, bar in enumerate(bars):
        if not (dates["start"] <= bar["date"] <= dates["end"]):
            continue
        for config in configs:
            rule_id = config["id"]
            rule_key = (rule_id, config["revision"])
            if index - previous.get(rule_key, -100) < 5 or not event_flags(bars, index, config, j_values):
                continue
            previous[rule_key] = index
            split = ("development" if bar["date"] < dates["developmentEnd"] else
                     "validation" if bar["date"] < dates["validationEnd"] else "holdout")
            event = {"ruleId": rule_id, "revision": config["revision"], "kind": kind, "date": bar["date"],
                     "split": split, "j": round(j_values[index], 3) if j_values[index] is not None else None,
                     "entryDate": bars[index + 1]["date"] if index + 1 < len(bars) else None,
                     "returns": {}, "missing": []}
            for horizon in HORIZONS:
                exit_index = index + horizon
                if exit_index >= len(bars) or bars[exit_index]["date"] > dates["end"]:
                    event["missing"].append(f"{horizon}日未来行情不足")
                    continue
                if index + 1 >= len(bars) or bars[index + 1]["status"] != "eligible":
                    event["missing"].append("下一交易日不可交易")
                    continue
                entry, exit_price = bars[index + 1]["open"], bars[exit_index]["close"]
                if entry <= 0:
                    event["missing"].append("入场价无效")
                    continue
                gross = exit_price / entry - 1
                # Research-only round-trip proxy; app execution fees are unchanged.
                fee = .0015 if kind == "stock" else .0005
                event["returns"][str(horizon)] = round((gross if config["side"] == "buy" else -gross) - fee, 6)
            events.append(event)
    return events


def intraday_target_dates(events: list[dict]) -> list[str]:
    """Deterministic bounded event-local sample: first date per rule and time split."""
    selected = {}
    latest = {}
    for event in events:
        latest[event["ruleId"]] = max(latest.get(event["ruleId"], 0), event["revision"])
    for event in sorted(events, key=lambda item: item["date"]):
        if event["revision"] != latest[event["ruleId"]]:
            continue
        selected.setdefault((event["ruleId"], event["split"]), event["date"])
    return sorted(set(selected.values()))


def summarize_events(events: list[dict], all_symbols: int, processed: int, excluded: dict, dates: dict) -> dict:
    scanned = processed + excluded.get("failedSymbols", 0) + excluded.get("insufficientSymbols", 0)
    complete_scan = all_symbols > 0 and scanned >= all_symbols
    coverage_adequate = complete_scan and processed / all_symbols >= .9 and excluded.get("failedSymbols", 0) / all_symbols <= .05
    grouped = {}
    for event in events:
        key = (event["ruleId"], event["revision"], event["kind"], event["split"])
        grouped.setdefault(key, []).append(event)
    groups = []
    for (rule_id, revision, kind, split), items in sorted(grouped.items()):
        horizons = {}
        for horizon in HORIZONS:
            values = [item["returns"][str(horizon)] for item in items if str(horizon) in item["returns"]]
            ordered = sorted(values)
            horizons[str(horizon)] = {"count": len(values), "meanNet": round(statistics.mean(values), 6) if values else None,
                                      "medianNet": round(statistics.median(values), 6) if values else None,
                                      "downsideRate": round(sum(x < 0 for x in values) / len(values), 4) if values else None,
                                      "p10Net": round(ordered[max(0, int(len(ordered) * .1) - 1)], 6) if values else None}
        groups.append({"ruleId": rule_id, "revision": revision, "kind": kind, "split": split,
                       "signals": len(items), "symbols": len({item["symbol"] for item in items}), "horizons": horizons,
                       "missingOutcomes": sum(bool(item["missing"]) for item in items)})
    coverage = {"universe": all_symbols, "processed": processed, "scanned": scanned, "coverageAdequate": coverage_adequate, "excluded": excluded,
                "dates": dates, "survivorsOnly": True, "source": "BaoStock", "adjust": "前复权",
                "feeAssumption": "A股往返0.15%，ETF往返0.05%研究代理费率；5/10/20日持有，不模拟日内回转；A股T+1、ETF T+0均不受同日限制。",
                "limitations": "仅当前存续且非ST证券；存在幸存者偏差。历史ST仅排除信号决策日，不用未来状态筛选历史信号。"}
    for group in groups:
        if (not coverage_adequate or group["split"] == "development" or group["horizons"]["20"]["count"] < 50
                or group["symbols"] < 20):
            group["evidence"] = "证据不足"
        elif group["horizons"]["20"]["meanNet"] <= 0:
            group["evidence"] = "样本外方向不稳定"
        else:
            group["evidence"] = "样本外统计可查；仍需人工确认"
    return {"version": VERSION, "createdAt": utc_now(), "coverage": coverage, "groups": groups,
            "events": len({(event["symbol"], event["date"], event["ruleId"]) for event in events}),
            "versionedEvents": len(events), "status": "complete" if complete_scan else "partial"}


class ResearchEngine:
    def __init__(self, directory: Path, universe_fetch, source_lock: threading.RLock):
        self.path = Path(directory) / "research-validation.sqlite3"
        self.universe_fetch = universe_fetch
        self.source_lock = source_lock
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.worker = None
        self.validation_worker = None
        self._init_db()

    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=20)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS symbols (symbol TEXT PRIMARY KEY, name TEXT, kind TEXT, state TEXT, reason TEXT, updated_at TEXT);
                CREATE TABLE IF NOT EXISTS daily (symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL, status TEXT, provider TEXT, adjust TEXT, PRIMARY KEY(symbol,date));
                CREATE TABLE IF NOT EXISTS events (symbol TEXT, date TEXT, rule_id TEXT, revision INTEGER, payload TEXT, PRIMARY KEY(symbol,date,rule_id,revision));
                CREATE TABLE IF NOT EXISTS intraday (symbol TEXT, date TEXT, state TEXT, bars INTEGER, reason TEXT, payload TEXT, PRIMARY KEY(symbol,date));
                CREATE TABLE IF NOT EXISTS rule_versions (id TEXT, revision INTEGER, payload TEXT, approved INTEGER DEFAULT 0, created_at TEXT, PRIMARY KEY(id,revision));
            """)
            if "payload" not in {row[1] for row in db.execute("PRAGMA table_info(intraday)")}:
                db.execute("ALTER TABLE intraday ADD COLUMN payload TEXT")
            for rule_id, rule in RULES.items():
                db.execute("INSERT OR IGNORE INTO rule_versions(id,revision,payload,approved,created_at) VALUES(?,?,?,?,?)",
                           (rule_id, 1, json.dumps({"id": rule_id, "revision": 1, **rule}, ensure_ascii=False), 0, utc_now()))

    def _get(self, key, default=None):
        with closing(self._connect()) as db:
            row = db.execute("SELECT payload FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def _put(self, key, payload):
        with closing(self._connect()) as db, db:
            db.execute("INSERT OR REPLACE INTO meta(key,payload) VALUES(?,?)", (key, json.dumps(payload, ensure_ascii=False)))

    def rules(self):
        with closing(self._connect()) as db:
            rows = db.execute("SELECT id,revision,payload,approved FROM rule_versions ORDER BY id,revision DESC").fetchall()
        return [{**json.loads(row["payload"]), "approved": bool(row["approved"])} for row in rows]

    def latest_configs(self):
        latest = {}
        for item in self.rules():
            latest.setdefault(item["id"], item)
        return list(latest.values())

    def status(self):
        task = self._get("task", {"state": "idle", "dates": period_dates(), "error": ""})
        if task["state"] == "running" and not (self.worker and self.worker.is_alive()):
            task = {**task, "state": "paused", "reason": "应用关闭或任务中断；可手动继续"}
            self._put("task", task)
        rule_validation = self._get("ruleValidation", {"state": "idle"})
        if rule_validation["state"] == "running" and not (self.validation_worker and self.validation_worker.is_alive()):
            rule_validation = {**rule_validation, "state": "interrupted", "error": "应用关闭或规则重验中断"}
            self._put("ruleValidation", rule_validation)
        with closing(self._connect()) as db:
            counts = {row["state"]: row["n"] for row in db.execute("SELECT state, COUNT(*) n FROM symbols GROUP BY state")}
            event_count = db.execute("SELECT COUNT(*) FROM (SELECT 1 FROM events GROUP BY symbol,date,rule_id)").fetchone()[0]
            intraday_count = db.execute("SELECT COUNT(*) FROM intraday WHERE state='complete'").fetchone()[0]
        return {**task, "counts": counts, "events": event_count, "intradayDays": intraday_count,
                "reportAvailable": self._get("report") is not None, "ruleValidation": rule_validation,
                "universeCount": self._get("universe", {}).get("count", 0)}

    def start(self, max_symbols: int | None = None):
        with self.lock:
            if self.worker and self.worker.is_alive():
                raise ValueError("研究任务正在运行。")
            if self.validation_worker and self.validation_worker.is_alive():
                raise ValueError("规则重验正在进行，请完成后再继续扫描。")
            if max_symbols is not None and not (1 <= max_symbols <= 10000):
                raise ValueError("本批证券数量须在 1 至 10000 之间。")
            task = self._get("task", {})
            task = {**task, "state": "running", "reason": "", "error": "", "startedAt": utc_now(),
                    "dates": task.get("dates") or period_dates(), "maxSymbols": max_symbols}
            task.pop("sourceFailure", None)
            self._put("task", task)
            self.stop_event.clear()
            self.worker = threading.Thread(target=self._run, daemon=True, name="review-research")
            self.worker.start()
            return self.status()

    def pause(self):
        self.stop_event.set()
        return {**self.status(), "pauseRequested": True}

    def _fetch_daily(self, instrument: dict, dates: dict) -> tuple[list[dict], dict]:
        import baostock as bs
        symbol, kind = instrument["baostockCode"], instrument["kind"]
        fields = "date,open,high,low,close,volume,amount,adjustflag,tradestatus,isST" if kind == "stock" else "date,open,high,low,close,volume,amount,adjustflag"
        start = (date.fromisoformat(dates["start"]) - timedelta(days=125)).isoformat()
        with self.source_lock:
            login = bs.login()
            if getattr(login, "error_code", "1") != "0":
                raise RuntimeError("BaoStock 登录失败")
            try:
                result = bs.query_history_k_data_plus(symbol, fields, start_date=start, end_date=dates["end"], frequency="d", adjustflag="2")
                if getattr(result, "error_code", "1") != "0":
                    raise RuntimeError(getattr(result, "error_msg", "日线请求失败"))
                rows = []
                while result.next():
                    rows.append(result.get_row_data())
            finally:
                bs.logout()
        return parse_history_rows(rows, kind)

    def _fetch_intraday(self, instrument: dict, target_date: str) -> tuple[list[dict], str]:
        import baostock as bs
        with self.source_lock:
            login = bs.login()
            if getattr(login, "error_code", "1") != "0":
                raise RuntimeError("BaoStock 分时登录失败")
            try:
                query = bs.query_history_k_data_plus(instrument["baostockCode"], "date,time,code,open,high,low,close,volume,amount,adjustflag",
                                                     start_date=target_date, end_date=target_date, frequency="5", adjustflag="3")
                if getattr(query, "error_code", "1") != "0":
                    raise RuntimeError(getattr(query, "error_msg", "分时请求失败"))
                bars = []
                while query.next():
                    row = query.get_row_data()
                    try:
                        bars.append({"time": str(row[1]), "open": float(row[3]), "high": float(row[4]),
                                     "low": float(row[5]), "close": float(row[6]), "volume": float(row[7])})
                    except (ValueError, TypeError, IndexError):
                        continue
            finally:
                bs.logout()
        return bars, "complete" if len(bars) == 48 else "incomplete"

    def _run(self):
        task = self._get("task", {})
        try:
            universe = self.universe_fetch()["instruments"]
            self._put("universe", {"source": "BaoStock 当前存续证券名单", "fetchedAt": utc_now(), "count": len(universe)})
            configs = self.rules()
            with closing(self._connect()) as db, db:
                for instrument in universe:
                    db.execute("INSERT OR IGNORE INTO symbols(symbol,name,kind,state,reason,updated_at) VALUES(?,?,?,'pending','',?)",
                               (instrument["symbol"], instrument["name"], instrument["kind"], utc_now()))
                live = {item["symbol"] for item in universe}
                for row in db.execute("SELECT symbol FROM symbols").fetchall():
                    if row["symbol"] not in live:
                        db.execute("UPDATE symbols SET state='excluded',reason='已不在当前存续非ST名单中' WHERE symbol=?", (row["symbol"],))
            done_this_batch = 0
            source_failures = 0
            for instrument in universe:
                if self.stop_event.is_set():
                    break
                if task.get("maxSymbols") is not None and done_this_batch >= task["maxSymbols"]:
                    break
                symbol = instrument["symbol"]
                with closing(self._connect()) as db:
                    row = db.execute("SELECT state FROM symbols WHERE symbol=?", (symbol,)).fetchone()
                if row and row["state"] == "insufficient":
                    continue
                if row and row["state"] == "complete":
                    with closing(self._connect()) as db:
                        stored_events = [json.loads(item[0]) for item in db.execute("SELECT payload FROM events WHERE symbol=?", (symbol,))]
                        dates_to_fetch = intraday_target_dates(stored_events)
                else:
                    done_this_batch += 1
                    try:
                        bars, reasons = self._fetch_daily(instrument, task["dates"])
                        if len(bars) < 80:
                            with closing(self._connect()) as db, db:
                                db.execute("UPDATE symbols SET state='insufficient',reason=?,updated_at=? WHERE symbol=?",
                                           (f"历史日线仅 {len(bars)} 根，不足以预热规则", utc_now(), symbol))
                            continue
                        events = build_events(bars, instrument["kind"], configs, task["dates"])
                        with closing(self._connect()) as db, db:
                            db.execute("DELETE FROM daily WHERE symbol=?", (symbol,))
                            db.execute("DELETE FROM events WHERE symbol=?", (symbol,))
                            db.executemany("INSERT INTO daily VALUES(?,?,?,?,?,?,?,?,?,?)",
                                           [(symbol, x["date"], x["open"], x["high"], x["low"], x["close"], x["volume"], x["status"], "BaoStock", "qfq") for x in bars])
                            db.executemany("INSERT INTO events VALUES(?,?,?,?,?)",
                                           [(symbol, x["date"], x["ruleId"], x["revision"], json.dumps({**x, "symbol": symbol}, ensure_ascii=False)) for x in events])
                            db.execute("UPDATE symbols SET state='complete',reason=?,updated_at=? WHERE symbol=?",
                                       (json.dumps(reasons, ensure_ascii=False), utc_now(), symbol))
                        dates_to_fetch = intraday_target_dates(events)
                        source_failures = 0
                    except Exception as exc:
                        with closing(self._connect()) as db, db:
                            db.execute("UPDATE symbols SET state='failed',reason=?,updated_at=? WHERE symbol=?",
                                       (str(exc)[:250], utc_now(), symbol))
                        source_failures += 1
                        if source_failures >= 3:
                            self.stop_event.set()
                            task["sourceFailure"] = "连续三个标的日线请求失败；请检查数据源后继续"
                        continue
                try:
                    # Event-local intraday is optional context; missing data never becomes zero volume.
                    for day in dates_to_fetch:
                        if self.stop_event.is_set():
                            break
                        with closing(self._connect()) as db:
                            existing = db.execute("SELECT state FROM intraday WHERE symbol=? AND date=?", (symbol, day)).fetchone()
                        if existing and existing["state"] == "complete":
                            continue
                        try:
                            minute_bars, status = self._fetch_intraday(instrument, day)
                            count = len(minute_bars)
                            reason = "" if status == "complete" else f"仅 {count}/48 根"
                        except Exception as exc:
                            minute_bars, count, status, reason = [], 0, "unavailable", str(exc)[:200]
                        with closing(self._connect()) as db, db:
                            db.execute("INSERT OR REPLACE INTO intraday VALUES(?,?,?,?,?,?)",
                                       (symbol, day, status, count, reason, json.dumps(minute_bars, ensure_ascii=False)))
                except Exception as exc:
                    with closing(self._connect()) as db, db:
                        db.execute("UPDATE symbols SET state='failed',reason=?,updated_at=? WHERE symbol=?",
                                   (str(exc)[:250], utc_now(), symbol))
                if done_this_batch % 10 == 0:
                    self._refresh_report(len(universe), task["dates"])
            state = "paused" if self.stop_event.is_set() or task.get("maxSymbols") is not None else "complete"
            reason = task.get("sourceFailure") or ("用户暂停" if self.stop_event.is_set() else "本批完成，可继续" if state == "paused" else "证券名单扫描完毕")
            self._put("task", {**task, "state": state, "reason": reason, "updatedAt": utc_now()})
            self._refresh_report(len(universe), task["dates"])
        except Exception as exc:
            self._put("task", {**task, "state": "paused", "reason": "数据源或任务异常", "error": str(exc)[:300], "updatedAt": utc_now()})

    def _refresh_report(self, universe_size, dates):
        with closing(self._connect()) as db:
            rows = db.execute("SELECT events.payload FROM events JOIN symbols ON symbols.symbol=events.symbol WHERE symbols.state='complete'").fetchall()
            symbols = db.execute("SELECT state,reason FROM symbols").fetchall()
            minute = {row["state"]: row["n"] for row in db.execute("SELECT state,COUNT(*) n FROM intraday GROUP BY state")}
            daily_coverage = [dict(row) for row in db.execute("""
                SELECT symbols.kind, COUNT(DISTINCT daily.symbol) symbols, COUNT(*) days,
                       MIN(daily.date) firstDate, MAX(daily.date) lastDate
                FROM daily JOIN symbols ON symbols.symbol=daily.symbol
                WHERE symbols.state='complete' AND daily.status='eligible' AND daily.date>=? AND daily.date<=?
                GROUP BY symbols.kind
            """, (dates["start"], dates["end"]))]
            failure_examples = [dict(row) for row in db.execute("SELECT symbol,reason FROM symbols WHERE state='failed' ORDER BY updated_at DESC LIMIT 10")]
        events = [json.loads(row["payload"]) for row in rows]
        processed = sum(row["state"] == "complete" for row in symbols)
        excluded = {"stDays": 0, "suspendedDays": 0, "unknownStatusDays": 0, "invalidRows": 0,
                    "failedSymbols": 0, "excludedSymbols": 0, "insufficientSymbols": 0}
        for row in symbols:
            if row["state"] == "failed": excluded["failedSymbols"] += 1
            if row["state"] == "excluded": excluded["excludedSymbols"] += 1
            if row["state"] == "insufficient": excluded["insufficientSymbols"] += 1
            if row["state"] == "complete":
                try: reason = json.loads(row["reason"])
                except (ValueError, TypeError): reason = {}
                for source, target in (("st", "stDays"), ("suspended", "suspendedDays"), ("unknownStatus", "unknownStatusDays"), ("invalid", "invalidRows")):
                    excluded[target] += reason.get(source, 0)
        report = summarize_events(events, universe_size, processed, excluded, dates)
        report["intradayCoverage"] = minute
        report["dailyCoverage"] = daily_coverage
        report["failureExamples"] = failure_examples
        report["intradaySampling"] = "每标的每规则每时间分段取首个候选日，最多12日；未采样候选不推断分时量。"
        self._put("report", report)

    def report(self):
        return self._get("report", {"status": "not-run", "groups": [], "coverage": {}, "events": 0})

    def propose(self, rule_id: str, threshold: float, source: str, url: str, title: str = ""):
        if self.worker and self.worker.is_alive():
            raise ValueError("请先暂停研究任务，再提交新规则版本。")
        if self.validation_worker and self.validation_worker.is_alive():
            raise ValueError("上一条候选规则仍在重新验证。")
        existing = next((item for item in self.latest_configs() if item["id"] == rule_id), None)
        template_id = existing.get("templateId", rule_id) if existing else rule_id
        if template_id not in RULES or not math.isfinite(threshold) or not source.strip():
            raise ValueError("规则、数值或来源无效。")
        if url and not url.startswith("https://"):
            raise ValueError("来源链接必须使用 https。")
        bounds = {"personal-j-low": (-100, 100), "personal-j-high": (0, 200),
                  "price-volume-context": (1, 10), "estimated-volume-profile": (40, 250)}
        if not bounds[template_id][0] <= threshold <= bounds[template_id][1]:
            raise ValueError("阈值超出该规则允许范围。")
        if title.strip():
            if len(title.strip()) > 80:
                raise ValueError("规则名称最多 80 字。")
            rule_id = f"custom-{uuid.uuid4().hex[:12]}"
        with self.lock, closing(self._connect()) as db, db:
            revision = db.execute("SELECT COALESCE(MAX(revision),0)+1 FROM rule_versions WHERE id=?", (rule_id,)).fetchone()[0]
            payload = {**RULES[template_id], "id": rule_id, "templateId": template_id,
                       "title": title.strip() or RULES[template_id]["title"], "revision": revision, "threshold": threshold,
                       "source": source.strip()[:300], "url": url[:500]}
            db.execute("INSERT INTO rule_versions VALUES(?,?,?,?,?)", (rule_id, revision, json.dumps(payload, ensure_ascii=False), 0, utc_now()))
        self._put("ruleValidation", {"state": "running", "ruleId": rule_id, "revision": revision, "startedAt": utc_now()})
        self.validation_worker = threading.Thread(target=self._run_revalidation, args=(payload,), daemon=True, name="research-rule-revalidation")
        self.validation_worker.start()
        return payload

    def _run_revalidation(self, config):
        try:
            self.revalidate_rule(config)
            self._put("ruleValidation", {"state": "complete", "ruleId": config["id"], "revision": config["revision"], "updatedAt": utc_now()})
        except Exception as exc:
            self._put("ruleValidation", {"state": "failed", "ruleId": config["id"], "revision": config["revision"], "error": str(exc)[:300], "updatedAt": utc_now()})

    def revalidate_rule(self, config: dict):
        dates = self._get("task", {}).get("dates") or period_dates()
        with closing(self._connect()) as db:
            symbols = db.execute("SELECT symbol,kind FROM symbols WHERE state='complete'").fetchall()
        with closing(self._connect()) as db, db:
            for row in symbols:
                bars = [dict(item) for item in db.execute("SELECT date,open,high,low,close,volume,status FROM daily WHERE symbol=? ORDER BY date", (row["symbol"],))]
                events = build_events(bars, row["kind"], [config], dates)
                db.executemany("INSERT OR REPLACE INTO events VALUES(?,?,?,?,?)",
                               [(row["symbol"], x["date"], x["ruleId"], x["revision"], json.dumps({**x, "symbol": row["symbol"]}, ensure_ascii=False)) for x in events])
        universe = self._get("universe", {})
        self._refresh_report(universe.get("count", len(symbols)), dates)

    def retry_validation(self):
        if self.worker and self.worker.is_alive() or self.validation_worker and self.validation_worker.is_alive():
            raise ValueError("请等待当前任务结束。")
        current = self.status()["ruleValidation"]
        if current.get("state") not in {"interrupted", "failed"}:
            raise ValueError("没有需要重试的规则验证。")
        config = next((item for item in self.rules() if item["id"] == current.get("ruleId") and item["revision"] == current.get("revision")), None)
        if not config:
            raise ValueError("待重验规则版本已不存在。")
        self._put("ruleValidation", {**current, "state": "running", "error": "", "startedAt": utc_now()})
        self.validation_worker = threading.Thread(target=self._run_revalidation, args=(config,), daemon=True, name="research-rule-revalidation")
        self.validation_worker.start()
        return self.status()["ruleValidation"]

    def approve(self, rule_id: str, revision: int):
        if self.validation_worker and self.validation_worker.is_alive():
            raise ValueError("规则仍在重新验证，完成后再审核。")
        report = self.report()
        matches = [group for group in report.get("groups", []) if group["ruleId"] == rule_id and group["revision"] == revision]
        eligible = {(group["kind"], group["split"]) for group in matches if group["evidence"] == "样本外统计可查；仍需人工确认"}
        if report.get("status") != "complete" or not all((kind, split) in eligible for kind in ("stock", "etf") for split in ("validation", "holdout")):
            raise ValueError("A股与ETF的验证期及留出期均需达到最低样本量且方向一致，当前不能启用；可继续作为观察提示。")
        with closing(self._connect()) as db, db:
            if not db.execute("SELECT 1 FROM rule_versions WHERE id=? AND revision=?", (rule_id, revision)).fetchone():
                raise ValueError("规则版本不存在。")
            db.execute("UPDATE rule_versions SET approved=0 WHERE id=?", (rule_id,))
            db.execute("UPDATE rule_versions SET approved=1 WHERE id=? AND revision=?", (rule_id, revision))
        return {"ruleId": rule_id, "revision": revision, "approved": True}
