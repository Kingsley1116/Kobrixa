# 3E E1 dependent settings contract receipt

Date: 2026-10-26. Implementation: `612f637` on `feat/plugin-3e`.

This closes the atomic dependent-field prerequisite in the approved 3E design §2.2/§4. It does not close E1 as a whole, combined import, production preference admission, E3 or Stage 3. The API remains the single unpublished 1.8.0 batch; no separate release is claimed.

## Public resource rule

An optional settings field property `resetWhen: { key: SettingKey, equals: boolean }` refers to another declared boolean field. The controller must not itself have a rule. Missing/non-boolean/self references, chains and cycles are invalid. Targets retain their declared type, default and bounds; no expressions or coercion are allowed.

The rule participates in the resource validation digest. Resources without a rule retain their previous validation-text encoding. Structural JSON Schema and both SDKs recognize the strict object; semantic resource validation also checks references. An old same-version resource with a different digest is not silently adopted.

The host constructs and validates the complete candidate, resets matching targets to their declared defaults, then reserves and publishes through the original single expected-revision CAS. Update, reset and explicit migration share this path. Implicit target changes appear in changedKeys. A failed publication preserves the previous complete snapshot; no watcher performs a later corrective write. Ordinary complete reads reject inconsistent stored values instead of repairing them.

The actual device resource declares `lastWifiAddress.resetWhen = { key: "rememberWifiAddress", equals: false }`. Turning off remembering and clearing the address therefore share one receipt/revision.

## Renderer and evidence

Generic settings forms evaluate the current controller draft, disable matching targets and show their defaults. Failed controller drafts and retry behavior remain explicit. Disabled stale callbacks cannot publish a dependent edit; committed resets clear obsolete native text.

Implementation and independent review each ran 540 JS/TS tests in ten files and four Python settings plus eight conformance test methods. Source typechecking, scoped lint and diff checks passed. Real AtomicStore cases cover seal failure, concurrent CAS and the single-receipt false/empty snapshot. Renderer evidence is automated DOM/state testing, not native keyboard/accessibility acceptance.

The separate combined-source mapper originally validated before normalization; its compatibility correction belongs to E3. The receipt does not claim an all-green E integration run while that correction is pending. Durable combined originals, pristine target admission, migration barriers and production wiring require their own evidence.
