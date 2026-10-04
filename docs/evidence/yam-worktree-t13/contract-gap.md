# T13 finite contract and cleanup gap

Author: Jeff.Liu. Date: 2026-10-03.

The approved T13 acceptance remains unchanged. This task is not complete while successful safe removal is unavailable; returning a fixed unavailable code is a safety boundary, not deletion acceptance.

1. Creation is explicit and separate from Start. Owner preview reserves the real first session ID, branch defaults to `codex/yam/<session-id>`, and confirmation uses an owner-issued attempt. A new root needs its own T09 project configuration preview/trust; parent trust is never carried over.
2. A bounded private atomic manifest records creating before any Git mutation. Registration alone does not establish checkout completion. Failed/interrupted creation preserves a recoverable residue and is never silently promoted to created or deleted.
3. Reserved session ID consumption is durable before history/PTY/Bridge allocation, through the existing owner create path. Duplicate/replayed/restarted Starts cannot reuse that ID. Ordinary/Resume/managed start and cleanup share a lifecycle gate with canonical descendant/alias checks; Git never holds the sessions mutex.
4. Creation uses no-checkout plus private fixed-configuration checkout of a fixed confirmed local commit, with clean/smudge/process drivers rejected, empty hooks and no lazy fetch. The controller reports a successful isolated temporary plumbing experiment; production is not yet implemented or accepted.
5. Cleanup previews remain possible, but actual deletion is unavailable. Controller/Astra source review of Git v2.39.3 and master confirms that non-force worktree removal invokes child status with the target Git directory and its local/common/worktree config. A real temporary experiment triggered an external clean filter. A preflight shadow status and after-check cannot protect that final command. There is no confirmed CLI switch disabling every filter. Force, rmtree, user common-config mutation, broad prune or custom Git registration/deletion are excluded. Review note（原始文件已归档） transcribes the supplied inline outputs and source links. No independent raw logs/scripts were captured, fixtures were removed, and these experiments were not rerun. This is not whole-crate validation.

Only isolated owned fixtures are permitted. No real agents, user repositories, GUI/system permissions, new dependencies or T13-complete claim. Initial tests/fixed-error scaffolds are distinct from production implementation; root independently verifies semantic red before the business grant.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
