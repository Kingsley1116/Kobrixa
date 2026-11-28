# Desktop regression after public stale-ID correction

Controller local working-tree suite:4051 tests passed,22 existing tests skipped;309 files passed,1 skipped;213.94seconds. This follows product correction9a48b48 and the16 worker rejection cases4acba30. No production source in apps/desktop/src, packages or frontends changed after9a48b48 during the run.

Two agents could append test-only cases concurrently, so this is deliberately not labelled an immutable full-tree run. Subsequent committed N04/N13 and filesystem adapter tests carry their own focused/full-file evidence. The log does not establish native Electron, performance, manual/hardware, or complete Stage3 acceptance. E-source aliases and installed D dependencies were used through /private/tmp/e6-full-desktop.config.mjs; no dependency installation or shared build was performed.
