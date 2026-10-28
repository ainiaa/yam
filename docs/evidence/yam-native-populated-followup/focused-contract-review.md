# Focused live-task reopen baseline correction review

Author: Jeff.Liu.

Verdict: **contractReady** for the added pre-admission baseline correction. No necessary correction identified.

Reviewed contract: `/tmp/yam-native-live-reopen-focused-contract.md`
Current SHA-256: `8caf9319ca4050f7884365ca763f7c20b4cdd0c8691b1f643293cbc1f4dd7d2b`
Review time: 2026-10-04T03:04:41.851008+00:00

The correction explicitly retires original owner PID 39005 as the live baseline. It binds the focused slice to replacement owner PID 41144 plus its current instance/start identity, independently attributed by Root to the same staged executable and private environment. Same-owner assertions apply only from that new baseline through the immediate live-task reopen checkpoint. It does not claim survival of the original owner across the expiry gap.

The failed old-instance guard and superseding receipt are retained, and the correction states that no fresh task has yet been admitted. The existing exact-two-fresh-task budget and subsequent expiry/identity-failure stopping condition remain in force. PID alone is not the identity: the existing contract still requires namespace/executable/instance/start and environment guards before submission and through reopen.

The unchanged contract portions retain the prior review. That original review is preserved byte-for-byte at `/tmp/yam-native-live-reopen-focused-astra-contract-review-prior.md`, SHA-256 `087958ac5a48184e6620d0ee3f0280e3e81c4ae6142103a8dd28cfc138ef07f7`.

This is a read-only review of the new contract paragraph. The reported process guards and zero-admission state are Root-provided execution evidence, not independently rerun by this reviewer. No GUI, task, process, repository or sealed-archive action was performed.
