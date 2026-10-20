import type { RpcPeer } from "@kobrixa/plugin-protocol";
import {
  type DeviceMethod,
  type DeviceParams,
  type DeviceResult,
  type DeviceEvent,
  type DeviceSubscriptionParams,
  type DeviceSubscriptionSnapshot,
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
export function createDevicesClient(peer: RpcPeer, ready: Promise<string>): DevicesClient {
  let version: string | null = null,
    negotiation: Promise<DeviceResult<"devices/negotiate">> | null = null;
  void ready.then((value) => {
    version = value;
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
    if (!negotiation)
      negotiation = send("devices/negotiate", {})
        .then((result) => {
          if (!result.ok) negotiation = null;
          else if (eventChannelBound(peer)) inbox().enable();
          return result;
        })
        .catch((error: unknown) => {
          negotiation = null;
          throw error;
        });
    return negotiation;
  }
  const call =
    <M extends DeviceMethod>(method: M): Call<M> =>
    async (params, signal) => {
      const status = await negotiate();
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
      const status = await negotiate();
      if (!status.ok) return status;
      if (!eventChannelBound(peer)) return unavailable;
      const finish = inbox().beginSubscription();
      try {
        const result = await send("devices/subscribe", params, signal);
        if (!result.ok) return result;
        const id = result.value.subscriptionId;
        let snapshot = result.value.snapshot;
        const refresh = async () => {
          const current =
            params.topic === "catalog"
              ? await client.list({})
              : params.topic === "session" || params.topic === "telemetry"
                ? await client.session({ sessionId: params.sessionId })
                : params.topic === "motion"
                  ? await client.motion.query({ operationId: params.operationId })
                  : params.topic === "reservation"
                    ? await client.recording.query({ reservationId: params.reservationId })
                    : await client.context({ contextRef: params.contextRef });
          if (current.ok) {
            const value = current.value;
            snapshot =
              "operation" in value
                ? value.operation
                : "reservation" in value
                  ? value.reservation
                  : value;
          }
        };
        inbox().open(id, listener, refresh);
        return {
          ok: true,
          value: {
            subscriptionId: id,
            get snapshot() {
              return snapshot;
            },
            get lastSequence() {
              return inbox().last(id);
            },
            async dispose() {
              const ended = await send("events/unsubscribe", { subscriptionId: id });
              if (ended.ok) inbox().close(id);
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
