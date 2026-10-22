**Spec FAIL. Quality FAIL.** Two remaining findings in `ad2083c` against `79b7ef2`:

1. **P2 — Invalid oversized drafts still block core safety actions.**
   [state-store.ts:206](/Users/kingsley/Documents/Kobrixa/.claude/worktrees/plugin-3b1/apps/desktop/src/renderer/plugin-ui/state-store.ts:206) sends the entire draft for stop/disconnect/openRecovery. IPC rejects forms exceeding 16 KiB before reaching the core route.

   **Trigger:** an admitted panel has five text fields, each allowing 4,000 characters. Fill each field. The core button remains enabled, but clicking returns `PLUGIN_E_STALE_RESOURCE`; the core handler never runs. An in-memory probe through the actual IPC registration reproduced this with a 20,036-byte draft.

2. **P3 — Reconciliation errors are not fenced by private edit generation.**
   [state-store.ts:170](/Users/kingsley/Documents/Kobrixa/.claude/worktrees/plugin-3b1/apps/desktop/src/renderer/plugin-ui/state-store.ts:170) publishes `problem: "snapshot"` without checking whether the user edited during reconciliation.

   **Trigger:** finish one action, explicitly invoke another, edit while its reconciliation snapshot is pending, then reject that snapshot. The edit clears the problem, but the older reconciliation restores it. An in-memory probe reproduced this. The subsequent generation check prevents dispatch, but occurs after this error publication.

Otherwise, the scoped trace supports strict accepted revision +1 submission, explicit reconciliation without side-effect replay, late field-error fencing, and original-admission hold cleanup with stop first. **I2 passes:** actual registry retirement emits notifications after the last voluntary close, renderer handling purges cached drafts, and receipts are bounded without timers or retained resources.

No edits, installs, agents, suites, or Electron runs. Dirty desktop observers and closed D160/V160/K160 findings were excluded. Physical/native behavior remains with the controller’s independent checks.
