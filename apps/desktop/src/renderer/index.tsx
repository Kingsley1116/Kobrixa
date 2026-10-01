import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles/index.css";
import { applyAppearance } from "./settings/settings.js";
import { settingsStore } from "./settings/settings-state.js";
import { initializeEditorServices } from "./editor/monaco-services.js";

initializeEditorServices();
applyAppearance(settingsStore.getSnapshot().values, document.documentElement);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
