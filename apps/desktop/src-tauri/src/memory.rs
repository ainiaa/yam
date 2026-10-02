use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_PROCESSES: usize = 16384;
const MAX_ATTRIBUTED: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct OwnerProcesses {
    pub pid: u32,
    pub runtime_pid: u32,
    pub workloads: Vec<u32>,
}

#[derive(Clone, Debug)]
struct Process {
    parent: u32,
    identity: u64,
    bytes: Option<u64>,
}

#[derive(Serialize)]
pub(super) struct Sample {
    pub application_bytes: u64,
    pub workload_bytes: u64,
    pub metric: &'static str,
    pub sampled_at: u64,
}

fn attributed(
    rows: &HashMap<u32, Process>,
    gui: &[u32],
    owner: &OwnerProcesses,
) -> Result<(HashSet<u32>, HashSet<u32>), String> {
    if gui.is_empty() || gui.len() > MAX_ATTRIBUTED || owner.workloads.len() > MAX_ATTRIBUTED {
        return Err("Memory attribution exceeds its process budget".into());
    }
    let mut all: HashSet<_> = gui
        .iter()
        .copied()
        .chain([owner.pid, owner.runtime_pid])
        .collect();
    let mut tasks: HashSet<_> = owner.workloads.iter().copied().collect();
    if all.iter().any(|pid| !rows.contains_key(pid))
        || tasks.iter().any(|pid| !rows.contains_key(pid))
        || tasks.contains(&gui[0])
        || tasks.contains(&owner.pid)
        || tasks.contains(&owner.runtime_pid)
        || rows
            .get(&owner.runtime_pid)
            .is_none_or(|row| row.parent != owner.pid)
    {
        return Err("Memory process identities are unavailable".into());
    }
    // PTY roots supplied by the authenticated owner must belong to that owner.
    if tasks.iter().any(|pid| rows[pid].parent != owner.pid) {
        return Err("Task memory ownership is unavailable".into());
    }
    all.extend(tasks.iter());
    loop {
        let previous = (all.len(), tasks.len());
        for (&pid, row) in rows {
            if all.contains(&row.parent) {
                all.insert(pid);
            }
            if tasks.contains(&row.parent) {
                tasks.insert(pid);
            }
        }
        if all.len() > MAX_ATTRIBUTED {
            return Err("Memory attribution exceeds its process budget".into());
        }
        if previous == (all.len(), tasks.len()) {
            break;
        }
    }
    Ok((all, tasks))
}

fn aggregate(
    before: &HashMap<u32, Process>,
    after: &HashMap<u32, Process>,
    gui: &[u32],
    owner: &OwnerProcesses,
) -> Result<(u64, u64), String> {
    let (all, tasks) = attributed(before, gui, owner)?;
    if attributed(after, gui, owner)? != (all.clone(), tasks.clone()) {
        return Err("Memory process membership changed during sampling".into());
    }
    let (mut application, mut workload) = (0u64, 0u64);
    for pid in all {
        let first = &before[&pid];
        let last = &after[&pid];
        if first.identity != last.identity || first.parent != last.parent || first.bytes.is_none() {
            return Err("Memory process identity changed during sampling".into());
        }
        let bytes = last.bytes.ok_or("Memory measurement is incomplete")?;
        let total = if tasks.contains(&pid) {
            &mut workload
        } else {
            &mut application
        };
        *total = total
            .checked_add(bytes)
            .ok_or("Memory measurement overflow")?;
    }
    Ok((application, workload))
}

pub(super) fn sample(owner: &OwnerProcesses) -> Result<Sample, String> {
    sample_for_desktop(owner, std::process::id())
}

fn sample_for_desktop(owner: &OwnerProcesses, desktop: u32) -> Result<Sample, String> {
    let before = platform::snapshot()?;
    let gui = platform::gui_members(desktop)?;
    let after = platform::snapshot()?;
    if gui != platform::gui_members(desktop)? {
        return Err("WebKit process membership changed during sampling".into());
    }
    let (application_bytes, workload_bytes) = aggregate(&before, &after, &gui, owner)?;
    Ok(Sample {
        application_bytes,
        workload_bytes,
        metric: platform::METRIC,
        sampled_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "System clock unavailable")?
            .as_millis()
            .try_into()
            .map_err(|_| "System clock out of range")?,
    })
}

#[cfg(target_os = "macos")]
fn coalition_members(text: &str, pid: u32) -> Result<Vec<u32>, String> {
    let mut blocks = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        if line
            .trim_start()
            .split_once(')')
            .is_some_and(|(n, _)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            && !current.is_empty()
        {
            blocks.push(std::mem::take(&mut current));
        }
        current.push_str(line);
        current.push('\n');
    }
    blocks.push(current);
    let matches: Vec<_> = blocks
        .iter()
        .filter(|block| {
            block
                .split_once("pid = ")
                .and_then(|(_, rest)| rest.split_whitespace().next())
                .and_then(|s| s.parse::<u32>().ok())
                == Some(pid)
        })
        .collect();
    if matches.len() != 1 {
        return Err("Desktop LaunchServices identity is unavailable".into());
    }
    let members = matches[0]
        .split_once("coalition:")
        .and_then(|(_, s)| s.split_once('{'))
        .and_then(|(_, s)| s.split_once('}'))
        .ok_or("WebKit coalition membership is unavailable")?
        .0;
    let mut members = members
        .split_whitespace()
        .map(|s| {
            s.parse::<u32>()
                .map_err(|_| "Invalid WebKit coalition membership")
        })
        .collect::<Result<Vec<_>, _>>()?;
    members.sort_unstable();
    members.dedup();
    if !members.contains(&pid) || members.len() > MAX_ATTRIBUTED {
        return Err("WebKit coalition membership is incomplete".into());
    }
    members.retain(|member| *member != pid);
    members.insert(0, pid);
    Ok(members)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::io::Read;
    use std::process::{Command, Stdio};
    pub(super) const METRIC: &str = "physical footprint";

    pub(super) fn snapshot() -> Result<HashMap<u32, Process>, String> {
        let started = Instant::now();
        let mut pids = vec![0i32; MAX_PROCESSES];
        // libc declares the native libproc ABI; no elevated task port is required.
        let count = unsafe {
            libc::proc_listallpids(
                pids.as_mut_ptr().cast(),
                std::mem::size_of_val(pids.as_slice()) as i32,
            )
        };
        if count <= 0 || count as usize >= MAX_PROCESSES {
            return Err("Process snapshot is unavailable or exceeds budget".into());
        }
        let mut rows = HashMap::new();
        for pid in pids.into_iter().take(count as usize).filter(|pid| *pid > 0) {
            if started.elapsed() > Duration::from_secs(2) {
                return Err("Process snapshot timed out".into());
            }
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of_val(&info) as i32;
            if unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    size,
                )
            } != size
            {
                continue;
            }
            let mut usage: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
            let available = unsafe {
                libc::proc_pid_rusage(
                    pid,
                    libc::RUSAGE_INFO_V2,
                    (&mut usage as *mut libc::rusage_info_v2).cast(),
                )
            } == 0;
            rows.insert(
                pid as u32,
                Process {
                    parent: info.pbi_ppid,
                    identity: info
                        .pbi_start_tvsec
                        .saturating_mul(1_000_000)
                        .saturating_add(info.pbi_start_tvusec),
                    bytes: available.then_some(usage.ri_phys_footprint),
                },
            );
        }
        Ok(rows)
    }
    pub(super) fn gui_members(pid: u32) -> Result<Vec<u32>, String> {
        let mut child = Command::new("/usr/bin/lsappinfo")
            .arg("list")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "LaunchServices memory attribution unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("LaunchServices output unavailable")?;
        let reader = std::thread::spawn(move || {
            let mut output = Vec::new();
            stdout
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut output)
                .map(|_| output)
        });
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if started.elapsed() < Duration::from_secs(1) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err("LaunchServices memory attribution timed out");
                }
            }
        };
        let bytes = reader
            .join()
            .map_err(|_| "LaunchServices reader failed")?
            .map_err(|_| "LaunchServices read failed")?;
        if !status?.success() || bytes.len() > 2 * 1024 * 1024 {
            return Err("LaunchServices memory attribution failed".into());
        }
        coalition_members(
            std::str::from_utf8(&bytes).map_err(|_| "Invalid LaunchServices output")?,
            pid,
        )
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    pub(super) const METRIC: &str = "RSS";
    pub(super) fn gui_members(pid: u32) -> Result<Vec<u32>, String> {
        Ok(vec![pid])
    }
    fn parse_stat(text: &str, page: u64) -> Option<Process> {
        let fields: Vec<_> = text.rsplit_once(')')?.1.split_whitespace().collect();
        Some(Process {
            parent: fields.get(1)?.parse().ok()?,
            identity: fields.get(19)?.parse().ok()?,
            bytes: fields.get(21)?.parse::<u64>().ok()?.checked_mul(page),
        })
    }
    pub(super) fn snapshot() -> Result<HashMap<u32, Process>, String> {
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if page <= 0 {
            return Err("System page size unavailable".into());
        }
        let started = Instant::now();
        let mut rows = HashMap::new();
        let mut count = 0;
        for entry in std::fs::read_dir("/proc").map_err(|_| "Process snapshot unavailable")? {
            let entry = entry.map_err(|_| "Process snapshot unavailable")?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            count += 1;
            if count >= MAX_PROCESSES || started.elapsed() > Duration::from_secs(2) {
                return Err("Process snapshot exceeds budget".into());
            }
            if let Ok(text) = std::fs::read_to_string(entry.path().join("stat")) {
                if let Some(row) = parse_stat(&text, page as u64) {
                    rows.insert(pid, row);
                }
            }
        }
        Ok(rows)
    }
    #[test]
    fn stat_parser_handles_parentheses_in_process_name() {
        let mut fields = vec!["0"; 22];
        fields[0] = "S";
        fields[1] = "123";
        fields[19] = "987";
        fields[21] = "42";
        let row = parse_stat(
            &format!("456 (name ) with spaces) {}", fields.join(" ")),
            4096,
        )
        .unwrap();
        assert_eq!(
            (row.parent, row.identity, row.bytes),
            (123, 987, Some(42 * 4096))
        );
        assert!(parse_stat("bad", 4096).is_none());
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    pub(super) const METRIC: &str = "working set";
    type Handle = *mut c_void;
    // Native Win32 ABI, matching the installed windows crate/Windows SDK.
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        executable: [u16; 260],
    }
    #[repr(C)]
    struct Counters {
        size: u32,
        faults: u32,
        peak_working: usize,
        working: usize,
        peak_paged: usize,
        paged: usize,
        peak_nonpaged: usize,
        nonpaged: usize,
        pagefile: usize,
        peak_pagefile: usize,
    }
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetLastError() -> u32;
        fn GetProcessTimes(
            process: Handle,
            created: *mut FileTime,
            exited: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn K32GetProcessMemoryInfo(process: Handle, counters: *mut Counters, size: u32) -> i32;
    }
    struct OwnedHandle(Handle);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    pub(super) fn gui_members(pid: u32) -> Result<Vec<u32>, String> {
        Ok(vec![pid])
    }
    pub(super) fn snapshot() -> Result<HashMap<u32, Process>, String> {
        let started = Instant::now();
        let handle = unsafe { CreateToolhelp32Snapshot(2, 0) };
        if handle == (-1isize) as Handle {
            return Err("Process snapshot unavailable".into());
        }
        let snapshot = OwnedHandle(handle);
        let mut entry: Entry = unsafe { std::mem::zeroed() };
        entry.size = std::mem::size_of::<Entry>() as u32;
        if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
            return Err("Process snapshot unavailable".into());
        }
        let mut rows = HashMap::new();
        loop {
            if rows.len() >= MAX_PROCESSES || started.elapsed() > Duration::from_secs(2) {
                return Err("Process snapshot exceeds budget".into());
            }
            let mut row = Process {
                parent: entry.parent,
                identity: 0,
                bytes: None,
            };
            let handle = unsafe { OpenProcess(0x1000, 0, entry.pid) }; // PROCESS_QUERY_LIMITED_INFORMATION
            if !handle.is_null() {
                let process = OwnedHandle(handle);
                let (mut created, mut exited, mut kernel, mut user) = (
                    FileTime::default(),
                    FileTime::default(),
                    FileTime::default(),
                    FileTime::default(),
                );
                let mut memory: Counters = unsafe { std::mem::zeroed() };
                memory.size = std::mem::size_of::<Counters>() as u32;
                if unsafe {
                    GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user)
                } != 0
                    && unsafe { K32GetProcessMemoryInfo(process.0, &mut memory, memory.size) } != 0
                {
                    row.identity = ((created.high as u64) << 32) | created.low as u64;
                    row.bytes = Some(memory.working as u64);
                }
            }
            rows.insert(entry.pid, row);
            if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
                if unsafe { GetLastError() } != 18 {
                    return Err("Process snapshot is incomplete".into());
                }
                break;
            }
        }
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(parent: u32, bytes: Option<u64>, identity: u64) -> Process {
        Process {
            parent,
            bytes,
            identity,
        }
    }
    #[test]
    fn separates_workloads_from_application_and_deduplicates_coalition() {
        let rows = [
            (1, row(0, Some(10), 1)),
            (2, row(0, Some(20), 2)),
            (3, row(2, Some(30), 3)),
            (4, row(2, Some(40), 4)),
            (5, row(4, Some(50), 5)),
            (6, row(0, Some(60), 6)),
            (99, row(0, Some(999), 99)),
        ]
        .into();
        let owner = OwnerProcesses {
            pid: 2,
            runtime_pid: 3,
            workloads: vec![4],
        };
        let sample = aggregate(&rows, &rows, &[1, 2, 3, 4, 5, 6, 6], &owner).unwrap();
        assert_eq!(sample, (120, 90));
    }
    #[test]
    fn rejects_missing_measurements_recycled_pids_and_changing_membership() {
        let rows: HashMap<_, _> = [
            (1, row(0, Some(10), 1)),
            (2, row(0, Some(20), 2)),
            (3, row(2, Some(30), 3)),
        ]
        .into();
        let owner = OwnerProcesses {
            pid: 2,
            runtime_pid: 3,
            workloads: vec![],
        };
        for changed in [row(0, None, 1), row(0, Some(10), 99)] {
            let mut after = rows.clone();
            after.insert(1, changed);
            assert!(aggregate(&rows, &after, &[1], &owner).is_err());
        }
        let mut after = rows.clone();
        after.insert(4, row(1, Some(40), 4));
        assert!(aggregate(&rows, &after, &[1], &owner).is_err());
        after = rows.clone();
        after.remove(&3);
        assert!(aggregate(&rows, &after, &[1], &owner).is_err());
        let mut invalid = owner.clone();
        invalid.workloads = vec![1];
        assert!(aggregate(&rows, &rows, &[1], &invalid).is_err());
    }

    #[test]
    fn rejects_overflow_invalid_roots_and_excessive_process_sets() {
        let owner = OwnerProcesses {
            pid: 2,
            runtime_pid: 3,
            workloads: vec![],
        };
        let mut rows: HashMap<_, _> = [
            (1, row(0, Some(u64::MAX), 1)),
            (2, row(0, Some(1), 2)),
            (3, row(2, Some(1), 3)),
        ]
        .into();
        assert!(aggregate(&rows, &rows, &[1], &owner).is_err());
        rows.insert(1, row(0, Some(1), 1));
        assert!(aggregate(&rows, &rows, &[], &owner).is_err());
        rows.insert(3, row(99, Some(1), 3));
        assert!(aggregate(&rows, &rows, &[1], &owner).is_err());
        rows.insert(3, row(2, Some(1), 3));
        for pid in 4..=(MAX_ATTRIBUTED as u32 + 1) {
            rows.insert(pid, row(1, Some(1), pid as u64));
        }
        assert!(aggregate(&rows, &rows, &[1], &owner).is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn coalition_parser_requires_exact_live_root_and_explicit_membership() {
        let text="1) other bundleID=\"x\" pid = 12 coalition: 9 { 12 21 }\n2) YAM bundleID=\"yam\" pid = 123 coalition: 10 { 123 456 }\n3) other pid = 777 coalition: 11 { 777 }";
        assert_eq!(coalition_members(text, 123).unwrap(), vec![123, 456]);
        assert!(coalition_members(text, 12_345).is_err());
        assert!(coalition_members("1) YAM pid = 123 coalition: 10", 123).is_err());
        assert!(coalition_members("1) YAM pid = 123 coalition: 10 { 456 }", 123).is_err());
    }
    #[test]
    fn native_sampler_can_measure_current_process() {
        let rows = platform::snapshot().unwrap();
        assert!(rows.get(&std::process::id()).unwrap().bytes.unwrap() > 0);
    }

    // Only the test binary accepts external fixture PIDs; the Tauri command never does.
    #[test]
    #[ignore = "requires an isolated, running desktop fixture"]
    fn native_running_desktop_fixture() {
        let desktop = std::env::var("YAM_MEMORY_TEST_DESKTOP_PID")
            .unwrap()
            .parse()
            .unwrap();
        let owner: OwnerProcesses =
            serde_json::from_str(&std::env::var("YAM_MEMORY_TEST_OWNER").unwrap()).unwrap();
        let sample = sample_for_desktop(&owner, desktop).unwrap();
        assert!(sample.application_bytes > 0);
        if !owner.workloads.is_empty() {
            assert!(sample.workload_bytes > 0);
        }
        let rows = platform::snapshot().unwrap();
        let (all, tasks) =
            attributed(&rows, &platform::gui_members(desktop).unwrap(), &owner).unwrap();
        assert!(
            all.contains(&desktop) && all.contains(&owner.pid) && all.contains(&owner.runtime_pid)
        );
        assert!(owner.workloads.iter().all(|pid| tasks.contains(pid)));
        #[cfg(target_os = "macos")]
        assert!(
            all.difference(&tasks).count() > 3,
            "Native WebKit service was omitted"
        );
        println!(
            "YAM_MEMORY_SAMPLE {}",
            serde_json::to_string(&sample).unwrap()
        );
    }
}
