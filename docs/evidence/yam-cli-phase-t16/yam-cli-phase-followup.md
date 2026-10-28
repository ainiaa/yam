# Confirmed read-only CLI Agent-phase projection followup

Author: Jeff.Liu

Root and Astra independently confirmed P2 at cli.rs session_metadata:214–218: only idle/working/waiting are retained. background.rs cli_read:3320–3322 (show) and :3332–3338 (list) both invoke that function. Real AgentState.apply produces response_finished/needs_permission/needs_attention/interrupted/failed, which therefore become unknown in query metadata even after T17 safe snapshots retain them. Snapshot-gap consumers querying current state lose the phase meaning. Persisted AgentState is correct; the defect is DTO projection.

Do not change the active T18 configuration scope. After its source/docs seal and lease release, use a fresh baseline and an independent finite T16Phase task: actual apply→list/show regressions first, minimum shared finite whitelist fix, retain arbitrary-value unknown redaction and exact existing DTO fields/readonly state, affected locked Rust and independent Root/Astra review. No source/test has yet been modified for this followup.
