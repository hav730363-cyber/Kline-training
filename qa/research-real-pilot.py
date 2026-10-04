"""Small live provider check; never starts a full-market collection."""

import json
import re
import sys
import tempfile
import threading
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import baostock as bs
from research_validation import ResearchEngine, build_events, period_dates


def current_instruments():
    login = bs.login()
    if login.error_code != "0":
        raise RuntimeError(login.error_msg)
    try:
        for offset in range(8):
            query = bs.query_all_stock(day=(date.today() - timedelta(days=offset)).isoformat())
            if query.error_code != "0":
                continue
            result = []
            while query.next():
                row = query.get_row_data()
                code, name = row[0], row[2]
                if row[1] != "1" or re.search(r"ST|退", name.upper()):
                    continue
                if re.fullmatch(r"sh\.6\d{5}|sz\.[03]\d{5}", code):
                    result.append({"symbol": code[-6:], "baostockCode": code, "name": name, "kind": "stock"})
                elif re.fullmatch(r"(?:sh|sz)\.(?:5|15|16|18)\d{3,5}", code):
                    result.append({"symbol": code[-6:], "baostockCode": code, "name": name, "kind": "etf"})
            if result:
                stocks = [item for item in result if item["kind"] == "stock"][:3]
                etfs = [item for item in result if item["kind"] == "etf"][:2]
                return stocks + etfs
    finally:
        bs.logout()
    raise RuntimeError("最近证券名单不可用")


def main():
    instruments = current_instruments()
    dates = period_dates()
    results = []
    with tempfile.TemporaryDirectory() as directory:
        engine = ResearchEngine(Path(directory), lambda: {"instruments": instruments}, threading.RLock())
        configs = engine.latest_configs()
        for instrument in instruments:
            try:
                bars, exclusions = engine._fetch_daily(instrument, dates)
                events = build_events(bars, instrument["kind"], configs, dates)
                five_minute = {"status": "no candidate", "bars": 0}
                if events:
                    day = events[0]["date"]
                    try:
                        minute_bars, state = engine._fetch_intraday(instrument, day)
                        five_minute = {"date": day, "status": state, "bars": len(minute_bars)}
                    except Exception as exc:
                        five_minute = {"date": day, "status": "unavailable", "reason": str(exc)[:160]}
                results.append({"symbol": instrument["symbol"], "name": instrument["name"], "kind": instrument["kind"],
                                "dailyBars": len(bars), "excluded": exclusions, "events": len(events), "intraday": five_minute})
            except Exception as exc:
                results.append({"symbol": instrument["symbol"], "kind": instrument["kind"], "error": str(exc)[:180]})
    print(json.dumps({"source": "BaoStock", "period": dates, "sampleCount": len(results), "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
