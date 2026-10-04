"""Recheck collected real samples without requesting or inventing market bars."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    os.environ["KLINE_CACHE_DIR"] = args.cache
    import server
    from side_training import _indicator_snapshot, _left_score, _right_score
    db = sqlite3.connect(Path(args.cache) / "market-cache.sqlite3")
    candidates = server._load_candidates()
    catalog = server._candidate_catalog()
    events = {}
    for item in candidates:
        if server._is_side_candidate(item):
            events.setdefault(item["eventId"], []).append(item)

    def source(provider, symbol, dates):
        rows = db.execute("SELECT payload FROM cache_entries WHERE source=? AND symbol=? ORDER BY saved_at DESC", (provider, symbol))
        payloads = [json.loads(row[0]) for row in rows]
        for payload in payloads:
            if payload.get("period") == "daily" and payload.get("adjust") == "qfq" and set(dates) <= {bar["date"] for bar in payload.get("bars", [])}:
                return payload
        # Stored daily rows are still actual observations, with the provider's saved unit.
        unit = next((p.get("volumeUnit", "股") for p in payloads if p.get("period") == "daily"), "股")
        keys = ["date", "open", "high", "low", "close", "volume"]
        bars = [dict(zip(keys, row)) for row in db.execute("SELECT date,open,high,low,close,volume FROM daily_bars WHERE provider=? AND symbol=? AND period='daily' AND adjust='qfq' ORDER BY date", (provider, symbol))]
        return {"provider": provider, "bars": bars, "volumeUnit": unit}

    audited, gaps = [], []
    for event, pair in events.items():
        if not all(item.get("reviewStatus") == "approved" for item in pair):
            gaps.append({"event": event, "reason": [item.get("verificationError") for item in pair]})
            continue
        assert server._side_pair_ready(pair), event
        result = {"event": event, "sides": []}
        for candidate in pair:
            combined = candidate["indicatorWarmupBars"] + candidate["bars"]
            dates = [bar["date"] for bar in combined]
            tencent = source("腾讯网页行情", candidate["symbol"], dates)
            bao = source("BaoStock", candidate["symbol"], dates)
            report = server._verify_side_daily(candidate, tencent, bao)
            assert report["status"] == "verified_strict", (event, report)
            anchor = 250 + candidate["decisionAnchorIndex"]
            snapshot = _indicator_snapshot(combined, anchor)
            causal = _indicator_snapshot(combined[:anchor + 1], anchor)
            assert snapshot == causal, (event, "indicator look-ahead")
            pivot = next(i for i, bar in enumerate(combined) if bar["date"] == candidate["pivotDate"])
            scorer = _left_score if candidate["tradeTiming"] == "left" else _right_score
            score = scorer(combined, anchor, pivot, snapshot)
            assert score, (event, "side signal no longer matches")
            result["sides"].append({"key": candidate["key"], "decisionDate": candidate["decisionAnchorDate"],
                "pivotDate": candidate["pivotDate"], "direction": candidate["tradeTiming"], "indicatorSnapshot": snapshot,
                "dailyMatched": report["warmupMatched"] + report["visibleMatched"], "intradayDays": len(candidate["intradayByDate"]),
                "ohlcP99Percent": report["pairs"]["tencentBaoStock"]["ohlcP99Percent"],
                "pricesSha256": hashlib.sha256(json.dumps(combined, sort_keys=True).encode()).hexdigest()})
        audited.append(result)
    assert len(audited) >= 5, "need at least 5 actual paired events"
    # Admission regression uses real records with fields removed, never invented prices.
    example = next(pair for pair in events.values() if all(item.get("reviewStatus") == "approved" for item in pair))
    rejected = []
    for scenario in ["missing_partner", "missing_warmup", "missing_intraday_day", "missing_intraday_bar", "bad_pair_link", "unverified_daily"]:
        pair = copy.deepcopy(example)
        if scenario == "missing_partner":
            pair.pop()
        elif scenario == "missing_warmup":
            pair[0]["indicatorWarmupBars"].pop()
        elif scenario == "missing_intraday_day":
            pair[0]["intradayByDate"].pop(next(iter(pair[0]["intradayByDate"])))
        elif scenario == "missing_intraday_bar":
            next(iter(pair[0]["intradayByDate"].values()))["bars"].pop()
        elif scenario == "bad_pair_link":
            pair[0]["pairedSampleKey"] = "invalid-pair"
        elif scenario == "unverified_daily":
            pair[0]["verificationStatus"] = "pending_secondary"
        assert not server._side_pair_ready(pair), scenario
        rejected.append(scenario)
    output = {"source": "existing locally collected Tencent/BaoStock observations", "synthesizedBars": 0,
              "catalog": catalog["summary"], "auditedPairs": audited, "pendingReasons": gaps,
              "strictAdmissionRejections": rejected}
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"auditedPairs": len(audited), "catalog": catalog["summary"], "report": args.output}, ensure_ascii=False))


if __name__ == "__main__":
    main()
