# Desktop tools acceptance — 2026-09-22

Implemented: aligned 18px file-tree indentation and folder icons; 14px UI / 16px code defaults; persisted appearance options; Connection / EV3 files / Activity tabs; diagnostics-only bottom panel; 360px tools pane with 320–520px resizing and a content-driven overlay.

EV3 file access is restricted in the main process to `/home/root/lms2012/prjs`, including `SD_Card` and `USB_Stick`. Storage roots cannot be renamed or deleted. Native dialogs select upload/download paths and confirm replacement or recursive deletion. Downloads use a temporary sibling file and validate size and available MD5 before final delivery. Rename copies, compares directory contents / sizes / checksums, and removes the source only after successful verification. Device operations share a session lock; local editing remains available during file transfers. Session and request identifiers reject stale results and progress.

## Automated checks

- Desktop and device TypeScript checks passed.
- ESLint for `apps/desktop/src` and `packages/device/src` passed.
- Desktop + device suites: 85 tests passed.
- Coverage includes multi-packet listings, segmented and empty downloads, streamed uploads, handle cleanup, timeouts, disconnects, overwrite confirmation, partial download cleanup, checksum mismatch, recursive folder operations, rename collisions and partial failures, protected roots, stale responses, operation locks and deployed-version invalidation.
- Existing run-controller, drafts, workspace mutations, diagnostics and compiler integration tests passed.

Commands (local dependency executables, without package-manager downloads):

```sh
node node_modules/typescript/bin/tsc -p packages/device/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.json --noEmit
node node_modules/eslint/bin/eslint.js apps/desktop/src packages/device/src
node node_modules/vitest/vitest.mjs run --project desktop --project @kobrixa/device
```

## Electron acceptance

Production renderer and main/preload bundles were launched in real Electron with an isolated temporary profile and project. EV3 responses were mocked; local workspace and compiler operations were real.

- All 36 combinations of dark/light, English/Traditional Chinese, 100/110/125% interface size, and 1420×900 / 1280×800 / 980×650 passed layout checks.
- Five-level tree checked: every name starts at `44 + depth × 18` pixels, with 30px rows at 100%. Long names truncate within the available width.
- Keyboard rename, pointer drag to another folder and resulting indentation passed. A deferred tree-focus race that could cancel a quick F2 rename was fixed.
- Theme/size/tab changes kept the same editor element, edited content and working undo history.
- Remote folder creation, rename collision, recovery on the same tab, protected storage-root controls and keyboard tab navigation passed.
- Appearance settings and active tools tab survived reload.
- Actual local build completed after edits and file mutations.
- No renderer page errors. The existing Monaco worker fallback warning and Vite large-bundle advisory remain.

## Hardware status

USB and Wi-Fi with a physical EV3 have **not been verified**. Hardware acceptance remains necessary for firmware-specific behavior, storage media, permission failures, cable removal and long transfers. No real robot was run by these tests.

## Protocol references

Segmented `LIST_FILES` / `CONTINUE_LIST_FILES`, `BEGIN_UPLOAD` / `CONTINUE_UPLOAD`, EOF status and handle cleanup follow the [LEGO EV3 Communication Developer Kit](https://www.lego.com/cdn/cs/set/assets/blt6879b00ae6951482/LEGO_MINDSTORMS_EV3_Communication_Developer_Kit.pdf).

Stock firmware `opFILE MOVE` copies via `cp -r`; it does not remove the source. The implementation therefore verifies the copy before using `opFILE REMOVE`. See [LEGO firmware c_memory.c](https://raw.githubusercontent.com/mindboards/ev3sources/master/lms2012/c_memory/source/c_memory.c). `opFILE REMOVE` also avoids the shorter system-delete path buffer in [c_com.c](https://raw.githubusercontent.com/mindboards/ev3sources/master/lms2012/c_com/source/c_com.c).
