# T06 current-package measurement evidence

Author: Jeff.Liu. Host: macOS ARM64, 2026-10-03. This directory preserves raw measurements and failed attempts. Measurement scope is explicit: owner RPC, production terminal modules in a native WebKit fixture, and unmeasured real App interaction.

The package was built once from HEAD `6b00a7dcad249c4fca90efbcdafdbc4a836ea8ec` plus the dirty, closed T05 product tree. build-receipt.json（原始文件已归档） freezes the relative-path product source hash and every package resource. Its descriptive build command is corrected by build-command-correction.json（原始文件已归档）, which records the actual executable argv. Runners consume that receipt and reject changed product source or package files. The parent independently matched the executable, terminal resource and Info.plist hashes. This is an unsigned release validation package, not the old October 1–2 package or a signed distribution.

## Scope and timing

- Owner runs start with a new, marker-owned empty namespace, use the same package, size each synthetic PTY to 100×40, and retain 2000 lines. Tasks never finish themselves. They write 254 UTF-8 bytes per iteration at a nominal 20 iterations/s (5080 bytes/s per task; 81280 bytes/s for 16). Actual native frame `end_offset` deltas and monotonic phase durations are saved separately; nominal pacing is not a measured output rate.
- Physical footprint and cumulative process CPU come from `proc_pid_rusage` v2, with authenticated owner/parser identities and LaunchServices coalition attribution. Component CPU counters must be finite and nonnegative. PID identity, membership and real wall-time deltas must remain valid. Application totals exclude workload processes. Per-process physical-footprint sums may repeat shared accounting; they are not unique physical memory.
- On this ARM host, CPU counters are Mach ticks. `mach_timebase_info` is 125/3. A separate 0.25 s busy-loop calibration gave 5,998,820 ticks → 0.2499508333 s, close to `resource.getrusage` 0.249962 s. Treating these ticks as nanoseconds understated CPU by 41.6667. Primary references: [Apple mach_timebase_info](https://developer.apple.com/documentation/driverkit/mach_timebase_info-c.struct) and [XNU fill_task_rusage](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c). The sampler is explicitly not the slow `footprint` CLI.
- Samples are scheduled every five monotonic seconds. Start/end, scheduled slot, late and missed slots are raw fields. Invalid, missing, late or partial samples cannot yield a complete phase. Scheduled-slot denominators include missed slots. Empty required phases, NaN, negative values, CPU rollback, reused PIDs and duplicate members fail validation.
- Module percentiles use nearest rank `ceil(p*n)-1`, with every raw sample retained and no rounding or bad-sample filtering. A WebKit write callback or two animation frames is a render opportunity, not proof of actual App pixels or native keyboard input.

## Completed module runs

[latency-module-launchservices](latency-module-launchservices) contains three rounds of 100 sequences, using plain input, ANSI TUI, Unicode/emoji and a full 32768-character paste. Each acknowledgement is emitted only after receiving the entire payload and must occur in the production projection before write completion and two animation frames. All timestamps use the same document's `performance.now`. p50 is 34/34/34 ms and p95 is 101/101/100 ms. This includes HTTP → owner RPC, the existing polling wait and two animation frames. It is an end-to-end module observation bound, not an App input target result. Production output-queue telemetry remains unmeasured.

[renderer-module-launchservices](renderer-module-launchservices) contains three rounds, each with 100 warm selections and 100 ended-scene cold restorations. Warm p95 is approximately 3/2/2 ms; forced-release cold p95 is approximately 15/16/17 ms. The cold run deliberately releases hidden static ended scenes. Its lower memory is an experiment, not a measured production policy change or whole-App memory saving. Both runs verify projection content, cursor and viewport, and preserve unrounded timings and byte footprint samples.

## Owner runs and incomplete evidence

Final serial owner baseline: [owner-short-baseline](owner-short-baseline). Three rounds completed with 18/18 samples each and ratio 1. Their 16-output memory medians were 43.520/43.270/43.395 MiB and CPU medians 0.074996/0.075903/0.075191 cores. Observed aggregate output was 77586/77694/77668 bytes/s. One further [owner-continuity-short](owner-continuity-short) run checks the later per-slot validity repair. These cover owner/parser memory and CPU; no GUI is present during PTY activity.

The continuity short completed 18/18 samples, ratio 1, with all nine output slots valid. The long runner actually started at **2026-10-03 08:23:34 UTC** (execution session 36569), using the same external receipt, with no concurrent probe/build/test. Its command is:

```sh
rtk proxy python3 scripts/terminal-performance.py --app 'apps/desktop/src-tauri/target/release/bundle/macos/YAM Performance Validation T06.app' --receipt docs/evidence/yam-performance-t06/build-receipt.json --output docs/evidence/yam-performance-t06/owner-long --rounds 1 --long-seconds 1800
```

The explicit long phase completed all 361 planned slots including both endpoints, covering 1800 scheduled monotonic seconds. The first-to-last `memory.collect` completion span (`monotonic_seconds`) is 1800.001909 s. Complete sample-end timestamps, after the per-source frame observations, span 1799.999582 s; the first complete sample start to the final complete sample end is 1800.349339 s. The separate phase-boundary output observation window spans 1800.541106 s. These are distinct observation boundaries; the derived receipt names each explicitly. Execution exited 0 at 08:55 UTC, including stop/reopen and final package verification. All 379 samples across seven phases are complete, ratio 1; late, missed and outside-phase counts are zero. Every long slot retains 16 running sources, progressing counters and the same 16 workload identities. Per-slot files are under [owner-long](owner-long); stdout progress occurs every 12 samples. Cancellation can stop only the 16 IDs returned by this run's own create calls. No real GUI is launched, notification context stays paused, and cleanup requires the exact newly created namespace's ownership marker.

Derived summary（原始文件已归档）, all 361 curve points（原始文件已归档） and post-long source/package verification（原始文件已归档） preserve the following results. MiB values here are presentation rounding; byte values and CPU deltas remain raw in the artifacts.

| Owner phase | Memory median / peak MiB | CPU median, cores |
|---|---:|---:|
| Cold owner | 25.847 / 25.940 | 0.002869 |
| One output | 30.035 / 30.581 | 0.016053 |
| Four outputs | 34.238 / 34.472 | 0.032017 |
| Sixteen outputs, short | 43.989 / 44.255 | 0.075988 |
| Sixteen outputs, 30 minutes | 54.146 / 62.443 | 0.070664 |
| Stopped tasks | 57.990 / 57.990 | 0.002999 |
| Reopened owner | 25.909 / 25.909 | 0.003046 |

The long curve begins at 44.255 MiB and ends at 58.365 MiB. The inclusive 0–60 s median is 44.989 MiB; 1740–1800 s median is 62.365 MiB. This records growth and a late peak rather than claiming a flat curve. The long-phase component medians are owner 11.110 MiB and parser 43.036 MiB; their independent peaks are 19.141 and 43.302 MiB. Stop did not materially release the retained process footprint; restarting the owner returned to 25.909 MiB. Both stopped/reopened phases have zero workload processes, and owner PID changed from 95197 to 8353. This is **owner restart, not GUI App reopen or normal Cmd+Q**.

Each source advanced by roughly 8.73 MB over the long output observation window. The aggregate delta is 139,766,082 bytes, cumulative output 141,083,670 bytes and observed rate 77,624.49 bytes/s. The workload is fixed, bounded synthetic output; it does not establish behavior under an arbitrary high-throughput terminal workload.

Before starting the long run, independent review found two reporting defects. New tests reproduced a late final slot escaping the planned phase denominator and a missing per-slot continuous-output check. The repair preserves raw missed slots but separates outside-phase spill, and checks all expected frame statuses, strictly advancing per-source offsets and fixed workload PID/start/executable identities at every output slot. The first slot establishes a running 16-source anchor. Every slot performs bounded frame RPC observations; this observer cost is included in owner CPU. Any missing/stopped/stalled/changed source is partial even if its total phase output was positive. The earlier short baseline remains valid for its recorded owner metrics, but cannot retrospectively prove this stronger per-slot continuity condition.

The following evidence must not be used as a complete baseline:

- `owner-short` failed before sampling because the initial resource path was wrong.
- `owner-short-v2` and `owner-short-final` used unconverted Mach ticks; their CPU values are invalid.
- `owner-short-mach-correct` corrected CPU units but overlapped a renderer run, and predated the external frozen build receipt. It is not a stable final CPU baseline.
- `owner-short-frozen` contains all nine actual empty-GUI samples as partial (`measurement_unavailable`, `ValueError`), and its later owner phases overlapped the renderer launch. The partial GUI result is not silently filtered. The GUI connected, but complete coalition sampling was unavailable; the exact thrown cause was not recorded. Its configured window is 1180×760; actual geometry was not measured. The own GUI was terminated and disconnection confirmed before creating any PTY, then notification pause was restored.
- `renderer-module` preserves the original native receipt timeout. A larger bounded fixture budget does not change the per-restoration performance target.
- `latency-module`, `latency-module-final`, and `latency-module-app-loop` preserve failed fixture stages. The last reached fetch/write but document visibility remained hidden at two-rAF. The final successful fix launches a private .app through LaunchServices, with a normal NSApplication event loop; it does not override visibility or change production rendering.

Real App input/switching/live-GUI footprint, visible memory UI, native Cmd+Q and notification/Hook/permission workflows remain pending. Computer control inventory timed out; no permissions were modified. These probes operate only their newly created identifiers, PTYs, temporary apps and ownership-marked namespace. Cancellation validates all requested IDs against the owned fixture set before stopping any task. No user history or CLI data is cleaned.

## Validation

Executable tests were added and observed red before each corresponding production repair; parent independently reproduced the semantic reds. Current targeted checks: performance 20, memory 13, latency 10 pass. The last review red is also retained in `/tmp/yam-t06-review-red.log`. After all measurement processes finished, checks ran sequentially:

| Command | Actual result / raw log |
|---|---|
| `rtk proxy python3 -m unittest discover -s scripts -p 'test_*.py'` | 63 passed, 10.660 s; `/tmp/yam-t06-full-python.log` |
| `rtk proxy pnpm --dir apps/desktop test:coverage` | 138 passed, 1.082 s test duration; `/tmp/yam-t06-full-node-coverage.log` |
| `rtk proxy pnpm --dir apps/desktop build` | Passed; Vite transform/build stage 178 ms, existing >500 kB chunk warning; `/tmp/yam-t06-full-build.log` |
| `rtk proxy cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` | Passed; `/tmp/yam-t06-full-fmt.log` |
| `rtk proxy cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings` | Passed, 7.74 s; `/tmp/yam-t06-full-clippy.log` |

The covered frontend tool TypeScript files have lines/functions 100% and branches 98.69%; this is not whole React or Rust coverage. Python tests and the SEA/native build were not run concurrently in the final checks. No measured package was rebuilt. Final diff, 60 local-document links, 797 strict JSON inputs, 361 CSV rows and frozen source/package matching passed; see final validation receipt（原始文件已归档）. Official Converge coverage/provider gates remain unconfigured and are distinct from actual executable tests.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
