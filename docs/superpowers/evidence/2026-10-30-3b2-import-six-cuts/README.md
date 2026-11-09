# Six actual interrupted-import publication trials

Candidate `6f2496c`, Linux arm64 Electron source-built acceptance host, real composition, persistence worker and public JS SDK/router, offline Docker with a fake device provider. Six fresh profiles each received an externally observed SIGKILL at the named boundary, three cold reopens, a public CAS delete and a final reopen. These are **six scoped trials, not complete RF5 or Stage3 acceptance**.

| Boundary | Actual host PIDs: killed, reopen1, reopen2, reopen3, deleted |
| --- | --- |
| before-publish | 136, 315, 1530, 1833, 2147 |
| after-publish | 2459, 2635, 3919, 4232, 4550 |
| before-receipt | 4872, 5044, 6290, 6597, 6904 |
| after-receipt | 7207, 7380, 8646, 8971, 9282 |
| before-marker | 9588, 10750, 11073, 11389, 11709 |
| after-marker | 12018, 13160, 13479, 13796, 14115 |

Every ordinary reopen returned exactly50 records totaling419,430,400 bytes, fully streamed through public openRead/readChunk/closeRead and verified against original SHA-256. IDs/revisions/metadata stayed stable, and the deleted target did not resurrect on the final49-record reopen. Original400MiB sources remained unchanged. Each process had a fresh host epoch; normal shutdown had zero workers, listeners, children or cleanup errors; killed process groups were independently checked by the supervisor.

Before/after-receipt means the durable per-item import journal receipt, not a transport ACK. Before-marker selects the real internal import complete-document write; its worker fault ticket is null and is not replaced with an invented record ticket. Selection is instead bound to the observed complete call, journal and pause window. Before-publish correctly reconciles the original attempt as not committed and uses a freshly admitted attempt; later reopens reconcile its original planned target. The other cuts reconcile the original committed record without republishing it.

Native1 failed at pre-head recovery. Product1979204 verifies the exact pending journal, candidate and payload, then preserves unpublished bytes in quarantine without promoting them. Controller98focused tests passed, including interrupted quarantine retention. A separate marker-only prior run exposed a fixture old-owner read;6f2496c now observes the coordinator's current admitted journal owner while preserving the historical reconciliation ticket. Controller44fixture tests passed. Both earlier failure logs and receipts remain failures here.

The controller independently replayed the immutable candidate oracle against all30 receipts, rehashed all original sources and checked the retained renderer files/main bundle/composite artifact hashes. Raw gzip files preserve exact bytes with an inventory. Source fixtures and installed binaries remain in the external evidence directory. CPU identity is reported unknown in the native receipt; this run does not establish a load/performance environment or hardware power-loss durability.

The separate eighteen semantic boundaries, trusted skip/raw/consumed nonce/pre-raw pending cases, complete load and installed/manual/hardware gates remain open. Ordinary untagged missing-head creates retain the original unavailable contract; subsequent evidence-retention commit a8c0ddb is covered by separate tests and is not retroactively claimed as this run's candidate.
