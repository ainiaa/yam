# T15 pure preference stage (partial)

Author: Jeff.Liu. `partial_scope=pure preference validation only`. This candidate has no App integration, real localStorage access, owner request, automatic attach/restore, PTY, GUI or process launch. Full T15 remains pending the owner's cross-reopen identity contract and subsequent App/race/native work.

The pure snapshot is exactly `{version:1,mode,panes,selected}`. It stores no command, argv, prompt, environment, owner, launch data or runtime revisions. Single has one slot, horizontal/vertical two, grid four; IDs are unique or null. Non-null selection must be a member; null selection identifies an empty slot. Decoding resets runtime revision to zero and picks the selected ID/first empty slot. The input bound is 4096 JavaScript string code units checked before JSON parsing, not a UTF-8-byte claim. Valid snapshots use ASCII hexadecimal `s-…-…` IDs of at most64 characters, matching the existing generator's format. Decode/load failures return fresh single-pane state with fixed warnings; invalid encode never reaches a write callback, and save failures return fixed warnings without raw error text.

Four APIs use the existing callback preference pattern: decode, encode, load(read), save(layout,write). There is no new storage abstraction, App preference key or owner witness. A type-only dependency reuses T14 TerminalLayoutState. The actual `next_session_id` CodeGraph source is `format!("s-{now:x}-{sequence:x}")`; no broader legacy format or owner identity is assumed.

| Actual evidence | Result | Scope |
| --- | --- | --- |
| [Initial red](pure-scaffold-red.log), [source/argv receipt](pure-scaffold-red.json) | 13/13 failures, exit1, .146s | Normal executable fixed-error scaffold, not an import/compiler failure |
| [Root independent red](yam-t15-root-pure-red.log) | 13/13 semantic failures | Independent actual run before pure implementation |
| [Sparse-array red](pure-sparse-array-red.log) | 1 AssertionError, missing expected exception | Strict encode must reject missing slots, not serialize them as null |
| [First build](pure-frontend-build.log) | exit2, TS2550 | Existing lib lacks Object.hasOwn; fixed with existing hasOwnProperty.call, no config/dependency change |
| [Final targeted](pure-final-targeted.log) | 46/46 passed, exit0, .310s | 13 pure plus33 unchanged terminal-view tests |
| [Final full coverage](pure-final-node.log) | 252 passed, exit0, 2.742s | Tool TS module lines/branches/functions100%; aggregate branches95.08%, no native/React/Rust coverage claim |
| [Standard build](pure-final-build.log), [diff](pure-final-diff.log) | exit0, 1.300s/.015s | Standard pnpm build, not tsc-b; existing large-chunk advisory remains |

[Pure code freeze](pure-code-freeze.json) contains two source/test hashes. [Actual checks](pure-final-checks.json) preserve argv/exit/elapsed values. Rust/Python were not rerun: their inputs remain identical to the actual [T14 validation](../yam-layout-t14/validation.json), which explicitly references same-source Python80 and T13 Rust340/2ignored. This is not a new full T15 verification or official provider gate. Independent pure-stage review is pending at preparation; original failed logs are retained.

The user has not yet chosen the cross-reopen owner identity semantics. No default/elapsed time is treated as approval, no owner witness is persisted, and no cross-reopen automatic restoration is implemented. App integration, running/ended/archive/missing resolution, user/notification/owner race guards and real GUI reopen acceptance remain pending. Existing T14 source/tests/native limits are unchanged.
