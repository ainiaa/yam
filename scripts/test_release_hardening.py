"""Finite configuration contracts, not WebKit enforcement. Author: Jeff.Liu."""

import json
from pathlib import Path
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "apps/desktop/src-tauri"
PERMISSIONS = {"core:event:allow-listen", "core:event:allow-unlisten", "dialog:allow-open"}
PRODUCTION = {
    "default-src": {"'self'"},
    "base-uri": {"'none'"},
    "object-src": {"'none'"},
    "frame-src": {"'none'"},
    "script-src": {"'self'"},
    "style-src": {"'self'", "'unsafe-inline'"},
    "img-src": {"'self'"},
    "font-src": {"'self'"},
    "connect-src": {"ipc:", "http://ipc.localhost"},
    "form-action": {"'none'"},
}
DEVELOPMENT = {**PRODUCTION,
    "script-src": {"'self'", "'unsafe-inline'"},
    "connect-src": PRODUCTION["connect-src"] | {
        "http://localhost:1420", "ws://localhost:1420", "ws://localhost:1421"},
}


def policy_contract(raw, expected):
    """Test oracle for the finite source sets; does not emulate a browser CSP."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("missing policy")
    actual = {}
    for directive in raw.split(";"):
        tokens = directive.split()
        if not tokens:
            continue
        name, sources = tokens[0], tokens[1:]
        if not sources or name in actual or len(sources) != len(set(sources)):
            raise ValueError("invalid or repeated directive")
        actual[name] = set(sources)
    if actual != expected:
        raise ValueError("sources differ from finite contract")
    return actual


def serialized_policy(directives):
    return "; ".join(name + " " + " ".join(sorted(sources))
                     for name, sources in directives.items())


class ReleaseHardeningTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((TAURI / "tauri.conf.json").read_text())
        self.security = self.config["app"]["security"]
        self.capability = json.loads((TAURI / "capabilities/default.json").read_text())
        self.manifest = tomllib.loads((TAURI / "Cargo.toml").read_text())

    def test_production_has_strict_script_and_only_local_ipc_policy(self):
        policy = self.security.get("csp")
        self.assertIsInstance(policy, str, "production CSP is not configured")
        self.assertEqual(policy_contract(policy, PRODUCTION), PRODUCTION)
        self.assertFalse(self.security.get("dangerousDisableAssetCspModification", False))

    def test_development_policy_is_separate_and_default_localhost_only(self):
        policy = self.security.get("devCsp")
        self.assertIsInstance(policy, str, "separate development CSP is missing")
        self.assertEqual(policy_contract(policy, DEVELOPMENT), DEVELOPMENT)
        self.assertNotEqual(policy, self.security.get("csp"))
        self.assertEqual(self.config["build"]["devUrl"], "http://localhost:1420")

    def test_main_permission_set_matches_only_frontend_consumers(self):
        permissions = self.capability["permissions"]
        self.assertEqual(set(permissions), PERMISSIONS)
        self.assertEqual(len(permissions), len(PERMISSIONS))

    def test_capability_cannot_expand_to_other_windows_or_remote_origins(self):
        self.assertEqual(self.capability["windows"], ["main"])
        self.assertNotIn("webviews", self.capability)
        self.assertNotIn("remote", self.capability)
        self.assertTrue(self.capability.get("local", True))

    def test_package_metadata_identifies_yam_and_author(self):
        package = self.manifest["package"]
        self.assertEqual(package["authors"], ["Jeff.Liu"])
        self.assertIn("YAM", package["description"])
        self.assertNotEqual(package["description"], "A Tauri App")

    def test_sdk_version_and_deep_link_configuration_remain_unchanged(self):
        self.assertEqual(self.manifest["package"]["version"], "0.1.0")
        self.assertNotIn("license", self.manifest["package"])
        target = 'cfg(any(target_os = "macos", windows, target_os = "linux"))'
        self.assertEqual(self.manifest["target"][target]["dependencies"]["tauri-plugin-updater"], "2")
        self.assertEqual(self.config["plugins"]["deep-link"]["desktop"]["schemes"], ["yam"])
        self.assertNotIn("updater", self.config["plugins"])

    def test_policy_oracle_rejects_missing_duplicate_wildcard_and_script_relaxation(self):
        valid = serialized_policy(PRODUCTION)
        self.assertEqual(policy_contract(valid, PRODUCTION), PRODUCTION)
        invalid = [None, "", valid + "; script-src 'self'",
                   valid.replace("default-src 'self'", "default-src *"),
                   valid.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
                   valid.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
                   valid.replace("http://ipc.localhost", "https://example.invalid"),
                   valid.replace("script-src 'self'", "script-src 'self' 'self'")]
        for policy in invalid:
            with self.subTest(policy=policy):
                with self.assertRaises(ValueError):
                    policy_contract(policy, PRODUCTION)

    def test_development_oracle_rejects_arbitrary_remote_or_websocket_sources(self):
        valid = serialized_policy(DEVELOPMENT)
        self.assertEqual(policy_contract(valid, DEVELOPMENT), DEVELOPMENT)
        for source in ("ws:", "wss:", "*", "https://example.invalid", "ws://other-host:1421"):
            with self.subTest(source=source):
                with self.assertRaises(ValueError):
                    policy_contract(valid.replace("connect-src ", "connect-src " + source + " ", 1), DEVELOPMENT)


if __name__ == "__main__":
    unittest.main()
