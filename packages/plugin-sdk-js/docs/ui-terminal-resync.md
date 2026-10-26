# UI terminal resync (JS and Python)

Install one session-scoped control hook in your UI-ready callback, before subscribing:

- JS: `ui.onResyncRequired(handler)` returns a detach function.
- Python: `ui.on_resync_required(handler)` returns a detach function.

Registering another hook replaces the previous hook. UI retirement removes the hook; install it again in the next ready session. Existing UI listeners still receive only the strict `ui.*` event union. Existing subscribe methods still return the raw Result containing the real host `subscriptionId`, sequence and snapshot.

A common `events.resyncRequired` ends the affected streams. It is different from an ordinary sequence gap: the SDK still reconciles ordinary gaps using `ui/snapshot(liveId)`, but never uses `ui/snapshot(oldId)` to recover a terminal stream. The host may already have removed oldId when it processes the immediate ACK. The SDK does not delay ACK for queries, callbacks or cleanup, and does not transparently resubscribe or alias oldId to a new subscription.

The control notice contains:

- `event`: a private copy of the original common envelope, including its actual carrier ID, owner, reason and affected IDs. The carrier may belong to devices or settings.
- `subscriptions`: affected UI subscriptions known to this SDK session. Each entry has its original raw ID (`subscriptionId` / `subscription_id`), a private copy of its original `params`, and `isCurrent()` / `is_current()`. JS also exposes an AbortSignal. Check currentness after every await.
- `cleanup`: awaitable results of the SDK's already-started `events/unsubscribe` requests for those known UI IDs. Inspect business failures; transport failures reject/raise. Cleanup does not wait for user callbacks, and cancelling a Python waiter does not cancel the underlying cleanup. Other domains retain their own cleanup APIs.

The lifetime guard expires on retirement, hook detach/replacement, explicit unsubscribe, or completion of the hook callback. Await recovery work inside the callback; do not spawn detached recovery using the notice. Callbacks are cooperative: the SDK cannot forcibly stop arbitrary JS code. Existing request-start epoch fences still reject old replies even when the response resolved before the awaiting continuation resumed.

The shared queue retains at most eight control items and 32 affected IDs in terminal bookkeeping, with the existing early-event and telemetry limits. The existing 32-slot local adoption limit remains in place. Subscription requests still reach the host, so its quota failures retain their raw business Result; the SDK does not replace them with a preflight exception. Hung callbacks remain charged against the control budget; they do not retain the old UI inbox slots or prevent host cleanup. If the bounded queue cannot accept an event, it does not ACK it. Early adoption can deliver disjoint batches of UI entries for the same terminal envelope; each affected UI lifetime is delivered at most once. A callback need not assume it sees all affected domains or all in-flight subscribe results in its first batch.

## JS: explicit recovery for an environment subscription

This example assumes `ui`, `onUi`, `active` (a Map of raw IDs to snapshots), and `report` are application-owned. It runs inside the current UI-ready session.

```ts
const detach = ui.onResyncRequired(async (notice) => {
  try {
    const cleanup = await notice.cleanup;
    if (cleanup.some((result) => !result.ok)) {
      report(cleanup);
      return;
    }
    for (const entry of notice.subscriptions) {
      if (!entry.isCurrent()) continue;
      const query = await ui.instances(entry.signal);
      if (!entry.isCurrent() || !query.ok) continue;
      const fresh = await ui.subscribe(entry.params, onUi, entry.signal);
      if (!fresh.ok) {
        report(fresh.error);
        continue;
      }
      if (!entry.isCurrent()) {
        await ui.unsubscribe(fresh.value.subscriptionId);
        continue;
      }
      active.delete(entry.subscriptionId);
      active.set(fresh.value.subscriptionId, fresh.value.snapshot);
    }
  } catch (error) {
    report(error);
  }
});
const initial = await ui.subscribe({ topics: ["environment"] }, onUi);
if (initial.ok) active.set(initial.value.subscriptionId, initial.value.snapshot);
```

`ui/instances` does not return the complete environment. Use the fresh subscribe response's atomic snapshot for locale/theme and the new sequence baseline. For bound subscriptions, query the original binding with `ui.state`; for v2 data, use `ui.data.snapshot(binding)` as appropriate. A stale binding ends that recovery attempt: do not substitute a new panel, owner, generation or resource version. Do not replay actions, patches or motion commands to fill a gap.

## Python: the same explicit recovery

This example assumes application-owned `ui`, `on_ui`, `active` and `report` in the current ready session.

```python
async def resync(notice):
    try:
        cleanup = await notice.cleanup
        if any(not result["ok"] for result in cleanup):
            report(cleanup)
            return
        for entry in notice.subscriptions:
            if not entry.is_current():
                continue
            query = await ui.instances()
            if not entry.is_current() or not query["ok"]:
                continue
            fresh = await ui.subscribe(
                entry.params["topics"], on_ui, entry.params.get("binding")
            )
            if not fresh["ok"]:
                report(fresh["error"])
                continue
            if not entry.is_current():
                await ui.unsubscribe(fresh["value"]["subscriptionId"])
                continue
            active.pop(entry.subscription_id, None)
            active[fresh["value"]["subscriptionId"]] = fresh["value"]["snapshot"]
    except Exception as error:
        report(error)

detach = ui.on_resync_required(resync)
initial = await ui.subscribe(["environment"], on_ui)
if initial["ok"]:
    active[initial["value"]["subscriptionId"]] = initial["value"]["snapshot"]
```

Old IDs retain their original wire meaning: `snapshot(oldId)` can return stale, and `unsubscribe(oldId)` cannot unsubscribe the new ID. No new callback is sent through the old UI event union. Consumers that do not install this hook have no automatic recovery claim. These SDK tests and examples do not certify full Stage 3 or native acceptance.
