# Fourth pressure run: failed final cleanup flush

Frozen candidate 237bcac; offline Linux Electron host137, two real SDK consumers1066/1067. The timed write loop ran beyond600seconds with settled flushes between replacement and restaging. Final fixture cleanup aborted two intentionally unpublished sealed writes, then incorrectly demanded a successful all-saved flush. Both consumers returned PLUGIN_E_STORAGE_CONFLICT / flush-incomplete. The retained aggregate includes the original failure and cleanup failure. This does not prove a successful full load run or completed1000 UI cycles. No product limit, abort semantics, or RSS acceptance threshold is changed by this record.

Raw source profile remains at the inventory paths. This archive preserves traces, failure receipts and controller logs, not the complete payload directory. A corrected fixture requires a fresh immutable run; this failure is not relabelled as a pass.
