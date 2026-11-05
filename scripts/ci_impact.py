"""Author: Jeff.Liu. Conservative CI routing for a fixed, tested fixture group."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


QUICK_PATHS = frozenset({
    "apps/desktop/tests/fixtures/provider_api.py",
    "scripts/terminal-latency-probe.py",
    "scripts/test_loopback_fixtures.py",
    "scripts/test_terminal_latency_probe.py",
})
CI_PATHS = frozenset({
    ".github/workflows/ci.yml",
    "scripts/ci_impact.py",
    "scripts/test_ci_impact.py",
    "apps/desktop/tests/ci-workflow.test.mjs",
})
ROOT = Path(__file__).resolve().parents[1]


def parse_changes(raw):
    if not raw:
        return []
    fields = raw.split(b"\0")
    if fields.pop() != b"" or len(fields) % 2:
        raise ValueError("incomplete diff")
    changes = []
    for header, path in zip(fields[::2], fields[1::2]):
        match = re.fullmatch(rb":([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} ([A-Z][0-9]*)", header)
        if not match or not path:
            raise ValueError("invalid diff record")
        old, new, status = (value.decode("ascii") for value in match.groups())
        changes.append((status, old, new, path.decode("utf-8")))
    return changes


def classify(changes):
    return "quick" if changes and all(
        status == "M" and old == new and old in {"100644", "100755"} and path in QUICK_PATHS
        for status, old, new, path in changes
    ) else "full"


def read_changes(base, head, root):
    result = subprocess.run(
        ["git", "diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--ignore-submodules=none",
         "--no-textconv", base + "..." + head, "--"],
        cwd=root, check=True, capture_output=True, timeout=15,
    )
    if result.stderr:
        raise ValueError("git reported an unreliable diff")
    return parse_changes(result.stdout)


def plan(event, base, head, root=ROOT):
    fallback = {"route": "full", "exercise_quick": "false"}
    if event != "pull_request" or not all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in [base, head]):
        return fallback
    try:
        changes = read_changes(base, head, root)
    except (OSError, ValueError, subprocess.SubprocessError):
        return fallback
    return {"route": classify(changes),
            "exercise_quick": "true" if any(path in CI_PATHS for _, _, _, path in changes) else "false"}


def admit(route, exercise, planned, quick, frontend, native, package):
    if planned != "success":
        return False
    if (route, exercise) == ("quick", "false"):
        return quick == "success" and (frontend, native, package) == ("skipped",) * 3
    if route == "full" and (frontend, native, package) == ("success",) * 3:
        return (exercise == "false" and quick == "skipped") or (exercise == "true" and quick == "success")
    return False


def main():
    if sys.argv[1:] == ["plan"]:
        selected = plan(os.environ.get("EVENT_NAME", ""), os.environ.get("BASE_SHA", ""), os.environ.get("HEAD_SHA", ""))
        print(json.dumps(selected, sort_keys=True))
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            for name, value in selected.items():
                output.write(name + "=" + value + "\n")
        return 0
    if sys.argv[1:] == ["gate"]:
        keys = ["ROUTE", "EXERCISE_QUICK", "PLAN_RESULT", "QUICK_RESULT", "FRONTEND_RESULT", "NATIVE_RESULT", "PACKAGE_RESULT"]
        allowed = admit(*(os.environ.get(key, "") for key in keys))
        print("selected CI route passed" if allowed else "selected CI route did not pass")
        return 0 if allowed else 1
    raise SystemExit("expected plan or gate")


if __name__ == "__main__":
    raise SystemExit(main())
