# Device plugins (API 1.5.0)

Device consumers request `devices.read`, `devices.connect` and/or `devices.control` in their manifest. A permission grants eligibility, not a permanent lease. Negotiate after initialize, inspect provider/capability availability, and check every business result. An unavailable provider must remain unavailable until the user enables it.

Only the host allowlist can register `kobrixa.device-ev3`. A development plugin declaring `contributes.deviceProviders` is invalid even if the value is an empty array or null. `devices.provide` is not a permission. Plugins execute trusted local code; this API is a safety and compatibility boundary, not a hostile-code sandbox.

Use `context.devices` in JavaScript and `ctx.devices` in Python. Method names are the same except `inputModes` becomes `input_modes`. Wire object keys remain camelCase. Both SDKs return `{ok:true,value}` or `{ok:false,error:{code,message,detail?}}`; transport failures remain separate. See the two executable consumers in `tests/desktop/fixtures/device-broker/` for the same complete scenario.

The read path is negotiate → list → session → read/subscribe. `devices/context` returns only a host-bound context reference and its restricted snapshot. No default binding means unbound, not local authority. `devices.connect` accepts a host candidate or a canonical IP literal, never a hostname, credentials or native transport path. Read, browse, download and stopping one's own operation remain available without holder status, subject to source/session permissions.

Motion requires a host-issued visible panel scope, current authority and `devices.control`; jog additionally requires a real gesture. A consumer must not synthesize a scope, heartbeat or gesture. API 1.5 transport fixtures receive references from the trusted test host. General declarative UI binding arrives in 1.6. A missing UI scope is an explicit unavailable result.

Prepare performs no device I/O. Start consumes its reference once within 5 seconds. Preserve the operation ID before start; a timeout or lost reply does not justify another start. Query the original ID and request stop. Forced stop preserves brake even when the original motion requested coast. A stop acknowledgement records intent; only subsequent readback confirms stopping. Unconfirmed stop remains visible in core recovery after the feature disappears.

Query/control waits are 5 seconds, reads 15 seconds, connections 65 seconds in the SDK. Provider exchanges retain motor 2 seconds, ordinary 5 seconds and file transfer 10 seconds, capped by the original deadline. Stop/readback has 15 seconds including the in-flight exchange, followed by at most 5 seconds for journal disposition. Neither cancellation nor retry extends these clocks.

All monitor, battery and recorder demands share one session sampler. Polls wait 500 ms after completion, or 30 seconds when only battery remains. Recording reserves one to four stable channels; source changes end it. Frames may contain explicit gaps. Subscription queues and recording buffers are bounded: never assume an offline consumer can recover unlimited history. Unwrap the subscribe business result before using it. JS subscriptions expose `subscriptionId`, `snapshot`, `lastSequence` and `dispose()`; Python subscriptions expose `subscription_id`, `snapshot`, `last_sequence` and `close()`. SDK acknowledgements occur after validation and bounded enqueue, not after arbitrary user callbacks.

A reservation's first end fixes its final-read grant and deadline. Provider loss, suspend or core Disconnect does not retire a healthy consumer generation. Core Disconnect stops, saves and then disconnects, or displays a blocker. Wake never resumes motion or recording automatically. New settings/storage APIs are unavailable before 1.7; legacy Lab storage remains protected by its existing close/update/save guards.

Remote file confirmation expires after 120 seconds idle. Only an explicit user confirmation renews it, with an absolute 600-second lifetime. A late native dialog cannot execute an expired plan. Cancellation or lost authority stops subsequent chunks and entries but cannot roll back writes already sent.

The durable journal records uncertainty before risky motion/program dispatch. Full, corrupt or unwritable journals prevent new risk. Reconnecting to the same IP is not physical identity proof. Core recovery remains accessible with every optional feature disabled and in safe mode.

Automated synthetic-provider tests, actual Electron/Python transport tests, installed artifacts and physical USB/Wi-Fi evidence are distinct acceptance rows. This foundation does not certify motor UI migration (3C), Lab storage/charts migration (3D), stage-2 V01–V04 or final Stage 3 closeout (3E).
