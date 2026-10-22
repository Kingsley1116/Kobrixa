import { randomUUID } from "node:crypto";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { DeviceIntentPort, MotionScopeBinding } from "@kobrixa/plugin-runtime";
import { resourceOwnerKey, stale, deviceFailure } from "./registry.js";
type Scope = {
  binding: MotionScopeBinding;
  sequence: number;
  pulse: number | null;
  revoked: boolean;
  gesture: string | null;
};
type Gesture = { scope: string; sequence: number; pulse: number; ended: boolean };
export class IntentRegistry implements DeviceIntentPort {
  #scopes = new Map<string, Scope>();
  #gestures = new Map<string, Gesture>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly now: () => number,
    private readonly invalidate: (scope: string) => void,
  ) {}
  #arm(id: string, expire: () => void): void {
    const previous = this.#timers.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.#timers.delete(id);
      expire();
    }, 350);
    timer.unref();
    this.#timers.set(id, timer);
  }
  #clear(id: string): void {
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
  }
  bindMotionScope(binding: MotionScopeBinding): string {
    for (const [id, s] of this.#scopes)
      if (
        s.binding.panelInstance === binding.panelInstance &&
        resourceOwnerKey(s.binding.owner) === resourceOwnerKey(binding.owner)
      )
        this.revokeScope(id, "resource-retired");
    const id = randomUUID();
    this.#scopes.set(id, {
      binding: structuredClone(binding),
      sequence: -1,
      pulse: null,
      revoked: false,
      gesture: null,
    });
    return id;
  }
  #valid(scope: string): Scope {
    const s = this.#scopes.get(scope);
    if (!s || s.revoked) return stale();
    if (s.pulse !== null && this.now() - s.pulse >= 350) {
      this.revokeScope(scope, "hidden");
      return deviceFailure("PLUGIN_E_DEVICE_AUTHORITY", "scope-expired");
    }
    return s;
  }
  pulsePanel(scope: string, sequence: number): void {
    let s: Scope;
    try {
      s = this.#valid(scope);
    } catch {
      return;
    }
    if (!Number.isSafeInteger(sequence) || sequence <= s.sequence) return;
    s.sequence = sequence;
    s.pulse = this.now();
    this.#arm(scope, () => {
      try {
        this.#valid(scope);
      } catch {
        /* Expiration already revokes the scope. */
      }
    });
  }
  beginGesture(scope: string, sequence: number): string {
    const s = this.#valid(scope);
    if (s.pulse === null)
      return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "ui-scope-unavailable");
    if (!Number.isSafeInteger(sequence) || sequence < 0) return stale();
    for (const [id, other] of this.#scopes)
      if (
        id !== scope &&
        resourceOwnerKey(other.binding.owner) === resourceOwnerKey(s.binding.owner) &&
        other.gesture
      )
        this.endGesture(other.gesture, "cancelled");
    if (s.gesture) this.endGesture(s.gesture, "cancelled");
    const id = randomUUID();
    this.#gestures.set(id, { scope, sequence, pulse: this.now(), ended: false });
    s.gesture = id;
    this.#arm(id, () => this.endGesture(id, "cancelled"));
    return id;
  }
  pulseGesture(id: string, sequence: number): void {
    const g = this.#gestures.get(id);
    if (!g || g.ended) return;
    if (this.now() - g.pulse >= 350) {
      this.endGesture(id, "cancelled");
      return;
    }
    try {
      this.#valid(g.scope);
    } catch {
      return;
    }
    if (!Number.isSafeInteger(sequence) || sequence <= g.sequence) return;
    g.sequence = sequence;
    g.pulse = this.now();
    this.#arm(id, () => this.endGesture(id, "cancelled"));
  }
  endGesture(id: string, _reason: "released" | "cancelled"): void {
    const g = this.#gestures.get(id);
    if (!g || g.ended) return;
    g.ended = true;
    this.#clear(id);
    this.#gestures.delete(id);
    const s = this.#scopes.get(g.scope);
    if (s?.gesture === id) s.gesture = null;
    this.invalidate(g.scope);
  }
  revokeScope(id: string, _reason: "hidden" | "closed" | "window-lost" | "resource-retired"): void {
    const s = this.#scopes.get(id);
    if (!s || s.revoked) return;
    s.revoked = true;
    this.#clear(id);
    if (s.gesture) this.endGesture(s.gesture, "cancelled");
    this.#scopes.delete(id);
    this.invalidate(id);
  }
  assert(owner: ResourceOwner, scope: string, contextRef: string, gesture?: string): void {
    const s = this.#valid(scope);
    if (
      resourceOwnerKey(owner) !== resourceOwnerKey(s.binding.owner) ||
      contextRef !== s.binding.contextRef
    )
      return stale();
    if (s.pulse === null)
      return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "ui-scope-unavailable");
    if (gesture) {
      const g = this.#gestures.get(gesture);
      if (!g || g.scope !== scope || g.ended) return stale();
      if (this.now() - g.pulse >= 350) {
        this.endGesture(gesture, "cancelled");
        return deviceFailure("PLUGIN_E_DEVICE_AUTHORITY", "scope-expired");
      }
    }
  }
  retire(owner: ResourceOwner): void {
    for (const [id, s] of this.#scopes)
      if (resourceOwnerKey(owner) === resourceOwnerKey(s.binding.owner))
        this.revokeScope(id, "resource-retired");
  }
  sweep(): void {
    for (const [id] of this.#scopes)
      try {
        this.#valid(id);
      } catch {
        /* Expiration already revokes the scope. */
      }
    for (const [id, g] of this.#gestures)
      if (!g.ended && this.now() - g.pulse >= 350) this.endGesture(id, "cancelled");
  }
}
