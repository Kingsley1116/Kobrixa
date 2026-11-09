/** E0 legacy oracle at 590fd93. Test data only, never import into feature runtime.
 * Private DTOs here describe legacy inputs, not a proposed public contract.
 * Owners use design/plan §1 abbreviations. All public/v2/D1 evidence is UNRUN.
 */
import type { CompileResult, DeviceDescriptor } from "../../shared/api.js";
import type { DeviceInputModes, DeviceMonitorSnapshot } from "@kobrixa/device";

export const legacyBaseline = {
  sourceCommit: "590fd93",
  stage: "3E E0",
  publicParity: "unrun",
} as const;
const execution = "renderer/execution/execution.ts";
const monitor = "renderer/device/monitor-controller.ts";
/** Paths below are relative to apps/desktop/src. Partial means only the named
 * legacy seam is exercised; it is not completion of the design row. */
export const parityRows = [
  {
    id: "P01",
    behavior: "USB/Wi-Fi discovery and selection",
    feature: "F-E",
    core: "H-D/3A provider",
    contract: "H-P + H-V/3D D1",
    retained: ["main/device/device.ts"],
    coverage: "unrun",
    exercised: [],
    unrun: [
      {
        input: "USB and Wi-Fi candidates; choose wifi; discover pending/empty/error",
        expected: "Only Wi-Fi candidates selectable; searching, empty and error distinguishable",
        reason: "renderer/app.tsx + device-panel.tsx DOM/discovery integration",
      },
    ],
  },
  {
    id: "P02",
    behavior: "Direct Wi-Fi address and connection failure",
    feature: "F-E",
    core: "H-D provider; H-V execution adapter",
    contract: "H-P address schema",
    retained: [execution, "renderer/app.tsx"],
    coverage: "partial",
    exercised: ["wifi-error-retry", "wifi-normalization"],
    unrun: [
      {
        input: "Address draft with surrounding whitespace; failed connect",
        expected: "Trim at app boundary; retain draft and retry UI",
        reason: "DOM app wiring/address validation not executed",
      },
    ],
  },
  {
    id: "P03",
    behavior: "Connection reuse and USB reconnect",
    feature: "F-E catalog view",
    core: "H-D/3A provider recovery; H-V execution",
    contract: "H-P + H-R recovery",
    retained: [execution, "main/device/device.ts"],
    coverage: "partial",
    exercised: ["reuse-no-replay", "recovery-deployment"],
    unrun: [
      {
        input: "Open/reload panel with committed reconnect policy",
        expected: "No discovery/connect/replay on open; provider reconnect creates new session",
        reason: "DOM mount and main provider policy unrun",
      },
    ],
  },
  {
    id: "P04",
    behavior: "Recovery progress/cancel/terminal notices",
    feature: "F-E",
    core: "H-D/3A trusted cancellation; H-V execution",
    contract: "H-P + H-R + H-V, D1 dependent",
    retained: [execution, "main/device/device.ts"],
    coverage: "partial",
    exercised: [
      "recovery-cancel-late",
      "recovery-cancel-failure",
      "recovery-notices",
      "recovery-deployment",
    ],
    unrun: [
      {
        input: "Physical USB loss and retry exhaustion",
        expected: "Bounded retries, trusted cancel identity, no stale restoration",
        reason: "Main/native and public recovery projection unrun",
      },
    ],
  },
  {
    id: "P05",
    behavior: "Pending Run waits and cancels",
    feature: "none: core adjacent UI",
    core: "H-V execution + H-D authority",
    contract: "H-P/3A authority",
    retained: [execution, "renderer/app.tsx"],
    coverage: "partial",
    exercised: ["pending-run", "pending-cancel-late", "pending-authority", "wifi-error-retry"],
    unrun: [
      {
        input: "Workspace closes/switches or authority changes across main await",
        expected: "Core revalidates workspace and authority; UI opening creates no intent",
        reason: "Main admission and DOM workspace lifecycle unrun",
      },
    ],
  },
  {
    id: "P06",
    behavior: "Disconnect",
    feature: "F-E trusted core action",
    core: "H-D/3A coordinator + H-R; H-V summary",
    contract: "H-P v1 core action/busy",
    retained: [execution, "main/device/device.ts"],
    coverage: "partial",
    exercised: ["disconnect-failure"],
    unrun: [
      {
        input: "Disconnect during another owner's recording; stop/save fails",
        expected:
          "quiesce → stop/readback + end/drain/save → disconnect; failure blocks; public disconnect busy",
        reason: "Main coordinator, broker and public transport unrun",
      },
    ],
  },
  {
    id: "P07",
    behavior: "Battery and program status",
    feature: "F-E",
    core: "H-V BatteryStatus global demand; H-D broker sampler",
    contract: "H-P/3A channel semantics",
    retained: [
      "renderer/device/battery-status.ts",
      "renderer/app.tsx",
      "main/device/monitor-service.ts",
    ],
    coverage: "partial",
    exercised: ["battery-unknown", "monitor-gates"],
    unrun: [
      {
        input: "Null battery/voltage and unknown program",
        expected: "Unavailable/unknown labels, never display zero for null",
        reason: "DOM formatting and shared sampler demand unrun",
      },
    ],
  },
  {
    id: "P08",
    behavior: "Four inputs/outputs, readings, units and age",
    feature: "F-E",
    core: "H-D broker; H-V motor/Lab composition retained for their owners",
    contract: "H-P + 3D source semantics",
    retained: [monitor, "main/device/monitor-service.ts", "renderer/device/monitor-workspace.tsx"],
    coverage: "partial",
    exercised: ["monitor-values-busy-age", "monitor-session-sequence"],
    unrun: [
      {
        input: "Ready/empty/unknown/error ports, foreground files, old sample",
        expected: "Four inputs/outputs retain null gaps/units/timestamp; busy is waiting, not live",
        reason:
          "Main foreground arbitration and DOM age formatting unrun; legacy unknown is not a frozen public unsupported enum",
      },
    ],
  },
  {
    id: "P09",
    behavior: "Input modes",
    feature: "F-E",
    core: "H-D/3A admission; H-V withMonitor",
    contract: "H-P + H-V/3D D1 rows/revisions",
    retained: [monitor, execution, "renderer/app.tsx"],
    coverage: "partial",
    exercised: ["mode-selection", "mode-late-session", "mode-busy-error", "monitor-gates"],
    unrun: [
      {
        input: "Mode click after authority/source revision changes",
        expected: "Main rechecks locks/authority; public selection tied to session/source revision",
        reason: "Main consequential admission and v2 unrun",
      },
    ],
  },
  {
    id: "P10",
    behavior: "Fresh and read-only",
    feature: "F-E",
    core: "H-V authority/stop; H-D admission",
    contract: "H-P + 3D freshness",
    retained: [execution, "renderer/app.tsx"],
    coverage: "partial",
    exercised: ["read-only-stop", "monitor-values-busy-age"],
    unrun: [
      {
        input: { agesMs: [-1, 0, 2500, 2501], status: "live", session: "s1" },
        expected: { fresh: [false, true, true, false] },
        reason:
          "Historical baseline panel used private isFreshMonitorReading/useFreshReading for 2.5s freshness; that retired DOM hook was not run. MonitorController alone has no age cutoff. Retirement adds no freshness parity proof.",
      },
    ],
  },
  {
    id: "P11",
    behavior: "Six preferences/reset/retry",
    feature: "F-E settings resource",
    core: "B2/H-D persistence/provider reader; H-V form; core deploy skipUnchangedAssets",
    contract: "B2 + H-P + H-V dependent fields/CAS",
    retained: [
      "main/device/preferences.ts",
      "shared/device-preferences.ts",
      "renderer/settings/settings.ts",
      "renderer/settings/device-settings.ts",
    ],
    coverage: "partial",
    exercised: ["preferences-options", "preferences-commit-retry", "wifi-normalization"],
    unrun: [
      {
        input: "Failed field edit/reset, concurrent CAS, import corrupt file",
        expected: "Draft/error/retry retained; reset one field; new import blocks corruption",
        reason:
          "DOM hook, B2 import/CAS unrun. Legacy store has no reset/CAS API; legacy loader catch-all defaults are NOT new importer requirements.",
      },
    ],
  },
  {
    id: "P12",
    behavior: "Build/deploy/version and remote files",
    feature: "none: retained core exception",
    core: "H-V execution/remote-files + H-D broker adapter",
    contract: "H-P/3A broker/authority",
    retained: [
      execution,
      "renderer/device/remote-files.ts",
      "renderer/device/remote-files-panel.tsx",
      "shared/api.ts",
      "preload/index.ts",
      "main/device/device.ts",
    ],
    coverage: "partial",
    exercised: ["pending-run", "recovery-deployment", "file-reservation"],
    unrun: [
      {
        input: "Remote file mutation and build version display",
        expected:
          "Shared broker, invalidated deployment on matching files-changed; private paths stay core",
        reason: "Remote file protocol/main broker and DOM version labels unrun",
      },
    ],
  },
] as const;

export const usb: DeviceDescriptor = { id: "usb", name: "EV3", transport: "usb" };
export const buildResult: CompileResult = {
  buildId: "b1",
  target: "ev3-native",
  deploy: "ev3",
  success: true,
  diagnostics: [],
  runtimeDirectory: "/robot",
  artifacts: [
    {
      slot: "program",
      kind: "rbf",
      role: "deploy-main",
      mediaType: "application/octet-stream",
      path: "/tmp/build/demo.rbf",
      sha256: "abc",
      byteLength: 1,
    },
  ],
};
export const executionOracle = {
  runCalls: ["save", "build", "deploy:s1:b1:/robot", "run:s1:/robot/demo.rbf"],
  cancelledCalls: [],
  deployed: {
    workspaceId: "w1",
    buildId: "b1",
    sessionId: "s1",
    path: "/robot/demo.rbf",
    deploy: "ev3",
  },
  wifiError: { phase: "connecting", detail: "Wi-Fi timed out" },
};
export const preferenceCases = [
  { key: "skipUnchangedAssets", default: true, options: [true, false], invalid: [0, "true", null] },
  { key: "usbAutoReconnect", default: true, options: [true, false], invalid: [1, "false", null] },
  {
    key: "usbRetryInterval",
    default: "backoff",
    options: ["backoff", 1000, 2000, 5000, 10000],
    invalid: [0, 3000, "1000"],
  },
  {
    key: "usbRetryLimit",
    default: "unlimited",
    options: ["unlimited", 3, 5, 10],
    invalid: [0, 4, "3"],
  },
  {
    key: "wifiConnectTimeout",
    default: 5000,
    options: [3000, 5000, 10000, 30000],
    invalid: [-1, 1000, "5000"],
  },
  {
    key: "wifiHandshakeTimeout",
    default: 3000,
    options: [1000, 3000, 5000, 10000],
    invalid: [0, 2000, "3000"],
  },
] as const;
export const inputModes: DeviceInputModes = {
  port: 0,
  type: 29,
  modes: [
    { mode: 0, name: "COL-REFLECT" },
    { mode: 1, name: "COL-AMBIENT" },
  ],
};
export function monitorSample(): DeviceMonitorSnapshot {
  return {
    sampledAt: 10000,
    battery: { percent: 78, voltage: 7.5 },
    program: { status: "stopped", rawStatus: 0, result: 0 },
    inputs: [
      {
        port: 0,
        type: 29,
        connection: 122,
        mode: 0,
        state: "ready",
        name: "Color",
        modeName: "COL-REFLECT",
        unit: "pct",
        decimals: 0,
        values: [38, null],
        switchable: true,
      },
      {
        port: 1,
        type: 0,
        connection: 0,
        mode: 0,
        state: "empty",
        name: "",
        modeName: "",
        unit: "",
        decimals: 0,
        values: [],
        switchable: false,
      },
      {
        port: 2,
        type: 99,
        connection: 0,
        mode: 0,
        state: "unknown",
        name: "",
        modeName: "",
        unit: "",
        decimals: 0,
        values: [null],
        switchable: false,
      },
      {
        port: 3,
        type: 29,
        connection: 122,
        mode: 0,
        state: "error",
        name: "Color",
        modeName: "",
        unit: "pct",
        decimals: 0,
        values: [null],
        switchable: false,
      },
    ],
    outputs: [
      { port: 0, type: 7, state: "ready", name: "Large motor", angle: -123 },
      { port: 1, type: 0, state: "empty", name: "", angle: null },
      { port: 2, type: 99, state: "unknown", name: "", angle: null },
      { port: 3, type: 7, state: "error", name: "Large motor", angle: null },
    ],
  };
}
export const monitorOracle = {
  inputs: [
    [0, "ready", "pct", [38, null]],
    [1, "empty", "", []],
    [2, "unknown", "", [null]],
    [3, "error", "pct", [null]],
  ],
  outputs: [
    [0, "ready", -123],
    [1, "empty", null],
    [2, "unknown", null],
    [3, "error", null],
  ],
};
