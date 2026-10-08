import {
  controlStateSchema,
  type ControlState,
  type PresenceState,
} from "@kobrixa/collab-protocol";
import type { Locale } from "../i18n/copy.js";
import { collabCopy } from "./collab-copy.js";
import { canEdit, sharedTypes, type CollabSession } from "./types.js";

export interface DeviceControlRequest {
  participantId: string;
  name: string;
}

export interface DeviceControlSnapshot {
  /** Effective holder: the stored holder, or the host when none is stored. */
  holder: string | null;
  holderName: string | null;
  /** False when the roster reports the holder offline. */
  holderOnline: boolean;
  /** Pending requests in request order (the holder is never listed). */
  requests: readonly DeviceControlRequest[];
  isHolder: boolean;
  isHost: boolean;
  /** This participant has a pending request. */
  requested: boolean;
  /** The host declined this participant's latest request (until it requests again). */
  declined: boolean;
  canRequest: boolean;
  /** Connected and synced: control changes can be sent. */
  connected: boolean;
  isViewer: boolean;
}

const holderSchema = controlStateSchema.shape.holder;
const requestsSchema = controlStateSchema.shape.requests;

/**
 * Shared EV3 control permission for one room, stored in the `control` Y.Map.
 * Only one participant (the holder) may upload or run programs; the host owns
 * control by default and can grant or take it back. Values that do not match
 * `controlStateSchema` are ignored.
 */
export class DeviceControl {
  readonly #listeners = new Set<() => void>();
  readonly #control;
  #snapshot: DeviceControlSnapshot;
  #key = "";
  /** Re-adds this participant's request if a concurrent write dropped it. */
  #wantsControl = false;
  #declined = false;
  /** Requests the host declined; hidden until the request leaves the document. */
  readonly #dismissed = new Set<string>();
  readonly #dispose: Array<() => void> = [];

  constructor(readonly session: CollabSession) {
    this.#control = sharedTypes(session.doc).control;
    this.#snapshot = this.#compute();
    this.#key = JSON.stringify(this.#snapshot);
    const changed = (): void => this.#refresh();
    const observer = (_event: unknown, transaction: { local: boolean }): void => {
      if (!transaction.local) this.#reassertRequest();
      this.#refresh();
    };
    this.#control.observe(observer);
    this.#dispose.push(() => this.#control.unobserve(observer));
    this.#dispose.push(session.subscribe(changed));
    session.awareness.on("change", changed);
    this.#dispose.push(() => session.awareness.off("change", changed));
    const declined = session.onControlDeclined?.(() => {
      this.#wantsControl = false;
      this.#declined = true;
      this.#refresh();
    });
    if (declined) this.#dispose.push(declined);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): DeviceControlSnapshot => this.#snapshot;

  dispose(): void {
    for (const dispose of this.#dispose.splice(0)) dispose();
    this.#listeners.clear();
  }

  /** Asks the host for control (editors only; viewer writes are dropped by the server). */
  request(): void {
    if (!this.#snapshot.canRequest) return;
    this.#wantsControl = true;
    this.#declined = false;
    const me = this.#me();
    const requests = this.#state().requests;
    if (!requests.includes(me)) this.#write({ requests: [...requests, me] });
  }

  cancelRequest(): void {
    this.#wantsControl = false;
    if (!this.#connected() || !canEdit(this.session.getSnapshot().role)) return;
    const me = this.#me();
    const requests = this.#state().requests;
    if (requests.includes(me)) this.#write({ requests: requests.filter((id) => id !== me) });
  }

  /** Hides the "request declined" message. */
  dismissDeclined(): void {
    if (!this.#declined) return;
    this.#declined = false;
    this.#refresh();
  }

  /** Host only: hands control to `participantId` and removes its request. */
  grant(participantId: string): void {
    if (!this.#connected() || !this.#isHost() || !holderSchema.safeParse(participantId).success)
      return;
    const member = this.session
      .getSnapshot()
      .participants.find((participant) => participant.participantId === participantId);
    if (!member?.online || !canEdit(member.role)) return;
    const requests = this.#state().requests.filter((id) => id !== participantId);
    this.#write({ holder: participantId, requests });
  }

  /**
   * Host only: declines `participantId`'s request. The room removes the request
   * and tells the requester; the request is hidden locally right away, and also
   * stays hidden (until the host reconnects) on servers that predate the decline
   * command.
   */
  decline(participantId: string): void {
    if (!this.#connected() || !this.#isHost()) return;
    if (!this.#state().requests.includes(participantId)) return;
    // Not sent (the socket just closed): keep showing the request so it can be retried.
    if (this.session.declineControlRequest?.(participantId) === false) return;
    this.#dismissed.add(participantId);
    this.#refresh();
  }

  /** Host only: takes control back (also when the holder went offline). */
  reclaim(): void {
    if (!this.#connected() || !this.#isHost()) return;
    const me = this.#me();
    this.#write({ holder: me, requests: this.#state().requests.filter((id) => id !== me) });
  }

  /** Holder gives control back to the host. */
  release(): void {
    if (!this.#snapshot.isHolder || this.#isHost()) return;
    this.#wantsControl = false;
    this.#write({ holder: this.#hostId() });
  }

  #me(): string {
    return this.session.connection.participantId;
  }

  #connected(): boolean {
    const snapshot = this.session.getSnapshot();
    return snapshot.synced && snapshot.status === "connected";
  }

  #isHost(): boolean {
    return this.session.getSnapshot().role === "host";
  }

  #hostId(): string | null {
    if (this.#isHost()) return this.#me();
    return (
      this.session.getSnapshot().participants.find((member) => member.role === "host")
        ?.participantId ?? null
    );
  }

  #state(): ControlState {
    const holder = holderSchema.safeParse(this.#control.get("holder"));
    const requests = requestsSchema.safeParse(this.#control.get("requests"));
    return {
      holder: holder.success ? holder.data : null,
      requests: requests.success ? [...new Set(requests.data)] : [],
    };
  }

  #write(patch: Partial<ControlState>): void {
    this.session.doc.transact(() => {
      if ("holder" in patch) this.#control.set("holder", patch.holder ?? null);
      if (patch.requests) this.#control.set("requests", patch.requests);
    });
  }

  #reassertRequest(): void {
    if (!this.#wantsControl || !this.#connected()) return;
    const me = this.#me();
    const state = this.#state();
    if (state.holder === me || !canEdit(this.session.getSnapshot().role)) {
      this.#wantsControl = false;
      return;
    }
    if (!state.requests.includes(me)) this.#write({ requests: [...state.requests, me] });
  }

  #name(participantId: string): string {
    const member = this.session
      .getSnapshot()
      .participants.find((item) => item.participantId === participantId);
    if (member) return member.name;
    for (const state of this.session.awareness.getStates().values()) {
      const presence = state as Partial<PresenceState>;
      if (presence.participantId === participantId && typeof presence.name === "string")
        return presence.name;
    }
    return participantId.slice(0, 8);
  }

  #compute(): DeviceControlSnapshot {
    const me = this.#me();
    const session = this.session.getSnapshot();
    const isHost = session.role === "host";
    const state = this.#state();
    // Viewers never hold control; a holder demoted to viewer falls back to the host.
    const stored = state.holder
      ? session.participants.find((item) => item.participantId === state.holder)
      : undefined;
    const demoted = stored?.role === "viewer" || (state.holder === me && !canEdit(session.role));
    const holder = state.holder && !demoted ? state.holder : this.#hostId();
    const isHolder = this.#connected() && canEdit(session.role) && holder === me;
    const member = holder
      ? session.participants.find((item) => item.participantId === holder)
      : undefined;
    const requested = state.requests.includes(me) && !isHolder;
    const requests = state.requests
      .filter((id) => id !== holder && !this.#dismissed.has(id))
      .filter((id) => {
        const requester = session.participants.find((item) => item.participantId === id);
        return requester?.online && canEdit(requester.role);
      })
      .map((participantId) => ({ participantId, name: this.#name(participantId) }));
    return {
      holder,
      holderName: holder ? this.#name(holder) : null,
      holderOnline: holder === me ? this.#connected() : (member?.online ?? false),
      requests,
      isHolder,
      isHost,
      requested,
      declined: this.#declined && !requested && !isHolder,
      canRequest: this.#connected() && canEdit(session.role) && !isHolder && !requested,
      connected: this.#connected(),
      isViewer: !canEdit(session.role),
    };
  }

  #refresh(): void {
    if (this.#dismissed.size) {
      // Forget a decline once its request leaves the document, and while disconnected:
      // a new request can merge in on reconnect without the old one disappearing first.
      if (!this.#connected()) this.#dismissed.clear();
      const pending = new Set(this.#state().requests);
      for (const id of this.#dismissed) if (!pending.has(id)) this.#dismissed.delete(id);
    }
    const next = this.#compute();
    const key = JSON.stringify(next);
    if (key === this.#key) return;
    this.#key = key;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

/** Notice shown on disabled device actions while another participant holds control. */
export function deviceControlNotice(locale: Locale, holderName: string | null): string {
  return collabCopy[locale].deviceControlHeldBy(holderName);
}
