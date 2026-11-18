import type { RpcPeer } from "@kobrixa/plugin-protocol";
import {
  supportsConnectionRecovery,
  type DeviceMethodV180 as DeviceMethod,
  type DeviceParamsV180 as DeviceParams,
  type DeviceResultV180 as DeviceResult,
  type DeviceEventV180 as DeviceEvent,
  type DeviceSubscriptionParamsV180 as DeviceSubscriptionParams,
  type DeviceSubscriptionSnapshotV180 as DeviceSubscriptionSnapshot,
  type BusinessResult,
  type DeviceFailureDetail,
} from "@kobrixa/plugin-protocol";
import { eventInbox, eventChannelBound } from "./events.js";
export interface DeviceSubscription {
  readonly subscriptionId: string;
  readonly snapshot: DeviceSubscriptionSnapshot;
  readonly lastSequence: number;
  dispose(): Promise<DeviceResult<"events/unsubscribe">>;
}
type Call<M extends DeviceMethod> = (
  params: DeviceParams<M>,
  signal?: AbortSignal,
) => Promise<DeviceResult<M>>;
const unavailable = {
  ok: false,
  error: {
    code: "PLUGIN_E_DEVICE_UNAVAILABLE",
    message: "Devices are not available before initialization or on this host.",
    detail: {
      kind: "device",
      reason: "provider-disabled",
      dispatch: "not-sent",
      stopConfirmation: "not-required",
    },
  },
} as const;
const lifetimes = new WeakMap<RpcPeer, { retire(): void; initialized(version: string): void }>();
export function retireDevicesClient(peer: RpcPeer): void {
  lifetimes.get(peer)?.retire();
}
export function initializeDevicesClient(peer: RpcPeer, version: string): void {
  lifetimes.get(peer)?.initialized(version);
}
export function createDevicesClient(peer: RpcPeer, ready: Promise<string>): DevicesClient {
  let version: string | null = null,
    negotiation: Promise<DeviceResult<"devices/negotiate">> | null = null;
  let epoch = 0;
  const observers = new Set<() => void>();
  let cleanupTail: Promise<unknown> = Promise.resolve();
  lifetimes.set(peer, {
    retire() {
      epoch++;
      version = null;
      negotiation = null;
      for (const retire of [...observers]) retire();
    },
    initialized(value) {
      version = value;
    },
  });
  const initialEpoch = epoch;
  void ready.then((value) => {
    if (epoch === initialEpoch) version = value;
  });
  const timeout = (method: DeviceMethod) =>
    ["devices/connect", "devices/disconnect", "devices/inputModes/set"].includes(method)
      ? 65000
      : ["devices/read", "devices/discover", "devices/inputModes/query"].includes(method)
        ? 15000
        : 5000;
  const send = <M extends DeviceMethod>(
    method: M,
    params: DeviceParams<M>,
    signal?: AbortSignal,
  ): Promise<DeviceResult<M>> =>
    peer.request(method, params, {
      timeoutMs: timeout(method),
      ...(signal ? { signal } : {}),
    }) as Promise<DeviceResult<M>>;
  const inbox = () => eventInbox(peer);
  async function negotiate(): Promise<DeviceResult<"devices/negotiate">> {
    if (
      version === null ||
      Number(version.split(".")[0]) < 1 ||
      (version.startsWith("1.") && Number(version.split(".")[1]) < 5)
    )
      return unavailable;
    const admittedEpoch = epoch;
    if (!negotiation)
      negotiation = send("devices/negotiate", {})
        .then((result) => {
          if (epoch !== admittedEpoch) return unavailable;
          if (!result.ok) negotiation = null;
          else if (eventChannelBound(peer)) inbox().enable();
          return result;
        })
        .catch((error: unknown) => {
          if (epoch === admittedEpoch) negotiation = null;
          throw error;
        });
    return negotiation;
  }
  const call =
    <M extends DeviceMethod>(method: M): Call<M> =>
    async (params, signal) => {
      if (
        method === "devices/connectionRecovery/read" &&
        (!version || !supportsConnectionRecovery(version))
      )
        return unavailable as DeviceResult<M>;
      if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
      const status = await negotiate();
      if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
      if (!status.ok) return status as DeviceResult<M>;
      return send(method, params, signal);
    };
  const client: DevicesClient = {
    negotiate,
    context: call("devices/context"),
    list: call("devices/list"),
    discover: call("devices/discover"),
    connect: call("devices/connect"),
    disconnect: call("devices/disconnect"),
    session: call("devices/session"),
    read: call("devices/read"),
    inputModes: { query: call("devices/inputModes/query"), set: call("devices/inputModes/set") },
    motion: {
      prepare: call("devices/motion/prepare"),
      start: call("devices/motion/start"),
      query: call("devices/motion/query"),
      stop: call("devices/motion/stop"),
    },
    connectionRecovery: { read: call("devices/connectionRecovery/read") },
    recording: {
      reserve: call("devices/recording/reserve"),
      query: call("devices/recording/query"),
      read: call("devices/recording/read"),
      release: call("devices/recording/release"),
    },
    async subscribe(
      params: DeviceSubscriptionParams,
      listener: (event: DeviceEvent) => void | Promise<void>,
      signal?: AbortSignal,
    ): Promise<BusinessResult<DeviceSubscription, DeviceFailureDetail>> {
      params = structuredClone(params);
      if (
        params.topic === "connectionRecovery" &&
        (!version || !supportsConnectionRecovery(version))
      )
        return unavailable;
      if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
      const status = await negotiate();
      if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
      if (!status.ok) return status;
      if (!eventChannelBound(peer)) return unavailable;
      const recovery = params.topic === "connectionRecovery";
      const ownerEpoch = epoch;
      const originalInbox = inbox();
      const live = () => !peer.closed && epoch === ownerEpoch && peer.connectionRecoveryReady;
      const finish = originalInbox.beginSubscription(recovery);
      try {
        const result = await send("devices/subscribe", params, signal);
        if (!result.ok) return result;
        const id = result.value.subscriptionId;
        let snapshot = result.value.snapshot;
        let disposed = false,
          terminal = false;
        let cleanup: Promise<DeviceResult<"events/unsubscribe">> | undefined;
        const closeHost = () => {
          if (!cleanup) {
            const pending = cleanupTail.then(() =>
              peer.closed ? unavailable : send("events/unsubscribe", { subscriptionId: id }),
            );
            // One source can have 32 affected observers but only a bounded RPC
            // window. Drain cleanup independently of user callbacks, in order.
            cleanupTail = pending.catch(() => {});
            cleanup = pending;
            void pending.then(
              (result) => {
                if (!result.ok && cleanup === pending) cleanup = undefined;
              },
              () => {
                if (cleanup === pending) cleanup = undefined;
              },
            );
          }
          return cleanup;
        };
        const retire = () => {
          disposed = true;
          originalInbox.close(id);
          observers.delete(retire);
          void closeHost();
        };
        const current = () => !disposed && !terminal && live();
        if (recovery) {
          if (!live()) {
            retire();
            return unavailable;
          }
          observers.add(retire);
        }
        const refresh = async () => {
          if (recovery && !current()) return;
          const refreshed =
            params.topic === "connectionRecovery"
              ? await client.connectionRecovery.read({})
              : params.topic === "catalog"
                ? await client.list({})
                : params.topic === "session" || params.topic === "telemetry"
                  ? await client.session({ sessionId: params.sessionId })
                  : params.topic === "motion"
                    ? await client.motion.query({ operationId: params.operationId })
                    : params.topic === "reservation"
                      ? await client.recording.query({ reservationId: params.reservationId })
                      : await client.context({ contextRef: params.contextRef });
          if (recovery && !(!disposed && !terminal && live())) return;
          if (refreshed.ok) {
            const value = refreshed.value;
            if (
              params.topic === "connectionRecovery" &&
              "hostEpoch" in snapshot &&
              "hostEpoch" in value &&
              (value.hostEpoch !== snapshot.hostEpoch || value.revision < snapshot.revision)
            )
              return;
            snapshot =
              "operation" in value
                ? value.operation
                : "reservation" in value
                  ? value.reservation
                  : value;
          }
        };
        originalInbox.open(
          id,
          async (event) => {
            if (recovery && !current()) {
              retire();
              return;
            }
            if (
              params.topic === "connectionRecovery" &&
              event.kind === "devices.connectionRecovery"
            ) {
              if (
                "hostEpoch" in snapshot &&
                (event.data.hostEpoch !== snapshot.hostEpoch ||
                  event.data.revision < snapshot.revision)
              )
                return;
              snapshot = event.data;
            }
            await listener(event);
          },
          refresh,
          0,
          recovery
            ? async (event) => {
                observers.delete(retire);
                if (!disposed && live()) await listener(event);
              }
            : undefined,
          recovery
            ? () => {
                terminal = true;
                return closeHost();
              }
            : undefined,
        );
        return {
          ok: true,
          value: {
            subscriptionId: id,
            get snapshot() {
              return snapshot;
            },
            get lastSequence() {
              return originalInbox.last(id);
            },
            async dispose() {
              if (recovery) {
                retire();
                return closeHost();
              }
              const ended = await send("events/unsubscribe", { subscriptionId: id });
              if (ended.ok) originalInbox.close(id);
              return ended;
            },
          },
        };
      } finally {
        finish();
      }
    },
  };
  return client;
}
export interface DevicesClient {
  connectionRecovery: { read: Call<"devices/connectionRecovery/read"> };
  negotiate(): Promise<DeviceResult<"devices/negotiate">>;
  context: Call<"devices/context">;
  list: Call<"devices/list">;
  discover: Call<"devices/discover">;
  connect: Call<"devices/connect">;
  disconnect: Call<"devices/disconnect">;
  session: Call<"devices/session">;
  read: Call<"devices/read">;
  inputModes: { query: Call<"devices/inputModes/query">; set: Call<"devices/inputModes/set"> };
  motion: {
    prepare: Call<"devices/motion/prepare">;
    start: Call<"devices/motion/start">;
    query: Call<"devices/motion/query">;
    stop: Call<"devices/motion/stop">;
  };
  recording: {
    reserve: Call<"devices/recording/reserve">;
    query: Call<"devices/recording/query">;
    read: Call<"devices/recording/read">;
    release: Call<"devices/recording/release">;
  };
  subscribe(
    params: DeviceSubscriptionParams,
    listener: (event: DeviceEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<BusinessResult<DeviceSubscription, DeviceFailureDetail>>;
}

export type {
  ConnectionRecoveryRef,
  ConnectionRecovery,
  ConnectionRecoverySnapshot,
} from "@kobrixa/plugin-protocol";
