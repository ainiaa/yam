PROTOCOL_VERSION = 2
"""Author: Jeff.Liu. Measure a macOS app coalition without collecting argv/env."""
import argparse
import datetime
import json
import os
import secrets
import socket
import stat
import struct
import pathlib
import platform
import re
import subprocess
import tempfile
import time
import ctypes
import math


def parse_apps(text):
    apps = []
    for block in re.split(r'(?m)(?=^\s*\d+\))', text):
        bundle = re.search(r'bundleID="([^"]+)"', block)
        pid = re.search(r'\bpid = (\d+)', block)
        coalition = re.search(r'coalition:\s*(\d+)(?:\s*\{([^}]+)\})?', block)
        if bundle and pid:
            apps.append({"bundle":bundle[1], "pid":int(pid[1]),
                "coalition":int(coalition[1]) if coalition else None,
                "members":[int(p) for p in coalition[2].split()] if coalition and coalition[2] else []})
    return apps


def parse_processes(text):
    rows = {}
    for line in text.splitlines():
        parts = line.strip().split(None, 8)
        if len(parts) != 9 or not all(p.isdecimal() for p in parts[:3]):
            raise ValueError("Invalid process measurement record")
        pid, parent, rss = map(int, parts[:3])
        if pid in rows: raise ValueError("Duplicate process ID in sample")
        rows[pid] = {"pid":pid, "parent":parent, "rss_bytes":rss*1024,
                     "started":" ".join(parts[3:8]), "executable":parts[8]}
    return rows


def root_app(bundle, apps):
    roots = [app for app in apps if app['bundle'] == bundle]
    if len(roots) != 1 or roots[0]['pid'] not in roots[0]['members']:
        raise ValueError("App must have one live root and explicit coalition membership")
    if len(roots[0]['members']) > 256:
        raise ValueError("Coalition measurement exceeds 256-process budget")
    return roots[0]


def attribute_sample(bundle, apps, before, after, footprint, owner=None):
    roots = [app for app in apps if app['bundle'] == bundle and (not owner or app['pid'] != owner['pid'])]
    root = root_app(bundle, roots) if roots or not owner else None
    if root is None and owner['desktop_connected']:
        raise ValueError("Connected desktop has no measurable LaunchServices coalition")
    members = set(root['members']) if root else set()
    service_ids = set()
    if owner:
        background, runtime = before.get(owner['pid']), before.get(owner['runtime_pid'])
        if not background or not runtime or runtime['parent'] != background['pid']:
            raise ValueError("Background process identity is unavailable")
        executable = pathlib.Path(background['executable'])
        if executable.name != 'yam-desktop' or executable.parent.name != 'MacOS' or executable.parent.parent.parent.suffix != '.app':
            raise ValueError("Background process is outside a YAM app bundle")
        if pathlib.Path(runtime['executable']).name != 'yam-terminal' or not pathlib.Path(runtime['executable']).is_relative_to(executable.parent.parent / 'Resources'):
            raise ValueError("Terminal service is outside its owner bundle")
        if root and before.get(root['pid'],{}).get('executable') != str(executable):
            raise ValueError("Desktop and background belong to different bundles")
        service_ids = {background['pid'],runtime['pid']}
        members |= service_ids
        changed = True
        while changed:
            expanded = members | {pid for pid,row in before.items() if row['parent'] in members}
            changed = expanded != members
            members = expanded
        if len(members) > 256: raise ValueError("Application measurement exceeds 256-process budget")
    issues, stable = [], {}
    for pid in sorted(members):
        first, last = before.get(pid), after.get(pid)
        if not first or not last or (first['started'],first['executable']) != (last['started'],last['executable']):
            issues.append(f"Process {pid} disappeared or identity changed")
        else: stable[pid] = last
    agents = {pid for pid,row in stable.items() if pathlib.Path(row['executable']).name in {'claude','codex','opencode'}}
    # Custom PTY commands are workload processes, even if their name is not an Agent CLI.
    workload_parents = ({root['pid']} if root else set()) | ({owner['pid']} if owner else set())
    agents |= {pid for pid,row in stable.items() if pid not in service_ids and row['parent'] in workload_parents and
               pathlib.Path(row['executable']).name not in {'yam-desktop','yam-runtime','yam-terminal'}}
    changed = True
    while changed:
        expanded = agents | {pid for pid,row in stable.items() if row['parent'] in agents}
        changed = expanded != agents
        agents = expanded
    metrics = {}
    if footprint.get('unit') != 'byte': issues.append('Footprint unit is unsupported')
    elif footprint.get('errors'): issues.append('Footprint tool reported measurement errors')
    else:
        for row in footprint.get('processes',[]):
            value = row.get('auxiliary',{}).get('phys_footprint')
            if type(row.get('pid')) is int and type(value) is int and value >= 0:
                metrics[row['pid']] = value
    application, workload = [], []
    for pid,row in stable.items():
        measured = {**row, 'phys_footprint_bytes':metrics.get(pid), 'role':
            'agent' if pid in agents else 'background-owner' if owner and pid == owner['pid'] else
            'terminal-service' if owner and pid == owner['runtime_pid'] else 'desktop' if root and pid == root['pid'] else
            'webkit' if pathlib.Path(row['executable']).name.startswith('com.apple.WebKit.') else 'application-service'}
        (workload if pid in agents else application).append(measured)
    if any(row['phys_footprint_bytes'] is None for row in application):
        issues.append('Application physical footprint is incomplete')
    if root and root['pid'] not in stable: issues.append('Desktop process is unavailable')
    return {'status':'partial' if issues else 'complete', 'issues':issues,
        'bundle':bundle,'root_pid':root['pid'] if root else None,'coalition':root['coalition'] if root else None,
        'attribution':('LaunchServices coalition plus authenticated background owner and descendants; process identity checked before and after' if owner else 'LaunchServices coalition membership; process identity checked before and after'),
        'application':application,'agents':workload,
        'rss_bytes':sum(row['rss_bytes'] for row in application),
        # Sum of per-process footprint can include shared accounting; not a system-wide unique total.
        'phys_footprint_sum_bytes':None if issues else sum(row['phys_footprint_bytes'] for row in application),
        'footprint_note':'Sum of attributed process phys_footprint; shared accounting is not deduplicated',
        'warnings_count':len(footprint.get('warnings',[]))}


def read_connection(path):
    descriptor_fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor_fd, 'rb') as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
            raise ValueError("Background descriptor must be private and owned by this user")
        data = source.read(4097)
    if len(data) > 4096: raise ValueError("Background descriptor exceeds budget")
    descriptor = json.loads(data)
    if set(descriptor) != {'version','address','instance','token'} or descriptor['version'] != PROTOCOL_VERSION:
        raise ValueError("Invalid background descriptor")
    if not all(isinstance(descriptor[key],str) and re.fullmatch(r'[0-9a-fA-F]{64}',descriptor[key]) for key in ['instance','token']):
        raise ValueError("Invalid background identity")
    if not isinstance(descriptor['address'],str) or not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}',descriptor['address']):
        raise ValueError("Background measurement requires IPv4 loopback")
    if not 1 <= int(descriptor['address'].split(':')[1]) <= 65535: raise ValueError("Invalid background port")
    return descriptor


def owner_status(descriptor):
    identity = secrets.token_hex(32)
    request = {key:descriptor[key] for key in ['version','instance','token']}
    request.update(client=identity,id=1,command='background_status',args={})
    data = json.dumps(request).encode()
    with socket.create_connection(('127.0.0.1',int(descriptor['address'].split(':')[1])),timeout=3) as stream:
        stream.settimeout(3)
        stream.sendall(struct.pack('!I',len(data))+data)
        deadline=time.monotonic()+3
        def read(size):
            result=bytearray()
            while len(result)<size:
                remaining=deadline-time.monotonic()
                if remaining<=0: raise ValueError("Background measurement deadline reached")
                stream.settimeout(remaining)
                chunk=stream.recv(size-len(result))
                if not chunk: raise ValueError("Incomplete background measurement response")
                result.extend(chunk)
            return result
        size=struct.unpack('!I',read(4))[0]
        if not 0<size<=4096: raise ValueError("Background status exceeds budget")
        reply=json.loads(read(size))
    if reply.get('version')!=PROTOCOL_VERSION or reply.get('instance')!=descriptor['instance'] or reply.get('client')!=identity or reply.get('id')!=1:
        raise ValueError("Background measurement identity changed")
    status=reply.get('result',{}).get('Ok',{})
    if type(status.get('pid')) is not int or status['pid']<=1 or type(status.get('desktop_connected')) is not bool:
        raise ValueError("Invalid background process status")
    return status


def measured_owner(descriptor, rows):
    status=owner_status(descriptor)
    runtimes=[pid for pid,row in rows.items() if row['parent']==status['pid'] and pathlib.Path(row['executable']).name=='yam-terminal']
    if len(runtimes)!=1: raise ValueError("Background must own exactly one terminal service")
    return {**status,'runtime_pid':runtimes[0]}


def run(argv):
    return subprocess.run(argv,check=True,capture_output=True,text=True,timeout=20).stdout


def native_metrics(pids):
    """The same macOS rusage v2 physical footprint used by the native renderer probe."""
    lib = ctypes.CDLL('/usr/lib/libproc.dylib')
    class Timebase(ctypes.Structure):
        _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]
    timebase = Timebase()
    if ctypes.CDLL('/usr/lib/libSystem.B.dylib').mach_timebase_info(ctypes.byref(timebase)) != 0:
        raise ValueError("CPU timebase unavailable")
    result = {}
    for pid in pids:
        buf = ctypes.create_string_buffer(256)
        if lib.proc_pid_rusage(pid, 2, ctypes.byref(buf)) == 0:
            result[pid] = {"phys_footprint_bytes": ctypes.c_uint64.from_buffer(buf, 72).value,
                           "cpu_seconds": cpu_seconds_from_ticks(ctypes.c_uint64.from_buffer(buf, 16).value +
                                           ctypes.c_uint64.from_buffer(buf, 24).value, timebase.numer, timebase.denom)}
    return result


def cpu_seconds_from_ticks(ticks, numer, denom):
    if any(type(value) is not int for value in [ticks, numer, denom]) or ticks < 0 or numer <= 0 or denom <= 0:
        raise ValueError("Invalid Mach CPU timebase")
    return ticks * numer / denom / 1e9


def sample_timing(scheduled, started, ended, interval):
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in [scheduled, started, ended, interval]) or interval <= 0 or scheduled < 0 or started < scheduled or ended < started:
        raise ValueError("Invalid sampling schedule")
    return {"scheduled_monotonic_seconds": scheduled,
            "sample_start_monotonic_seconds": started, "sample_end_monotonic_seconds": ended,
            "late": ended > scheduled + interval,
            "missed_slots": max(0, math.ceil((ended - scheduled) / interval) - 1)}


def collect(bundle, connection=None):
    started = time.monotonic()
    apps = parse_apps(run(['lsappinfo','list']))
    descriptor = read_connection(connection) if connection else None
    ps = ['ps','-axo','pid=,ppid=,rss=,lstart=,comm='] if descriptor else ['ps','-p',','.join(str(pid) for pid in sorted(set(root_app(bundle,apps)['members']))),'-o','pid=,ppid=,rss=,lstart=,comm=']
    before = parse_processes(run(ps))
    owner = measured_owner(descriptor,before) if descriptor else None
    # Resolve only attributed identities before requesting physical footprint.
    selection = attribute_sample(bundle,apps,before,before,{'unit':'byte','errors':['pending']},owner)
    ids = sorted(row['pid'] for row in selection['application']+selection['agents'])
    try:
        metrics = native_metrics(ids)
    except (OSError, ValueError): metrics = {}
    footprint = {'unit':'byte','processes':[{'pid':pid,'auxiliary':{'phys_footprint':value['phys_footprint_bytes']}}
                 for pid,value in metrics.items()], 'errors':[]}
    after = parse_processes(run(ps))
    result = attribute_sample(bundle,apps,before,after,footprint,owner)
    for row in result['application'] + result['agents']:
        row['cpu_seconds'] = metrics.get(row['pid'], {}).get('cpu_seconds')
    if any(type(row['cpu_seconds']) not in (int, float) or not math.isfinite(row['cpu_seconds']) or row['cpu_seconds'] < 0 for row in result['application']):
        result['status'] = 'partial'; result['issues'].append('Application CPU measurement is incomplete')
        result['phys_footprint_sum_bytes'] = None
    current_apps = parse_apps(run(['lsappinfo','list']))
    current_owner = measured_owner(descriptor,after) if descriptor else None
    current = attribute_sample(bundle,current_apps,after,after,{'unit':'byte','errors':['pending']},current_owner)
    if (current['root_pid'],current['coalition'],[r['pid'] for r in current['application']+current['agents']]) != (selection['root_pid'],selection['coalition'],[r['pid'] for r in selection['application']+selection['agents']]) or current_owner != owner:
        result['status']='partial'; result['issues'].append('Coalition membership changed during measurement')
        result['phys_footprint_sum_bytes']=None
    result['time']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    result['sample_start_monotonic_seconds'] = started
    result['sample_end_monotonic_seconds'] = time.monotonic()
    result['monotonic_seconds'] = result['sample_end_monotonic_seconds']
    result['measurement_tool'] = 'macOS proc_pid_rusage v2 physical footprint; user+system Mach ticks converted with host mach_timebase_info'
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle',default='com.yam.validation')
    parser.add_argument('--output',type=pathlib.Path,required=True)
    parser.add_argument('--background',action='store_true',help='Include the authenticated owner and bundled terminal service, including after desktop exit')
    parser.add_argument('--scenario',required=True)
    parser.add_argument('--duration',type=float,default=0)
    parser.add_argument('--interval',type=float,default=5)
    args=parser.parse_args()
    if platform.system() != 'Darwin': parser.error('This collector requires macOS')
    if not 0 <= args.duration <= 7200 or not 0.1 <= args.interval <= 60:
        parser.error('Duration must be 0..7200 seconds and interval 0.1..60 seconds')
    failed=False; slot=time.monotonic(); deadline=slot+args.duration
    # Never replace an earlier measurement, even after a crash or repeated command.
    with args.output.open('x',encoding='utf-8') as output:
        while True:
            delay = slot - time.monotonic()
            if delay > 0: time.sleep(delay)
            started = time.monotonic()
            try: result=collect(args.bundle,pathlib.Path.home()/'Library/Application Support'/args.bundle/'background/connection.json' if args.background else None)
            except (OSError,ValueError,subprocess.SubprocessError) as error:
                result={'status':'partial','issues':[type(error).__name__],
                        'time':datetime.datetime.now(datetime.timezone.utc).isoformat()}
            result.update(sample_timing(slot, started, time.monotonic(), args.interval))
            failed |= result['status'] != 'complete' or result['late'] or result['missed_slots'] > 0
            result.update(scenario=args.scenario,platform=platform.platform(),machine=platform.machine())
            output.write(json.dumps(result,ensure_ascii=False)+'\n'); output.flush()
            slot += args.interval * (1 + result['missed_slots'])
            if slot > deadline: break
    print(json.dumps({'output':str(args.output),'status':'partial' if failed else 'complete'}))
    return 2 if failed else 0


if __name__ == '__main__': raise SystemExit(main())
