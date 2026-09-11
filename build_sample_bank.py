"""Build a real-data candidate sample bank from Eastmoney.

The output is intentionally a pending-review bank.  Shape scores are
heuristics for triage, not probabilities, so this script never auto-approves
or presents a score as a 90% certainty.
"""

from __future__ import annotations

import json
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
HOST = "https://7.push2.eastmoney.com"
KLINE_HOST = "https://7.push2his.eastmoney.com"
USER_AGENT = "Mozilla/5.0 KLineTrainingSampleBuilder/1.0"
UT = "fa5fd1943c7b386f172d6893dbbd1b5b"
PERIODS = {"daily": 101, "weekly": 102, "monthly": 103, "yearly": 106}
LIBRARY_TEXT = (ROOT / "library.js").read_text(encoding="utf-8")
PATTERN_IDS = re.findall(r'id:\s*"([^"]+)"', LIBRARY_TEXT)
PATTERN_NAMES = dict(re.findall(r'id:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"', LIBRARY_TEXT))
FALLBACK_CODES = [
    "600000", "600016", "600036", "600048", "600104", "600276", "600309", "600519",
    "600690", "600887", "601012", "601088", "601318", "601398", "601668", "601857",
    "601888", "603259", "603288", "603501", "000001", "000002", "000333", "000651",
    "000858", "000895", "002027", "002129", "002230", "002415", "002594", "002714",
    "300015", "300059", "300122", "300274", "300308", "300750", "300760", "510300",
    "510500", "512100", "515790", "518880", "159915", "159919", "159949", "159995",
]


def get_json(url: str, attempts: int = 3) -> dict:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT, "Referer": "https://quote.eastmoney.com/"})
            with urlopen(request, timeout=25) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # network providers can close a connection transiently
            last_error = exc
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"请求失败：{last_error}")


def fetch_universe() -> list[dict]:
    params = {
        "pn": 1, "pz": 120, "po": 1, "np": 1, "ut": UT, "fltt": 2, "invt": 2,
        "fid": "f3", "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
        "fields": "f12,f14,f2,f3",
    }
    try:
        data = get_json(f"{HOST}/api/qt/clist/get?{urlencode(params)}").get("data") or {}
        rows = data.get("diff") or []
        universe = []
        for row in rows:
            code = str(row.get("f12", ""))
            name = str(row.get("f14", ""))
            price = float(row.get("f2") or 0)
            if re.fullmatch(r"\d{6}", code) and price > 0 and not re.search(r"ST|退|\*|U$|W$", name, re.I):
                universe.append({"code": code, "name": name})
        if universe:
            return universe
    except Exception as exc:
        print(f"证券列表获取失败，使用预设代码重试：{exc}")
    return [{"code": code, "name": ""} for code in FALLBACK_CODES]


def secid(code: str) -> str:
    return f"1.{code}" if code.startswith(("5", "6")) else f"0.{code}"


def fetch_bars(code: str, limit: int = 2000) -> tuple[list[dict], str]:
    params = {
        "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "beg": 0, "end": 20500101, "klt": PERIODS["daily"], "fqt": 1,
        "secid": secid(code), "lmt": limit, "rtntype": 6, "ut": UT,
    }
    payload = get_json(f"{KLINE_HOST}/api/qt/stock/kline/get?{urlencode(params)}")
    if payload.get("rc") != 0:
        raise RuntimeError(f"东方财富返回 rc={payload.get('rc')}")
    data = payload.get("data") or {}
    bars = []
    seen = set()
    for row in data.get("klines") or []:
        cells = row.split(",") if isinstance(row, str) else row
        if not isinstance(cells, list) or len(cells) < 6:
            continue
        try:
            date, open_price, close, high, low, volume = cells[:6]
            values = [float(open_price), float(high), float(low), float(close), float(volume)]
        except (TypeError, ValueError):
            continue
        if date in seen or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(date)):
            continue
        if min(values[:4]) <= 0 or values[4] < 0 or values[2] > min(values[0], values[3]) or values[1] < max(values[0], values[3]):
            continue
        seen.add(date)
        bars.append({"date": date, "open": values[0], "high": values[1], "low": values[2], "close": values[3], "volume": values[4]})
    return sorted(bars, key=lambda item: item["date"]), str(data.get("name") or "")


def avg(values: list[float]) -> float:
    return mean(values) if values else 0.0


def clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def slope(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    x_mean = (len(values) - 1) / 2
    y_mean = avg(values)
    numerator = sum((i - x_mean) * (value - y_mean) for i, value in enumerate(values))
    denominator = sum((i - x_mean) ** 2 for i in range(len(values))) or 1
    return numerator / denominator


def local_extrema(values: list[float], low: bool = True) -> list[int]:
    indexes = []
    for index in range(2, len(values) - 2):
        window = values[index - 2:index + 3]
        if (values[index] == min(window) if low else values[index] == max(window)):
            indexes.append(index)
    return indexes


def range_ratio(segment: list[dict], start: int, end: int) -> float:
    prices = [bar["high"] - bar["low"] for bar in segment[start:end]]
    return avg(prices) / max(avg([bar["close"] for bar in segment[start:end]]), 0.0001)


def score_pattern(pattern_id: str, segment: list[dict]) -> float:
    closes = [bar["close"] for bar in segment]
    highs = [bar["high"] for bar in segment]
    lows = [bar["low"] for bar in segment]
    volumes = [bar["volume"] for bar in segment]
    n = len(segment)
    start, middle, end = avg(closes[:max(4, n // 8)]), min(closes[n // 3:2 * n // 3]), avg(closes[-max(4, n // 8):])
    top_middle = max(closes[n // 3:2 * n // 3])
    decline = clamp((start - middle) / max(start * 0.18, 0.01))
    recovery = clamp((end - middle) / max(middle * 0.18, 0.01))
    top_decline = clamp((top_middle - end) / max(top_middle * 0.18, 0.01))
    low_points = local_extrema(lows, True)
    high_points = local_extrema(highs, False)
    low_prices = [lows[i] for i in low_points]
    high_prices = [highs[i] for i in high_points]
    similar_lows = clamp(1 - (max(low_prices[-3:]) - min(low_prices[-3:])) / max(avg(low_prices[-3:]) * 0.1, 0.01)) if len(low_prices) >= 3 else 0
    similar_highs = clamp(1 - (max(high_prices[-3:]) - min(high_prices[-3:])) / max(avg(high_prices[-3:]) * 0.1, 0.01)) if len(high_prices) >= 3 else 0
    center_low = clamp((start - middle) / max(start * 0.2, 0.01))
    smooth = clamp(1 - avg(abs(closes[i] - closes[i - 1]) for i in range(1, n)) / max(avg(closes) * 0.04, 0.01))
    first_range, last_range = range_ratio(segment, 0, n // 3), range_ratio(segment, 2 * n // 3, n)
    converging = clamp(1 - last_range / max(first_range, 0.0001))
    expanding = clamp(last_range / max(first_range, 0.0001) - 0.75)
    breakout = clamp((end - max(closes[n // 2:])) / max(avg(closes) * 0.12, 0.01))
    upward = clamp(slope(closes) / max(avg(closes) * 0.02, 0.0001))
    downward = clamp(-slope(closes) / max(avg(closes) * 0.02, 0.0001))
    low_zone_width = (max(lows[n // 3:4 * n // 5]) - min(lows[n // 3:4 * n // 5])) / max(middle, 0.01)
    rectangle = clamp((0.2 - low_zone_width) / 0.2)
    gap = max(abs(closes[i] - closes[i - 1]) / max(closes[i - 1], 0.01) for i in range(1, n))
    volume_dry = clamp((avg(volumes[:n // 4]) - avg(volumes[n // 3:2 * n // 3])) / max(avg(volumes[:n // 4]), 1) + 0.5)
    bottom = 0.28 * decline + 0.28 * recovery + 0.16 * volume_dry + 0.14 * upward + 0.14 * smooth
    top = 0.28 * top_decline + 0.28 * clamp((top_middle - end) / max(end * 0.18, 0.01)) + 0.16 * volume_dry + 0.14 * downward + 0.14 * smooth
    if pattern_id == "three-rising-valleys": return 0.55 * similar_lows + 0.25 * bottom + 0.2 * clamp((low_prices[-1] - low_prices[0]) / max(avg(low_prices) * 0.08, 0.01)) if len(low_prices) >= 3 else 0
    if pattern_id in {"triple-bottom", "head-shoulders-bottom", "complex-head-shoulders-bottom"}: return 0.5 * similar_lows + 0.5 * bottom
    if pattern_id in {"triple-top", "head-shoulders-top", "complex-head-shoulders-top"}: return 0.5 * similar_highs + 0.5 * top
    if pattern_id.endswith("bottom") or pattern_id in {"round-bottom", "ascending-scallop", "measured-rise"}: return bottom
    if pattern_id.endswith("top") or pattern_id in {"round-top", "measured-decline"}: return top
    if pattern_id in {"ascending-triangle", "symmetrical-triangle", "descending-triangle"}: return 0.45 * converging + 0.3 * (upward if pattern_id == "ascending-triangle" else downward if pattern_id == "descending-triangle" else 0.5) + 0.25 * smooth
    if pattern_id in {"falling-wedge", "rising-wedge"}: return 0.45 * converging + 0.3 * (downward if pattern_id == "falling-wedge" else upward) + 0.25 * smooth
    if pattern_id in {"pennant", "four-sided-flag", "high-tight-flag"}: return 0.4 * converging + 0.35 * clamp(abs(slope(closes[:n // 3])) / max(avg(closes) * 0.025, 0.0001)) + 0.25 * smooth
    if pattern_id == "gap": return clamp(gap / 0.08)
    if pattern_id in {"broadening-bottom", "broadening-top", "diamond-bottom", "diamond-top"}: return 0.45 * expanding + 0.3 * (bottom if pattern_id.endswith("bottom") else top) + 0.25 * converging
    if pattern_id == "rectangle-bottom": return 0.55 * rectangle + 0.45 * bottom
    if pattern_id == "rectangle-top": return 0.55 * rectangle + 0.45 * top
    if pattern_id in {"pipe-bottom", "adam-adam-bottom", "eve-adam-bottom", "adam-eve-bottom", "eve-eve-bottom"}: return 0.5 * similar_lows + 0.5 * bottom
    if pattern_id in {"pipe-top", "adam-adam-top", "eve-adam-top", "adam-eve-top", "eve-eve-top"}: return 0.5 * similar_highs + 0.5 * top
    return clamp(0.5 * smooth + 0.25 * (bottom + top))


def collect_candidates(universe: list[dict]) -> list[dict]:
    all_candidates = []
    for position, security in enumerate(universe, 1):
        code, name = security["code"], security["name"]
        try:
            bars, fetched_name = fetch_bars(code)
            name = fetched_name or name
        except Exception as exc:
            print(f"[{position}/{len(universe)}] {code} 跳过：{exc}")
            continue
        print(f"[{position}/{len(universe)}] {code} {name or '未命名'}：{len(bars)} 根")
        if len(bars) < 260:
            continue
        for size in (60, 90, 120, 180):
            for end in range(size - 1, len(bars), 15):
                segment = bars[end - size + 1:end + 1]
                for pattern_id in PATTERN_IDS:
                    score = score_pattern(pattern_id, segment)
                    all_candidates.append({"code": code, "name": name, "patternId": pattern_id, "score": round(score, 4), "bars": segment})
        time.sleep(0.18)
    selected = []
    for pattern_id in PATTERN_IDS:
        pool = sorted((item for item in all_candidates if item["patternId"] == pattern_id), key=lambda item: item["score"], reverse=True)
        used = set()
        count = 0
        for item in pool:
            start_date, end_date = item["bars"][0]["date"], item["bars"][-1]["date"]
            key = (item["code"], start_date, end_date)
            if key in used:
                continue
            used.add(key)
            selected.append({
                "key": f"{item['code']}|{start_date}|{end_date}|{pattern_id}",
                "symbol": f"{item['name']} ({item['code']})" if item["name"] else item["code"],
                "code": item["code"], "patternId": pattern_id,
                "patternName": PATTERN_NAMES.get(pattern_id, pattern_id), "startDate": start_date, "endDate": end_date,
                "startIndex": 0, "endIndex": len(item["bars"]) - 1,
                "confidence": item["score"], "patternScore": item["score"], "bottomScore": None,
                "reviewStatus": "pending", "status": "待审核", "autoEligible": False,
                "provider": "东方财富", "dataSource": "real", "adjust": "qfq", "period": "daily",
                "ruleVersion": "heuristic-v1-pending-review", "snapshot": True, "bars": item["bars"],
            })
            count += 1
            if count == 3:
                break
    return selected


def main() -> None:
    if len(PATTERN_IDS) != 40:
        raise RuntimeError(f"library.js 中应有 40 个形态，实际为 {len(PATTERN_IDS)} 个。")
    universe = fetch_universe()
    candidates = collect_candidates(universe)
    counts = {pattern_id: sum(item["patternId"] == pattern_id for item in candidates) for pattern_id in PATTERN_IDS}
    missing = {pattern_id: count for pattern_id, count in counts.items() if count < 3}
    output = {
        "format": "kline-training-real-sample-bank", "version": 1,
        "provider": "东方财富", "adjust": "qfq", "period": "daily",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "reviewPolicy": "全部候选待人工审核；启发式评分不等同于概率，不自动入库。",
        "targetPerPattern": 3, "patternCount": len(PATTERN_IDS),
        "sampleCount": len(candidates), "counts": counts, "missing": missing,
        "samples": candidates,
    }
    (ROOT / "sample_bank.json").write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已写入 sample_bank.json：{len(candidates)} 个真实候选，缺口 {len(missing)} 个形态。")
    if missing:
        print("缺口：" + ", ".join(f"{key}={value}" for key, value in missing.items()))


if __name__ == "__main__":
    main()
