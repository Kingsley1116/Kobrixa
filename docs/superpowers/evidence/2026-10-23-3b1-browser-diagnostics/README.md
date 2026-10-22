# 3B1 browser diagnostics — partial evidence

These are authoring diagnostics, **not P160 acceptance or Stage 3 completion**.

The observer loads the actual production main/preload/renderer bundles, with two real SDK consumers and a fresh canonical temporary profile. There are no mock IPC/services. The CJK run uses the explicit `--plain-glyphs` flag: only the visible note initial value changes from `🙂界` to `界`; the RPC Unicode output assertion still uses `🙂界`. This mode does not verify emoji display. Its source identity is dirty `4f49ab9` (status initialization fixes subsequently committed as `9a95251`), as preserved in the raw report. Later changes to the harness are not covered by this receipt.

Observed CJK results: two active statuses continue updating after 1,000 API open/close cycles; stale forms/foreign bindings reject; duplicate close acknowledges; literal HTML stays text; native mouse input focuses the actual control; normal close exits with all recorded child PIDs absent. These API cycles are not renderer mount cycles or a zero-resource diagnostic claim. Recovery snapshot requests racing normal close log `Device recovery is unavailable`; that shutdown-observation behavior remains to be assessed.

The default emoji workbench run crashes with exit code 10. Its local-only crash dump has `EXC_BAD_ACCESS` in `ImageIO` → `CoreText CopyEmojiImage` → `CTFontDrawGlyphs`. A separate minimal Electron page containing a UTF-8 `🙂界` textarea reproduces the crash; the corresponding ASCII page focuses and accepts native input normally. The raw dump stays in the named temporary path; its SHA-256 and LLDB backtrace are retained here. No system font, renderer sandbox, or OS security setting was changed. Emoji display remains a failed environment/runtime prerequisite, not a pass or a product workaround.

Independent reviews, the full native motion matrix, status replay/remount, actual diagnostics/heap counters, three full load repetitions, installed old-SDK compatibility, and physical/manual checks are still pending. See the Stage 3 execution ledger for subsequent work.
