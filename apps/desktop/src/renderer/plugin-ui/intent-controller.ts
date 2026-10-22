import type { PluginUiBridge } from "@kobrixa/plugin-runtime";
import type { UiStateStore } from "./state-store.js";
import { send } from "./catalog-store.js";
type Input = {
  trusted: boolean;
  kind: "pointer" | "key";
  id: string;
  primary: boolean;
  repeat: boolean;
};
type Held = {
  nodeId: string;
  input: Input;
  token: string;
  gesture: string | null;
  form: ReturnType<UiStateStore["form"]> | null;
};
export class UiIntentController {
  private held: Held | undefined;
  private visible = true;
  private focused = true;
  private dead = false;
  private queued: string | undefined;
  private seen: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private offState: () => void;
  constructor(
    private bridge: Pick<PluginUiBridge, "hold" | "pulse" | "visibility">,
    private state: UiStateStore,
  ) {
    state.onEdit = () => this.cancel();
    this.offState = state.subscribe(() => {
      if (this.held && (!state.nodeEnabled(this.held.nodeId) || !state.valid())) this.cancel();
    });
  }
  isHolding(nodeId: string): boolean {
    return this.held?.nodeId === nodeId;
  }
  begin(nodeId: string, input: Input): boolean {
    if (
      this.dead ||
      this.held ||
      !this.visible ||
      !this.focused ||
      !input.trusted ||
      !input.primary ||
      input.repeat ||
      (input.kind === "key" && input.id !== " " && input.id !== "Enter") ||
      !this.state.actionEnabled(nodeId)
    )
      return false;
    const held: Held = { nodeId, input, token: crypto.randomUUID(), gesture: null, form: null };
    this.held = held;
    const start = () => {
      if (this.held !== held || this.dead) return;
      if (!this.state.actionEnabled(nodeId) || !this.state.nextAction()) {
        this.cancel();
        return;
      }
      held.form = this.state.form();
      try {
        void this.state
          .actionReply(
            this.bridge.hold({ ...held.form, nodeId, phase: "begin", inputToken: held.token }),
          )
          .then(
            (result) => {
              this.state.actionFinished();
              if (this.held !== held || this.dead) return;
              if (!result.ok) {
                this.cancel();
                return;
              }
              held.gesture = result.value.gesture;
            },
            () => {
              this.state.actionFinished();
              if (this.held === held) this.cancel();
            },
          );
      } catch {
        this.state.actionFinished();
        if (this.held === held) this.cancel();
      }
    };
    if (this.state.needsReconcile()) {
      this.state.actionPreparing();
      void this.state.reconcileAction().then((ok) => {
        this.state.actionFinished();
        if (ok) start();
        else if (this.held === held) this.cancel();
      });
    } else start();
    return true;
  }
  release(kind: Input["kind"], id: string, forced: boolean): void {
    const held = this.held;
    if (!held || held.input.kind !== kind || held.input.id !== id) return;
    this.held = undefined;
    this.state.intentRevoked(); // synchronously before any IPC promise settles
    if (!held.form) return;
    send(() =>
      this.bridge.hold({
        ...held.form!,
        nodeId: held.nodeId,
        phase: forced ? "cancel" : "end",
        inputToken: held.token,
      }),
    );
  }
  cancel(): void {
    if (this.held) this.release(this.held.input.kind, this.held.input.id, true);
  }
  focus(focused: boolean): void {
    this.focused = focused;
    if (!focused) this.cancel();
  }
  challenge(challenge: string): void {
    if (
      this.dead ||
      !this.visible ||
      !this.focused ||
      !this.state.getSnapshot().active ||
      this.seen.includes(challenge)
    )
      return;
    this.seen = [...this.seen.slice(-3), challenge];
    this.queued = challenge;
    this.state.queueChallenge(challenge);
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      if (this.timer !== undefined) this.state.clearInputTimer(this.timer);
      this.timer = undefined;
      const current = this.queued;
      this.queued = undefined;
      this.state.queueChallenge(undefined);
      if (
        !current ||
        this.dead ||
        !this.visible ||
        !this.focused ||
        !this.state.getSnapshot().active
      )
        return;
      if (this.held && (!this.state.valid() || !this.state.nodeEnabled(this.held.nodeId)))
        this.cancel();
      try {
        void this.bridge
          .pulse({
            binding: this.state.form().binding,
            challenge: current,
            gesture: this.held?.gesture ?? null,
            inputToken: this.held?.token ?? null,
          })
          .then(
            (result) => {
              if (!result.ok) this.cancel();
            },
            () => this.cancel(),
          );
      } catch {
        this.cancel();
      }
    }, 0);
    this.state.trackInputTimer(this.timer);
  }
  hide(reason: Parameters<PluginUiBridge["visibility"]>[0]["reason"]): Promise<void> {
    return this.visibility(false, reason);
  }
  async visibility(
    visible: boolean,
    reason: Parameters<PluginUiBridge["visibility"]>[0]["reason"],
  ): Promise<void> {
    this.visible = visible;
    this.state.setVisible(visible);
    if (!visible) {
      this.cancel();
      this.queued = undefined;
      this.state.queueChallenge(undefined);
      if (this.timer !== undefined) this.state.clearInputTimer(this.timer);
      this.timer = undefined;
    }
    try {
      const result = await this.bridge.visibility({
        binding: this.state.form().binding,
        visible,
        reason,
      });
      if (!result.ok) this.cancel();
    } catch {
      this.cancel();
    }
  }
  dispose(): void {
    if (this.dead) return;
    this.cancel();
    this.dead = true;
    this.offState();
    if (this.timer !== undefined) this.state.clearInputTimer(this.timer);
    this.timer = undefined;
    this.queued = undefined;
    this.state.queueChallenge(undefined);
  }
}
