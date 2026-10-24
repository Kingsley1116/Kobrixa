# Linux arm64 installed source-isolation evidence

Product and runner source: `dbccbc2f4be23676e6ba49ca07a33e6be87718d5`, clean checkout, 2026-10-24. Built inside the retained Docker recipe from a Git bundle of that commit. The recipe checks the checkout remains clean after the actual product build. This is a Linux arm64 artifact, not a replacement for the existing macOS artifact.

The actual packaged Electron product passed healthy, restart, missing-resource and tampered-resource scenarios (4/4); every run quit normally without forced cleanup or orphan child processes. The original ASAR/executable/renderer/preload and motor payload hashes are recorded in the raw receipt. No fixture replaces the product entry or launch implementation.

Each product main process received `EACCES` when reading the existing checkout, worktree and external dependency file, and when connecting to a live controller loopback TCP listener. Landlock restrictions apply before exec and are inherited by descendants. Separate kernel tests passed 2/2, including a descendant read and `/proc/self/root` access. The product’s Chromium sandbox, context isolation and disabled node integration were checked in every run; no `--no-sandbox` or `--disable-setuid-sandbox` flags were used.

Docker ran with `network none`, no external network interfaces, no added capabilities or privileged mode. Its outer seccomp filter was relaxed to allow Chromium to create its own user namespaces; Chromium’s own sandbox remained enabled. The only host mount was the fresh evidence directory. `container.json` retains these settings and the image identity. Landlock denies TCP; the networkless namespace supplies full external network disconnection.

Reproduce by creating `source.bundle` from the stated commit, building the retained Dockerfile, and running that image as its non-root user with `--network none --security-opt seccomp=unconfined --shm-size 1g`, a fresh writable evidence mount and `TMPDIR` pointing there. Execute `xvfb-run -a node tests/desktop/builtin-process-installed.mjs --isolated`. The runner rejects Linux isolation when an external network interface exists. Preserve its raw receipt and command exit status.

Gzip files are byte-preserving; `files.json` lists raw and compressed hashes. Earlier attempts remain separate: Nu6yRL failed the obsolete macOS-only outside assertion; h9lSkU passed an earlier checker but lacks the later network-interface field and is not used for this gate. Neither receipt was edited.

This closes the bounded Linux source-access-denial proof. It does not establish physical EV3 behavior, clean-machine GUI usability, other architectures/platforms, legacy feature removal, B1/B2 aggregate gates or Stage 3 completion. The macOS Seatbelt limitation is unchanged.
