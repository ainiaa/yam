"""Regression checks for the approved Rust desktop SDK and GUI registration isolation. Author: Jeff.Liu."""

import json
from pathlib import Path
import re
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps/desktop"
TAURI = DESKTOP / "src-tauri"
DESKTOP_TARGET = 'cfg(any(target_os = "macos", windows, target_os = "linux"))'
SDK = "tauri-plugin-updater"


class UpdaterDependencyTests(unittest.TestCase):
    def test_rust_sdk_is_declared_only_for_desktop_targets(self):
        manifest = tomllib.loads((TAURI / "Cargo.toml").read_text())
        declaration = manifest.get("target", {}).get(DESKTOP_TARGET, {}).get("dependencies", {})
        self.assertEqual(declaration.get(SDK), "2", "approved desktop SDK requirement is missing")
        for section in ("dependencies", "build-dependencies", "dev-dependencies"):
            self.assertNotIn(SDK, manifest.get(section, {}))
        for target, settings in manifest.get("target", {}).items():
            if target != DESKTOP_TARGET:
                self.assertNotIn(SDK, settings.get("dependencies", {}))

    def test_lockfile_contains_resolved_registry_sdk_and_direct_dependency(self):
        packages = tomllib.loads((TAURI / "Cargo.lock").read_text())["package"]
        sdk = [package for package in packages if package["name"] == SDK]
        self.assertEqual(len(sdk), 1, "Cargo has not resolved the approved SDK")
        self.assertRegex(sdk[0]["version"], r"^2\.\d+\.\d+(?:[-+].*)?$")
        self.assertEqual(sdk[0]["source"], "registry+https://github.com/rust-lang/crates.io-index")
        self.assertRegex(sdk[0]["checksum"], r"^[0-9a-f]{64}$")
        application = next(package for package in packages if package["name"] == "yam-desktop")
        self.assertIn(SDK, application["dependencies"])

    def test_frontend_updater_sdk_is_not_introduced(self):
        package = json.loads((DESKTOP / "package.json").read_text())
        for section in ("dependencies", "devDependencies", "optionalDependencies"):
            self.assertNotIn("@tauri-apps/plugin-updater", package.get(section, {}))

    def test_no_updater_service_key_or_bundle_configuration(self):
        config = json.loads((TAURI / "tauri.conf.json").read_text())
        self.assertNotIn("updater", config.get("plugins", {}))
        self.assertNotIn("createUpdaterArtifacts", config.get("bundle", {}))
        # All capability inputs remain free of updater permissions, including inline ones.
        capabilities = [json.loads(path.read_text()) for path in (TAURI / "capabilities").glob("*.json")]
        capabilities += config.get("app", {}).get("security", {}).get("capabilities", [])
        self.assertNotRegex(json.dumps(capabilities), r"updater:")

    def test_gui_registration_is_explicit_and_isolated_from_owner_cli(self):
        gui = (TAURI / "src/lib.rs").read_text()
        updater = (TAURI / "src/updater.rs").read_text()
        self.assertEqual(gui.count("updater::initialize(app.handle())?;"), 1)
        self.assertIn(".setup(|app| {\n            updater::initialize(app.handle())?;", gui)
        initializer = updater.split("pub(super) fn initialize(app:", 1)[1].split("#[tauri::command]", 1)[0]
        self.assertIn("initialize_with(", initializer)
        self.assertIn('app.config().plugins.0.get("updater")', initializer)
        self.assertIn("app.plugin(", initializer)
        self.assertIn("tauri_plugin_updater::Builder::new()", initializer)
        for name in ["background.rs", "cli.rs", "agent_bridge.rs"]:
            source = (TAURI / "src" / name).read_text()
            self.assertNotIn("updater::initialize", source)
            self.assertNotIn("tauri_plugin_updater", source)
        frontend = "\n".join(path.read_text() for path in (DESKTOP / "src").rglob("*")
                             if path.suffix in (".ts", ".tsx"))
        self.assertNotIn("@tauri-apps/plugin-updater", frontend)


if __name__ == "__main__":
    unittest.main()
