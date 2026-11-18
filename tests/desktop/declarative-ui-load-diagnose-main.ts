import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContentTracing, WebContents } from "electron";
import type { FoundationDiagnosticEvent, UiStateRegistry } from "@kobrixa/plugin-runtime";

const wall = () => performance.timeOrigin + performance.now();

export function diagnoseMain(
  states: UiStateRegistry,
  contents: WebContents,
  directory: string,
  contentTracing: ContentTracing,
  electronVersion: string,
) {
  const rows: object[] = [];
  let tracing = false;
  let profiling = false;
  let installed = false;
  const patch = states.patch;
  const send = contents.send;
  const write = (name: string, data: unknown) =>
    writeFile(path.join(directory, name), JSON.stringify(data));
  return {
    async start() {
      const available = await contentTracing.getCategories();
      const categories = new Set(available.flatMap((group) => group.split(",")));
      const groups = [
        ["renderer.scheduler", "sequence_manager"],
        ["toplevel"],
        ["devtools.timeline"],
        ["v8"],
        ["disabled-by-default-v8.gc", "v8.gc", "disabled-by-default-v8.gc_stats"],
        ["ipc", "mojom"],
        ["blink.user_timing"],
      ];
      const confirmed = groups.map((group) => group.filter((name) => categories.has(name)));
      await write("diagnostic-categories.json", {
        diagnostic: true,
        electron: electronVersion,
        available,
        groups,
        confirmed,
      });
      if (!electronVersion.startsWith("44.") || confirmed.some((group) => !group.length))
        throw new Error(
          "Unexpected Electron version or missing trace categories; see diagnostic-categories.json",
        );
      await contentTracing.startRecording({
        included_categories: confirmed.flat(),
        recording_mode: "record-as-much-as-possible",
      });
      tracing = true;
      await contents.debugger.sendCommand("Performance.enable", { timeDomain: "timeTicks" });
      const sent = wall();
      const { metrics } = await contents.debugger.sendCommand("Performance.getMetrics");
      const received = wall();
      const ticks = metrics.find((metric: { name: string }) => metric.name === "Timestamp")?.value;
      if (!Number.isFinite(ticks)) throw new Error("Missing renderer CDP monotonic timestamp");
      await write("diagnostic-cdp-clock.json", {
        sent,
        received,
        rendererTicksSeconds: ticks,
        ticksToMainMs: (received + sent) / 2 - ticks * 1000,
        uncertaintyMs: (received - sent) / 2,
      });
      await contents.debugger.sendCommand("Performance.disable");
      await contents.debugger.sendCommand("Profiler.enable");
      await contents.debugger.sendCommand("Profiler.start");
      profiling = true;
      states.patch = function (owner, params) {
        const applyStart = wall();
        const result = patch.call(this, owner, params);
        const applyEnd = wall();
        if (result.ok)
          rows.push({
            owner,
            binding: params.binding,
            revision: result.value.revision,
            applyStart,
            applyEnd,
          });
        return result;
      };
      contents.send = function (channel, ...args) {
        const [event] = args;
        if (!channel.startsWith("plugins:ui:event:") || event?.type !== "state")
          return send.call(this, channel, ...args);
        const sendStart = wall();
        const result = send.call(this, channel, ...args);
        rows.push({
          binding: event.binding,
          revision: event.revision,
          sendStart,
          sendEnd: wall(),
          channel,
        });
        return result;
      };
      installed = true;
    },
    wrap(observer: (event: FoundationDiagnosticEvent) => void) {
      return (event: FoundationDiagnosticEvent) => {
        if (!installed || event.kind !== "apply") return observer(event);
        const observerStart = wall();
        observer(event);
        rows.push({
          owner: event.owner,
          binding: event.binding,
          origin: event.time,
          observerStart,
          observerEnd: wall(),
        });
      };
    },
    async stop() {
      if (installed) {
        states.patch = patch;
        contents.send = send;
        installed = false;
        await write("diagnostic-main.json", rows.splice(0));
      }
      try {
        if (profiling) {
          profiling = false;
          const { profile } = await contents.debugger.sendCommand("Profiler.stop");
          await write("renderer.cpuprofile", profile);
        }
      } finally {
        if (tracing) {
          tracing = false;
          await contentTracing.stopRecording(path.join(directory, "electron.trace"));
        }
      }
    },
  };
}
