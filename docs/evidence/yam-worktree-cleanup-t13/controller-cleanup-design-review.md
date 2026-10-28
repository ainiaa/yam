# T13 quarantine cleanup design review

Author: Jeff.Liu
Result: NOT READY to certify the bare quarantine + missing-path Git remove + recursive erase candidate as complete. The original T13 requirements do not promise immunity to a malicious same-UID attacker; the stronger external-writer schedules below delimit the candidate rather than automatically becoming new acceptance requirements. The candidate can remove Git registration without --force in an uncontended fixture, but neither the probe nor current platform primitives establish a transaction that also safely deletes all data. This is a bounded design blocker, not a claim that every conceivable OS-isolated implementation is impossible.

Scope: read-only source, prior raw fixture outputs and primary documentation. No repo source, real worktree, Git config, filesystem fixture or live process was modified. Only this /tmp report was written. No runtime probe was repeated.

## Verified evidence

The supplied /tmp/yam-t13-cleanup-isolation-probes.md and three quarantine raw JSON files show:
- Same-parent rename then ordinary git worktree remove OLD exits 0; filter sentinel untouched; real registry entry gone; quarantine still exists.
- The surviving quarantine .git points to deleted admin metadata. git status exits 128 and git worktree repair exits 1. Post-remove rollback is not just rename-back.
- Malformed common config makes removal fail before deleting admin metadata; restoring fixture config permits retry. Missing target does not mean original config is never parsed.
- Other supplied isolation candidates either execute filters or change cleanliness semantics. They are not execution barriers for removal.

The upstream Git 2.54.0 remove implementation validates the registered path, tests path existence, invokes a status subprocess if it exists, recursively deletes it, then removes admin metadata. Metadata deletion continues after a physical-delete error. Thus neither parent prechecks nor the Git exit code alone identify the final state. Its API does not accept an expected filesystem identity or transaction token. [Git source](https://raw.githubusercontent.com/git/git/v2.54.0/builtin/worktree.c), remove_worktree/check_clean_worktree/delete_git_work_tree, lines 1240-1338.

Rename preserves existing file descriptors; atomic name replacement is not a freeze of directory contents. A no-replace rename flag can protect a destination name but cannot revoke writers or keep the original name absent. [rename reference](https://man7.org/linux/man-pages/man2/rename.2.html).

Rust remove_dir_all provides symlink-race protection on the mainstream supported platforms, but its contract permits partial removal and DirectoryNotEmpty under concurrent writes. It neither checks a previously reviewed inventory nor refuses every newly added regular file. [Rust API](https://doc.rust-lang.org/std/fs/fn.remove_dir_all.html).

## Current code and reusable boundaries

1. worktree_manager.rs:940-976 has Created/Removing/Removed states, but no cleanup journal. WorktreeIdentity stores repository/common/target filesystem IDs only. decode_manifest:982 validates version 1, bounded record counts/strings and identity map. There is no quarantine path, parent identity, expected inventory, cleanup phase or post-registration recovery record.
2. read_manifest:1047 uses bounded regular-file reads with O_NOFOLLOW on Unix. save_manifest:1072 uses exclusive temp, sync file, rename, then sync parent on Unix. This is a useful durable transition pattern; quarantine parent rename needs its own durable handling. Do not silently infer recovery from a filesystem name prefix.
3. directory_identity:1803 uses dev+ino on Unix, volume+file IDs on Windows; verify_physical:1858 binds repo/common/target roots. These are lookup checks, not held directory capabilities. fs::metadata follows symlinks, with canonical checks separately in verify_relation:1708. A cleanup path needs nofollow handle-based identity at rename and disposal boundaries, not just repeat these helpers and assume atomicity.
4. verify_relation:1708 binds top-level/common/branch and unclaimed HEAD. Claimed worktrees may legitimately advance HEAD (1745), so cleanup must assess current HEAD/index and keep the branch; do not require the original creation commit as a shortcut. list_managed:1752 knows how to reconcile Creating only, not Removing.
5. validate_cleanup:1149 and cleanup_guard:1193 are cfg(test). They demonstrate intended dirty/untracked/ignored/nested/active refusal, but provide no production preflight. owner_command:2000 returns worktree_cleanup_unavailable for both cleanup endpoints. Do not represent these unit predicates as implemented safe deletion.
6. LIFECYCLE:979 and start_guard:1189 are real production gates. create_session_owner_with_worktree in lib.rs:2449 holds this gate through ordinary/managed/resumed allocation. Cleanup must acquire the same gate BEFORE reading active sessions and hold it through its last destructive operation. prepare_start:1876 refuses non-Created records for matching target associations.
7. Existing cleanup RPC wrappers lib.rs:2245-2263 pass only private root/args to owner_command. It has no manager/active-session access. A real cleanup wrapper must snapshot current owner sessions (including starting/live descendants and aliases) while holding LIFECYCLE, then release sessions/history mutexes before spawning Git. A frontend active flag or stale HistoryStore status is insufficient.
8. git_context.rs:428-752 already has a bounded isolated shadow status query. It copies index, config conversion allowlist and info attributes/exclude, verifies effective attributes, and runs status with a private execution barrier. Rechecking originals is snapshot validation, not that barrier. config_environment:332 only carries relevant config environment and rejects redirected Git state; it does not isolate local/common config by itself.
9. Existing query returns only dirty/branch; status uses --untracked-files=normal and --ignore-submodules=all and does not request ignored files. It cannot be reused unchanged as a cleanup certificate. Cleanup must explicitly reject every ignored/untracked entry and nested repo/gitlink (HEAD and index, including staged deletion tricks), plus unsupported attributes/conversions, bounds and inaccessible entries. Keep clean/smudge/process rejection from worktree_manager:1168. A successful dirty=false status is not authorization to recursively erase ignored data.

## Concrete failure schedules: why the proposed chain does not close

A. Old-path recreation re-enables Git status and filter execution.
- Preflight and identity checks pass for T. App records journal, renames T to Q, checks T absent.
- Before the child Git process tests file_exists(T), another same-user process recreates T with its valid .git link pointing to the still-existing admin directory. That process may also add a clean/process driver to repo or worktree config after App's preflight. Nothing in the private YAM lifecycle mutex prevents this.
- Git sees a valid existing worktree and invokes status using that config. A postcheck cannot undo a filter process already executed. If its status is clean, Git can also delete the recreated path. Even without a malicious driver, the stranger's ignored data is not protected by ordinary remove.
- More app-side prechecks only move the last race window. Holding a directory FD pins identity but does not reserve the absent basename for Git's path-based lookup. Git worktree lock blocks ordinary remove itself and is not a filesystem write lock.

B. Quarantine ownership does not prove its contents are still clean.
- A writer opens T/tracked-file, App validates clean state and renames T to Q; Q has the expected root inode.
- Writer modifies its still-open file, or a process with an open directory/CWD creates ignored data after the last inventory comparison.
- Recursive disposal erases the new bytes. The root ID, branch and manifest remain unchanged. An inventory-based deleter also has a final compare-to-unlink gap for changed regular files; per-entry inode checks do not detect all content mutation or freeze writes.
- chmod on names, random quarantine naming, a same-user 0700 directory and advisory flock are not revocation of existing handles and do not stop an uncooperative same-user owner. Do not describe them as exclusive write authority.

C. Crash after registry removal changes what rollback can mean.
- After ordinary remove succeeds, Q is unregistered data; its .git link is broken. Without its own durable recovery phase, a restart cannot safely interpret it as an ordinary worktree or re-run the same remove as if no effect happened.
- If disposal partially deletes Q then fails/crashes, rename-back cannot reconstruct the removed files or Git admin metadata. Error != no effect. Retrying blanket recursion can erase data added after the first attempt.
- A journal can truthfully expose/preserve residue but cannot restore bytes already unlinked or establish exclusivity. Keeping Q is safe failure behavior; it is not completed cleanup.

These schedules use behaviors allowed by the existing arbitrary target parent and normal user processes. They do not rely on root privileges, a new dependency or an exotic filesystem. They identify the missing guarantees in this particular protocol; ordinary no-force syntax by itself does not satisfy the safety intent once Git's clean check is intentionally bypassed using a missing path.

## Minimum state machine if a real exclusion/disposal boundary is established

The following is the smallest useful implementation skeleton, conditional on closing A/B rather than claiming that journaling closes them.

- Preview: verify owned manifest record, physical repo/common/target/parent identities, exact registered non-main/non-locked relation, current HEAD/index, no active owner session/alias/descendant, and fully clean isolated inventory including ignored and nested entries. Store a one-use short-lived preview bound to manifest revision and all identities, not a boolean clean flag.
- Commit preflight: acquire lifecycle; reload the manifest; consume matching preview; snapshot/recheck owner active sessions; run bounded safe preflight; refuse every unavailable/unsupported/changed result before mutation. No force, prune, branch delete, handwritten Git registry edits or user config changes.
- Prepared: persist Removing + cleanup operation identity + original/quarantine locations + parent and target IDs BEFORE rename; block new start via target AND quarantine aliases. Use unique no-replace same-filesystem rename and validate held-directory identity. Sync the affected parent before publishing Quarantined. Failure to persist/sync remains indeterminate; stop and reconcile.
- Quarantined: Q exists with bound ID and T absent. Only with a demonstrated exclusion preventing T recreation may ordinary removal be invoked. Bound timeout/kill behavior does not imply rollback; on return inspect registry plus paths regardless of exit status.
- Unregistered: persist this phase only after exact registration absence verified, with Q identity retained. This is explicitly not Removed. Do not auto-rename Q back or synthesize registry metadata. Preserve actual recoverable bytes on any ambiguity.
- Disposing: only with a demonstrated content-write exclusion OR an explicitly accepted recoverable data-retention mechanism may bounded physical disposal start. Handle-relative nofollow traversal and an expected inventory are useful containment checks, but do not constitute write exclusion. Never follow symlinks/reparse points or cross devices; refuse extras/type/identity changes and preserve residue. There must be an honest strategy for crash after each entry removal.
- Removed: publish only when original registered identity is absent, expected quarantine is absent after complete disposal, and no owned cleanup residue remains. An external recreated T is a separate object: never touch it and never report that foreign directory as deleted. Keep the branch.

Recovery matrix:
| Journal + observation | Safe response |
|---|---|
| Prepared; T bound identity exists, Q absent, registry intact | no rename occurred; re-preflight before retry, or restore Created after full verification |
| Prepared/Quarantined; Q bound identity exists, T absent, registry intact | either retry under the required exclusion or verified no-replace rollback; revalidate Q contents first |
| Q bound identity exists; T occupied by another object | preserve both, mark conflict; no remove, rollback, overwrite or deleting the foreign T |
| Registry absent; Q bound identity exists | persist Unregistered recovery-needed; preserve Q; no automatic repair claim |
| Disposal partial; Q remains | recovery-needed with exact phase/inventory; no Removed or unconditional recursive retry |
| Expected Q absent; registry absent | reconcile only a durable disposing record with trustworthy ownership evidence; absence alone is not permission to delete anything |
| Both expected T and Q identities missing/mismatch, bad manifest/config, timeout, unknown Git result | stop/preserve; report explicit fixed recovery error |

This extends manifest lifecycle meaning and owner-start association checks; it is not a two-line cleanup function. Existing dependencies include libc usage, so Unix nofollow/relative syscalls need not imply a new crate. Equivalent Windows handle/no-reparse behavior and cross-platform rename semantics still require independent evidence; do not claim three-platform support from the macOS probe.

## Required RED tests before any destructive implementation

Use only owned temp repositories and deterministic fault hooks, never user worktrees. Existing worktree_manager GitFixture and CreateFault patterns are reusable.

- Real cleanup endpoint takes production lifecycle gate and sees actual owner active/starting/resume descendants and path aliases; refusal has zero Git removal/rename/disposal calls.
- Dirty tracked, staged, ordinary untracked, ignored-only (including info/exclude), nested repo, HEAD/index gitlink, filtered config (clean/smudge/process), changed attributes/config, unsupported conversion, bounds and permission failure all refuse before mutation; sentinels stay unexecuted.
- Insert old-path recreation immediately after final absence check and before Git's own check; require zero execution/deletion at foreign T, not merely a later error. This test must FAIL the bare proposed chain.
- Keep an open file/directory handle through rename, write after final inventory recheck, and require preservation of new bytes. This test must FAIL blanket remove_dir_all/compare-then-unlink if no exclusion exists.
- Root/parent/quarantine replaced with symlink, different inode, junction or cross-device target cannot redirect disposal; original bytes and foreign sentinels survive.
- Crash/fault before/after every journal save, rename, registry removal, each disposal boundary and final save; reopen through actual production reconciliation, repeat retry, assert correct phase and no duplicate/wrong-target deletion.
- Git remove nonzero with registry already missing and timeout with unknown effect must be reconciled, never assumed safe rollback.
- Successful isolated clean path must demonstrate registry absent AND physical quarantine absent, no force/prune/branch deletion/user-config writes, idempotent final state and future unrelated start unaffected. Rename-only success is insufficient.

## Actionable conclusion

Do not enable the destructive endpoint by treating the bare quarantine chain as an already proven safety boundary. Apply the original T13 contract, not a silently strengthened universal same-UID adversary model. The smallest safe next implementation is the non-destructive production cleanup preflight/preview with explicit unavailable execution, if the root decides that independently useful slice is within scope; it must remain partial T13.

To claim the STRONGER permanent-erasure / arbitrary concurrent-writer guarantee discussed in the failure schedules, one of the following boundaries would need to be explicit and independently proven: (1) an OS-enforced, platform-specific namespace/write exclusion spanning Git removal and disposal, including already-open writers; or (2) changed product semantics that retain recoverable data rather than permanently disposing it, with recovery metadata and an accurate non-complete status. No such boundary is present in the current source or supplied probe. The original T13 contract does not impose that universal guarantee; its practical scope and recoverable Trash option are assessed below. Do not silently promote or weaken an already frozen filter-execution guarantee.

This report proves the candidate's missing conditions by source-supported schedules; it does not authorize new dependencies, filesystem permission changes, external-process interruption, or weakening the original no-force/clean/ownership requirements and any separately frozen no-filter-execution contract.


## Scope correction after reading original T13 (authoritative)

Read directly: docs/superpowers/plans/2026-10-03-yam-optimization-proposal.md:217-225. Required: only YAM-created, no active sessions, clean, preview plus confirmation, refuse dirty, no --force, no existing-user-directory deletion, no submodule/nested management; failures retain recoverable records. It does NOT specify permanent erasure, a particular rmtree/quarantine algorithm, complete immunity to all external writers, or resistance to a process that can rewrite the same user's entire app data. Any earlier phrasing here implying those stronger promises is subordinate to this section.

Threat distinctions:
- YAM's own ordinary/managed/resumed starts are concrete business races: the production lifecycle gate can and must close these, using real manager state. No blocker here; the current missing integration is implementable.
- Normal editors, background build tools and shells may keep handles or write into a directory without being YAM sessions. A quarantine root inode match does not show that its contents remain unchanged. Recheck the isolated inventory after rename and stop/preserve on change. Recoverable final disposition avoids turning an undetected late save into permanent data loss. This is a practical safety improvement, not a demand to freeze every user process forever.
- Deliberately recreating a valid .git checkout at exactly the old basename while changing filter config, or replacing the app's 0700 directory as its own UID, is a substantially stronger same-user manipulation model. Do not use it to conclude all cleanup is impossible. It does prove that the missing-path trick is NOT an unconditional execution sandbox; a claim of absolute no-filter execution under arbitrary concurrent config/path replacement requires a real boundary. Ordinary rechecks may support a bounded cooperating-user model but cannot prove that stronger statement.

background::private_root at background.rs:120-138 verifies non-symlink directory and owner UID, applies 0700 on Unix and protected ACL on Windows. This is useful and adequate to exclude OTHER users from the manifest/private operation state. It does not protect arbitrary target parent paths accepted by inspect_create:1286-1313, prevent ordinary processes from using their pre-opened target handles, or exclude the same user. Moving quarantine under a verified same-volume private operation directory reduces accidental name collisions and third-party-user access; it cannot revoke handles. Cross-device private storage must fail closed rather than copy-and-delete by surprise.

## Recoverable Trash vs intermediate quarantine

A durable, visible, user-restorable system Trash operation is a possible final cleanup semantics under the ORIGINAL wording because permanent disk-space reclamation was never specified. It need not be dismissed as forever partial solely because the bytes remain recoverable. Distinguish three outcomes:

1. Bare rename to an obscure .yam-quarantine path: intermediate/residue, not completed cleanup. Registry or actual location may still be wrong; no stable recovery/disposition experience exists.
2. Git registration removed AND whole owned directory successfully transferred to the native/system Trash AND recoverable location/operation result journaled: can count as the implemented safe cleanup feature if preview/result clearly says moved to Trash, branch kept, no space-reclamation or automatic Git-worktree-restore claim. It still requires safe owner/active/clean preflight, crash reconciliation, stale-path checks and actual platform integration tests. The source/raw evidence here does not yet prove this path.
3. Registry removed but Trash API rejects/fails/unknown result: remain recovery-needed with Q intact, never silently fall back to permanent erase or mark Removed. Post-remove Q has a broken .git pointer; restore of its files from Trash does not automatically rebuild a registered worktree. Say this accurately.

The freedesktop Trash specification explicitly distinguishes trashing from erasing, requires unique stored names and original-location metadata, and says a failed trash operation must not silently erase the file. It also separates trashing from freeing disk space. [Trash specification](https://specifications.freedesktop.org/trash/latest/). This supplies a product-consistent recovery concept, not a ready-made installed cross-platform API. The Apple API documentation entry exists but its detailed Markdown could not be retrieved here; no specific macOS return/atomicity guarantee is claimed from that page.

Reviewer recommendation for Root: freeze a narrower practical contract before a writer implements it: production preflight plus lifecycle/ownership safeguards, explicit Trash disposition on supported platforms, and recovery-needed on every indeterminate/partial state. This does not require inventing permanent erasure as an acceptance condition or negotiating away the original user's safety constraints. Native platform API via already installed bindings/FFI may avoid a new crate, but check actual platform capability and output semantics first; no new dependency is approved here. If the previously agreed no-filter requirement is absolute even during benign config changes plus old-path recreation, the missing-path Git trick remains an unresolved execution boundary and must not be waved through by the Trash improvement.

Practical decision: the original T13 is implementable in principle; the current three-step candidate is incomplete, not universally impossible. The concrete missing work is production active/clean preflight, durable cleanup state and observable final recoverable disposition, plus a precise decision about the filter-execution concurrency guarantee. Do not authorize rmtree merely because the root belongs to YAM.
