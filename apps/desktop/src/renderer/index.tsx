import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";
import { readTheme } from "./theme.js";

document.documentElement.dataset.theme = readTheme(window.localStorage);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
