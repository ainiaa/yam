#!/usr/bin/env python3
"""Author: Jeff.Liu. Explicit local Developer ID signing and notarization; no publishing."""
import argparse
import json
import pathlib
import plistlib
import subprocess
import tempfile


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=1200)


def bundle(app):
    app = pathlib.Path(app).resolve(strict=True)
    if app.suffix != ".app" or not app.is_dir():
        raise ValueError("Expected the production YAM app bundle")
    info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
    executable = info.get("CFBundleExecutable", "")
    if info.get("CFBundleIdentifier") != "com.yam.desktop" or pathlib.Path(executable).name != executable or not executable:
        raise ValueError("Unexpected YAM bundle identity or executable")
    if not (app / "Contents" / "MacOS" / executable).is_file():
        raise ValueError("YAM bundle executable is missing")
    return app


def signature(app, identity=None):
    run(["codesign", "--verify", "--deep", "--strict", str(app)])
    result = run(["codesign", "-dv", "--verbose=4", str(app)])
    details = result.stdout + result.stderr
    if "Authority=Developer ID Application:" not in details or "TeamIdentifier=" not in details or "TeamIdentifier=not set" in details or "(runtime)" not in details:
        raise ValueError("A Developer ID certificate and hardened runtime signature are required; ad-hoc signing is insufficient")
    if identity is not None and f"Authority={identity}" not in details.splitlines():
        raise ValueError("The existing signature does not match the requested signing identity")


def check(app):
    app = bundle(app)
    signature(app)
    run(["xcrun", "stapler", "validate", str(app)])
    run(["spctl", "--assess", "--type", "execute", "--verbose=4", str(app)])


def deliver(app, identity, profile, *, sign=False):
    app = bundle(app)
    if not identity.startswith("Developer ID Application: ") or any(c in identity + profile for c in "\0\n\r") or not profile.strip():
        raise ValueError("Provide an existing Developer ID certificate name and Keychain notary profile")
    if sign:
        # Refuse to guess nested signing order or entitlements; use Tauri's native
        # signing during the build if a future bundle contains embedded code.
        if any(p.suffix in {".app", ".framework", ".dylib", ".xpc"} for p in app.rglob("*")):
            raise ValueError("Use Tauri build signing for nested code bundles")
        identities = run(["security", "find-identity", "-v", "-p", "codesigning"]).stdout
        if f'"{identity}"' not in identities:
            raise ValueError("The requested Developer ID certificate is not available in Keychain")
        run(["codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, str(app)])
    signature(app, identity)
    with tempfile.TemporaryDirectory(prefix="yam-notary-") as directory:
        archive = pathlib.Path(directory) / "YAM.zip"
        run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(archive)])
        result = run(["xcrun", "notarytool", "submit", str(archive), "--keychain-profile", profile, "--wait", "--output-format", "json"])
        receipt = json.loads(result.stdout)
        if receipt.get("status") != "Accepted":
            raise ValueError(f"Notarization rejected: status={receipt.get('status')}, id={receipt.get('id')}; inspect using notarytool log")
    run(["xcrun", "stapler", "staple", str(app)])
    check(app)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["check", "notarize", "sign-notarize"])
    parser.add_argument("app", type=pathlib.Path)
    parser.add_argument("--identity")
    parser.add_argument("--notary-profile")
    args = parser.parse_args()
    try:
        if args.mode == "check":
            check(args.app)
        else:
            if not args.identity or not args.notary_profile:
                parser.error("--identity and --notary-profile are required")
            deliver(args.app, args.identity, args.notary_profile, sign=args.mode == "sign-notarize")
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # Avoid printing arbitrary command stdout/stderr or secrets from tools.
        print(f"Release validation failed: {error}")
        return 1
    print("Developer ID signature, notarization ticket and Gatekeeper assessment passed; nothing published")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
