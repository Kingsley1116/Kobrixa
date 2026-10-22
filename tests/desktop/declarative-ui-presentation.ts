// Test-only observer in the production renderer module graph. Preferences use
// the same store as Settings; all controls remain the actual PanelTree.
import type {} from "../../apps/desktop/src/renderer/window.js";
import {
  pluginUiWindow,
  settingsStore,
} from "../../apps/desktop/src/renderer/settings/settings-state.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, label: string) {
  const end = performance.now() + 5000;
  while (!predicate()) {
    check(performance.now() < end, label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function pane() {
  const element = document.querySelector<HTMLElement>(".plugin-tools-pane");
  check(element && element.getBoundingClientRect().width > 0, "panel absent");
  return element;
}
function control(selector: string) {
  const element = pane().querySelector<HTMLElement>(selector);
  check(element, `control absent: ${selector}`);
  return element;
}
function selected() {
  const session = pluginUiWindow().session;
  const entry = session.catalog
    .getSnapshot()
    .entries.find((item) => item.kind === "panel" && item.pluginId === "acceptance.ui-0");
  check(entry, "presentation source absent");
  const record = session.record(entry);
  check(record, "presentation binding absent");
  return { session, entry, record };
}
export async function configure(locale: "en" | "zh-TW", theme: "light" | "dark") {
  settingsStore.set("locale", locale);
  settingsStore.set("theme", theme);
  settingsStore.set("deviceWidth", 320);
  settingsStore.set("rightPanel", "plugins");
  await until(
    () =>
      document.documentElement.lang === locale && document.documentElement.dataset.theme === theme,
    "actual preferences not applied",
  );
  await frame();
  await frame();
  const root = pane();
  await until(
    () => Math.abs(root.getBoundingClientRect().width - 320) <= 1,
    "320px layout did not settle",
  );
  root.scrollTop = 0;
  const labels = [...root.querySelectorAll("label")].map((node) => node.textContent);
  check(
    labels.some((text) => text === (locale === "en" ? "Speed" : "速度")),
    "locale label absent",
  );
  const width = root.getBoundingClientRect().width;
  check(Math.abs(width - 320) <= 1, `expected320CSSpx actual${width}`);
  check(root.scrollWidth <= root.clientWidth + 1, "horizontal panel overflow");
  const nodes = [...root.querySelectorAll<HTMLElement>("[data-ui-node]")].map((node) => ({
    id: node.dataset.uiNode,
    hidden: !!node.closest("[hidden]"),
    width: node.getBoundingClientRect().width,
  }));
  check(nodes.length === 14, `expected14 actual${nodes.length}`);
  check(
    nodes.every((node) => node.hidden || node.width <= root.clientWidth + 1),
    "node overflow",
  );
  return {
    locale,
    theme,
    width,
    clientWidth: root.clientWidth,
    scrollWidth: root.scrollWidth,
    nodes,
    labels,
  };
}
export function target(selector: string) {
  const element = control(selector);
  element.scrollIntoView({ block: "center", inline: "nearest" });
  const bounds = element.getBoundingClientRect();
  check(bounds.width > 0 && bounds.height > 0, "target invisible");
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
}
export function inputSnapshot() {
  const { record } = selected();
  const view = record.state.getSnapshot();
  const input = control('[data-ui-node="speed"] input') as HTMLInputElement;
  return {
    value: input.value,
    invalid: input.getAttribute("aria-invalid"),
    focused: document.activeElement === input,
    activeNode: document.activeElement?.closest<HTMLElement>("[data-ui-node]")?.dataset.uiNode,
    alertVisible: !control('[data-ui-node="alert"]').hidden,
    enabled: view.draft.enabled,
    binding: view.snapshot.binding,
    revision: view.localRevision,
    draft: { ...view.draft },
    raw: { ...view.raw },
  };
}
export async function retainInvalidThroughClose() {
  const before = inputSnapshot();
  check(before.value === "-" && before.invalid === "true", "invalid draft not entered");
  const { entry, session } = selected();
  control("[data-close-contribution]").click();
  await until(() => !session.record(entry), "voluntary close failed");
  const tab = [...pane().querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) =>
    Object.values(entry.title).includes(button.textContent?.trim() ?? ""),
  );
  check(tab, "reopen tab absent");
  tab.click();
  await until(() => !!session.record(entry), "reopen failed");
  await frame();
  const after = inputSnapshot();
  check(after.value === "-" && after.invalid === "true", "invalid raw lost on reopen");
  check(after.binding.panelInstance !== before.binding.panelInstance, "old panel reused");
  check(
    after.binding.processEpoch === before.binding.processEpoch,
    "execution unexpectedly replaced",
  );
  check(after.binding.hostEpoch === before.binding.hostEpoch, "host unexpectedly replaced");
  check(JSON.stringify(after.draft) === JSON.stringify(before.draft), "draft changed on reopen");
  return { before, after };
}
export async function observeAnnouncements() {
  const status = control('[data-ui-node="status"] [aria-live="polite"]');
  const samples: { at: number; text: string | null }[] = [];
  const observer = new MutationObserver(() =>
    samples.push({ at: performance.now(), text: status.textContent }),
  );
  observer.observe(status, { childList: true, characterData: true, subtree: true });
  const started = performance.now();
  try {
    await new Promise((resolve) => setTimeout(resolve, 2200));
  } finally {
    observer.disconnect();
  }
  check(samples.length >= 1 && samples.length <= 3, `live status announcements:${samples.length}`);
  return {
    started,
    ended: performance.now(),
    samples,
    scope: "actual DOM live-region changes; not screen-reader speech",
  };
}
export async function siblingPanes() {
  const observations = [];
  for (const panel of ["ev3", "collab", "plugins"] as const) {
    settingsStore.set("rightPanel", panel);
    await frame();
    await frame();
    const visible = [
      ...document.querySelectorAll<HTMLElement>(".device-panel > .right-pane-content"),
    ].filter((element) => !element.hidden && element.getBoundingClientRect().width > 0);
    check(visible.length === 1, `sibling exclusivity:${panel}/${visible.length}`);
    check(
      visible[0]!.classList.contains("plugin-pane") === (panel === "plugins"),
      "wrong sibling visible",
    );
    observations.push({ panel, visible: visible.map((element) => element.className) });
  }
  return observations;
}
