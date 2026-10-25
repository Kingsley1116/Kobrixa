# Renderer loss and explicit restart — 2026-10-26

Actual native run Gbg1iR at `2a39344dcdcad3b4776f1a3ee30c73197f30702e` passed. Fresh Electron/profile, real composition, worker and original public SDK consumer. The renderer was deliberately crashed; its OS PID disappeared and the original plugin child exited. Old action, gesture, epoch and unfinished write commit were denied before their ordinary expiry. No automatic plugin relaunch occurred during the observed idle interval. An explicit host restart created generation 1 from generation 0 with a fresh process epoch and authority context.

Outside exit 0; cleanup workers/listeners/children are zero, errors empty. Controller independently reran verifyRunReceipt and recomputed main-bundle and combined-artifact hashes from the executed files. Original receipt/candidate/config/log bytes are preserved unchanged in gzip with an inventory. Pure oracle suite: 491 passed, including 52 renderer-loss cases. Independent scoped review is pending.

This uses a fake device provider and trusted host UI/intent admission seams, not physical mouse/keyboard or EV3 hardware. The short no-relaunch observation is bounded, not an unlimited temporal claim. The log retains expected disposed-render-frame send errors during the crash; this is not a warning-free run. This case does not close the full foundation matrix, import/restart, installed/interop/load or manual Stage3 gates.

## Existing action scenario regression

The common renderer-crash and recovery helpers changed in this slice. Fresh actual action-replay run PS6emk at `d399ddac80dead87e9dc6678efecd998bb0e3461` also passed, outside exit 0 and zero cleanup counts/errors. The controller independently revalidated its receipt and both artifact hashes. Its four original raw files are retained separately with the action-refactor prefix; no old evidence was rewritten.
