# Native last-window reopen

Command: `node tests/desktop/declarative-ui-browser-run.mjs --plain-glyphs --reopen`.
Clean product and observer commit: `89b3446`. Observed exit 0 on macOS arm64.

The original production bundle at `e4ff9a5` failed the second public UI open with `PLUGIN_E_UI_RESOURCE` after normal last-window close. The repaired production main/preload/renderer retain the host while retiring the closed window. Both windows pass the actual UI probe, 1,000 bridge cycles each, live panel/status updates and literal text rendering. Replacement processes have different process epochs and panel identities under the same host epoch; the old window binding is rejected by actual IPC. All recorded child PIDs are absent after normal closure. Raw receipts and logs are retained as gzip, with uncompressed hashes in files.json.

The observer uses native focus for the replacement window and respects the restored pane layout. It does not turn an already visible pane off merely to open it again. Those observer corrections are separate from the production lifecycle fix.

This is the CJK diagnostic mode for the known platform emoji rasterization issue, not an emoji display pass. It uses test plugins with no connected physical device. Device stop/readback and installer-backend failure are separately verified by real composition/formal-provider tests. It does not establish a signed installer, physical hardware or another OS result. Independent review remains required.
