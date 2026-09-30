import "../src/renderer/index.js";
import * as monaco from "monaco-editor";
import { settingsStore } from "../src/renderer/settings/settings-state.js";
import { keybindingsStore } from "../src/renderer/keybindings/keyboard-state.js";
import { editorCommandCatalog } from "../src/renderer/keybindings/monaco-keybindings.js";
Object.assign(window, { smoke: { monaco, settingsStore, keybindingsStore, editorCommandCatalog } });
