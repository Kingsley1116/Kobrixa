import {
  validateUiResource,
  type UiCatalogEntry,
  type UiStateSnapshot,
} from "@kobrixa/plugin-protocol";
import type {} from "../../apps/desktop/src/renderer/window.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await pause(25);
  }
}
function value<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
const bridge = () => window.kobrixa.plugins.ui;
async function stale(operation: Promise<unknown>) {
  const result = (await operation) as {
    ok: boolean;
    error?: { code: string; detail?: { kind: string; reason: string } };
  };
  check(
    !result.ok && result.error?.code === "PLUGIN_E_STALE_RESOURCE",
    "expected stale resource failure",
  );
  check(
    result.error.detail?.kind === "resource" && result.error.detail.reason === "stale",
    "expected stale resource detail",
  );
}
export function noteBounds() {
  const label = [...document.querySelectorAll("label")].find((item) =>
    /^(Note|備註)/.test(item.textContent?.trim() ?? ""),
  );
  const control = label?.control ?? label?.querySelector("input,textarea");
  check(
    control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement,
    "actual note control absent",
  );
  const rect = control.getBoundingClientRect();
  check(rect.width > 0 && rect.height > 0, "actual note control invisible");
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
    focused: document.activeElement === control,
  };
}
export async function run() {
  await until(() => !!document.querySelector(".plugin-tools-toggle"), "real workbench ready");
  const api = bridge();
  const entries: UiCatalogEntry[] = [];
  let cursor: string | undefined;
  let revision: number | undefined;
  do {
    const page = value(await api.catalog(cursor ? { cursor } : {}));
    if (revision !== undefined) check(page.revision === revision, "catalog changed across pages");
    revision = page.revision;
    entries.push(...page.entries.filter((entry) => entry.pluginId.startsWith("acceptance.ui-")));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const panels = entries.filter(
    (entry) => entry.kind === "panel" && entry.availability === "available",
  );
  check(panels.length === 2, `expected two available panels: ${JSON.stringify(entries)}`);
  const live: UiStateSnapshot[] = [];
  const off = api.onEvent(() => {});
  try {
    for (const panel of panels) {
      const resource = value(
        await api.resource({
          sourceKey: panel.sourceKey,
          id: panel.id,
          uiResourceGeneration: panel.uiResourceGeneration,
          resourceDigest: panel.resourceDigest,
        }),
      );
      check(
        validateUiResource(
          resource.resource,
          resource.validationContext,
          Math.max(
            resource.rawBytes,
            new TextEncoder().encode(JSON.stringify(resource.resource)).length,
          ),
        ).ok,
        "real resource failed browser validation",
      );
      live.push(
        value(
          await api.open({
            sourceKey: panel.sourceKey,
            id: panel.id,
            uiResourceGeneration: panel.uiResourceGeneration,
          }),
        ),
      );
    }
    const initial = live[0]!;
    value(await api.visibility({ binding: initial.binding, visible: true, reason: "tab" }));
    const invoke = {
      binding: initial.binding,
      nodeId: "activate",
      formRevision: initial.formRevision + 1,
      form: initial.form,
    };
    const invoked = value(await api.invoke(invoke));
    check(invoked.output.unicode === "🙂界", "real SDK output corrupted Unicode");
    await stale(api.invoke({ ...invoke, formRevision: Number.MAX_SAFE_INTEGER }));
    await stale(
      api.invoke({ ...invoke, binding: { ...invoke.binding, processEpoch: crypto.randomUUID() } }),
    );
    const before = value(await api.snapshot({ binding: initial.binding }));
    await pause(500);
    const after = value(await api.snapshot({ binding: initial.binding }));
    check(
      after.revision > before.revision && after.data.ticks !== before.data.ticks,
      "actual process patch missing",
    );
    for (const current of live) value(await api.close({ binding: current.binding }));
    value(await api.close({ binding: initial.binding }));
    await stale(api.snapshot({ binding: initial.binding }));

    // These are real bridge open/close cycles. They are NOT renderer mount cycles
    // or proof of zero private counters; those diagnostics remain a separate gate.
    for (let n = 0; n < 1000; n++) {
      const panel = panels[n % panels.length]!;
      const opened = value(
        await api.open({
          sourceKey: panel.sourceKey,
          id: panel.id,
          uiResourceGeneration: panel.uiResourceGeneration,
        }),
      );
      value(await api.close({ binding: opened.binding }));
    }
    (document.querySelector(".plugin-tools-toggle") as HTMLButtonElement).click();
    await until(() => !!document.querySelector(".plugin-tools-pane"), "actual plugin pane");
    const pane = document.querySelector(".plugin-tools-pane")!;
    const titles = Object.values(panels[0]!.title);
    const tab = [...pane.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((button) =>
      titles.includes(button.textContent?.trim() ?? ""),
    );
    check(tab, "actual plugin tab absent");
    tab.click();
    await until(
      () => pane.textContent?.includes("<b>literal, not HTML</b>") ?? false,
      "actual React panel tree",
    );
    check(
      ![...pane.querySelectorAll("b")].some((item) => item.textContent === "literal, not HTML"),
      "HTML executed",
    );
    noteBounds();
    const statusText = () => document.querySelector(".plugin-status-host")?.textContent ?? "";
    await until(() => (statusText().match(/tick:[0-9]+/g) ?? []).length === 2, "two live statuses");
    const initialStatus = statusText();
    await until(() => statusText() !== initialStatus, "status patches after panel close/reopen");
    // The application listener remains mounted. A later observer must get its
    // own catalog/status replay, without resetting the application's stream.
    let replayedCatalog = false;
    const replayedStatuses = new Set<string>();
    const offReplay = api.onEvent((event) => {
      if (event.type === "catalog") replayedCatalog = true;
      if (event.type === "state" && event.binding.kind === "status")
        replayedStatuses.add(event.binding.panelInstance);
    });
    try {
      await until(
        () => replayedCatalog && replayedStatuses.size === 2,
        "late preload listener replay",
      );
    } finally {
      offReplay();
    }
    const pluginPids: number[] = [];
    for (const sourceKey of new Set(entries.map((entry) => entry.sourceKey))) {
      const log = await window.kobrixa.plugins.readLog(sourceKey, 0);
      const pids = log.lines.flatMap((line) => {
        const match = /UI_PID:([0-9]+)/.exec(line.text);
        return match ? [Number(match[1])] : [];
      });
      check(pids.length > 0, "no actual process PID in plugin log");
      pluginPids.push(...pids);
    }
    return {
      kind: "ui-browser-baseline",
      opened: live.length,
      unicode: invoked.output.unicode,
      literalHtml: true,
      oldBindingRejected: true,
      staleFormRejected: true,
      foreignBindingRejected: true,
      patchObserved: true,
      duplicateCloseIdempotent: true,
      liveStatuses: 2,
      statusAdvancedAfterCycles: true,
      lateListenerReplay: true,
      apiCycles: 1000,
      pluginPids,
    };
  } finally {
    off();
    // The normal workbench close owns its live panel and all remaining processes.
  }
}

export async function runLegacy() {
  const plugins = (await window.kobrixa.plugins.state()).plugins.filter((plugin) =>
    plugin.id.startsWith("acceptance.legacy-"),
  );
  check(plugins.length === 6, `missing preserved SDK cases: ${plugins.map((plugin) => plugin.id)}`);
  const cases = [];
  const pluginPids: number[] = [];
  for (const plugin of plugins) {
    check(
      plugin.status === "enabled",
      `legacy source rejected before execution: ${JSON.stringify(plugin)}`,
    );
    const result = await window.kobrixa.plugins.execute(`${plugin.id}.legacy`);
    const ui = plugin.id.includes("old-ui");
    if (ui)
      check(
        !result.ok && result.code === "PLUGIN_E_HANDSHAKE",
        `old SDK UI did not fail handshake: ${JSON.stringify(result)}`,
      );
    else check(result.ok, `legacy command failed: ${JSON.stringify(result)}`);
    await pause(100);
    const log = await window.kobrixa.plugins.readLog(plugin.sourceKey, 0);
    check(!log.truncated, "legacy wire evidence truncated");
    type Wire = {
      direction: string;
      message: {
        id?: number | string;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { code?: number };
      };
    };
    const wire: Wire[] = log.lines.flatMap((line) => {
      const prefix = "UI_LEGACY_WIRE:";
      const start = line.text.indexOf(prefix);
      return start < 0 ? [] : [JSON.parse(line.text.slice(start + prefix.length)) as Wire];
    });
    const initialize = wire.find(
      (row) => row.direction === "host" && row.message.method === "initialize",
    )?.message;
    check(
      initialize &&
        JSON.stringify(Object.keys(initialize.params ?? {}).sort()) ===
          JSON.stringify(["apiVersion", "grantedPermissions", "locale", "pluginId"]),
      "legacy initialize params changed",
    );
    const initialized = wire.find(
      (row) => row.direction === "plugin" && row.message.id === initialize.id,
    )?.message;
    const hello = initialized?.result as { apiVersion?: string } | undefined;
    const execute = wire.find(
      (row) => row.direction === "host" && row.message.method === "command/execute",
    )?.message;
    if (ui) {
      check(!execute, "UI handshake failure fell back to legacy execute");
      check(
        !log.lines.some((line) => line.text.includes("UI_LEGACY_EXECUTED:")),
        "old UI callback executed",
      );
      // The preserved strict 1.4 permission schema may reject ui.panels during
      // initialize, before negotiation. This is still the mandatory fail-closed
      // handshake, with the same four fields and no legacy callback fallback.
      if (hello) {
        check(hello.apiVersion === "1.4.0", "old UI fixture is not old SDK");
        const negotiate = wire.find(
          (row) => row.direction === "host" && row.message.method === "ui/negotiate",
        )?.message;
        check(
          negotiate &&
            wire.some(
              (row) =>
                row.direction === "plugin" &&
                row.message.id === negotiate.id &&
                row.message.error?.code === -32601,
            ),
          "old UI negotiation did not reject unknown method",
        );
      } else
        check(
          initialized?.error?.code === -32602,
          "old SDK did not reject new initialize permission",
        );
    } else {
      check(
        hello?.apiVersion === (plugin.id.includes("legacy-new") ? "1.6.0" : "1.4.0"),
        "preserved SDK version mismatch",
      );
      check(execute, "legacy execute absent");
      check(
        wire.some(
          (row) =>
            row.direction === "plugin" &&
            row.message.id === execute.id &&
            row.message.result === null,
        ),
        "legacy execute result is not null",
      );
      check(
        !wire.some(
          (row) => row.message.method === "command/invoke" || row.message.method?.startsWith("ui/"),
        ),
        "legacy manifest acquired UI/context protocol",
      );
      check(
        !wire.some((row) => row.message.method && row.message.id === undefined),
        "legacy manifest received new notifications",
      );
    }
    const pids = log.lines.flatMap((line) => {
      const match = /UI_PID:([0-9]+)/.exec(line.text);
      return match ? [Number(match[1])] : [];
    });
    check(pids.length === 1, "legacy process PID absent or replayed activation");
    pluginPids.push(...pids);
    cases.push({ id: plugin.id, result, wire, pids });
  }
  return { cases, pluginPids };
}
