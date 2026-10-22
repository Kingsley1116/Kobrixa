# Packaged persistence worker probe

K170 builds the existing persistence worker into its own CJS artifact, preserving native and plugin payload unpack rules. The repository release builder is the actual packaging entrypoint, so its shared packaging adapter and regression test are included alongside Forge; editing Forge alone would not ship a worker. No product leaves were activated.

Actual local darwin-arm64 package built successfully. The selected installed worker booted from an unrelated temporary working directory with an empty PATH, returned ready, then exited normally after the real close message. Ten packaging tests passed with zero skips; two release packaging tests passed. Source-only invocations explicitly skip the installed probe unless PERSISTENCE_INSTALLED_RESOURCES is supplied.

Initial installed probe failed because its raw boot fixture omitted the namespaces directory normally created by openStoreRoot. The fixture now matches that host precondition; production code was not loosened. The private shared buffer also uses the delivered T2 gate/free-list size rather than the stale pre-free-list plan snippet.

This proves artifact selection and worker boot/normal exit only. Full installed Electron startup, original-channel drain, BM-26/T7 lifecycle and P170 remain pending. The original logs are retained losslessly as gzip, with original and compressed hashes.
