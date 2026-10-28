# T13 recovery scope — normative finite clarification

Author: Jeff.Liu.

This clarification supersedes retry/rollback offers in the preparation draft. The initial cleanup action accepts only Created, checkout_complete, physically verified, clean, inactive YAM-managed records. It implements the complete preview-confirm-quarantine-unregister-native-Trash flow and a durable verified final outcome.

Nonfinal Prepared/Quarantined/Unregistered/Trashing outcomes are reconciled without filesystem disposition, Git registration repair, or another native Trash call. Display recovery-needed with the verified retained location (or fixed unknown-destination warning), original source and branch-retained information. Files remain available for explicit manual recovery; no one-click rollback, retry, registration recreation or broad Trash search is provided in this slice.

If Prepared is proved untouched and the original physical identity and registration remain intact, reconciliation can restore the public Created state; the former token is invalid and a later new preview/confirm is ordinary initial cleanup authorization. Quarantined and later nonfinal states remain Removing/recovery-needed. A durable verified Trashed result may be returned idempotently for the same confirmed operation without repeating Git/native actions. Listing/restart/reconnect never performs another disposition.

This keeps interrupted data recoverable and results truthful without claiming Git restoration. It adds no dependency, public wire key, owned path or destructive authorization. The frozen plan acceptance and decision T13D2 already specify this boundary.
