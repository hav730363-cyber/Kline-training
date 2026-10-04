import unittest

from side_training import WINDOW_BARS, detect_side_pairs


def fixture_bars(length=720):
    bars = []
    for index in range(length):
        if index < 360:
            price = 110 - 0.02 * index
        elif index < 480:
            price = 103 - (index - 360) * 0.28
        elif index < 540:
            price = 69 + (index - 480) * 0.38
        else:
            price = 92 + (index - 540) * 0.06
        bars.append({
            "date": f"2024-{index + 1:04d}",
            "open": price,
            "high": price * 1.01,
            "low": price * 0.99,
            "close": price,
            "volume": 1000 + (2500 if 480 <= index < 500 else 0),
        })
    return bars


class SideTrainingTests(unittest.TestCase):
    def test_emits_linked_left_and_right_samples(self):
        samples = detect_side_pairs(fixture_bars(), "TEST", "fixture")
        self.assertEqual({sample["tradeTiming"] for sample in samples}, {"left", "right"})
        self.assertEqual(len({sample["eventId"] for sample in samples}), 1)
        self.assertTrue(all(sample["pivotPhase"] in {"before-low", "after-low"} for sample in samples))
        self.assertTrue(all(len(sample["bars"]) == WINDOW_BARS for sample in samples))
        self.assertTrue(all(len(sample["indicatorWarmupBars"]) == 250 for sample in samples))
        self.assertEqual(samples[0]["pairedSampleKey"], samples[1]["key"])

    def test_rejects_insufficient_history(self):
        self.assertEqual(detect_side_pairs(fixture_bars(500), "TEST", "fixture"), [])

    def test_600_bar_scan_has_room_for_multiple_pivots(self):
        samples = detect_side_pairs(fixture_bars(600), "TEST", "fixture")
        self.assertEqual(len(samples), 2)
        self.assertEqual({sample["tradeTiming"] for sample in samples}, {"left", "right"})

    def test_right_side_requires_volume_confirmation(self):
        bars = fixture_bars(600)
        for bar in bars:
            bar["volume"] = 1000
        self.assertEqual(detect_side_pairs(bars, "TEST", "fixture"), [])

    def test_flat_market_has_no_paired_sample(self):
        bars = fixture_bars(600)
        for bar in bars:
            bar.update(open=100, high=101, low=99, close=100)
        self.assertEqual(detect_side_pairs(bars, "TEST", "fixture"), [])


if __name__ == "__main__":
    unittest.main()
