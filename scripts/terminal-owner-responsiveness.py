#!/usr/bin/env python3
"""Author: Jeff.Liu. Finite owner-RPC→parser marker fixture; separately gated execution."""
import importlib.util
from pathlib import Path


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


smoke = load('responsiveness_smoke', 'background-smoke.py')
performance = load('responsiveness_performance', 'terminal-performance.py')
memory = load('responsiveness_memory', 'yam-memory.py')


import argparse
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time

RATES = (10 * 1024, 100 * 1024, 1024 * 1024)
SCOPE = "owner-write-RPC-to-parser-projection-marker"


def marker(nonce, phase, sequence):
    if not isinstance(nonce, str) or not re.fullmatch(r"[0-9a-f]{32}", nonce) or type(phase) is not int or not 0 <= phase < 3 or type(sequence) is not int or not 0 <= sequence < 10000:
        raise ValueError("Invalid fixture marker")
    return f"ECHO_{nonce}_{phase}_{sequence}"


def chunk(nonce, phase, sequence):
    marker(nonce, phase, sequence)
    header = f"FLOOD_{nonce}_{phase}:{sequence} "
    return (header + "x" * (4095 - len(header)) + "\n").encode("ascii")


def summarize(samples, scheduled):
    if type(scheduled) is not int or not 1 <= scheduled <= 300 or len(samples) > scheduled:
        raise ValueError("Invalid probe denominator")
    valid = {"complete", "timeout", "rejected", "duplicate", "aborted"}
    if any(s.get("status") not in valid for s in samples):
        raise ValueError("Invalid probe outcome")
    complete = [s for s in samples if s["status"] == "complete"]
    latencies = [performance.number(s["latency_ms"]) for s in complete]
    writes = [performance.number(s["write_ms"]) for s in samples if "write_ms" in s]
    result = {"scope": SCOPE, "scheduled": scheduled, "observed": len(samples), "complete": len(complete),
              "missing": scheduled - len(samples), "complete_ratio": len(complete) / scheduled,
              "timeouts": sum(s["status"] == "timeout" for s in samples),
              "rejected": sum(s["status"] == "rejected" for s in samples),
              "duplicates": sum(s["status"] == "duplicate" for s in samples), "queue_bytes": None,
              "p50_ms": performance.nearest_rank(latencies, .5) if latencies else None,
              "p95_ms": performance.nearest_rank(latencies, .95) if latencies else None,
              "max_ms": max(latencies) if latencies else None,
              "write_rpc_p95_ms": performance.nearest_rank(writes, .95) if writes else None}
    result["passed"] = len(complete) == scheduled and result["p95_ms"] <= 250
    return result


def environment(root, launcher, python):
    if not all(Path(p).is_absolute() for p in (root, launcher, python)):
        raise ValueError("Fixture paths must be absolute")
    return {"HOME": str(root / "home"), "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"), "TMPDIR": str(root / "tmp"),
            "SHELL": str(launcher), "YAM_OUTPUT_STAGE_DIAGNOSTICS": "1", "PATH": str(python.parent), "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"}


def owner_command(app, executable, terminal_node=None):
    command = [str(executable), '--yam-background']
    if terminal_node is None and not (app / 'Contents/Resources/target/terminal-runtime/yam-terminal.cjs').is_file():
        return command
    selected = terminal_node if terminal_node is not None else shutil.which('node')
    if selected is None:
        raise ValueError('Node unavailable: pass --terminal-node with an installed or YAM private Node path')
    node = Path(selected)
    if not node.is_absolute() or not node.is_file() or not os.access(node, os.X_OK):
        raise ValueError('Invalid --terminal-node executable')
    # The owner verifies Node version and the real parser protocol before any fixture task.
    return command + ['--yam-terminal-node', str(node.resolve())]


NATIVE_STAGE_PREFIX = b'YAM_OUTPUT_STAGES_V1 '


def validate_native_output_stage(row):
    def keys(value, expected):
        if type(value) is not dict or set(value) != set(expected.split()): raise ValueError('Invalid native stage fields')
    def integer(value):
        if type(value) is not int or not 0 <= value <= 2**64-1: raise ValueError('Invalid native stage number')
    def duration(value):
        keys(value,'count sum_ns max_ns errors')
        for item in value.values(): integer(item)
        if value['errors'] > value['count'] or not value['max_ns'] <= value['sum_ns'] <= value['count'] * value['max_ns']: raise ValueError('Invalid native stage duration')
        if value['count'] == 0 and any(value.values()): raise ValueError('Invalid empty native stage')
    def array(value, count):
        if type(value) is not list or len(value) != count: raise ValueError('Invalid native stage counts')
        for item in value: integer(item)
    keys(row,'version read_count read_bytes read_min read_max read_buckets publish_count publish_bytes read_errors overflow log_wait parser_total append emit parser')
    for key in ('version','read_count','read_bytes','read_min','read_max','publish_count','publish_bytes','read_errors'): integer(row[key])
    if row['version'] != 1 or type(row['overflow']) is not bool: raise ValueError('Invalid native stage version')
    array(row['read_buckets'],4)
    for key in ('log_wait','parser_total','append','emit'): duration(row[key])
    parser=row['parser'];keys(parser,'serial reply replies outcomes overflow')
    if type(parser['overflow']) is not bool: raise ValueError('Invalid native stage overflow')
    duration(parser['serial']);duration(parser['reply']);array(parser['replies'],3);array(parser['outcomes'],10)
    if row['overflow'] or parser['overflow']: raise ValueError('Overflowed native stages')
    if sum(row['read_buckets']) != row['read_count'] or row['read_max'] > 4096: raise ValueError('Invalid native read histogram')
    if row['read_count'] == 0:
        if row['read_bytes'] or row['read_min'] or row['read_max']: raise ValueError('Invalid empty native reads')
    elif not 1 <= row['read_min'] <= row['read_max'] <= 4096 or not row['read_min'] * row['read_count'] <= row['read_bytes'] <= row['read_max'] * row['read_count']:
        raise ValueError('Invalid native read bounds')
    if row['read_count']:
        occupied=[i for i,count in enumerate(row['read_buckets']) if count]
        bucket=lambda size:sum(size>edge for edge in (256,1024,2048))
        if bucket(row['read_min']) != occupied[0] or bucket(row['read_max']) != occupied[-1]: raise ValueError('Invalid native read extrema')
    remaining=list(row['read_buckets']);lower=upper=0
    if row['read_count']:
        # Reserve observations witnessing both extrema before bounding the rest.
        for size in dict.fromkeys((row['read_min'],row['read_max'])):
            index=bucket(size);remaining[index]-=1;lower+=size;upper+=size
        if any(count<0 for count in remaining): raise ValueError('Invalid native read extrema')
        lower+=sum(count*max(size,row['read_min']) for count,size in zip(remaining,(1,257,1025,2049)))
        upper+=sum(count*min(size,row['read_max']) for count,size in zip(remaining,(256,1024,2048,4096)))
    if not lower <= row['read_bytes'] <= upper: raise ValueError('Invalid native read totals')
    if row['publish_count'] > row['read_count']+1 or (row['publish_count']==0) != (row['publish_bytes']==0): raise ValueError('Invalid native publish counts')
    if row['log_wait']['count'] != row['publish_count'] or row['append']['count'] != row['log_wait']['count']-row['log_wait']['errors'] or row['emit']['count'] != row['append']['count']: raise ValueError('Invalid native output stage order')
    calls=row['parser_total']['count'];outcomes=parser['outcomes']
    if calls > row['append']['count'] or parser['serial']['count'] != calls or sum(outcomes) != calls or row['parser_total']['errors'] != sum(outcomes[1:]) or parser['serial']['errors'] != outcomes[1]: raise ValueError('Invalid parser call counts')
    if parser['replies'] != [outcomes[0]+outcomes[9],outcomes[8],outcomes[7]] or parser['reply']['count'] != sum(parser['replies']) or parser['reply']['errors'] != sum(parser['replies'][1:]): raise ValueError('Invalid parser reply counts')
    return row


def unique_native_stage_fields(pairs):
    result={}
    for key,value in pairs:
        if key in result: raise ValueError('Duplicate native stage field')
        result[key]=value
    return result


class NativeOutputStages:
    """Two anonymous summaries; continuously drain without retaining arbitrary stderr."""
    def __init__(self):
        self.pending=bytearray();self.discarding=False;self.rows=[];self.errors=set();self.finished=False
    def feed(self, data):
        for byte in data:
            if byte == 10:
                if not self.discarding and self.pending.startswith(NATIVE_STAGE_PREFIX):
                    try:
                        row=validate_native_output_stage(json.loads(self.pending[len(NATIVE_STAGE_PREFIX):],object_pairs_hook=unique_native_stage_fields))
                        if len(self.rows) == 2: self.errors.add('extra_row')
                        else: self.rows.append(row)
                    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError): self.errors.add('invalid_row')
                self.pending.clear();self.discarding=False
            elif not self.discarding:
                self.pending.append(byte)
                if len(self.pending) <= len(NATIVE_STAGE_PREFIX) and not NATIVE_STAGE_PREFIX.startswith(self.pending):
                    self.pending.clear();self.discarding=True
                elif len(self.pending) > 2048:
                    self.errors.add('line_too_long');self.pending.clear();self.discarding=True
    def finish(self):
        if self.pending: self.errors.add('truncated_row')
        self.pending.clear();self.finished=True
    def result(self):
        rows=list(self.rows);errors=set(self.errors)
        if not self.finished: errors.add('capture_unfinished')
        if len(rows) != 2: errors.add('missing_rows')
        for row in rows:
            if row['read_errors'] or any(row[key]['errors'] for key in ('log_wait','parser_total','append','emit')): errors.add('stage_error')
            if row['parser_total']['count'] != row['append']['count']: errors.add('parser_missing')
        return {'version':1,'enabled':True,'complete':not errors,'rows':rows,'errors':sorted(errors)}


def new_root(path, token):
    smoke.unlinked(path)
    if not re.fullmatch(r"[0-9a-f]{32}", token): raise ValueError("Invalid ownership token")
    path.mkdir(mode=0o700)
    with (path / "ownership").open("x") as output:
        os.chmod(output.name, 0o600)
        output.write(token)


def probe(call, identity, nonce, phase, sequence, deadline, clock, sleep, nanoclock=None):
    expected = marker(nonce, phase, sequence)
    start = clock()
    submitted_ns = nanoclock() if nanoclock is not None else int(start * 1e9)
    result = {"phase": phase, "sequence": sequence, "status": "aborted", "submitted_ns": submitted_ns}
    if start >= deadline: return result
    try:
        call("write_session", {"session_id": identity, "data": f"INPUT_{nonce}_{phase}_{sequence}" + ("_中" if phase == 2 and sequence == 99 else "") + "\n"}, deadline=deadline)
    except (OSError, ValueError, AssertionError):
        ended = clock()
        ended_ns = nanoclock() if nanoclock is not None else int(ended * 1e9)
        return {**result, "status": "timeout" if ended >= deadline else "rejected", "late": ended >= deadline,
                "write_end_ns": ended_ns, "write_ms": max(0, ended_ns - submitted_ns) / 1e6}
    acknowledged = clock()
    acknowledged_ns = nanoclock() if nanoclock is not None else int(acknowledged * 1e9)
    result["acknowledged_ns"] = acknowledged_ns
    result["write_ms"] = max(0, acknowledged_ns - submitted_ns) / 1e6
    if acknowledged >= deadline: return {**result, "status": "timeout", "late": True}
    # The observation second begins AFTER acknowledgement, not after submission.
    polling_deadline = min(deadline, acknowledged + 1)
    for _ in range(50):
        if clock() >= polling_deadline: break
        try:
            frame = call("read_terminal_frame", {"session_id": identity}, deadline=polling_deadline)
            observed = clock()
            observed_ns = nanoclock() if nanoclock is not None else int(observed * 1e9)
            result["observed_ns"] = observed_ns
            if observed >= polling_deadline: return {**result, "status": "timeout", "late": True}
            data = frame["projection"]["data"]
            if not isinstance(data, str) or len(data.encode()) > 8 * 1024 * 1024 or frame.get("persisted") is True:
                raise ValueError("Invalid current projection")
            # Exact line prevents an INPUT/kernel echo from masquerading as child receipt.
            matches = sum(line.rstrip() == expected for line in re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", data).replace("\r", "").split("\n"))
            if matches:
                if clock() >= polling_deadline: return {**result, "status": "timeout", "late": True}
                return {**result, "status": "complete" if matches == 1 else "duplicate",
                        "latency_ms": max(0, observed_ns - submitted_ns) / 1e6}
        except (OSError, ValueError, AssertionError, KeyError, TypeError):
            ended = clock()
            return {**result, "status": "timeout" if ended >= polling_deadline else "rejected", "late": ended >= polling_deadline}
        remaining = polling_deadline - clock()
        if remaining <= 0: break
        sleep(min(.02, remaining))
    return {**result, "status": "timeout"}


def cleanup(owner, identities, sessions, call, inspect, signal_process, deadline, clock, diagnostics=None, parser_pid=None):
    errors = []
    changes = {}
    outcome = diagnostics["cleanup_outcome"] if diagnostics is not None else None
    def skipped(command, arguments, reason):
        if diagnostics is not None:
            diagnostics["cleanup_requests"].append({"operation":command,"target":"owner" if command=="shutdown" else ("echo" if sessions.index(arguments["session_id"])==0 else "flood"),"attempted":False,"budget_ms":0,"elapsed_ms":0,"outcome":reason,"rejection_kind":None,"parser_termination_attempted_before_call":outcome["parser_signal_attempted"]})
    def current_identity(pid):
        try: return inspect(pid)
        except (OSError, ValueError, subprocess.SubprocessError):
            errors.append("inspection_failed")
            return False
    def request(command, arguments):
        if clock() >= deadline:
            errors.append("cleanup_deadline")
            skipped(command, arguments, "deadline_exhausted")
            return
        call(command, arguments)
    for identity in list(sessions):
        try: request("stop_session", {"session_id": identity})
        except (OSError, ValueError, AssertionError, EOFError, KeyError, TypeError): errors.append("stop_failed")
    def changed(pid, current, expected):
        errors.append("process_identity_changed")
        changes[pid] = {"role": "owner" if owner is not None and pid == owner.pid else "descendant",
                        "changed_fields": [key for key in ("pid", "parent", "started", "executable") if isinstance(current, dict) and current.get(key) != expected.get(key)]}
    def matched_zombie(current, expected):
        return isinstance(current, dict) and current.get("zombie") is True and all(current.get(key) == expected.get(key) for key in ("pid", "parent", "started"))
    descendants = {pid: expected for pid, expected in identities.items() if owner is None or pid != owner.pid}
    for sig in (signal.SIGTERM, signal.SIGKILL):
        pending = set()
        for pid, expected in descendants.items():
            current = current_identity(pid)
            if current is None or matched_zombie(current, expected): continue
            if current != expected:
                changed(pid, current, expected)
                continue
            if clock() >= deadline:
                errors.append("cleanup_deadline")
                continue
            if outcome is not None:
                outcome["fallback_used"] = True
                if pid == parser_pid: outcome["parser_signal_attempted"] = True
            try: signal_process(pid, sig)
            except ProcessLookupError: pass
            except OSError: errors.append("signal_failed")
            pending.add(pid)
        wait_end = min(deadline, clock() + 3)
        # The count is a second finite bound even for a broken injected clock.
        for _ in range(300):
            for pid in list(pending):
                current = current_identity(pid)
                if current is None or matched_zombie(current, descendants[pid]): pending.remove(pid)
                elif current != descendants[pid]:
                    changed(pid, current, descendants[pid]); pending.remove(pid)
            if not pending or clock() >= wait_end: break
            time.sleep(min(.01, max(0, wait_end - clock())))
    child_terminated = {}
    for pid, expected in descendants.items():
        current = current_identity(pid)
        child_terminated[pid] = current is None or matched_zombie(current, expected)
    if owner is not None and owner.pid in identities:
        current = current_identity(owner.pid)
        if current is not None and current != identities[owner.pid] and not matched_zombie(current, identities[owner.pid]): changed(owner.pid, current, identities[owner.pid])
    children_safe = all(child_terminated.values()) and not set(errors) & {"process_identity_changed", "inspection_failed", "cleanup_deadline"}
    if outcome is not None: outcome["child_first_barrier_passed"] = children_safe
    if children_safe:
        try: request("shutdown", {})
        except (OSError, ValueError, AssertionError, EOFError, KeyError, TypeError): errors.append("shutdown_failed")
    else: skipped("shutdown", {}, "not_attempted")
    def wait_direct():
        if owner is None: return True
        if clock() >= deadline:
            errors.append("cleanup_deadline")
            return False
        try:
            owner.wait(timeout=max(.01, min(3, deadline - clock())))
            return True
        except subprocess.TimeoutExpired: errors.append("wait_timeout")
        except (OSError, ValueError, AttributeError): errors.append("wait_failed")
        return False
    waited = wait_direct()
    if owner is not None and not waited:
        for sig, method in ((signal.SIGTERM, "terminate"), (signal.SIGKILL, "kill")):
            if clock() >= deadline:
                errors.append("cleanup_deadline"); break
            expected = identities.get(owner.pid)
            current = current_identity(owner.pid) if expected is not None else None
            if expected is not None and matched_zombie(current, expected):
                waited = wait_direct()
                if waited: break
                continue
            if outcome is not None: outcome["fallback_used"] = True
            if children_safe and expected is not None and current == expected:
                try: signal_process(owner.pid, sig)
                except ProcessLookupError: pass
                except OSError: errors.append("signal_failed")
            else:
                if expected is not None and current is not None and current != expected: changed(owner.pid, current, expected)
                # Exact retained unreaped direct child handle cannot be PID-reused.
                try: getattr(owner, method)()
                except (OSError, ValueError, AttributeError): errors.append(method + "_failed")
            waited = wait_direct()
            if waited: break
    def final_absence():
        result = {}
        for pid, expected in identities.items():
            current = current_identity(pid)
            result[pid] = current is None
            if current is not None and current != expected and not matched_zombie(current, expected): changed(pid, current, expected)
        return result
    absent = final_absence()
    final_end = min(deadline, clock() + 3)
    if waited:
        for _ in range(300):
            if all(absent.values()) or clock() >= final_end: break
            time.sleep(min(.01, max(0, final_end - clock())))
            absent = final_absence()
    exited = all(absent.values())
    if outcome is not None:
        outcome["direct_child_waited"] = waited
        outcome["final_all_identities_absent"] = exited
        outcome["graceful_shutdown_verified"] = owner is not None and owner.pid in identities and parser_pid in identities and outcome["owner_shutdown_before_parser_signal"] and not outcome["parser_signal_attempted"] and not outcome["fallback_used"] and waited and exited and children_safe
    for pid, change in changes.items(): change["final_absent"] = absent[pid]
    return {"complete": waited and exited and not set(errors) & {"process_identity_changed", "inspection_failed", "cleanup_deadline"},
            "direct_child_waited": waited, "verified_descendants_exited": exited, "errors": errors, "identity_changes": list(changes.values())}


def inspect_process(pid):
    if type(pid) is not int or pid <= 1: raise ValueError("Invalid owned PID")
    value = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'pid=,ppid=,rss=,stat=,lstart=,comm='],
                           capture_output=True, text=True, timeout=1)
    if not value.stdout.strip(): return None
    parts = value.stdout.strip().split(None, 9)
    if len(parts) != 10 or not re.fullmatch(r"[RSDITUVWZX][+<>NslEL]*", parts[3]):
        raise ValueError("Invalid process status observation")
    row = memory.parse_processes(" ".join(parts[:3] + parts[4:])).get(pid)
    if row is None: raise ValueError("Process observation PID mismatch")
    result = {key: row[key] for key in ("pid", "parent", "started", "executable")}
    if parts[3].startswith("Z"): result["zombie"] = True
    return result


def read_private(path, limit=65536):
    return json.loads(smoke.regular_bytes(path, limit))


def write_result(path, value):
    if "diagnostics" in value: validate_diagnostics(value["diagnostics"])
    encoded = json.dumps(value, ensure_ascii=False).encode()
    if len(encoded) > 2 * 1024 * 1024: raise ValueError("Fixture evidence exceeds budget")
    performance.write_evidence(path, value)



def parser_image(row, resources, authenticated_pid=None):
    image=Path(row['executable'])
    legacy=image.name=='yam-terminal' and image.is_relative_to(resources)
    return legacy or (row['pid']==authenticated_pid and image.is_absolute())


def verify_identities(owner, parser_pid, ready, nonce, resources, python, inspect):
    if owner.poll() is not None or len(ready) != 2:
        raise ValueError("Incomplete owned process gate")
    root = inspect(owner.pid)
    parser = inspect(parser_pid)
    if not root or not parser or parser['parent'] != owner.pid or not parser_image(parser, resources, parser_pid):
        raise ValueError("Parser identity unavailable")
    result = {owner.pid: root, parser_pid: parser}
    if {r.get('mode') for r in ready} != {'fixture-echo', 'fixture-flood'}:
        raise ValueError("Invalid workload identity")
    for record in ready:
        pid = record.get('pid')
        if type(pid) is not int or pid <= 1 or pid in result or record.get('nonce') != nonce:
            raise ValueError("Invalid workload ready receipt")
        row = inspect(pid)
        if not row or row['parent'] != owner.pid or Path(row['executable']).resolve() != python.resolve():
            raise ValueError("Workload process identity unavailable")
        result[pid] = row
    return result


def create_sessions(call, root, sessions, on_created=None):
    for mode in ('fixture-echo', 'fixture-flood'):
        value = call('create_session', {'cwd': str(root), 'command': mode})
        identity = value.get('session_id')
        if not isinstance(identity, str) or not identity or identity in sessions:
            raise ValueError("Invalid created session identity")
        sessions.append(identity)
        call('resize_session', {'session_id': identity, 'cols': 100, 'rows': 40})
        if on_created is not None: on_created(mode, identity)
    return sessions


def bounded_call(rpc, descriptor, client, sequence, command, arguments, deadline, clock):
    remaining = deadline - clock()
    if remaining <= 0: raise ValueError("Fixture soft deadline reached")
    return rpc(descriptor, client, sequence, command, arguments,
               timeout=min(10, remaining), max_response_bytes=64 * 1024 * 1024)


def remove_root(root, token):
    smoke.unlinked(root)
    marker_path = root / 'ownership'
    if smoke.regular_bytes(marker_path, 32).decode() != token:
        raise ValueError("Fixture ownership changed")
    shutil.rmtree(root)


def validate_ledger(value, nonce, phase):
    required = {'nonce','phase','bytes','markers_bytes','chunks','partial_bytes','elapsed','stall_seconds','done'}
    if not isinstance(value, dict) or set(value) != required or value['nonce'] != nonce or value['phase'] != phase or value['done'] is not True:
        raise ValueError("Invalid phase ledger")
    for key in ('bytes','markers_bytes','chunks','partial_bytes'):
        if type(value[key]) is not int or value[key] < 0: raise ValueError("Invalid byte ledger")
    if value['partial_bytes'] >= 4096 or value['bytes'] != value['chunks'] * 4096 + value['partial_bytes'] or value['markers_bytes'] > 4096:
        raise ValueError("Partial byte ledger mismatch")
    elapsed = performance.number(value['elapsed'])
    stalls = performance.number(value['stall_seconds'])
    if not 0 < elapsed <= 45 or stalls > elapsed:
        raise ValueError("Invalid phase duration")
    return {**value, 'bytes': value['bytes'] + value['markers_bytes'],
            'achieved_bytes_per_second': value['bytes'] / elapsed}

def phase_diagnostic(ledger, phase, samples):
    # Input is the existing validated ledger, whose legacy bytes includes markers.
    data = ledger['bytes'] - ledger['markers_bytes']
    rows = [row for row in samples if row['phase'] == phase]
    rate = RATES[phase]
    return {'phase':phase,'offered_bytes_per_second':rate,'offered_duration_ms':5000,
            'nominal_offer_bytes':rate*5,'written_data_bytes':data,'marker_bytes':ledger['markers_bytes'],
            'elapsed_ms':ledger['elapsed']*1000,'achieved_data_bytes_per_second':data/ledger['elapsed'],
            'producer_select_stall_ms':ledger['stall_seconds']*1000,'complete_chunks':ledger['chunks'],
            'partial_data_bytes':ledger['partial_bytes'],'ledger_complete':ledger['done'],
            'scheduled_probes':100,'observed_probes':len(rows),
            'completed_probes':sum(row['status']=='complete' for row in rows),
            'probe_phase_alignment':'scheduled-label-only'}


def validate_diagnostics(value):
    def keys(row, expected):
        if type(row) is not dict or set(row) != set(expected.split()): raise ValueError('Invalid fixture diagnostics fields')
    def number(value, maximum=None):
        if type(value) not in (int,float) or not math.isfinite(value) or value < 0 or (maximum is not None and value > maximum): raise ValueError('Invalid fixture diagnostics number')
    def integer(value, maximum=None):
        if type(value) is not int: raise ValueError('Invalid fixture diagnostics integer')
        number(value, maximum)
    keys(value,'version scope cleanup_rpc_cap_ms cleanup_requests cleanup_outcome phases')
    if type(value['version']) is not int or value['version'] != 2 or value['scope'] != 'fixture-cleanup-and-phase-delivery' or type(value['cleanup_rpc_cap_ms']) is not int or value['cleanup_rpc_cap_ms'] != 1000: raise ValueError('Invalid fixture diagnostics version')
    requests=value['cleanup_requests'];phases=value['phases']
    if type(requests) is not list or len(requests)>3 or type(phases) is not list or len(phases)>3: raise ValueError('Fixture diagnostics exceed bounds')
    outcomes={'acknowledged','server_rejected','transport_timeout','transport_closed','transport_error','protocol_or_validation_error','deadline_exhausted','not_attempted'}
    for row in requests:
        keys(row,'operation target attempted budget_ms elapsed_ms outcome rejection_kind parser_termination_attempted_before_call')
        kind = row['rejection_kind']
        if (row['outcome'] == 'server_rejected' and (type(kind) is not str or kind not in smoke.REJECTION_KINDS)) or (row['outcome'] != 'server_rejected' and kind is not None): raise ValueError('Invalid cleanup rejection kind')
        if row['operation'] not in ('stop_session','shutdown') or row['target'] not in ('echo','flood','owner') or (row['operation']=='shutdown') != (row['target']=='owner') or type(row['outcome']) is not str or row['outcome'] not in outcomes: raise ValueError('Invalid cleanup request provenance')
        for key in ('attempted','parser_termination_attempted_before_call'):
            if type(row[key]) is not bool: raise ValueError('Invalid cleanup request flag')
        number(row['budget_ms'],1000);number(row['elapsed_ms'])
        if not row['attempted'] and (row['budget_ms']!=0 or row['elapsed_ms']!=0 or row['outcome'] not in ('not_attempted','deadline_exhausted')): raise ValueError('Invalid unattempted cleanup request')
    outcome=value['cleanup_outcome']
    keys(outcome,'child_first_barrier_passed parser_signal_attempted owner_shutdown_acknowledged owner_shutdown_before_parser_signal fallback_used direct_child_waited final_all_identities_absent graceful_shutdown_verified')
    if any(type(flag) is not bool for flag in outcome.values()): raise ValueError('Invalid cleanup outcome flag')
    if outcome['graceful_shutdown_verified'] and (not outcome['owner_shutdown_before_parser_signal'] or not outcome['owner_shutdown_acknowledged'] or outcome['parser_signal_attempted'] or outcome['fallback_used'] or not outcome['direct_child_waited'] or not outcome['final_all_identities_absent']): raise ValueError('Unverified graceful shutdown')
    previous=-1
    for row in phases:
        keys(row,'phase offered_bytes_per_second offered_duration_ms nominal_offer_bytes written_data_bytes marker_bytes elapsed_ms achieved_data_bytes_per_second producer_select_stall_ms complete_chunks partial_data_bytes ledger_complete scheduled_probes observed_probes completed_probes probe_phase_alignment')
        integer(row['phase'],2)
        if row['phase']<=previous: raise ValueError('Invalid phase order')
        previous=row['phase'];rate=RATES[row['phase']]
        for key in ('offered_bytes_per_second','offered_duration_ms','nominal_offer_bytes','written_data_bytes','marker_bytes','complete_chunks','partial_data_bytes','scheduled_probes','observed_probes','completed_probes'): integer(row[key])
        if row['offered_bytes_per_second']!=rate or row['offered_duration_ms']!=5000 or row['nominal_offer_bytes']!=rate*5 or row['scheduled_probes']!=100 or row['probe_phase_alignment']!='scheduled-label-only' or row['ledger_complete'] is not True: raise ValueError('Invalid phase scope')
        if row['partial_data_bytes']>=4096 or row['marker_bytes']>4096 or row['written_data_bytes']!=row['complete_chunks']*4096+row['partial_data_bytes'] or not 0<=row['completed_probes']<=row['observed_probes']<=100: raise ValueError('Invalid phase accounting')
        number(row['elapsed_ms'],45000);number(row['producer_select_stall_ms'],row['elapsed_ms']);number(row['achieved_data_bytes_per_second'])
        if row['elapsed_ms']<=0 or not math.isclose(row['achieved_data_bytes_per_second'],row['written_data_bytes']/(row['elapsed_ms']/1000),rel_tol=1e-12,abs_tol=0): raise ValueError('Invalid phase delivery rate')
    return value


# Generated launcher is the only SHELL. It never evaluates a command or starts descendants.
LAUNCHER = r'''
import json, os, re, select, sys, time, tty
from pathlib import Path
ROOT = Path(__ROOT__)
NONCE = __NONCE__
mode = sys.argv[3] if len(sys.argv) == 4 and sys.argv[1:3] == ['-l', '-c'] else None
if mode not in ('fixture-echo', 'fixture-flood'): raise SystemExit(2)
os.umask(0o077)
tty.setraw(0)
os.set_blocking(1, False)
started = time.monotonic()
absolute = started + 45

def save(name, value):
    target = ROOT / name
    temporary = ROOT / (name + '.tmp')
    data = json.dumps(value).encode()
    if len(data) > 65536: raise SystemExit(3)
    with temporary.open('wb') as out: out.write(data)
    os.replace(temporary, target)

def send(data, deadline):
    cursor = 0
    stalls = 0.0
    while cursor < len(data) and time.monotonic() < min(deadline, absolute):
        try: cursor += os.write(1, data[cursor:])
        except BlockingIOError:
            before = time.monotonic()
            select.select([], [1], [], min(.02, max(0, deadline - before)))
            stalls += time.monotonic() - before
    return cursor, stalls

save(mode + '-ready.json', {'pid': os.getpid(), 'nonce': NONCE, 'mode': mode})
while not (ROOT / 'identity-gate').exists():
    if time.monotonic() >= absolute: raise SystemExit(4)
    time.sleep(.01)
if (ROOT / 'identity-gate').read_text() != NONCE: raise SystemExit(5)
if mode == 'fixture-echo':
    send(b'\x1b[?1049h', absolute)
    pending = bytearray()
    seen = []
    while time.monotonic() < absolute:
        if not select.select([0], [], [], .02)[0]: continue
        value = os.read(0, 256)
        if not value: break
        pending.extend(value)
        if len(pending) > 512: raise SystemExit(6)
        while b'\n' in pending:
            raw, _, rest = pending.partition(b'\n'); pending = bytearray(rest)
            line = raw.decode('utf-8')
            match = re.fullmatch('INPUT_' + NONCE + r'_([0-2])_([0-9]{1,4})(?:_中)?', line)
            if not match: raise SystemExit(7)
            phase, sequence = map(int, match.groups())
            receipt = 'ECHO_' + NONCE + '_' + str(phase) + '_' + str(sequence)
            seen.append([phase, sequence])
            if len(seen) > 300: raise SystemExit(8)
            written, _ = send(b'\x1b[2J\x1b[H' + receipt.encode() + b'\n', absolute)
            if written == 0: raise SystemExit(9)
            save('echo-seen.json', {'nonce': NONCE, 'seen': seen})
else:
    rates = (10240, 102400, 1048576)
    for phase, rate in enumerate(rates):
        control = ROOT / ('phase-' + str(phase) + '-start')
        while not control.exists():
            if time.monotonic() >= absolute: raise SystemExit(10)
            time.sleep(.01)
        if control.read_text() != NONCE: raise SystemExit(11)
        phase_start = time.monotonic()
        deadline = min(phase_start + 5, absolute)
        begin = ('PHASE_BEGIN_' + NONCE + '_' + str(phase) + '\n').encode()
        markers, stalls = send(begin, deadline)
        save('phase-' + str(phase) + '-running.json', {'nonce': NONCE, 'phase': phase})
        chunks = 0; partial = 0; total = 0
        next_write = phase_start
        while time.monotonic() < deadline:
            if time.monotonic() < next_write:
                time.sleep(min(.02, next_write - time.monotonic())); continue
            header = 'FLOOD_' + NONCE + '_' + str(phase) + ':' + str(chunks) + ' '
            data = (header + 'x' * (4095 - len(header)) + '\n').encode('ascii')
            before = time.monotonic()
            written, waited = send(data, deadline)
            total += written; stalls += waited
            if written != 4096: partial = written; break
            chunks += 1
            # No catch-up backlog: next slot begins after this completed chunk.
            next_write = max(before + 4096 / rate, time.monotonic())
        end = ('PHASE_END_' + NONCE + '_' + str(phase) + '\n').encode()
        written, waited = send(end, min(absolute, deadline + 1))
        markers += written; stalls += waited
        elapsed = time.monotonic() - phase_start
        save('phase-' + str(phase) + '-done.json', {'nonce': NONCE, 'phase': phase,
             'bytes': total, 'markers_bytes': markers, 'chunks': chunks, 'partial_bytes': partial,
             'elapsed': elapsed, 'stall_seconds': stalls, 'done': written == len(end) and markers == len(begin) + len(end)})
'''


def launcher_text(root, nonce, python):
    if '\n' in str(python) or ' ' in str(python) or not python.is_absolute():
        raise ValueError('Unsupported absolute Python shebang')
    marker(nonce, 0, 0)
    return '#!' + str(python) + '\n' + LAUNCHER.replace('__ROOT__', repr(str(root))).replace('__NONCE__', repr(nonce))


class Run:
    """One bounded fixture, one independent watchdog, no request queue or product state."""
    def __init__(self, hard_deadline, clock=time.monotonic, inspect=inspect_process, kill=os.kill):
        self.clock = clock
        self.hard_deadline = hard_deadline
        self.soft_deadline = hard_deadline - 30
        self.inspect = inspect
        self.kill = kill
        self.owner = None
        self.identities = {}
        self.sessions = []
        self.descriptor = None
        self.cancelled = threading.Event()
        self.finished = threading.Event()
        self.cleanup_lock = threading.Lock()
        self.cleanup_result = None
        self.client = secrets.token_hex(32)
        self.sequence = 0
        self.parser_pid = None
        self.diagnostics = {"version":2,"scope":"fixture-cleanup-and-phase-delivery","cleanup_rpc_cap_ms":1000,"cleanup_requests":[],"cleanup_outcome":{key:False for key in ("child_first_barrier_passed","parser_signal_attempted","owner_shutdown_acknowledged","owner_shutdown_before_parser_signal","fallback_used","direct_child_waited","final_all_identities_absent","graceful_shutdown_verified")},"phases":[]}
    def call(self, command, arguments=None, deadline=None):
        if self.cancelled.is_set(): raise ValueError('Fixture cancelled')
        self.sequence += 1
        result = bounded_call(smoke.rpc, self.descriptor, self.client, self.sequence, command,
                              arguments or {}, min(self.soft_deadline, deadline) if deadline is not None else self.soft_deadline, self.clock)
        if self.cancelled.is_set(): raise ValueError('Late reply after cancellation')
        return result
    def close(self):
        self.cancelled.set()
        with self.cleanup_lock:
            if self.cleanup_result is not None: return self.cleanup_result
            client = secrets.token_hex(32)
            sequence = 0
            def call(command, arguments):
                nonlocal sequence
                started = self.clock()
                budget = max(0, min(1, self.hard_deadline - 10 - started))
                row = {"operation":command,"target":"owner" if command=="shutdown" else ("echo" if self.sessions.index(arguments["session_id"])==0 else "flood"),"attempted":False,"budget_ms":0,"elapsed_ms":0,"outcome":"not_attempted","rejection_kind":None,"parser_termination_attempted_before_call":self.diagnostics["cleanup_outcome"]["parser_signal_attempted"]}
                self.diagnostics["cleanup_requests"].append(row)
                if self.descriptor is None: raise ValueError('No owned descriptor')
                if budget <= 0:
                    row["outcome"] = "deadline_exhausted"
                    raise ValueError('Fixture cleanup deadline reached')
                sequence += 1
                def dispatch(*args, **kwargs):
                    row.update(attempted=True,budget_ms=kwargs["timeout"]*1000)
                    return smoke.rpc(*args, **kwargs)
                try:
                    value = bounded_call(dispatch, self.descriptor, client, sequence, command, arguments,
                                         min(self.hard_deadline - 10, started + 1), self.clock)
                    row["outcome"] = "acknowledged"
                    if command == "shutdown":
                        outcome = self.diagnostics["cleanup_outcome"]
                        outcome["owner_shutdown_acknowledged"] = True
                        outcome["owner_shutdown_before_parser_signal"] = not outcome["parser_signal_attempted"]
                    return value
                except smoke.ServerRejected as error:
                    row.update(outcome="server_rejected", rejection_kind=error.rejection_kind); raise
                except TimeoutError:
                    row["outcome"] = "transport_timeout"; raise
                except EOFError:
                    row["outcome"] = "transport_closed"; raise
                except OSError:
                    row["outcome"] = "transport_error"; raise
                except (AssertionError, ValueError, KeyError, TypeError):
                    row["outcome"] = "deadline_exhausted" if self.clock() >= min(self.hard_deadline - 10, started + 1) else "protocol_or_validation_error"; raise
                finally:
                    row["elapsed_ms"] = max(0, self.clock() - started) * 1000 if row["attempted"] else 0
            self.cleanup_result = cleanup(self.owner, dict(self.identities), list(self.sessions), call,
                                          self.inspect, self.kill, self.hard_deadline, self.clock, self.diagnostics, self.parser_pid)
            self.finished.set()
            return self.cleanup_result
    def watchdog(self):
        if not self.finished.wait(max(0, self.soft_deadline - self.clock())):
            self.close()


def wait_file(path, deadline, run):
    while run.clock() < deadline and not run.cancelled.is_set():
        if path.exists(): return read_private(path)
        time.sleep(.01)
    raise ValueError('Fixture readiness deadline reached')


def parser_identity(owner, resources, authenticated_pid=None):
    result = subprocess.run(['/usr/bin/pgrep', '-P', str(owner.pid)], capture_output=True, text=True, timeout=1)
    rows = [inspect_process(int(value)) for value in result.stdout.split() if value.isdecimal()]
    candidates = [r for r in rows if r and r['parent']==owner.pid and parser_image(r, resources, authenticated_pid) and (authenticated_pid is None or r['pid']==authenticated_pid)]
    if len(candidates) != 1: raise ValueError('Owned parser identity unavailable')
    return candidates[0]


def validate_drain(frame, expected):
    offset = frame.get('end_offset')
    if type(offset) is not int or offset < 0 or offset > expected:
        raise ValueError('Unexpected output outside fixture ledger')
    if offset != expected: return None
    projection = frame.get('projection')
    if not isinstance(projection, dict) or projection.get('retained_lines') != 2000 or type(projection.get('revision')) is not int or projection['revision'] < 0 or len(json.dumps(projection).encode()) > 8 * 1024 * 1024:
        raise ValueError('Invalid retained frame budget')
    return {'expected_raw_bytes': expected, 'owner_end_offset': offset, 'revision': projection['revision']}


def execute(args):
    start = time.monotonic()
    gate = read_private(args.artifact_gate)
    own_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    test_hash = hashlib.sha256(Path(__file__).with_name('test_terminal_owner_responsiveness.py').read_bytes()).hexdigest()
    if gate != {'purpose': 'A11-owner-workload-authorization', 'authorized': True,
                'identifier': args.identifier, 'receipt_sha256': hashlib.sha256(smoke.regular_bytes(args.receipt)).hexdigest(),
                'fixture_sha256': own_hash, 'test_sha256': test_hash}:
        raise ValueError('Separate root artifact/workload authorization required')
    owner_home = args.root / "home"
    validated = smoke.validate_f7_run(args.app, args.identifier, args.receipt, owner_home=owner_home)
    executable = validated["executable"]
    command = owner_command(args.app, executable, getattr(args, 'terminal_node', None))
    data_root = validated["root"]
    if data_root != owner_home / "Library/Application Support" / args.identifier:
        raise ValueError("Unexpected private owner namespace")
    python = Path(sys.executable).resolve()
    self_identity = inspect_process(os.getpid())
    if not self_identity or self_identity.get("pid") != os.getpid():
        raise ValueError("Native Python identity unavailable")
    native_path = Path(self_identity.get("executable", ""))
    if not native_path.is_absolute() or not native_path.is_file():
        raise ValueError("Native Python image unavailable")
    python_image = native_path.resolve()
    nonce = secrets.token_hex(16)
    new_root(args.root, nonce)
    new_root(args.output, nonce)
    for name in ('home', 'config', 'data', 'tmp'): (args.root / name).mkdir(mode=0o700)
    data_root.parent.mkdir(mode=0o700, parents=True)
    data_root.mkdir(mode=0o700)
    (data_root / 'ownership').write_text(nonce)
    os.chmod(data_root / 'ownership', 0o600)
    launcher = args.root / 'shell'
    launcher.write_text(launcher_text(args.root, nonce, python)); launcher.chmod(0o700)
    run = Run(start + 90)
    watcher = threading.Thread(target=run.watchdog, daemon=True)
    samples = []
    ledgers = []
    final = {'scope': SCOPE, 'status': 'incomplete', 'queue_bytes': None, 'native': 'NOT RUN',
             'poll_interval_ms': 20, 'nominal_interval_ms': 50, 'one_inflight': True, 'phase_attribution': 'parent-observed running receipt; samples label scheduled phase; exact per-probe overlap with offered producer rate is unverified'}
    connection = data_root / 'background/connection.json'
    stderr = bytearray()
    native_stages = NativeOutputStages()
    drain = None
    tail = None
    stage = 'spawn'
    try:
        if time.monotonic() >= start + 15: raise ValueError('Artifact validation exceeded startup budget')
        if inspect_process(os.getpid()) != self_identity: raise ValueError('Native Python identity changed')
        run.owner = subprocess.Popen(command, env=environment(args.root, launcher, python),
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        owner_row = inspect_process(run.owner.pid)
        if owner_row is None: raise ValueError('Owned owner identity unavailable')
        run.identities[run.owner.pid] = owner_row
        watcher.start()
        def stderr_tail():
            try:
                while True:
                    value = run.owner.stderr.read(4096)
                    if not value: break
                    stderr.extend(value)
                    del stderr[:-65536]
                    native_stages.feed(value)
            except (OSError, ValueError): native_stages.errors.add('capture_error')
            finally: native_stages.finish()
        tail = threading.Thread(target=stderr_tail, daemon=True); tail.start()
        stage = 'connection_wait'
        while not connection.exists():
            if time.monotonic() >= start + 15 or run.owner.poll() is not None: raise ValueError('Owner startup failed')
            time.sleep(.01)
        stage = 'descriptor_validate'
        run.descriptor = memory.read_connection(connection)
        stage = 'owner_confirm'
        confirmed, run.sequence = smoke.confirm_f7_owner(run.owner, connection, run.client, run.sequence)
        if confirmed != run.descriptor or time.monotonic() >= start + 15: raise ValueError('Owner startup binding failed')
        stage = 'empty_state'
        status = run.call('background_status')
        if status.get('active_sessions') != 0 or status.get('desktop_connected') is not False or run.call('history_overview').get('total') != 0:
            raise ValueError('Nonempty isolated owner')
        run.call('set_agent_notification_context', {'selected': None, 'paused': True})
        resources = args.app / 'Contents/Resources'
        stage = 'parser_identity'
        parser = parser_identity(run.owner, resources, status.get("runtime_pid"))
        run.identities[parser['pid']] = parser
        run.parser_pid = parser['pid']
        ready = []
        def on_created(mode, identity):
            record = wait_file(args.root / (mode + '-ready.json'), min(start + 15, run.soft_deadline), run)
            if record.get('nonce') != nonce or record.get('mode') != mode:
                raise ValueError('Invalid child readiness')
            row = inspect_process(record.get('pid'))
            if not row or row['parent'] != run.owner.pid or Path(row['executable']).resolve() != python_image:
                raise ValueError('Unverified created child')
            run.identities[row['pid']] = row
            ready.append(record)
        stage = 'child_ready'
        create_sessions(run.call, args.root, run.sessions, on_created=on_created)
        stage = 'identity_gate'
        run.identities = verify_identities(run.owner, parser['pid'], ready, nonce, resources, python_image, inspect_process)
        run.parser_pid = parser['pid']
        # Recheck all four immediately before permitting either child to emit workload.
        if any(inspect_process(pid) != record for pid, record in run.identities.items()): raise ValueError('Process changed before gate')
        (args.root / 'identity-gate').write_text(nonce)
        echo, flood = run.sessions
        stage = 'workload'
        for phase, rate in enumerate(RATES):
            if run.cancelled.is_set(): raise ValueError('Workload cancelled')
            (args.root / f'phase-{phase}-start').write_text(nonce)
            running = wait_file(args.root / f'phase-{phase}-running.json', min(time.monotonic() + 2, run.soft_deadline), run)
            if running != {'nonce': nonce, 'phase': phase}: raise ValueError('Invalid active phase')
            phase_origin = time.monotonic()
            phase_end = min(phase_origin + 5, run.soft_deadline)
            for sequence in range(100):
                if time.monotonic() >= phase_end: break
                target_slot = phase_origin + sequence * .05
                time.sleep(max(0, min(.05, target_slot - time.monotonic())))
                if time.monotonic() >= phase_end: break
                samples.append(probe(run.call, echo, nonce, phase, sequence, phase_end, time.monotonic, time.sleep, time.monotonic_ns))
            value = wait_file(args.root / f'phase-{phase}-done.json', min(time.monotonic() + 2, run.soft_deadline), run)
            validated = validate_ledger(value, nonce, phase)
            phase_row = phase_diagnostic(validated, phase, samples)
            ledgers.append({**validated, 'nominal_bytes_per_second': rate})
            run.diagnostics['phases'].append(phase_row)
        stage = 'drain'
        expected = sum(value['bytes'] for value in ledgers)
        drain_end = min(time.monotonic() + 5, run.soft_deadline)
        while time.monotonic() < drain_end:
            frame = run.call('read_terminal_frame', {'session_id': flood})
            drain = validate_drain(frame, expected)
            if drain is not None: break
            time.sleep(.02)
        if drain is None: raise ValueError('Pipeline did not drain exact raw ledger')
        if any(inspect_process(pid) != record for pid, record in run.identities.items() if pid in (run.owner.pid, parser['pid'])):
            raise ValueError('Owner/parser identity changed during workload')
        seen = read_private(args.root / 'echo-seen.json')
        observed = [(s['phase'], s['sequence']) for s in samples if s['status'] == 'complete']
        if seen.get('nonce') != nonce or [tuple(x) for x in seen.get('seen', [])] != observed:
            raise ValueError('Echo child receipt differs from successful markers')
        final.update(summary=summarize(samples, 300), samples=samples, ledgers=ledgers, drain=drain,
                     process_identities=run.identities, launcher_sha256=hashlib.sha256(launcher.read_bytes()).hexdigest(),
                     artifact_receipt_sha256=gate['receipt_sha256'])
        final['status'] = 'complete' if final['summary']['passed'] else 'diagnostic_incomplete'
    except (OSError, ValueError, AssertionError, KeyError, TypeError, subprocess.SubprocessError) as error:
        final.update(error_type=type(error).__name__, samples=samples, ledgers=ledgers)
    finally:
        final.update(stage=stage, connection_seen=connection.exists(), owner_exit_code=run.owner.poll() if run.owner is not None else None)
        # A lost create reply may still have created a blocked launcher. Capture
        # its nonce-bound private ready receipt before fixture-only cleanup.
        if run.owner is not None:
            for mode in ('fixture-echo', 'fixture-flood'):
                path = args.root / (mode + '-ready.json')
                if path.exists():
                    try:
                        record = read_private(path)
                        row = inspect_process(record.get('pid'))
                        if record.get('nonce') == nonce and record.get('mode') == mode and row and row['parent'] == run.owner.pid and Path(row['executable']).resolve() == python_image:
                            run.identities[row['pid']] = row
                    except (OSError, ValueError, subprocess.SubprocessError): pass
        result = run.close()
        if watcher.is_alive(): watcher.join(timeout=max(.01, run.hard_deadline - time.monotonic()))
        if result['complete'] and run.owner is not None and run.owner.stderr is not None:
            if tail is not None: tail.join(timeout=1)
            if tail is None or not tail.is_alive(): run.owner.stderr.close()
        final['cleanup'] = result
        final['diagnostics'] = run.diagnostics
        final['native_output_stages'] = native_stages.result()
        if final['status'] == 'complete' and not final['native_output_stages']['complete']: final['status'] = 'diagnostic_incomplete'
        final['elapsed_seconds'] = time.monotonic() - start
        final['stderr_tail_bytes'] = len(stderr)  # Never dump child stderr or secrets into metrics.
        if not result['complete'] or final['elapsed_seconds'] > 90: final['status'] = 'incomplete'
        write_result(args.output / 'result.json', final)
        if result['complete']:
            remove_root(data_root, nonce)
            remove_root(args.root, nonce)
    return 0 if final['status'] == 'complete' else 2


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'receipt', 'artifact-gate', 'root', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--identifier', required=True)
    parser.add_argument('--terminal-node', type=Path, help='Absolute installed or YAM private Node; defaults to the caller PATH, never downloads')
    args = parser.parse_args(argv)
    for name in ('app','receipt','artifact_gate','root','output'):
        smoke.unlinked(getattr(args, name))
    if sys.flags.optimize: raise ValueError('Optimized Python cannot run fixture')
    return execute(args)


if __name__ == '__main__': raise SystemExit(main())
