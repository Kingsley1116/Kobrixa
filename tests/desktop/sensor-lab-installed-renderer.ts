import "./sensor-lab-public-renderer.js";

// Generic management controls only. The original preload IPC and host controller
// own enable/disable; no feature method or DOM-generated input is used.
const nav = document.createElement("nav");
nav.setAttribute("aria-label", "Installed fixture management");
for (const enabled of [false, true]) {
  const button = document.createElement("button");
  button.dataset.installedManagement = enabled ? "enable" : "disable";
  button.textContent = enabled ? "Enable Lab" : "Disable Lab";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await window.kobrixa.plugins.setEnabled("builtin:kobrixa.sensor-lab", enabled);
      if (!result.ok || result.persisted === false) throw Error(JSON.stringify(result));
    } catch (error) {
      console.error("Installed management failed", error);
    } finally {
      button.disabled = false;
    }
  });
  nav.append(button);
}
document.body.prepend(nav);
