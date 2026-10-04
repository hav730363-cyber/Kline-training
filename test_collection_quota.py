"""Collection checkpoint and quota tests using an isolated local cache."""

import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from side_training import detect_side_pairs
from test_side_training import fixture_bars


class CollectionQuotaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for name, value in {
            "CACHE_DIR": root,
            "CANDIDATE_FILE": root / "sample-candidates.json",
            "COLLECTION_STATE_FILE": root / "collection-scan-state.json",
            "SQLITE_FILE": root / "market-cache.sqlite3",
            "_collection_tasks": {},
            "_collection_sequence": 0,
            "_candidate_revision": 0,
        }.items():
            manager = patch.object(server, name, value)
            manager.start()
            self.addCleanup(manager.stop)
        server._init_sqlite()
        self.bars = fixture_bars(600)

    def _fake_verify(self, candidate):
        result = copy.deepcopy(candidate)
        result.update(verificationStatus="verified_strict", reviewStatus="pending", dataReviewAccepted=True)
        result["validationReport"] = {"warmupMatched": 250, "visibleMatched": 220}
        return result

    def _run(self, instruments, prefilter, verify=None, intraday_complete=True):
        with patch.object(server, "fetch_sina_universe", return_value={"instruments": instruments}), \
                patch.object(server, "fetch_baostock_universe", return_value={"instruments": []}), \
                patch.object(server, "_backfill_existing_intraday", return_value={"total": 0, "done": 0, "success": 0, "failed": 0}), \
                patch.object(server, "_prefilter_instrument", side_effect=prefilter), \
                patch.object(server, "_verify_prefiltered_candidate", side_effect=verify or self._fake_verify), \
                patch.object(server, "_has_complete_intraday", return_value=intraday_complete):
            task = server._start_collection_task(120, launch=False)
            server._run_collection_task(task["taskId"], 120)
            return server._task_snapshot(task["taskId"])

    def test_stops_at_ten_unique_pairs_and_keeps_checkpoint(self):
        instruments = [{"symbol": f"{index:06d}", "kind": "stock"} for index in range(1, 21)]

        def prefilter(instrument):
            symbol = instrument["symbol"]
            return {}, detect_side_pairs(self.bars, symbol, "fixture")

        result = self._run(instruments, prefilter)
        self.assertEqual(result["state"], "done")
        self.assertEqual(result["approvedPairsTotal"], 10)
        self.assertEqual(len(set(result["approvedEventIds"])), 10)
        self.assertLessEqual(result["scanned"], 16)
        with patch.object(server, "_has_complete_intraday", return_value=True):
            self.assertEqual(len(server._approved_side_events(server._load_candidates())), 10)
        saved = server._collection_state_read()
        self.assertEqual(saved["latestTask"]["approvedPairsTotal"], 10)
        self.assertEqual(len(saved["scannedSymbols"]), result["scanned"])
        self.assertTrue(Path(saved["collectionBackupPath"]).exists())
        with patch.object(server, "_load_candidates", side_effect=AssertionError("status reread candidate bank")):
            self.assertEqual(server._task_snapshot(result["taskId"])["approvedPairsTotal"], 10)

    def test_missing_intraday_never_enters_training(self):
        instruments = [{"symbol": "000001", "kind": "stock"}]
        result = self._run(instruments, lambda item: ({}, detect_side_pairs(self.bars, item["symbol"], "fixture")), intraday_complete=False)
        self.assertEqual(result["state"], "exhausted")
        self.assertEqual(result["approvedPairsTotal"], 0)
        self.assertEqual(result["scanned"], 1)

    def test_interrupted_symbol_is_retried_after_resume(self):
        instruments = [{"symbol": "000001", "kind": "stock"}]
        task_id = None

        def pause_during_verify(candidate):
            server._request_collection_pause(task_id, "测试中途关闭")
            return self._fake_verify(candidate)

        with patch.object(server, "fetch_sina_universe", return_value={"instruments": instruments}), \
                patch.object(server, "fetch_baostock_universe", return_value={"instruments": []}), \
                patch.object(server, "_backfill_existing_intraday", return_value={"total": 0, "done": 0, "success": 0, "failed": 0}), \
                patch.object(server, "_prefilter_instrument", side_effect=lambda item: ({}, detect_side_pairs(self.bars, item["symbol"], "fixture"))), \
                patch.object(server, "_verify_prefiltered_candidate", side_effect=pause_during_verify):
            task_id = server._start_collection_task(120, launch=False)["taskId"]
            server._run_collection_task(task_id, 120)
        self.assertEqual(server._task_snapshot(task_id)["state"], "paused")
        self.assertEqual(server._collection_state_read()["scannedSymbols"], [])
        server._collection_tasks.clear()  # simulate service restart; persisted task remains
        self.assertEqual(server._current_collection_status()["state"], "paused")
        result = self._run(instruments, lambda item: ({}, detect_side_pairs(self.bars, item["symbol"], "fixture")))
        self.assertEqual(result["scanned"], 1)
        self.assertEqual(result["approvedPairsTotal"], 1)

    def test_universe_change_retains_intersection(self):
        original = [{"symbol": symbol, "kind": "stock"} for symbol in ("000001", "000002", "000003")]
        selected, _ = server._select_rotating_batch(original, 1)
        server._mark_rotating_symbol(selected[0])
        updated = [{"symbol": symbol, "kind": "stock"} for symbol in ("000001", "000002", "000004")]
        selected, state = server._select_rotating_batch(updated, 3)
        self.assertEqual(state["remainingBefore"], 2)
        self.assertEqual({item["symbol"] for item in selected}, {"000002", "000004"})
        self.assertEqual(server._collection_state_read()["scannedSymbols"], ["000001"])


if __name__ == "__main__":
    unittest.main()
