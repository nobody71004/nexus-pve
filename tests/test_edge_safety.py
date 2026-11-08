#!/usr/bin/env python3
"""Regression tests for the edge shield's auto-ban and allowlist boundary.

These tests load the daemon that is shipped to the edge and exercise its
decision logic without nftables, root, or a live SSH host.

Run from the project root with: npm test
"""
from __future__ import annotations

import importlib.util
import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SHIELD_PATH = ROOT / "resources" / "nexus-shield" / "nexus-shieldd.py"
ALLOWED = "203.0.113.10"
OFFENDER = "198.51.100.20"


def load_shield():
    spec = importlib.util.spec_from_file_location("nexus_shieldd", SHIELD_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {SHIELD_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


shieldd = load_shield()


class EdgeSafetyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.config_path = root / "config.json"
        self.config_path.write_text(
            json.dumps(
                {
                    "mode": "defend",
                    "allowlist": [ALLOWED],
                    "autoBan": True,
                    "pollSeconds": 1,
                    "forwards": [],
                    "limits": {
                        "autoBanPps": 1000,
                        "autoBanSamples": 2,
                        "blockSeconds": 3600,
                    },
                }
            ),
            encoding="utf-8",
        )
        for name, path in (
            ("BLOCKED_PATH", root / "blocked.json"),
            ("INCIDENT_PATH", root / "incidents.json"),
            ("STATE_PATH", root / "state.json"),
        ):
            patcher = mock.patch.object(shieldd, name, path)
            patcher.start()
            self.addCleanup(patcher.stop)

        self.shield = shieldd.Shield(self.config_path, apply=False)
        self.set_add = mock.Mock()
        self.shield._set_add = self.set_add
        self.shield._set_delete = mock.Mock()
        self.shield.apply_rules = mock.Mock()

    def test_auto_ban_never_bans_an_allowlisted_source(self):
        sources = [
            {"ip": ALLOWED, "pps": 9000.0, "blocked": False, "allowlisted": True},
            {"ip": OFFENDER, "pps": 9000.0, "blocked": False, "allowlisted": False},
        ]

        for offset in range(2):
            self.shield._auto_ban(sources, time.time() + offset)

        self.assertNotIn(ALLOWED, self.shield.blocked)
        self.assertIn(OFFENDER, self.shield.blocked)
        self.assertNotIn(ALLOWED, self.shield.streaks)
        self.set_add.assert_called_once_with("blocked4", OFFENDER, 3600)

    def test_allow_adds_an_address_to_the_allowlist_and_allowed_set(self):
        self.shield.allow(OFFENDER, True)

        self.assertIn(OFFENDER, self.shield.cfg["allowlist"])
        self.set_add.assert_called_once_with("allowed4", OFFENDER)

    def test_manual_ban_refuses_an_allowlisted_address(self):
        with self.assertRaisesRegex(RuntimeError, "allowlisted"):
            self.shield.ban(ALLOWED)

        self.assertNotIn(ALLOWED, self.shield.blocked)
        self.set_add.assert_not_called()

    def test_allowed_set_is_evaluated_before_the_blocked_set(self):
        rules = self.shield.ruleset()
        allow_rule = "ip saddr @allowed4 return"
        block_rule = "ip saddr @blocked4 counter drop"

        self.assertIn(allow_rule, rules)
        self.assertIn(block_rule, rules)
        self.assertLess(
            rules.index(allow_rule),
            rules.index(block_rule),
            "an allowlisted source must bypass a stale block rule",
        )


if __name__ == "__main__":
    unittest.main()
