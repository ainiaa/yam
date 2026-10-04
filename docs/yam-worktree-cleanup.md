# Managed worktree cleanup on macOS

Author: Jeff.Liu

In **Managed records**, choose **Preview cleanup** for a completed YAM-created worktree. Review its directory, branch and current commit, then explicitly choose **Move to Trash**. Preview and cancellation before confirmation change no worktree files. Session launch remains a separate action. This also works when the active project is the worktree itself.

The owner checks physical ownership, Git registration, current branch/HEAD and the actual session map. Running, starting or finishing sessions using the worktree or an alias/descendant block cleanup. Retained completed sessions alone do not block it. Tracked/staged changes, assume-unchanged/skip-worktree index flags (even when currently clean), all untracked/ignored files, nested repositories, gitlinks, unsupported conversion/configuration, locks, invalid identity and unavailable/over-limit reads refuse the operation. A legitimate clean commit after creation can be cleaned up; its branch and commits are retained.

A confirmed operation moves the entire directory into an exclusive private quarantine on the same volume, rechecks its observed contents, removes the original Git registration with ordinary non-force `git worktree remove`, and invokes Foundation Trash. Only a verified returned file URL/object identity and durably saved final result produce **Moved to Trash; branch retained**. Restoring files from Trash does not restore their Git worktree registration. No disk-space reclamation, permanent erasure or automatic restoration is promised.

## Interrupted or uncertain results

The private, bounded manifest records Prepared → Quarantined → Unregistered → Trashing → Trashed. Every nonfinal uncertain operation preserves its known files and reports recovery needed. Listing/reconnecting performs no new rename, Git removal or Trash call. An untouched Prepared operation can reconcile its journal back to Created; its old token is invalid, so any later cleanup needs a new preview. Other nonfinal operations have manual recovery guidance only: there is no retry, rollback or registration-repair control.

A durable Trashed request repeated with the same token returns its historical result without repeating disposition. A crash after Foundation moves files but before saving its returned URL remains unresolved; the implementation does not search Trash or guess the destination. A saved returned path displays its historical verified location. Unresolved native movement with an unconfirmed quarantine identity is explicitly location-unknown; other retained recovery results show the quarantine path only as a possible location. Review the retained directory or system Trash manually. An obsolete `.git` link in a quarantined tree is not a restored Git registration.

## Engineering and verification limits

Cleanup previews are owner-bound, one-use opaque tokens valid for 120 seconds. Confirm accepts only attempt/token, never a caller-supplied path. Lifecycle admission remains held through cleanup, while session/history mutexes are released before Git/native I/O. Regular read-only Git context retains its existing behavior.

Each isolated cleanliness query shares a two-second deadline and 1 MiB cumulative output/metadata budget, rejects more than 4096 inventory entries and never traverses directory symlinks. Effective external clean/smudge/process filters are refused; fixed private Git configuration is the status execution barrier. Global cleanup preview storage is limited to 256 entries and 1 MiB total certificate bytes; manifest storage remains 1 MiB/256 records. Ordinary removal has its own bounded Git command budget. Foundation is synchronous and has no cancellable timeout; a client disconnect does not cancel or authorize a second native operation.

Immediately after successful configuration checks, the original path is checked absent again before ordinary removal. The original path must remain absent for the ordinary Git removal safety condition. Observed rechecks are not a universal sandbox against a deliberate same-UID writer changing config/paths between checks. Already-open handles can still write to the whole moved directory; injected tests verify those bytes remain in the moved tree. No `--force`, prune, reset, clean, branch deletion or recursive erase is used for cleanup.

Automated tests use only owned temporary Git repositories and injected Trash callbacks. The production Foundation binding compiles on this host, but actual macOS Trash, real GUI confirmation/permission behavior and Windows/Linux native acceptance have not been executed. Other platforms return a fixed unsupported error before cleanup mutation. Formal provider coverage is uncovered; executable host checks and independent source review are separate. See [task evidence](evidence/yam-worktree-cleanup-t13/README.md).
