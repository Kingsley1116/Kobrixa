import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";
import { applyAppearance } from "./settings.js";
import { settingsStore } from "./settings-state.js";

applyAppearance(settingsStore.getSnapshot().values, document.documentElement);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
