"""Paired left/right training-sample detection.

The existing pattern detector remains in ``sample_verification.py`` for the
later pattern-training phase.  This module is the active v1 detector for
indicator training: it finds a historical swing-low event and emits a linked
left-side sample plus a right-side sample around that event.
"""

from __future__ import annotations

from typing import Iterable


CONTEXT_BARS = 40
TRAINING_BARS = 180
WINDOW_BARS = CONTEXT_BARS + TRAINING_BARS
INDICATOR_WARMUP_BARS = 250
DECISION_TRAINING_OFFSET = 90
DECISION_INDEX = CONTEXT_BARS + DECISION_TRAINING_OFFSET
PIVOT_LEFT = 20
PIVOT_RIGHT = 20
LEFT_SCAN_MIN = 5
LEFT_SCAN_MAX = 30
RIGHT_SCAN_MIN = 5
RIGHT_SCAN_MAX = 60
LEFT_QUOTA = 10
RIGHT_QUOTA = 10
SIDE_RULE_VERSION = "side-paired-v1"


def _average(values: Iterable[float]) -> float:
    items = list(values)
    return sum(items) / len(items) if items else 0.0


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _values(bars: list[dict], field: str) -> list[float]:
    return [float(bar.get(field) or 0) for bar in bars]


def _sma(values: list[float], period: int, index: int) -> float | None:
    if index < period - 1:
        return None
    return _average(values[index - period + 1:index + 1])


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    result = [values[0]]
    for value in values[1:]:
        result.append((value - result[-1]) * alpha + result[-1])
    return result


def _indicator_snapshot(bars: list[dict], index: int) -> dict:
    closes = _values(bars, "close")
    volumes = _values(bars, "volume")
    fast = _ema(closes, 12)
    slow = _ema(closes, 26)
    dif = [fast[pos] - slow[pos] for pos in range(len(closes))]
    dea = _ema(dif, 9)
    hist = [(dif[pos] - dea[pos]) * 2 for pos in range(len(closes))]
    ma5 = _sma(closes, 5, index)
    ma20 = _sma(closes, 20, index)
    ma60 = _sma(closes, 60, index)
    ma20_prev = _sma(closes, 20, index - 10) if index >= 30 else None
    vol5 = _sma(volumes, 5, index)
    vol120 = _sma(volumes, 120, index)
    vol250 = _sma(volumes, 250, index)

    k = d = 50.0
    ks: list[float] = []
    ds: list[float] = []
    for pos, bar in enumerate(bars):
        start = max(0, pos - 8)
        window_high = max(_values(bars[start:pos + 1], "high"))
        window_low = min(_values(bars[start:pos + 1], "low"))
        rsv = 50.0 if window_high == window_low else (float(bar["close"]) - window_low) / (window_high - window_low) * 100
        k = (2 * k + rsv) / 3
        d = (2 * d + k) / 3
        ks.append(k)
        ds.append(d)

    return {
        "close": closes[index], "ma5": ma5, "ma20": ma20, "ma60": ma60,
        "ma20Slope": None if ma20 is None or ma20_prev in (None, 0) else ma20 / ma20_prev - 1,
        "dif": dif[index], "dea": dea[index], "hist": hist[index],
        "histImproving": len(hist) >= 5 and hist[index] > hist[index - 3],
        "k": ks[index], "d": ds[index],
        "kdjGoldenBelow50": index >= 1 and ks[index] > ds[index] and ks[index - 1] <= ds[index - 1] and ks[index] < 50,
        "vol5": vol5, "vol120": vol120, "vol250": vol250,
    }


def _window_score(value: float, low: float, high: float) -> float:
    if high <= low:
        return 0.0
    return _clamp((value - low) / (high - low))


def _left_score(bars: list[dict], index: int, pivot_index: int, snap: dict | None = None) -> dict | None:
    snap = snap or _indicator_snapshot(bars, index)
    if snap["ma60"] is None or snap["ma20"] is None or snap["vol120"] is None:
        return None
    lookback = bars[max(0, index - 120):index + 1]
    highs = _values(lookback, "high")
    lows = _values(lookback, "low")
    peak = max(highs)
    floor = min(lows)
    close = snap["close"]
    drawdown = 1 - close / max(peak, 0.01)
    low_distance = close / max(floor, 0.01) - 1
    prior20 = _values(bars[max(0, index - 20):index], "high")
    broke_high = bool(prior20) and close > max(prior20) * 1.02
    weak_trend = (snap["ma60"] - close) / max(snap["ma60"], 0.01)
    turn = 1.0 if snap["histImproving"] or snap["kdjGoldenBelow50"] else 0.25
    no_confirmation = 0.0 if broke_high else _clamp(1 - max(0.0, close / max(snap["ma20"], 0.01) - 1) / 0.06)
    score = (
        0.25 * _window_score(drawdown, 0.12, 0.35)
        + 0.20 * _window_score(0.10 - low_distance, 0.0, 0.10)
        + 0.20 * _window_score(weak_trend, -0.02, 0.18)
        + 0.20 * turn
        + 0.15 * no_confirmation
    )
    if pivot_index - index < LEFT_SCAN_MIN or pivot_index - index > LEFT_SCAN_MAX:
        return None
    if drawdown < 0.12 or low_distance > 0.10 or close > snap["ma60"] * 1.03 or broke_high or score < 0.72:
        return None
    return {
        "score": round(score, 3),
        "signals": {
            "drawdown": round(drawdown, 4), "lowDistance": round(low_distance, 4),
            "ma20": round(snap["ma20"], 6), "ma60": round(snap["ma60"], 6),
            "macdHist": round(snap["hist"], 6), "kdj": round(snap["k"], 2),
            "volumeRatio": round(snap["vol5"] / snap["vol120"], 4) if snap["vol5"] and snap["vol120"] else None,
            "summary": "下跌后接近阶段低位，趋势尚未确认，动能出现早期改善",
        },
    }


def _right_score(bars: list[dict], index: int, pivot_index: int, snap: dict | None = None) -> dict | None:
    snap = snap or _indicator_snapshot(bars, index)
    if any(snap[key] is None for key in ("ma5", "ma20", "ma60", "vol120", "ma20Slope")):
        return None
    post_low = min(_values(bars[pivot_index:index + 1], "low"))
    pivot_low = float(bars[pivot_index]["low"])
    rebound = snap["close"] / max(pivot_low, 0.01) - 1
    prior120 = _values(bars[max(0, pivot_index - 120):pivot_index], "high")
    # Use prior closes for the confirmation test. Requiring the current close
    # to exceed every previous intraday wick makes valid daily breakouts too
    # scarce, especially on long-upper-shadow sessions.
    prior20 = _values(bars[max(0, index - 20):index], "close")
    prior_peak = max(prior120) if prior120 else pivot_low
    prior_drawdown = 1 - pivot_low / max(prior_peak, 0.01)
    breakout = bool(prior20) and snap["close"] > max(prior20)
    trend = 1.0 if snap["close"] > snap["ma20"] and snap["close"] > snap["ma60"] and snap["ma5"] > snap["ma20"] else 0.0
    momentum = 1.0 if snap["dif"] > snap["dea"] and snap["hist"] > 0 else 0.25
    volume_ratio = snap["vol5"] / snap["vol120"] if snap["vol5"] and snap["vol120"] else 0.0
    volume = _clamp((volume_ratio - 1.05) / 0.75)
    extension = _clamp(1 - max(0.0, snap["close"] / max(snap["ma20"], 0.01) - 1) / 0.12)
    score = (
        0.25 * _window_score(rebound, 0.08, 0.35)
        + 0.25 * trend
        + 0.20 * (1.0 if breakout else 0.0)
        + 0.15 * momentum
        + 0.15 * ((volume + extension) / 2)
    )
    if index - pivot_index < RIGHT_SCAN_MIN or index - pivot_index > RIGHT_SCAN_MAX:
        return None
    if (post_low < pivot_low or prior_drawdown < 0.12 or rebound < 0.08 or not breakout
            or trend < 1 or snap["ma20Slope"] <= 0 or momentum < 1
            or volume_ratio < 1.05 or extension <= 0 or score < 0.75):
        return None
    return {
        "score": round(score, 3),
        "signals": {
            "rebound": round(rebound, 4), "priorDrawdown": round(prior_drawdown, 4),
            "ma20": round(snap["ma20"], 6), "ma60": round(snap["ma60"], 6),
            "macdHist": round(snap["hist"], 6), "volumeRatio": round(volume_ratio, 4),
            "summary": "阶段低点后站上均线并突破前高，趋势和量能已确认",
        },
    }


def _date(bar: dict) -> str:
    return str(bar.get("date", ""))[:10]


def _event_id(symbol: str, pivot: dict) -> str:
    return f"{symbol}|{_date(pivot)}"


def _build_sample(bars: list[dict], symbol: str, provider: str, pivot_index: int, anchor_index: int, side: str, score: dict, event_id: str) -> dict | None:
    visible_start = anchor_index - DECISION_INDEX
    visible_end = visible_start + WINDOW_BARS
    warmup_start = visible_start - INDICATOR_WARMUP_BARS
    if warmup_start < 0 or visible_end > len(bars):
        return None
    visible = [dict(bar) for bar in bars[visible_start:visible_end]]
    warmup = [dict(bar) for bar in bars[warmup_start:visible_start]]
    pivot_phase = "before-low" if anchor_index < pivot_index else "after-low"
    sample_id = f"{event_id}|{side}"
    return {
        "key": sample_id,
        "sampleType": "side-training", "sampleSchemaVersion": 1,
        "sideRuleVersion": SIDE_RULE_VERSION, "eventId": event_id,
        "tradeTiming": side, "pivotPhase": pivot_phase,
        "pivotDate": _date(bars[pivot_index]), "decisionAnchorDate": _date(bars[anchor_index]),
        "decisionAnchorIndex": CONTEXT_BARS + DECISION_TRAINING_OFFSET,
        "pairedSampleKey": f"{event_id}|{'right' if side == 'left' else 'left'}",
        "symbol": symbol, "patternId": f"side-{side}",
        "patternName": "左侧训练片段" if side == "left" else "右侧训练片段",
        "contextStartDate": _date(visible[0]), "startDate": _date(visible[CONTEXT_BARS]),
        "endDate": _date(visible[-1]), "confidence": score["score"],
        "sideScore": score["score"], "sideSignals": score["signals"],
        "provider": provider, "adjust": "qfq", "period": "daily",
        "snapshot": True, "bars": visible, "indicatorWarmupBars": warmup,
        "contextStartIndex": 0, "trainingStartIndex": CONTEXT_BARS,
        "trainingEndIndex": WINDOW_BARS - 1, "startIndex": CONTEXT_BARS,
        "endIndex": WINDOW_BARS - 1, "dataSource": "real",
        "verificationStatus": "prefiltered", "reviewStatus": "blocked",
        "status": "左右侧候选 · 等待数据复核", "autoEligible": True,
    }


def detect_side_pairs(bars: list[dict], symbol: str, provider: str) -> list[dict]:
    """Return the best paired left/right samples per historical swing-low event."""
    if len(bars) < INDICATOR_WARMUP_BARS + WINDOW_BARS + PIVOT_LEFT + PIVOT_RIGHT:
        return []
    lows = _values(bars, "low")
    candidates: list[dict] = []
    snapshots: dict[int, dict] = {}
    def snapshot(index: int) -> dict:
        if index not in snapshots:
            snapshots[index] = _indicator_snapshot(bars, index)
        return snapshots[index]

    # Require only the earliest possible left anchor and latest possible right
    # anchor to fit. Individual anchors are checked by _build_sample below.
    start = INDICATOR_WARMUP_BARS + DECISION_INDEX + LEFT_SCAN_MIN
    end = min(len(bars) - PIVOT_RIGHT, len(bars) - (WINDOW_BARS - DECISION_INDEX) - RIGHT_SCAN_MIN + 1)
    for pivot_index in range(max(PIVOT_LEFT, start), max(PIVOT_LEFT, end)):
        pivot_low = lows[pivot_index]
        local = lows[pivot_index - PIVOT_LEFT:pivot_index + PIVOT_RIGHT + 1]
        if pivot_low != min(local):
            continue
        prior = _values(bars[max(0, pivot_index - 120):pivot_index], "high")
        if not prior:
            continue
        prior_peak = max(prior)
        post = _values(bars[pivot_index:pivot_index + RIGHT_SCAN_MAX + 1], "close")
        if 1 - pivot_low / max(prior_peak, 0.01) < 0.15 or max(post, default=0) / max(pivot_low, 0.01) - 1 < 0.10:
            continue
        left_options = []
        for index in range(pivot_index - LEFT_SCAN_MAX, pivot_index - LEFT_SCAN_MIN + 1):
            if index - DECISION_INDEX - INDICATOR_WARMUP_BARS < 0:
                continue
            result = _left_score(bars, index, pivot_index, snapshot(index))
            if result and _build_sample(bars, symbol, provider, pivot_index, index, "left", result, _event_id(symbol, bars[pivot_index])):
                left_options.append((result["score"], index, result))
        right_options = []
        latest_anchor = min(pivot_index + RIGHT_SCAN_MAX, len(bars) - (WINDOW_BARS - DECISION_INDEX))
        for index in range(pivot_index + RIGHT_SCAN_MIN, latest_anchor + 1):
            result = _right_score(bars, index, pivot_index, snapshot(index))
            if result and _build_sample(bars, symbol, provider, pivot_index, index, "right", result, _event_id(symbol, bars[pivot_index])):
                right_options.append((result["score"], index, result))
        if not left_options or not right_options:
            continue
        _, left_index, left_result = max(left_options)
        _, right_index, right_result = max(right_options)
        event_id = _event_id(symbol, bars[pivot_index])
        left = _build_sample(bars, symbol, provider, pivot_index, left_index, "left", left_result, event_id)
        right = _build_sample(bars, symbol, provider, pivot_index, right_index, "right", right_result, event_id)
        if left and right:
            candidates.extend([left, right])
    return candidates
