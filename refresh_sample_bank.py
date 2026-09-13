"""Refresh the reviewed-candidate source bank with real Eastmoney data.

This is deliberately an all-or-nothing refresh.  The existing bank is never
overwritten unless every selected code can be fetched and every selected
pattern has two complete 40+180 bar snapshots.  No fallback or synthetic bar
is allowed here.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "sample_bank.json"
REPORT = ROOT / "sample_bank_refresh_report.json"
USER_AGENT = "Mozilla/5.0 KLineTrainingSampleRefresh/1.0"
UT = "fa5fd1943c7b386f172d6893dbbd1b5b"
CONTEXT_BARS = 40
TRAINING_BARS = 180
TARGET_PER_PATTERN = 2
UPSTREAMS = (
    "https://7.push2his.eastmoney.com/api/qt/stock/kline/get",
    "https://push2his.eastmoney.com/api/qt/stock/kline/get",
)


def secid(code: str) -> str:
    return f"1.{code}" if code.startswith(("5", "6")) else f"0.{code}"


def get_json(url: str, attempts: int = 4) -> dict:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Referer": "https://quote.eastmoney.com/",
                    "Accept": "application/json,text/plain,*/*",
                    "Connection": "close",
                },
            )
            with urlopen(request, timeout=25) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(str(last_error))


def fetch_bars(code: str) -> tuple[list[dict], str]:
    params = {
        "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "beg": 0,
        "end": 20500101,
        "klt": 101,
        "fqt": 1,
        "secid": secid(code),
        "lmt": 2000,
        "rtntype": 6,
        "ut": UT,
    }
    errors = []
    for upstream in UPSTREAMS:
        try:
            payload = get_json(f"{upstream}?{urlencode(params)}")
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
                if min(values[:4]) <= 0 or values[4] < 0:
                    continue
                if values[2] > min(values[0], values[3]) or values[1] < max(values[0], values[3]):
                    continue
                seen.add(date)
                bars.append({"date": date, "open": values[0], "high": values[1], "low": values[2], "close": values[3], "volume": values[4]})
            bars.sort(key=lambda item: item["date"])
            if len(bars) < CONTEXT_BARS + TRAINING_BARS:
                raise RuntimeError(f"有效日线只有 {len(bars)} 根，不足 {CONTEXT_BARS + TRAINING_BARS} 根")
            return bars, str(data.get("name") or "")
        except Exception as exc:
            errors.append(f"{upstream}: {exc}")
    raise RuntimeError("；".join(errors))


def choose_samples(samples: list[dict]) -> list[dict]:
    chosen = []
    for pattern_id in sorted({sample["patternId"] for sample in samples}):
        pool = sorted(
            (sample for sample in samples if sample["patternId"] == pattern_id),
            key=lambda item: (float(item.get("confidence") or 0), item.get("endDate", "")),
            reverse=True,
        )
        used = set()
        for sample in pool:
            identity = (sample.get("code"), sample.get("endDate"))
            if identity in used:
                continue
            chosen.append(sample)
            used.add(identity)
            if len(used) == TARGET_PER_PATTERN:
                break
        if len(used) < TARGET_PER_PATTERN:
            raise RuntimeError(f"形态 {pattern_id} 原始候选不足 {TARGET_PER_PATTERN} 个")
    return chosen


def rebuild(source: dict, selected: list[dict], fetched: dict[str, tuple[list[dict], str]]) -> dict:
    refreshed = []
    failures = []
    for old in selected:
        code = str(old["code"])
        bars, fetched_name = fetched[code]
        end_date = str(old["endDate"])
        end_index = next((index for index, bar in enumerate(bars) if bar["date"] == end_date), None)
        if end_index is None or end_index < CONTEXT_BARS + TRAINING_BARS - 1:
            failures.append({"key": old.get("key"), "code": code, "reason": f"找不到足够历史数据结束日 {end_date}"})
            continue
        training_start = end_index - TRAINING_BARS + 1
        context_start = training_start - CONTEXT_BARS
        snapshot = bars[context_start : end_index + 1]
        if len(snapshot) != CONTEXT_BARS + TRAINING_BARS:
            failures.append({"key": old.get("key"), "code": code, "reason": "截取结果不是 220 根"})
            continue
        start_date = snapshot[CONTEXT_BARS]["date"]
        refreshed.append({
            **old,
            "key": f"{code}|{start_date}|{end_date}|{old['patternId']}",
            "symbol": f"{fetched_name} ({code})" if fetched_name else str(old.get("symbol") or code),
            "startDate": start_date,
            "endDate": end_date,
            "startIndex": CONTEXT_BARS,
            "endIndex": CONTEXT_BARS + TRAINING_BARS - 1,
            "contextBars": CONTEXT_BARS,
            "trainingBars": TRAINING_BARS,
            "trainingStartIndex": CONTEXT_BARS,
            "trainingEndIndex": CONTEXT_BARS + TRAINING_BARS - 1,
            "provider": "东方财富",
            "dataSource": "real",
            "adjust": "qfq",
            "period": "daily",
            "ruleVersion": "real-eastmoney-qfq-v1-context40-training180-pending-review",
            "reviewStatus": "pending",
            "status": "待审核",
            "autoEligible": False,
            "snapshot": True,
            "bars": snapshot,
        })
    if failures:
        raise RuntimeError(json.dumps(failures, ensure_ascii=False))
    pattern_ids = sorted({item["patternId"] for item in refreshed})
    counts = {pattern_id: sum(item["patternId"] == pattern_id for item in refreshed) for pattern_id in pattern_ids}
    return {
        "format": "kline-training-real-sample-bank",
        "version": 3,
        "provider": "东方财富",
        "adjust": "qfq",
        "period": "daily",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "reviewPolicy": "全部候选待人工审核；启发式评分不等同于概率，不自动入库。",
        "targetPerPattern": TARGET_PER_PATTERN,
        "contextBars": CONTEXT_BARS,
        "trainingBars": TRAINING_BARS,
        "patternCount": len(pattern_ids),
        "sampleCount": len(refreshed),
        "counts": counts,
        "missing": {key: count for key, count in counts.items() if count < TARGET_PER_PATTERN},
        "sourceVersion": source.get("version"),
        "samples": sorted(refreshed, key=lambda item: (item["patternId"], item["code"], item["endDate"])),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=SOURCE)
    args = parser.parse_args()
    source = json.loads(args.source.read_text(encoding="utf-8"))
    selected = choose_samples(source.get("samples") or [])
    codes = sorted({str(sample["code"]) for sample in selected})
    fetched = {}
    report = {"startedAt": datetime.now(timezone.utc).isoformat(), "codes": codes, "selected": len(selected), "failures": []}
    for index, code in enumerate(codes, 1):
        print(f"[{index}/{len(codes)}] 获取东方财富 {code} 前复权日线…", flush=True)
        try:
            fetched[code] = fetch_bars(code)
            print(f"[{index}/{len(codes)}] {code} 成功：{len(fetched[code][0])} 根", flush=True)
        except Exception as exc:
            report["failures"].append({"code": code, "error": str(exc)})
    if report["failures"]:
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        raise SystemExit("东方财富数据未完整获取，未覆盖 sample_bank.json；详见 sample_bank_refresh_report.json")
    try:
        output = rebuild(source, selected, fetched)
    except Exception as exc:
        report["failures"].append({"stage": "rebuild", "error": str(exc)})
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        raise SystemExit("样本重建失败，未覆盖 sample_bank.json；详见 sample_bank_refresh_report.json")
    backup = ROOT / f"sample_bank.backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    shutil.copy2(args.source, backup)
    args.source.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    report.update({"finishedAt": datetime.now(timezone.utc).isoformat(), "success": True, "sampleCount": len(output["samples"]), "backup": backup.name})
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已更新 sample_bank.json：{len(output['samples'])} 个样本，{len(codes)} 个代码，全部待审核。", flush=True)


if __name__ == "__main__":
    main()
