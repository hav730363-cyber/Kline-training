"""Admission checks for paired indicator-training samples."""

import os
import tempfile
import unittest
from unittest.mock import patch

from side_training import detect_side_pairs
from test_side_training import fixture_bars

with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as _cache_dir:
    _previous_cache = os.environ.get("KLINE_CACHE_DIR")
    os.environ["KLINE_CACHE_DIR"] = _cache_dir
    import server
    if _previous_cache is None:
        os.environ.pop("KLINE_CACHE_DIR", None)
    else:
        os.environ["KLINE_CACHE_DIR"] = _previous_cache


class SideVerificationTests(unittest.TestCase):
    def setUp(self):
        left, right = detect_side_pairs(fixture_bars(600), "TEST", "fixture")
        self.pair = [left, right]

    def _verify(self, sample):
        combined = sample["indicatorWarmupBars"] + sample["bars"]
        source = {"bars": combined, "volumeUnit": "股", "provider": "fixture"}
        return server._verify_side_daily(sample, source, source)

    def test_full_warmup_and_window_pass(self):
        for sample in self.pair:
            report = self._verify(sample)
            self.assertEqual(report["status"], "verified_strict")
            self.assertEqual(report["warmupMatched"], 250)
            self.assertEqual(report["visibleMatched"], 220)

    def test_missing_warmup_and_broken_pair_fail(self):
        sample = dict(self.pair[0], indicatorWarmupBars=self.pair[0]["indicatorWarmupBars"][1:])
        self.assertEqual(self._verify(sample)["status"], "pending_secondary")
        sample = dict(self.pair[0], pairedSampleKey="wrong")
        self.assertEqual(self._verify(sample)["status"], "pending_secondary")

    def test_source_mismatch_fails(self):
        sample = self.pair[0]
        combined = sample["indicatorWarmupBars"] + sample["bars"]
        primary = {"bars": combined, "volumeUnit": "股", "provider": "primary"}
        secondary_bars = [dict(bar) for bar in combined]
        secondary_bars[200]["close"] *= 1.2
        secondary = {"bars": secondary_bars, "volumeUnit": "股", "provider": "secondary"}
        self.assertEqual(server._verify_side_daily(sample, primary, secondary)["status"], "pending_secondary")

    def test_pair_requires_both_sides_and_intraday(self):
        pair = []
        for sample in self.pair:
            candidate = dict(sample, verificationStatus="verified_strict", reviewStatus="pending", dataReviewAccepted=True)
            candidate["validationReport"] = self._verify(sample)
            pair.append(candidate)
        with patch.object(server, "_has_complete_intraday", return_value=True):
            self.assertTrue(server._side_pair_ready(pair))
            self.assertFalse(server._side_pair_ready(pair[:1]))
            broken = [dict(pair[0], reviewStatus="removed"), pair[1]]
            self.assertFalse(server._side_pair_ready(broken))
        with patch.object(server, "_has_complete_intraday", return_value=False):
            self.assertFalse(server._side_pair_ready(pair))


if __name__ == "__main__":
    unittest.main()
