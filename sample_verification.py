"""Deterministic sample detection and adaptive source verification.

This module contains no network access and never creates synthetic market data.
It is shared by the local service and the verification tests.
"""

from __future__ import annotations

import statistics
from typing import Iterable


CONTEXT_BARS = 40
TRAINING_BARS = 180
WINDOW_BARS = CONTEXT_BARS + TRAINING_BARS
SUPPORTED_PATTERN_IDS = (
    "triple-bottom", "head-shoulders-bottom", "adam-adam-bottom",
    "adam-eve-bottom", "rectangle-bottom", "round-bottom",
)
PATTERN_NAMES = {
    "triple-bottom": "三重底", "head-shoulders-bottom": "头肩底",
    "adam-adam-bottom": "Adam&Adam 双底", "adam-eve-bottom": "Adam&Eve 双底",
    "rectangle-bottom": "矩形底", "round-bottom": "圆底",
}


def _average(values: Iterable[float]) -> float:
    items = list(values)
    return sum(items) / len(items) if items else 0.0


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _sma(values: list[float], period: int, index: int) -> float | None:
    if index < period - 1:
        return None
    segment = values[index - period + 1:index + 1]
    return sum(segment) / period


def _local_lows(segment: list[dict]) -> list[int]:
    lows = [float(bar["low"]) for bar in segment]
    return [
        index for index in range(2, len(lows) - 2)
        if lows[index] <= lows[index - 1] and lows[index] <= lows[index + 1]
        and lows[index] <= lows[index - 2] and lows[index] <= lows[index + 2]
    ]


def _bottom_score(segment: list[dict]) -> tuple[float, float]:
    closes = [float(bar["close"]) for bar in segment]
    trough = min(float(bar["low"]) for bar in segment)
    trough_index = next(index for index, bar in enumerate(segment) if float(bar["low"]) == trough)
    left = _average(closes[:max(8, int(len(segment) * 0.25))])
    right = _average(closes[int(len(segment) * 0.75):])
    decline = _clamp((left - trough) / max(left * 0.18, 0.01))
    recovery = _clamp((right - trough) / max(trough * 0.16, 0.01))
    position = 1.0 if len(segment) * 0.2 < trough_index < len(segment) * 0.8 else 0.45
    early_volume = _average(float(bar["volume"]) for bar in segment[:10])
    middle_volume = _average(float(bar["volume"]) for bar in segment[int(len(segment) * 0.35):int(len(segment) * 0.55)])
    dry_up = _clamp((early_volume - middle_volume) / early_volume / 0.45 + 0.45) if early_volume else 0.5
    ma5 = _sma(closes, 5, len(closes) - 1)
    ma20 = _sma(closes, min(20, len(closes)), len(closes) - 1)
    momentum = 1.0 if ma5 is not None and ma20 is not None and ma5 > ma20 else 0.35
    return 0.28 * decline + 0.28 * recovery + 0.16 * position + 0.14 * dry_up + 0.14 * momentum, trough


def _double_bottom_score(segment: list[dict], lows: list[int]) -> float:
    if len(lows) < 2:
        return 0.0
    left = [index for index in lows if index < len(segment) * 0.55]
    right = [index for index in lows if index > len(segment) * 0.42]
    if not left or not right:
        return 0.0
    first = min(left, key=lambda index: float(segment[index]["low"]))
    second = min(right, key=lambda index: float(segment[index]["low"]))
    if second - first < 7:
        return 0.0
    level = max(float(segment[first]["low"]), float(segment[second]["low"]))
    similarity = 1.0 - _clamp(abs(float(segment[first]["low"]) - float(segment[second]["low"])) / max(level * 0.08, 0.01))
    neckline = max(float(bar["high"]) for bar in segment[first:second + 1])
    breakout = _clamp((float(segment[-1]["close"]) / max(neckline, 0.01) - 0.96) / 0.08)
    return 0.55 * similarity + 0.45 * breakout


def _triple_bottom_score(segment: list[dict], lows: list[int]) -> float:
    if len(lows) < 3:
        return 0.0
    thirds = (
        [index for index in lows if index < len(segment) / 3],
        [index for index in lows if len(segment) / 3 <= index < len(segment) * 2 / 3],
        [index for index in lows if index >= len(segment) * 2 / 3],
    )
    if any(not part for part in thirds):
        return 0.0
    chosen = [min(part, key=lambda index: float(segment[index]["low"])) for part in thirds]
    prices = [float(segment[index]["low"]) for index in chosen]
    average_low = _average(prices)
    similarity = 1.0 - _clamp(max(abs(price - average_low) for price in prices) / max(average_low * 0.09, 0.01))
    neckline = max(float(bar["high"]) for bar in segment[chosen[0]:chosen[2] + 1])
    breakout = _clamp((float(segment[-1]["close"]) / max(neckline, 0.01) - 0.95) / 0.1)
    return 0.6 * similarity + 0.4 * breakout


def _round_bottom_score(segment: list[dict]) -> float:
    prices = [float(bar["close"]) for bar in segment]
    center = min(prices[int(len(prices) * 0.35):int(len(prices) * 0.65)])
    left = _average(prices[:10])
    right = _average(prices[-10:])
    smooth = 1.0 - _clamp(_average(abs(price - prices[index]) for index, price in enumerate(prices[1:])) / max(_average(prices) * 0.035, 0.01))
    return 0.45 * _clamp((left - center) / max(left * 0.14, 0.01)) + 0.4 * _clamp((right - center) / max(center * 0.14, 0.01)) + 0.15 * smooth


def _rectangle_bottom_score(segment: list[dict]) -> float:
    zone = segment[int(len(segment) * 0.35):int(len(segment) * 0.8)]
    low = min(float(bar["low"]) for bar in zone)
    high = max(float(bar["high"]) for bar in zone)
    width = (high - low) / max(low, 0.01)
    breakout = _clamp((float(segment[-1]["close"]) / max(high, 0.01) - 0.98) / 0.08)
    return 0.55 * _clamp((0.24 - width) / 0.24) + 0.45 * breakout


def classify_window(window: list[dict]) -> dict:
    if len(window) != WINDOW_BARS:
        return {"ok": False, "reason": f"样本窗口需要{WINDOW_BARS}根，实际{len(window)}根"}
    segment = window[-TRAINING_BARS:]
    bottom, trough = _bottom_score(segment)
    lows = _local_lows(segment)
    scores = {
        "triple-bottom": _triple_bottom_score(segment, lows),
        "head-shoulders-bottom": _triple_bottom_score(segment, lows) * 0.9,
        "adam-adam-bottom": _double_bottom_score(segment, lows),
        "adam-eve-bottom": _double_bottom_score(segment, lows) * 0.96,
        "rectangle-bottom": _rectangle_bottom_score(segment),
        "round-bottom": _round_bottom_score(segment),
    }
    pattern_id, pattern_score = max(scores.items(), key=lambda item: item[1])
    confidence = _clamp(bottom * 0.56 + pattern_score * 0.44)
    return {
        "ok": bottom >= 0.58 and pattern_score >= 0.55,
        "patternId": pattern_id, "patternName": PATTERN_NAMES[pattern_id],
        "confidence": round(confidence, 3), "bottomScore": round(bottom, 3),
        "patternScore": round(pattern_score, 3), "trough": round(trough, 6),
    }


def detect_candidate_windows(bars: list[dict], symbol: str, provider: str) -> list[dict]:
    candidates: dict[str, dict] = {}
    for end in range(WINDOW_BARS - 1, len(bars), 5):
        window = bars[end - WINDOW_BARS + 1:end + 1]
        result = classify_window(window)
        if not result.get("ok"):
            continue
        pattern_id = result["patternId"]
        candidate = {
            "key": f"{symbol}|{window[CONTEXT_BARS]['date']}|{window[-1]['date']}|{pattern_id}",
            "symbol": symbol, "patternId": pattern_id, "patternName": result["patternName"],
            "contextStartDate": window[0]["date"], "startDate": window[CONTEXT_BARS]["date"],
            "endDate": window[-1]["date"], "confidence": result["confidence"],
            "bottomScore": result["bottomScore"], "patternScore": result["patternScore"],
            "provider": provider, "adjust": "unknown", "period": "daily",
            "snapshot": True, "bars": [dict(bar) for bar in window],
            "contextStartIndex": 0, "trainingStartIndex": CONTEXT_BARS,
            "trainingEndIndex": WINDOW_BARS - 1, "startIndex": CONTEXT_BARS,
            "endIndex": WINDOW_BARS - 1, "dataSource": "real",
            "verificationStatus": "prefiltered", "reviewStatus": "blocked",
            "status": "腾讯主数据扫描命中 · 等待BaoStock复核",
        }
        previous = candidates.get(pattern_id)
        if previous is None or candidate["confidence"] > previous["confidence"]:
            candidates[pattern_id] = candidate
    return sorted(candidates.values(), key=lambda item: item["confidence"], reverse=True)


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = (len(ordered) - 1) * fraction
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    weight = index - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _volume_multiplier(unit: str) -> float:
    normalized = str(unit or "股").strip().lower()
    if normalized in {"手", "lot", "lots"}:
        return 100.0
    if normalized in {"万股", "万份"}:
        return 10000.0
    return 1.0


def structural_report(payload: dict, expected_dates: list[str]) -> dict:
    bars = payload.get("bars") if isinstance(payload, dict) else []
    by_date = {str(bar.get("date")): bar for bar in bars or []}
    invalid = []
    for date, bar in by_date.items():
        try:
            opening, high, low, close, volume = (float(bar[field]) for field in ("open", "high", "low", "close", "volume"))
            if min(opening, high, low, close) <= 0 or volume < 0 or low > min(opening, close) or high < max(opening, close):
                invalid.append(date)
        except (KeyError, TypeError, ValueError):
            invalid.append(date)
    missing = [date for date in expected_dates if date not in by_date]
    return {
        "ok": not invalid and not missing and len(expected_dates) == WINDOW_BARS,
        "barCount": len(bars or []), "matched": WINDOW_BARS - len(missing),
        "missingDates": missing[:10], "invalidDates": invalid[:10],
    }


def pair_report(primary: dict, secondary: dict, expected_dates: list[str]) -> dict:
    first = {str(bar.get("date")): bar for bar in primary.get("bars", [])}
    second = {str(bar.get("date")): bar for bar in secondary.get("bars", [])}
    common = [date for date in expected_dates if date in first and date in second]
    missing = [date for date in expected_dates if date not in first or date not in second]
    invalid_value_dates: list[str] = []
    ratios = []
    for date in common:
        try:
            left_close = float(first[date]["close"])
            right_close = float(second[date]["close"])
            if right_close > 0:
                ratios.append(left_close / right_close)
        except (KeyError, TypeError, ValueError):
            invalid_value_dates.append(date)
    scale = statistics.median(ratios) if ratios else 1.0
    volume_a = _volume_multiplier(primary.get("volumeUnit", "股"))
    volume_b = _volume_multiplier(secondary.get("volumeUnit", "股"))
    ohlc_diffs: list[float] = []
    volume_diffs: list[float] = []
    return_diffs: list[float] = []
    date_price_diffs: dict[str, float] = {}
    previous = None
    for date in common:
        left, right = first[date], second[date]
        day_max = 0.0
        try:
            for field in ("open", "high", "low", "close"):
                a, b = float(left[field]), float(right[field]) * scale
                diff = abs(a - b) / max(abs(a), abs(b), 1e-9)
                day_max = max(day_max, diff)
                ohlc_diffs.append(diff)
            a_volume = float(left["volume"]) * volume_a
            b_volume = float(right["volume"]) * volume_b
        except (KeyError, TypeError, ValueError):
            invalid_value_dates.append(date)
            continue
        date_price_diffs[date] = day_max
        volume_diffs.append(abs(a_volume - b_volume) / max(abs(a_volume), abs(b_volume), 1.0))
        if previous:
            try:
                left_return = float(left["close"]) / float(first[previous]["close"]) - 1.0
                right_return = float(right["close"]) / float(second[previous]["close"]) - 1.0
                return_diffs.append(abs(left_return - right_return))
            except (KeyError, TypeError, ValueError, ZeroDivisionError):
                invalid_value_dates.append(date)
        previous = date
    price_anomalies = [date for date in common if date_price_diffs.get(date, 0.0) > 0.005]
    max_consecutive = 0
    current = 0
    for date in common:
        if date in price_anomalies:
            current += 1
            max_consecutive = max(max_consecutive, current)
        else:
            current = 0
    report = {
        "primary": primary.get("provider"), "secondary": secondary.get("provider"),
        "matched": len(common), "missingCount": len(missing), "missingDates": missing[:10],
        "invalidValueCount": len(set(invalid_value_dates)), "invalidValueDates": sorted(set(invalid_value_dates))[:10],
        "priceScale": round(scale, 8),
        "ohlcP95Percent": round(_percentile(ohlc_diffs, 0.95) * 100, 4),
        "ohlcP99Percent": round(_percentile(ohlc_diffs, 0.99) * 100, 4),
        "maxOhlcPercent": round(max(ohlc_diffs, default=0.0) * 100, 4),
        "returnP99Points": round(_percentile(return_diffs, 0.99) * 100, 4),
        "volumeMedianPercent": round(_percentile(volume_diffs, 0.5) * 100, 4),
        "volumeP95Percent": round(_percentile(volume_diffs, 0.95) * 100, 4),
        "priceAnomalyDates": price_anomalies[:10], "maxConsecutivePriceAnomalies": max_consecutive,
    }
    report["strict"] = (
        len(common) == WINDOW_BARS and not invalid_value_dates
        and report["ohlcP99Percent"] <= 1.2 and report["maxOhlcPercent"] <= 1.5
        and report["returnP99Points"] <= 0.30
        and report["volumeMedianPercent"] <= 1.0 and report["volumeP95Percent"] <= 3.0
    )
    report["warningEligible"] = (
        len(common) >= 217 and not invalid_value_dates and report["ohlcP95Percent"] <= 0.5
        and report["maxOhlcPercent"] <= 2.0 and len(price_anomalies) <= 3
        and max_consecutive <= 1 and report["volumeP95Percent"] <= 10.0
    )
    return report


def _aligned_window(payload: dict, expected_dates: list[str]) -> list[dict]:
    by_date = {str(bar.get("date")): bar for bar in payload.get("bars", [])}
    return [dict(by_date[date]) for date in expected_dates if date in by_date]


def verify_three_sources(candidate: dict, sina: dict, tencent: dict, baostock: dict) -> dict:
    expected_dates = [str(bar["date"]) for bar in candidate.get("bars", [])]
    structures = {
        "sina": structural_report(sina, expected_dates),
        "tencent": structural_report(tencent, expected_dates),
        "baostock": structural_report(baostock, expected_dates),
    }
    pairs = {
        "sinaTencent": pair_report(sina, tencent, expected_dates),
        "sinaBaoStock": pair_report(sina, baostock, expected_dates),
        "tencentBaoStock": pair_report(tencent, baostock, expected_dates),
    }
    shapes = {}
    for source_id, payload in (("sina", sina), ("tencent", tencent), ("baostock", baostock)):
        aligned = _aligned_window(payload, expected_dates)
        shape = classify_window(aligned)
        shape["targetMatched"] = bool(shape.get("ok") and shape.get("patternId") == candidate.get("patternId"))
        shapes[source_id] = shape
    strict = all(item["ok"] for item in structures.values()) and all(item["strict"] for item in pairs.values()) and all(item["targetMatched"] for item in shapes.values())
    bao_matches_sina = pairs["sinaBaoStock"]["strict"] and shapes["sina"]["targetMatched"]
    bao_matches_tencent = pairs["tencentBaoStock"]["strict"] and shapes["tencent"]["targetMatched"]
    warning = (
        not strict and structures["baostock"]["matched"] >= 217 and shapes["baostock"]["targetMatched"]
        and (bao_matches_sina or bao_matches_tencent)
        and all(item["warningEligible"] for item in pairs.values())
    )
    status = "verified_strict" if strict else "verified_warning" if warning else "rejected"
    reasons = []
    if status == "rejected":
        if not shapes["baostock"]["targetMatched"]:
            reasons.append("BaoStock未复现目标形态")
        if not (bao_matches_sina or bao_matches_tencent):
            reasons.append("BaoStock与腾讯、新浪均未严格吻合")
        if min(item["matched"] for item in structures.values()) < 217:
            reasons.append("共同日期不足217根")
    return {
        "status": status, "structures": structures, "pairs": pairs, "shapes": shapes,
        "providers": ["sina", "tencent", "baostock"],
        "reason": "；".join(reasons) or ("三源严格一致" if strict else "存在孤立差异，需人工确认"),
        "canonicalBars": _aligned_window(baostock, expected_dates),
    }


def verify_two_sources(candidate: dict, tencent: dict, baostock: dict) -> dict:
    """Verify a Tencent primary candidate against BaoStock.

    Sina's public daily endpoint does not declare a qfq reference basis, so it
    is intentionally excluded from the approval gate.  It remains available
    to the caller as a diagnostic source when this pair disagrees.
    """
    expected_dates = [str(bar["date"]) for bar in candidate.get("bars", [])]
    structures = {
        "tencent": structural_report(tencent, expected_dates),
        "baostock": structural_report(baostock, expected_dates),
    }
    pair = pair_report(tencent, baostock, expected_dates)
    shapes = {}
    for source_id, payload in (("tencent", tencent), ("baostock", baostock)):
        aligned = _aligned_window(payload, expected_dates)
        shape = classify_window(aligned)
        shape["targetMatched"] = bool(shape.get("ok") and shape.get("patternId") == candidate.get("patternId"))
        shapes[source_id] = shape

    strict = (
        all(item["ok"] for item in structures.values())
        and pair["strict"]
        and all(item["targetMatched"] for item in shapes.values())
    )
    warning = (
        not strict
        and structures["baostock"]["matched"] >= 217
        and shapes["baostock"]["targetMatched"]
        and pair["warningEligible"]
    )
    status = "verified_strict" if strict else "verified_warning" if warning else "rejected"
    reasons = []
    if not shapes["baostock"]["targetMatched"]:
        reasons.append("BaoStock未复现目标形态")
    if not pair["strict"] and not warning:
        reasons.append("腾讯与BaoStock未通过动态双源校验")
    if min(item["matched"] for item in structures.values()) < 217:
        reasons.append("共同日期不足217根")
    return {
        "status": status,
        "verificationMode": "dual",
        "structures": structures,
        "pairs": {"tencentBaoStock": pair},
        "shapes": shapes,
        "providers": ["tencent", "baostock"],
        "reason": "；".join(reasons) or ("腾讯与BaoStock双源严格一致" if strict else "存在可解释差异，需人工确认"),
        "canonicalBars": _aligned_window(tencent, expected_dates),
    }
