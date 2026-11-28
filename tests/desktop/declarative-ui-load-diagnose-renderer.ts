import type { PluginUiBridge } from "@kobrixa/plugin-runtime";
import type { UiBinding } from "@kobrixa/plugin-protocol";

const wall = () => performance.timeOrigin + performance.now();

export function diagnoseRenderer(api: PluginUiBridge) {
  const rows: object[] = [];
  let active = false;
  let dispatch: { binding: UiBinding; revision: number } | undefined;
  const anchors: object[] = [];
  function anchor(name: string) {
    const mark = performance.mark(name);
    anchors.push({ name, timeOrigin: performance.timeOrigin, startTime: mark.startTime });
  }
  const bridge: PluginUiBridge = {
    ...api,
    onEvent: (listener) =>
      api.onEvent((event) => {
        if (!active || event.type !== "state") return listener(event);
        const previous = dispatch;
        dispatch = event;
        try {
          rows.push({
            binding: event.binding,
            revision: event.revision,
            eventEntry: wall(),
            pushed: "snapshot" in event,
          });
          listener(event);
        } finally {
          dispatch = previous;
        }
      }),
    snapshot: async (params) => {
      if (!active) return api.snapshot(params);
      const requestedRevision =
        dispatch?.binding.panelInstance === params.binding.panelInstance ? dispatch.revision : null;
      const row = {
        binding: params.binding,
        requestedRevision,
        request: wall(),
        arrival: null as number | null,
        revision: null as number | null,
        replyBinding: null as UiBinding | null,
        error: null as string | null,
      };
      rows.push(row);
      try {
        const result = await api.snapshot(params);
        row.arrival = wall();
        if (result.ok) {
          row.revision = result.value.revision;
          row.replyBinding = result.value.binding;
        } else row.error = result.error.code;
        return result;
      } catch (error) {
        row.arrival = wall();
        row.error = String(error);
        throw error;
      }
    },
  };
  return {
    bridge,
    start() {
      active = true;
      anchor("ui-load-diagnostic-start");
    },
    stop() {
      active = false;
      anchor("ui-load-diagnostic-end");
      return { rows: rows.splice(0), anchors };
    },
    watch(state: {
      subscribe(fn: () => void): () => void;
      getSnapshot(): { snapshot: { binding: UiBinding; revision: number } };
    }) {
      let last = state.getSnapshot().snapshot.revision;
      return state.subscribe(() => {
        const { binding, revision } = state.getSnapshot().snapshot;
        if (active && revision !== last) rows.push({ binding, revision, storeUpdate: wall() });
        last = revision;
      });
    },
  };
}
