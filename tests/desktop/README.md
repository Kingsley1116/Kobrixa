# Desktop interaction smoke test

Run `pnpm test:desktop:smoke` (or `node tests/desktop/run-smoke.mjs`) on macOS, Windows or Linux with a graphical session. On Linux CI, run it under Xvfb. The test opens a focused Electron window: native editing commands require actual window focus.

The runner starts a temporary local Vite server, uses an isolated user-data directory, and loads the real React application and Monaco editor. A sandboxed preload supplies in-memory project/device services; it never connects to EV3 hardware or changes a user's projects. The native keyboard handler is bundled from the production source.

Coverage includes the complete Chinese command catalog, bilingual search, language switching, dark/light themes at minimum window size and 125% scale, shortcut recording and conflict round trips, two-stroke timeouts, keyboard-only dialog operation, search by shortcut, editor remapping, undo/redo, multi-cursor operations, read-only command contexts, IME input, editor options, automatic saving without formatting, undoable manual formatting, typing during pending writes, focus-change saving, JSON worker formatting, and recovery drafts after failed saves. The temporary profile and screenshots are deleted on success; failures print the artifact directory for inspection. Set `KOBRIXA_SMOKE_KEEP_ARTIFACTS=1` to retain screenshots after a successful run. Unit tests additionally cover persistence failures, invalid settings, command translation coverage, search aliases and filters, conflicting shortcuts, chord timeout and save-queue recovery.

The renderer fixtures in `apps/desktop/tests` are development-only and excluded by desktop packaging. This test does not replace platform packaging or the EV3 hardware matrix.
