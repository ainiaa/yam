"""Author: Jeff.Liu. Keep release resources aligned with the Tauri build target."""
import argparse
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tempfile
import re
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def validate_versions(root=ROOT):
    desktop = pathlib.Path(root) / "apps/desktop"
    versions = [json.loads((desktop / "package.json").read_text())["version"],
                json.loads((desktop / "src-tauri/tauri.conf.json").read_text())["version"],
                tomllib.loads((desktop / "src-tauri/Cargo.toml").read_text())["package"]["version"]]
    if len(set(versions)) != 1 or not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", versions[0]):
        raise ValueError("Release source version metadata must agree")
    packages = tomllib.loads((desktop / "src-tauri/Cargo.lock").read_text()).get("package", [])
    if [item.get("version") for item in packages if item.get("name") == "yam-desktop"] != [versions[0]]:
        raise ValueError("Release lockfile version must agree with source")
    return versions[0]


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("-t", "--target")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("-d", "--debug", action="store_true")
    args, _ = parser.parse_known_args(argv[1:])
    validate_versions()
    windows = "windows" in args.target if args.target else platform.system() == "Windows"
    config = json.loads(pathlib.Path(argv[0]).read_text())
    config["bundle"]["resources"] = [
        path + ".exe" if windows and path.endswith("/yam-terminal") else path
        for path in config["bundle"]["resources"]
    ]
    macos = "apple-darwin" in args.target if args.target else platform.system() == "Darwin"
    if macos:
        identity = os.environ.get("APPLE_SIGNING_IDENTITY", "")
        if not args.preview and not identity.startswith("Developer ID Application: "):
            raise ValueError("Developer ID is required; use --preview explicitly for an unnotarized build")
        config["bundle"].setdefault("macOS", {})["signingIdentity"] = identity or "-"
    # pnpm forwards through a shell; a file preserves literal $schema and build command values.
    with tempfile.TemporaryDirectory(prefix="yam-release-") as directory:
        temporary = pathlib.Path(directory) / "config.json"
        temporary.write_text(json.dumps(config), encoding="utf-8")
        environment = os.environ.copy()
        if macos:
            native = ROOT / "apps/desktop/src-tauri"
            target = pathlib.Path(environment.get("CARGO_TARGET_DIR", str(native / "target")))
            if not target.is_absolute():
                target = native / target
            if args.target:
                target = target / args.target
            environment["YAM_BUILD_BINARY"] = str(target / ("debug" if args.debug else "release") / "yam-desktop")
        return subprocess.call([shutil.which("pnpm") or "pnpm", "tauri", "build", "--config", str(temporary), *[value for value in argv[1:] if value != "--preview"]], env=environment)


if __name__ == "__main__":
    raise SystemExit(main())
