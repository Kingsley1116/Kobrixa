import { randomUUID } from "node:crypto";
import type { ResourceOwner, UiBinding } from "@kobrixa/plugin-protocol";
import type {
  DeviceIntentPort,
  MotionScopeBinding,
  UiBridgeEvent,
  FoundationDiagnosticEvent,
} from "@kobrixa/plugin-runtime";

type Session = {
  binding: UiBinding;
  owner: ResourceOwner;
  ownerSource: string;
  scope: string;
  alive: boolean;
  pulsed: boolean;
  expires: number;
  lastIssue: number;
  challenges: Map<string, number>;
  tokens: Set<string>;
  active: { token: string; gesture: string } | null;
  cadence?: ReturnType<typeof setInterval>;
  expiry?: ReturnType<typeof setTimeout>;
};
function key(binding: UiBinding): string {
  return JSON.stringify([
    binding.contributionId,
    binding.panelInstance,
    binding.kind,
    binding.uiResourceGeneration,
    binding.generation,
    binding.hostEpoch,
    binding.processEpoch,
  ]);
}
export class UiIntent {
  readonly #sessions = new Map<string, Session>();
  readonly #tombstones = new Map<string, Set<string>>();
  #sequence = 0;
  timerCount(): number {
    return this.#sessions.size * 2;
  }
  constructor(
    private readonly device: DeviceIntentPort,
    private readonly now: () => number,
    private readonly publish: (event: UiBridgeEvent) => void,
    private readonly observe?: (event: FoundationDiagnosticEvent) => void,
  ) {}
  #observed(kind: FoundationDiagnosticEvent["kind"], session: Session): void {
    try {
      this.observe?.({
        kind,
        owner: session.owner,
        binding: session.binding,
        time: performance.timeOrigin + performance.now(),
      });
    } catch {
      /* Observation cannot change a safety action. */
    }
  }
  bind(binding: UiBinding, input: MotionScopeBinding): void {
    this.revoke(binding, "resource-retired");
    const tokens = this.#tombstones.get(key(binding)) ?? new Set<string>();
    this.#tombstones.set(key(binding), tokens);
    const session: Session = {
      binding,
      owner: { ...input.owner },
      ownerSource: input.owner.sourceKey,
      scope: this.device.bindMotionScope(input),
      alive: true,
      pulsed: false,
      expires: this.now() + 350,
      lastIssue: -Infinity,
      challenges: new Map(),
      tokens,
      active: null,
    };
    this.#sessions.set(key(binding), session);
    this.#issue(session);
    if (session.alive) {
      session.cadence = setInterval(() => this.#issue(session), 100);
      this.#expire(session);
    }
  }
  #issue(session: Session): void {
    if (!session.alive) return;
    if (session.challenges.size >= 4 || this.now() >= session.expires) {
      this.revoke(session.binding, "resource-retired");
      return;
    }
    const challenge = randomUUID();
    session.challenges.set(challenge, this.now());
    this.publish({ type: "pulse", binding: session.binding, challenge });
  }
  #expire(session: Session): void {
    clearTimeout(session.expiry);
    session.expiry = setTimeout(
      () => {
        if (session.alive && this.now() >= session.expires)
          this.revoke(session.binding, "resource-retired");
      },
      Math.max(0, session.expires - this.now()),
    );
  }
  pulse(
    binding: UiBinding,
    challenge: string,
    gesture: string | null,
    inputToken: string | null,
  ): boolean {
    const session = this.#sessions.get(key(binding));
    const issued = session?.challenges.get(challenge);
    if (
      !session?.alive ||
      issued === undefined ||
      issued <= session.lastIssue ||
      this.now() >= issued + 350 ||
      this.now() >= session.expires ||
      gesture !== (session.active?.gesture ?? null) ||
      inputToken !== (session.active?.token ?? null)
    )
      return false;
    session.challenges.delete(challenge);
    for (const [id, time] of session.challenges) if (time <= issued) session.challenges.delete(id);
    session.lastIssue = issued;
    session.pulsed = true;
    session.expires = issued + 350;
    try {
      this.device.pulsePanel(session.scope, ++this.#sequence);
      if (session.active) this.device.pulseGesture(session.active.gesture, ++this.#sequence);
    } catch {
      this.revoke(binding, "resource-retired");
      return false;
    }
    this.#expire(session);
    return true;
  }
  scope(binding: UiBinding): string | undefined {
    const session = this.#sessions.get(key(binding));
    return session?.alive && session.pulsed && this.now() < session.expires
      ? session.scope
      : undefined;
  }
  begin(binding: UiBinding, inputToken: string): string | null {
    const session = this.#sessions.get(key(binding));
    if (
      !session?.alive ||
      !this.scope(binding) ||
      session.tokens.has(inputToken) ||
      session.active ||
      [...this.#sessions.values()].some(
        (item) => item.ownerSource === session.ownerSource && item.active,
      )
    )
      return null;
    if (session.tokens.size >= 256) {
      this.revoke(binding, "resource-retired");
      return null;
    }
    session.tokens.add(inputToken);
    try {
      const gesture = this.device.beginGesture(session.scope, ++this.#sequence);
      session.active = { token: inputToken, gesture };
      return gesture;
    } catch {
      this.revoke(binding, "resource-retired");
      return null;
    }
  }
  end(binding: UiBinding, inputToken: string, phase: "end" | "cancel"): void {
    const session = this.#sessions.get(key(binding));
    if (!session) return;
    if (session.tokens.size >= 256 && !session.tokens.has(inputToken)) {
      this.revoke(binding, "resource-retired");
      return;
    }
    session.tokens.add(inputToken);
    if (session.active?.token !== inputToken) return;
    const gesture = session.active.gesture;
    session.active = null;
    this.#observed("stop-dispatch", session);
    this.device.endGesture(gesture, phase === "end" ? "released" : "cancelled");
  }
  cancelHold(binding: UiBinding): void {
    const session = this.#sessions.get(key(binding));
    if (session?.active) this.end(binding, session.active.token, "cancel");
  }
  liveGesture(binding: UiBinding, inputToken: string, gesture: string): boolean {
    const session = this.#sessions.get(key(binding));
    return (
      !!session?.alive &&
      !!this.scope(binding) &&
      session.active?.token === inputToken &&
      session.active.gesture === gesture
    );
  }
  revoke(binding: UiBinding, reason: Parameters<DeviceIntentPort["revokeScope"]>[1]): void {
    const sessionKey = key(binding);
    if (reason === "closed" || reason === "window-lost") this.#tombstones.delete(sessionKey);
    const session = this.#sessions.get(sessionKey);
    if (!session) return;
    session.alive = false;
    clearInterval(session.cadence);
    clearTimeout(session.expiry);
    const gesture = session.active?.gesture;
    session.active = null;
    session.challenges.clear();
    this.#sessions.delete(sessionKey);
    try {
      if (gesture) {
        this.#observed("stop-dispatch", session);
        this.device.endGesture(gesture, "cancelled");
      }
    } finally {
      this.#observed("revoke", session);
      this.device.revokeScope(session.scope, reason);
    }
  }
  forget(binding: UiBinding): void {
    this.revoke(binding, "resource-retired");
    this.#tombstones.delete(key(binding));
  }
  dispose(): void {
    for (const session of [...this.#sessions.values()]) this.revoke(session.binding, "window-lost");
    this.#tombstones.clear();
  }
}
