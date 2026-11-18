import { stat } from "node:fs/promises";
import { until } from "./builtin-installed-client.mjs";
// Runs in the inspected renderer. All actions go through the installed controls.
function devicePanelStep(step, product) {
  const pane = document.querySelector(".plugin-tools-pane [role=tabpanel]");
  const click = (button) => {
    if (!button || button.disabled || !button.getClientRects().length) return false;
    button.click();
    return true;
  };
  switch (step) {
    case "tools": {
      const toggle = document.querySelector(".plugin-tools-toggle");
      return toggle?.getAttribute("aria-pressed") === "true" || click(toggle);
    }
    case "device":
      return click(
        [...document.querySelectorAll(".plugin-tools-pane [role=tab]")].find((tab) =>
          ["EV3 device", "EV3 裝置"].includes(tab.title),
        ),
      );
    case "open":
      return click(pane?.querySelector(":scope > button:not([data-close-contribution])"));
    case "discover":
      return click(pane?.querySelector('[data-ui-node="discover-action"] button'));
    case "refresh":
      return click(pane?.querySelector('[data-ui-node="refresh-action"] button'));
    case "candidate":
    case "select": {
      const rows = pane?.querySelectorAll('[data-ui-node="candidates"] tbody tr') ?? [];
      const row = [...rows].find(
        (r) => r.cells[0]?.textContent === product && r.cells[1]?.textContent === "usb",
      );
      return step === "candidate" ? row?.textContent : click(row?.querySelector("button"));
    }
    case "connected": {
      const text = pane?.querySelector('[data-ui-node="connection"]')?.textContent;
      return text?.includes(product + " · connected") && text;
    }
  }
}

export async function connectUhidPanel(client, traceFile, check = () => {}) {
  const name = "Kobrixa UHID spike";
  const step = (action) =>
    client.js(
      `(${devicePanelStep.toString()})(${JSON.stringify(action)}, ${JSON.stringify(name)})`,
    );
  const wait = (action) =>
    until(
      () => {
        check();
        return step(action);
      },
      "EV3 panel " + action,
      30000,
    );
  await wait("tools");
  await wait("device");
  let requestedOpen = false;
  await until(
    async () => {
      check();
      if (await step("discover")) return true;
      if (!requestedOpen) requestedOpen = await step("open");
      return false;
    },
    "open EV3 device panel and click Discover",
    30000,
  );
  console.log("Discovered row", await wait("candidate"));
  const offset = (await stat(traceFile)).size;
  await wait("select");
  const connection = await wait("connected");
  return { connection, offset, step };
}
