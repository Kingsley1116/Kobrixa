import "../src/renderer/index.js";
import * as monaco from "monaco-editor";
import { settingsStore } from "../src/renderer/settings-state.js";
import { keybindingsStore } from "../src/renderer/keyboard-state.js";
import { editorCommandCatalog } from "../src/renderer/monaco-keybindings.js";
Object.assign(window, { smoke: { monaco, settingsStore, keybindingsStore, editorCommandCatalog } });
