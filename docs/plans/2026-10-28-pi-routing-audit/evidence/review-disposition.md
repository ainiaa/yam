作者：Jeff.Liu

P1 confirmed: legacy native off was ambiguous and must remain off. Updated failing assertion first, observed red, removed automatic reinterpretation; 57 targeted tests pass.

P2 not applicable to current integration: App.tsx renders PiRoutingBar with key `${session.session_id}:${currentAgent?.generation??''}` at line 3362. React remounts and discards all state for either identity change. No redundant identity machinery added.

Reviewed scope: Pi router and status bar changes only; no new dependencies or official CLI changes. Native branch/projection APIs retain ownership of conversation messages.
