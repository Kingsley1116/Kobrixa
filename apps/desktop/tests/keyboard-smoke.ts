import "../src/renderer/index.js";
import * as monaco from "monaco-editor";
import { settingsStore } from "../src/renderer/settings/settings-state.js";
import { keybindingsStore } from "../src/renderer/keybindings/keyboard-state.js";
import { editorCommandCatalog } from "../src/renderer/keybindings/monaco-keybindings.js";
const metrics = {
  appRenders: 0,
  completed: [] as Array<{ time: number }>,
  applied: [] as Array<{ duration: number; time: number }>,
  merged: [] as Array<{ duration: number; time: number }>,
};
window.addEventListener("smoke-app-render", () => metrics.appRenders++);
window.addEventListener("smoke-analysis-applied", (event) =>
  metrics.applied.push((event as CustomEvent).detail),
);
window.addEventListener("smoke-analysis-merged", (event) =>
  metrics.merged.push((event as CustomEvent).detail),
);
window.addEventListener("smoke-completion-applied", (event) =>
  metrics.completed.push((event as CustomEvent).detail),
);
Object.assign(window, {
  smoke: { monaco, settingsStore, keybindingsStore, editorCommandCatalog, metrics },
});
