#!/usr/bin/env python3
"""Author: Jeff.Liu. Stage inspected macOS release assets locally; never publish implicitly."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import tarfile
import tempfile
import updater_release as updater


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


macos = load("macos_release", "macos-release.py")
validate_versions = load("build_release", "build-release.py").validate_versions


def verify_archive(app, archive):
    expected = {str(p.relative_to(app.parent)): p for p in (app, *app.rglob("*"))}
    seen = set()
    with tarfile.open(archive, "r:gz") as stream:
        for member in stream:
            path = expected.get(member.name)
            if path is None or member.name in seen:
                raise ValueError("Update archive contains unexpected or duplicate files")
            seen.add(member.name)
            if path.is_symlink():
                if not member.issym() or member.linkname != os.readlink(path):
                    raise ValueError("Update archive symlink differs from inspected bundle")
            elif stat.S_IMODE(member.mode) != stat.S_IMODE(path.stat().st_mode):
                raise ValueError("Update archive permissions differ from inspected bundle")
            elif path.is_dir():
                if not member.isdir():
                    raise ValueError("Update archive directory differs from inspected bundle")
            elif not member.isfile() or member.size != path.stat().st_size:
                raise ValueError("Update archive file differs from inspected bundle")
            else:
                with stream.extractfile(member) as data, path.open("rb") as original:
                    if hashlib.file_digest(data, "sha256").digest() != hashlib.file_digest(original, "sha256").digest():
                        raise ValueError("Update archive bytes differ from inspected bundle")
    if seen != set(expected):
        raise ValueError("Update archive is missing inspected bundle entries")


def prepare(version, target, app, artifact, notes, output, *, preview=False):
    output = Path(output)
    if output.exists():
        raise FileExistsError("Release output already exists; inspect it instead of overwriting")
    if target not in {"darwin-aarch64", "darwin-x86_64"} or version != validate_versions():
        raise ValueError("Release target or source version is invalid")
    app = macos.bundle(app)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if any(info.get(key) != version for key in ("CFBundleShortVersionString", "CFBundleVersion")):
        raise ValueError("Bundle version differs from release source")
    macos.notices.validate_packaged(macos.NOTICE_ROOT, app / "Contents/Resources/target/terminal-runtime")
    if preview:
        macos.run(["codesign", "--verify", "--deep", "--strict", str(app)])
    else:
        macos.check(app)
    arch = "arm64" if target == "darwin-aarch64" else "x86_64"
    actual = macos.run(["lipo", "-archs", str(app / "Contents/MacOS" / info["CFBundleExecutable"])]).stdout.split()
    if actual != [arch]:
        raise ValueError("Bundle architecture differs from release target")
    artifact = Path(artifact)
    if not artifact.name.endswith(".app.tar.gz"):
        raise ValueError("Expected a distinct .app.tar.gz update archive filename")
    verify_archive(app, artifact)
    text = Path(notes).read_text()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".yam-release-", dir=output.parent) as temporary:
        stage = Path(temporary) / "assets"
        stage.mkdir()
        copied = stage / artifact.name
        shutil.copyfile(artifact, copied)
        shutil.copyfile(str(artifact) + ".sig", str(copied) + ".sig")
        verify_archive(app, copied)
        manifest = updater.manifest(version, {target: copied}, text)
        (stage / "latest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        (stage / "RELEASE_NOTES.md").write_text(text)
        (stage / "release.json").write_text(json.dumps({"version": version, "target": target,
            "distribution": "unnotarized-preview" if preview else "notarized"}, indent=2) + "\n")
        sums = [hashlib.sha256(p.read_bytes()).hexdigest() + "  " + p.name for p in sorted(stage.iterdir())]
        (stage / "SHA256SUMS").write_text("\n".join(sums) + "\n")
        # Refuse replacement; a failed preparation never promotes partial assets.
        if output.exists():
            raise FileExistsError("Release output already exists")
        stage.rename(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("version", "target", "app", "artifact", "notes", "output"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    try:
        prepare(args.version, args.target, args.app, args.artifact, args.notes, args.output, preview=args.preview)
    except (ValueError, OSError, tarfile.TarError, subprocess.SubprocessError):
        parser.exit(1, "Release preparation rejected: bundle, metadata, signature or output validation failed.\n")
    print("Release assets prepared; nothing published. " + ("Unnotarized preview." if args.preview else "Notarized release."))


if __name__ == "__main__":
    main()
