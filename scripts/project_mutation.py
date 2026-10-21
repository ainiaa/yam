#!/usr/bin/env python3
"""Author: Jeff.Liu. Run a frozen Rust campaign in cargo-mutants' disposable copy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CAMPAIGN = ROOT / "docs/00_standards/rust-mutations.json"
SCOPE_DIFF = Path("docs/00_standards/rust-mutations.diff")


def load_campaign(root, path):
    root = Path(root).resolve()
    data = json.loads(Path(path).read_text())
    if (not isinstance(data, dict) or set(data) != {"schema_version", "tool_version", "manifest", "selector", "mutants"}
            or type(data["schema_version"]) is not int or data["schema_version"] != 1
            or data["tool_version"] != "27.1.0"
            or not isinstance(data["selector"], str)
            or not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9:]*", data["selector"])
            or not isinstance(data["manifest"], str)):
        raise ValueError("unsupported mutation campaign")
    manifest = Path(data["manifest"])
    if (manifest.is_absolute() or ".." in manifest.parts or "\\" in str(manifest)
            or manifest.name != "Cargo.toml" or not (root / manifest).is_file()
            or not (root / manifest).resolve().is_relative_to(root)):
        raise ValueError("mutation manifest must stay inside the repository")
    mutants = data["mutants"]
    if not isinstance(mutants, list) or not 1 <= len(mutants) <= 64:
        raise ValueError("mutation campaign must contain 1..64 required mutants")
    names = set()
    for mutant in mutants:
        if (not isinstance(mutant, dict) or set(mutant) != {"name", "source_sha256", "criterion"}
                or not isinstance(mutant["name"], str) or len(mutant["name"]) > 1024
                or not isinstance(mutant["criterion"], str) or not mutant["criterion"].strip()):
            raise ValueError("invalid required mutation")
        match = re.fullmatch(r"([^:\x00-\x1f\\]+\.rs):[1-9]\d*:[1-9]\d*: .+", mutant["name"])
        if not match or mutant["name"] in names:
            raise ValueError("mutation identities must be distinct and explicit")
        source = root / manifest.parent / match[1]
        if (not source.resolve().is_relative_to((root / manifest.parent).resolve()) or not source.is_file()
                or hashlib.sha256(source.read_bytes()).hexdigest() != mutant["source_sha256"]):
            raise ValueError("mutation source changed; review and freeze the campaign again")
        names.add(mutant["name"])
    if (root / SCOPE_DIFF).read_text() != scope_text(root, data):
        raise ValueError("mutation line filter changed; review and freeze it again")
    return data


def scope_text(root, campaign):
    locations = sorted({tuple(row["name"].split(":", 2)[:2]) for row in campaign["mutants"]},
                       key=lambda item: (item[0], int(item[1])))
    text, previous = [], None
    for name, number in locations:
        path = Path(root) / Path(campaign["manifest"]).parent / name
        lines = path.read_text().splitlines()
        line = int(number)
        if not 1 <= line <= len(lines):
            raise ValueError("mutation location is outside the frozen source")
        if name != previous:
            text.extend([f"--- a/{name}", f"+++ b/{name}"])
        text.extend([f"@@ -{line} +{line} @@", "-" + lines[line - 1], "+" + lines[line - 1]])
        previous = name
    return "\n".join(text) + "\n"


def command(campaign, output):
    pattern = "^(?:" + "|".join(re.escape(row["name"]) for row in campaign["mutants"]) + ")$"
    return ["cargo", "mutants", "--manifest-path", campaign["manifest"], "--no-config",
            "--baseline", "run", "--no-shuffle", "--all-logs", "--caught", "--jobs", "1",
            "--timeout", "180", "--re", pattern, "--in-diff", str(SCOPE_DIFF),
            "--output", str(Path(output).resolve()),
            "--cargo-arg=--locked", "--cargo-arg=--offline", "--", "--lib", campaign["selector"],
            "--", "--test-threads=2"]


def check_report(directory, report, campaign):
    names = {row["name"] for row in campaign["mutants"]}
    count = len(names)
    if (report.get("cargo_mutants_version") != "27.1.0" or not report.get("end_time")
            or any(type(report.get(key)) is not int or report[key] != value for key, value in
                   {"total_mutants": count, "caught": count, "missed": 0,
                    "timeout": 0, "unviable": 0, "success": 0}.items())):
        raise ValueError("every required mutation must be caught without errors")
    outcomes = report.get("outcomes", [])
    baseline = [row for row in outcomes if row.get("scenario") == "Baseline"]
    mutations = [row for row in outcomes if isinstance(row.get("scenario"), dict)]
    if len(baseline) != 1 or len(mutations) != count or len(outcomes) != count + 1:
        raise ValueError("fresh baseline and all required mutations must run")
    observed = set()
    tests = 0
    for index, row in enumerate([baseline[0], *mutations]):
        phases = row.get("phase_results", [])
        status = "Success" if index == 0 else {"Failure": 101}
        if (len(phases) != 2 or phases[0].get("phase") != "Build"
                or phases[0].get("process_status") != "Success" or phases[1].get("phase") != "Test"
                or phases[1].get("process_status") != status
                or phases[1].get("argv", [])[-4:] != ["--lib", campaign["selector"], "--", "--test-threads=2"]):
            raise ValueError("mutation must build and execute the frozen test selector")
        log = (Path(directory) / row["log_path"]).resolve()
        if not log.is_relative_to(Path(directory).resolve()) or log.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("invalid mutation log")
        summaries = re.findall(r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; \d+ ignored; "
                               r"\d+ measured; \d+ filtered out; finished in [^\n]+$", log.read_text(), re.M)
        if len(summaries) != 1:
            raise ValueError("mutation must prove nonempty libtest results")
        result, passed, failed = summaries[0]
        if index == 0:
            if row.get("summary") != "Success" or result != "ok" or int(passed) <= 0 or int(failed):
                raise ValueError("baseline must contain passing tests")
            tests = int(passed)
        else:
            name = row["scenario"].get("Mutant", {}).get("name")
            if (row.get("summary") != "CaughtMutant" or result != "FAILED" or int(failed) <= 0
                    or name not in names or name in observed):
                raise ValueError("required mutation was not caught by its tests")
            observed.add(name)
    return {"selector": campaign["selector"], "generated": count, "killed": count, "tests": tests}


def run_command(argv, timeout):
    if os.name != "posix":
        raise ValueError("mutation execution requires POSIX process-group cleanup")
    with tempfile.TemporaryDirectory(prefix="yam-mutation-") as directory:
        # cargo-mutants copies the crate one level below TMPDIR; preserve its sibling include_bytes! inputs.
        shutil.copytree(ROOT / "apps/desktop/tests/fixtures", Path(directory) / "tests/fixtures")
        environment = os.environ.copy()
        environment["TMPDIR"] = directory
        environment["CARGO_TARGET_DIR"] = str(Path(directory) / "target")
        environment["CARGO_BUILD_JOBS"] = "2"
        # Unit tests do not package the ignored terminal-runtime binary in the disposable source copy.
        environment["TAURI_CONFIG"] = json.dumps({"bundle": {"resources": []}})
        process = subprocess.Popen(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True, env=environment)
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=5)
            raise
        return process.returncode, stdout, stderr


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="new directory outside the repository")
    args = parser.parse_args()
    try:
        campaign = load_campaign(ROOT, CAMPAIGN)
        output = args.output.resolve()
        if output.is_relative_to(ROOT) or output.exists():
            raise ValueError("mutation output must be a new directory outside the repository")
        code, version, _ = run_command(["cargo", "mutants", "--version"], 10)
        if code or version.strip() != b"cargo-mutants 27.1.0":
            raise ValueError("install cargo-mutants 27.1.0 before running the campaign")
        output.mkdir(parents=True)
        code, stdout, stderr = run_command(command(campaign, output), 1200)
        (output / "stdout.log").write_bytes(stdout)
        (output / "stderr.log").write_bytes(stderr)
        if code:
            raise ValueError(f"cargo-mutants failed with exit {code}; inspect {output}")
        report = json.loads((output / "mutants.out/outcomes.json").read_text())
        print(json.dumps(check_report(output / "mutants.out", report, campaign), sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f"mutation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
