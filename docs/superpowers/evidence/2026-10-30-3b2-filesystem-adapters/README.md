# N07/N11 filesystem and engine subproof

Twelve focused cases passed against actual opened files and AtomicStore;81 pre-existing cases were unselected. Scoped types/lint passed according to the retained implementer report; separate command-output files were not retained. The controller reviewed and committed the tested two files as e2e5704; no product source changed. Original traces and exact head/payload bytes+hashes, reservation quota, original and reopened owner epochs, receipts and cleanup are retained. Test roots remain at inventory paths.

Positive short writes complete exact bytes. Zero progress and injected ENOSPC/EDQUOT/EACCES/EROFS after a real prefix preserve the prior head and release reservations only on explicit abort. Supported directory-sync ENOTSUP/EIO propagate errors without durability downgrade. Explicit unsupported capability uses file-sync-only. Fresh engine initialization verifies the exact committed head and bytes.

This is injected-adapter evidence on macOS, not real disk exhaustion, public RPC/SDK evidence, Windows semantics, process-kill or power-loss acceptance. It supplies only the N07/N11 engine/filesystem portion, not complete B2/Stage3. Original test traces are preserved without relabelling as native application receipts.
