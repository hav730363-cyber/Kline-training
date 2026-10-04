import tempfile
import threading
import unittest
from datetime import date, timedelta
from pathlib import Path

from research_validation import ResearchEngine, build_events, event_flags, parse_history_rows, period_dates


def sample_rows():
    rows = []
    start = date(2022, 1, 3)
    for index in range(105):
        day = start + timedelta(days=index)
        close = 10 + (index % 19) * .12
        st = "1" if index == 65 else "0"
        rows.append([day.isoformat(), str(close - .05), str(close + .1), str(close - .2), str(close), "10000", "0", "2", "1", st])
    return rows


class ResearchValidationTests(unittest.TestCase):
    def test_point_in_time_st_filter_and_restoration(self):
        rows = sample_rows()
        rows[66][9] = ""
        bars, reasons = parse_history_rows(rows, "stock")
        self.assertEqual(reasons["st"], 1)
        self.assertEqual(reasons["unknownStatus"], 1)
        self.assertEqual(bars[65]["status"], "st")
        self.assertEqual(bars[66]["status"], "unknownStatus")
        self.assertEqual(bars[67]["status"], "eligible")
        config = {"id": "personal-j-high", "revision": 1, "side": "sell", "threshold": -100}
        events = build_events(bars, "stock", [config], {"start": rows[0][0], "developmentEnd": rows[70][0], "validationEnd": rows[85][0], "end": rows[-1][0]})
        self.assertFalse(any(event["date"] in {rows[65][0], rows[66][0]} for event in events))
        self.assertTrue(any(event["date"] >= rows[67][0] for event in events))

    def test_future_prices_cannot_change_a_signal(self):
        bars, _ = parse_history_rows(sample_rows(), "stock")
        cfg = {"id": "personal-j-low", "revision": 1, "side": "buy", "threshold": 10}
        index = 62
        from research_validation import _kdj_j
        original = event_flags(bars, index, cfg, _kdj_j(bars))
        changed = [dict(bar) for bar in bars]
        for bar in changed[index + 1:]:
            bar["close"] *= 5
            bar["high"] *= 5
        self.assertEqual(original, event_flags(changed, index, cfg, _kdj_j(changed)))

    def test_low_j_can_keep_falling_and_high_j_can_keep_rising(self):
        start = date(2022, 1, 1)
        dates = {"start": "2022-01-01", "developmentEnd": "2022-03-01", "validationEnd": "2022-04-01", "end": "2022-05-31"}
        def make_trend(up):
            bars = []
            for i in range(100):
                close = 10 + i * .08 if up else 20 - i * .08
                bars.append({"date": (start + timedelta(days=i)).isoformat(), "open": close - (.03 if up else -.03),
                             "high": close + (.01 if up else .20), "low": close - (.20 if up else .01),
                             "close": close, "volume": 10000, "status": "eligible"})
            return bars
        buy = build_events(make_trend(False), "stock", [{"id": "personal-j-low", "revision": 1, "side": "buy", "threshold": 10}], dates)
        sell = build_events(make_trend(True), "stock", [{"id": "personal-j-high", "revision": 1, "side": "sell", "threshold": 75}], dates)
        self.assertTrue(buy and sell)
        self.assertLess(buy[0]["returns"]["5"], 0)
        self.assertLess(sell[0]["returns"]["5"], 0)

    def test_resumable_pilot_and_versioned_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            instruments = [{"symbol": f"60000{i}", "baostockCode": f"sh.60000{i}", "name": f"测试{i}", "kind": "stock"} for i in range(2)]
            engine = ResearchEngine(Path(directory), lambda: {"instruments": instruments}, threading.RLock())
            engine._put("task", {"state": "idle", "dates": {"start": "2022-01-01", "developmentEnd": "2022-03-01", "validationEnd": "2022-04-01", "end": "2022-05-31"}})
            engine._fetch_daily = lambda instrument, dates: parse_history_rows(sample_rows(), "stock")
            engine._fetch_intraday = lambda instrument, day: ([], "incomplete")
            engine.start(1)
            engine.worker.join(10)
            self.assertEqual(engine.status()["counts"].get("complete"), 1)
            self.assertEqual(engine.status()["state"], "paused")
            engine.start(1)
            engine.worker.join(10)
            self.assertEqual(engine.status()["counts"].get("complete"), 2)
            self.assertEqual(engine.status()["state"], "paused")
            proposal = engine.propose("personal-j-low", 8, "测试观察，不是已验证文献", "")
            engine.validation_worker.join(10)
            self.assertEqual(proposal["revision"], 2)
            self.assertFalse(engine.rules()[0]["approved"])
            with self.assertRaises(ValueError):
                engine.approve("personal-j-low", 2)

    def test_time_splits_are_ordered(self):
        dates = period_dates(date(2026, 9, 27))
        self.assertLess(dates["start"], dates["developmentEnd"])
        self.assertLess(dates["developmentEnd"], dates["validationEnd"])
        self.assertLess(dates["validationEnd"], dates["end"])

    def test_short_history_is_not_retried_on_next_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            instruments = [{"symbol": "510001", "baostockCode": "sh.510001", "name": "短历史", "kind": "etf"},
                           {"symbol": "600000", "baostockCode": "sh.600000", "name": "足量历史", "kind": "stock"}]
            engine = ResearchEngine(Path(directory), lambda: {"instruments": instruments}, threading.RLock())
            engine._put("task", {"state": "idle", "dates": {"start": "2022-01-01", "developmentEnd": "2022-03-01", "validationEnd": "2022-04-01", "end": "2022-05-31"}})
            calls = []
            def daily(instrument, dates):
                calls.append(instrument["symbol"])
                return parse_history_rows(sample_rows()[:40] if instrument["kind"] == "etf" else sample_rows(), "stock")
            engine._fetch_daily = daily
            engine._fetch_intraday = lambda instrument, day: ([], "incomplete")
            engine.start(1)
            engine.worker.join(10)
            engine.start(1)
            engine.worker.join(10)
            self.assertEqual(calls, ["510001", "600000"])
            self.assertEqual(engine.status()["counts"]["insufficient"], 1)
            self.assertEqual(engine.status()["counts"]["complete"], 1)


if __name__ == "__main__":
    unittest.main()
