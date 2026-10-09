import architectureEn from "../../../../../docs/en/architecture.md?raw";
import deviceSupportEn from "../../../../../docs/en/device-support.md?raw";
import installationEn from "../../../../../docs/en/installation.md?raw";
import keyboardSettingsEn from "../../../../../docs/en/keyboard-settings.md?raw";
import codeSigningEn from "../../../../../docs/en/code-signing.md?raw";
import collaborationEn from "../../../../../docs/en/collaboration.md?raw";
import languageSupportEn from "../../../../../docs/en/language-support.md?raw";
import productEn from "../../../../../docs/en/product.md?raw";
import roadmapEn from "../../../../../docs/en/roadmap.md?raw";
import architectureZh from "../../../../../docs/zh-TW/architecture.md?raw";
import deviceSupportZh from "../../../../../docs/zh-TW/device-support.md?raw";
import installationZh from "../../../../../docs/zh-TW/installation.md?raw";
import keyboardSettingsZh from "../../../../../docs/zh-TW/keyboard-settings.md?raw";
import codeSigningZh from "../../../../../docs/zh-TW/code-signing.md?raw";
import collaborationZh from "../../../../../docs/zh-TW/collaboration.md?raw";
import languageSupportZh from "../../../../../docs/zh-TW/language-support.md?raw";
import productZh from "../../../../../docs/zh-TW/product.md?raw";
import roadmapZh from "../../../../../docs/zh-TW/roadmap.md?raw";
import simulatorEn from "../../../../../docs/en/offline-preview.md?raw";
import simulatorZh from "../../../../../docs/zh-TW/offline-preview.md?raw";
import sensorLabEn from "../../../../../docs/en/sensor-lab.md?raw";
import sensorLabZh from "../../../../../docs/zh-TW/sensor-lab.md?raw";
import motorTestEn from "../../../../../docs/en/motor-test.md?raw";
import motorTestZh from "../../../../../docs/zh-TW/motor-test.md?raw";
import gettingReadyEn from "../../../../../docs/tutorials/en/00-getting-ready.md?raw";
import firstProgramEn from "../../../../../docs/tutorials/en/01-first-program.md?raw";
import valuesEn from "../../../../../docs/tutorials/en/02-values-and-logic.md?raw";
import controlEn from "../../../../../docs/tutorials/en/03-control-flow.md?raw";
import feedbackEn from "../../../../../docs/tutorials/en/04-feedback.md?raw";
import functionsEn from "../../../../../docs/tutorials/en/05-functions-projects.md?raw";
import motorsEn from "../../../../../docs/tutorials/en/06-motors.md?raw";
import sensorsEn from "../../../../../docs/tutorials/en/07-sensors.md?raw";
import dataEn from "../../../../../docs/tutorials/en/08-data-files.md?raw";
import runtimeEn from "../../../../../docs/tutorials/en/09-brick-runtime.md?raw";
import communicationEn from "../../../../../docs/tutorials/en/10-communication.md?raw";
import capstoneEn from "../../../../../docs/tutorials/en/11-capstone.md?raw";
import gettingReadyZh from "../../../../../docs/tutorials/zh-TW/00-getting-ready.md?raw";
import firstProgramZh from "../../../../../docs/tutorials/zh-TW/01-first-program.md?raw";
import valuesZh from "../../../../../docs/tutorials/zh-TW/02-values-and-logic.md?raw";
import controlZh from "../../../../../docs/tutorials/zh-TW/03-control-flow.md?raw";
import feedbackZh from "../../../../../docs/tutorials/zh-TW/04-feedback.md?raw";
import functionsZh from "../../../../../docs/tutorials/zh-TW/05-functions-projects.md?raw";
import motorsZh from "../../../../../docs/tutorials/zh-TW/06-motors.md?raw";
import sensorsZh from "../../../../../docs/tutorials/zh-TW/07-sensors.md?raw";
import dataZh from "../../../../../docs/tutorials/zh-TW/08-data-files.md?raw";
import runtimeZh from "../../../../../docs/tutorials/zh-TW/09-brick-runtime.md?raw";
import communicationZh from "../../../../../docs/tutorials/zh-TW/10-communication.md?raw";
import capstoneZh from "../../../../../docs/tutorials/zh-TW/11-capstone.md?raw";

export type DocsLocale = "zh-TW" | "en";
export type DocumentSlug =
  | "product"
  | "installation"
  | "keyboard-settings"
  | "collaboration"
  | "offline-preview"
  | "sensor-lab"
  | "motor-test"
  | "code-signing"
  | "language-support"
  | "device-support"
  | "architecture"
  | "roadmap";

export type DocumentEntry = {
  slug: DocumentSlug;
  category: "product" | "technical";
  title: Record<DocsLocale, string>;
  summary: Record<DocsLocale, string>;
  content: Record<DocsLocale, string>;
};

export type TutorialEntry = {
  slug: string;
  number: string;
  title: Record<DocsLocale, string>;
  summary: Record<DocsLocale, string>;
  hardware: Record<DocsLocale, string>;
  example: string;
  content: Record<DocsLocale, string>;
};

export const tutorials: readonly TutorialEntry[] = [
  {
    slug: "getting-ready",
    number: "00",
    title: { "zh-TW": "準備 Kobrixa 與 EV3", en: "Prepare Kobrixa and your EV3" },
    summary: { "zh-TW": "安裝、連線與安全準備。", en: "Installation, connection, and safety." },
    hardware: { "zh-TW": "EV3、USB 線", en: "EV3 and USB cable" },
    example: "getting-started/hello-ev3",
    content: { "zh-TW": gettingReadyZh, en: gettingReadyEn },
  },
  {
    slug: "first-program",
    number: "01",
    title: { "zh-TW": "第一個程式", en: "First program" },
    summary: { "zh-TW": "顯示文字與播放聲音。", en: "Display text and play sound." },
    hardware: { "zh-TW": "僅 EV3 本體", en: "EV3 brick only" },
    example: "getting-started/hello-ev3",
    content: { "zh-TW": firstProgramZh, en: firstProgramEn },
  },
  {
    slug: "values-and-logic",
    number: "02",
    title: { "zh-TW": "值、文字與運算", en: "Values, text, and math" },
    summary: { "zh-TW": "使用變數與運算式。", en: "Use variables and expressions." },
    hardware: { "zh-TW": "僅 EV3 本體", en: "EV3 brick only" },
    example: "language/text-and-math",
    content: { "zh-TW": valuesZh, en: valuesEn },
  },
  {
    slug: "control-flow",
    number: "03",
    title: { "zh-TW": "控制流程", en: "Control flow" },
    summary: { "zh-TW": "判斷、迴圈與布林值。", en: "Decisions, loops, and booleans." },
    hardware: { "zh-TW": "僅 EV3 本體", en: "EV3 brick only" },
    example: "control-flow/control-flow",
    content: { "zh-TW": controlZh, en: controlEn },
  },
  {
    slug: "feedback",
    number: "04",
    title: { "zh-TW": "互動回饋", en: "Interactive feedback" },
    summary: { "zh-TW": "顯示、聲音、按鍵與時間。", en: "Display, sound, buttons, and time." },
    hardware: { "zh-TW": "僅 EV3 本體", en: "EV3 brick only" },
    example: "buttons/button-feedback",
    content: { "zh-TW": feedbackZh, en: feedbackEn },
  },
  {
    slug: "functions-projects",
    number: "05",
    title: { "zh-TW": "函式與專案", en: "Functions and projects" },
    summary: {
      "zh-TW": "Sub、Function、Include 與 Import。",
      en: "Subs, Functions, Includes, and Imports.",
    },
    hardware: { "zh-TW": "僅 EV3 本體", en: "EV3 brick only" },
    example: "language/local-functions",
    content: { "zh-TW": functionsZh, en: functionsEn },
  },
  {
    slug: "motors",
    number: "06",
    title: { "zh-TW": "安全控制馬達", en: "Motors safely" },
    summary: { "zh-TW": "移動、停止與回授。", en: "Move, stop, and measure." },
    hardware: { "zh-TW": "A、D 馬達；先架高輪子", en: "Motors A and D; lift wheels" },
    example: "motors/motor-move",
    content: { "zh-TW": motorsZh, en: motorsEn },
  },
  {
    slug: "sensors",
    number: "07",
    title: { "zh-TW": "感測器", en: "Sensors" },
    summary: { "zh-TW": "讀取模式與門檻判斷。", en: "Read modes and thresholds." },
    hardware: { "zh-TW": "輸入埠 1 感測器", en: "Sensor on input 1" },
    example: "sensors/sensor-threshold",
    content: { "zh-TW": sensorsZh, en: sensorsEn },
  },
  {
    slug: "data-files",
    number: "08",
    title: { "zh-TW": "資料與檔案", en: "Data and files" },
    summary: { "zh-TW": "陣列、Vector 與檔案。", en: "Arrays, vectors, and files." },
    hardware: { "zh-TW": "僅 EV3 本體", en: "EV3 brick only" },
    example: "collections/row-vector",
    content: { "zh-TW": dataZh, en: dataEn },
  },
  {
    slug: "brick-runtime",
    number: "09",
    title: { "zh-TW": "本體與執行期", en: "Brick and runtime" },
    summary: { "zh-TW": "狀態、時間與程式結束。", en: "Status, time, and program endings." },
    hardware: { "zh-TW": "僅 EV3 本體", en: "EV3 brick only" },
    example: "program/brick-status",
    content: { "zh-TW": runtimeZh, en: runtimeEn },
  },
  {
    slug: "communication",
    number: "10",
    title: { "zh-TW": "信箱與並行", en: "Mailboxes and concurrency" },
    summary: { "zh-TW": "本機訊息與背景工作。", en: "Local messages and background work." },
    hardware: { "zh-TW": "僅 EV3 本體", en: "EV3 brick only" },
    example: "concurrency/thread-mutex",
    content: { "zh-TW": communicationZh, en: communicationEn },
  },
  {
    slug: "capstone",
    number: "11",
    title: { "zh-TW": "整合專題", en: "Capstone" },
    summary: { "zh-TW": "製作可安全測試的機器人。", en: "Build a robot you can test safely." },
    hardware: { "zh-TW": "馬達、按鍵、感測器", en: "Motors, buttons, and a sensor" },
    example: "capstones/obstacle-rover",
    content: { "zh-TW": capstoneZh, en: capstoneEn },
  },
];

export function findTutorial(slug: string | undefined) {
  return tutorials.find((tutorial) => tutorial.slug === slug);
}

export const documents: readonly DocumentEntry[] = [
  {
    slug: "code-signing",
    category: "technical",
    title: { "zh-TW": "簽章政策", en: "Code signing policy" },
    summary: {
      "zh-TW": "各平台簽章狀態、維護者責任與發布驗證。",
      en: "Platform signing status, maintainer responsibilities and release verification.",
    },
    content: { "zh-TW": codeSigningZh, en: codeSigningEn },
  },
  {
    slug: "product",
    category: "product",
    title: { "zh-TW": "產品規格", en: "Product specification" },
    summary: {
      "zh-TW": "Kobrixa 的目的、v1 使用流程、範圍與成功標準。",
      en: "Kobrixa's purpose, v1 workflow, scope, and success criteria.",
    },
    content: { "zh-TW": productZh, en: productEn },
  },
  {
    slug: "installation",
    category: "product",
    title: { "zh-TW": "安裝與復原", en: "Installation and recovery" },
    summary: {
      "zh-TW": "開發版設定、USB／Wi-Fi 連線與可復原的常見情境。",
      en: "Development setup, USB/Wi-Fi connection, and recoverable situations.",
    },
    content: { "zh-TW": installationZh, en: installationEn },
  },
  {
    slug: "keyboard-settings",
    category: "product",
    title: { "zh-TW": "快捷鍵與設定", en: "Keyboard shortcuts and settings" },
    summary: {
      "zh-TW": "編輯器操作、診斷解說、Quick Fix、儲存與復原設定。",
      en: "Editor controls, diagnostic explanations, Quick Fix, saving and recovery preferences.",
    },
    content: { "zh-TW": keyboardSettingsZh, en: keyboardSettingsEn },
  },
  {
    slug: "collaboration",
    category: "product",
    title: { "zh-TW": "雲端協作", en: "Cloud collaboration" },
    summary: {
      "zh-TW": "邀請碼與選填密碼、共同編輯、聊天、房間恢復、本機變更處理與 EV3 控制權。",
      en: "Invite codes and optional passwords, co-editing, chat, room recovery, local changes and EV3 control.",
    },
    content: { "zh-TW": collaborationZh, en: collaborationEn },
  },
  {
    slug: "offline-preview",
    category: "product",
    title: { "zh-TW": "本地 WRO 模擬器", en: "Local WRO simulator" },
    summary: {
      "zh-TW": "離線試跑 Basic Plus、多機場景、感測器與變數檢視，以及物理模型的限制。",
      en: "Run Basic Plus offline with multiple robots, inspect sensors and variables, and understand the physics limits.",
    },
    content: { "zh-TW": simulatorZh, en: simulatorEn },
  },
  {
    slug: "sensor-lab",
    category: "product",
    title: { "zh-TW": "Sensor Lab 感測器實驗室", en: "Sensor Lab" },
    summary: {
      "zh-TW": "感測器曲線、實驗比較、CSV 匯出、兩點校正與 Basic Plus 程式範例。",
      en: "Sensor charts, experiment comparisons, CSV export, two-point calibration and Basic Plus examples.",
    },
    content: { "zh-TW": sensorLabZh, en: sensorLabEn },
  },
  {
    slug: "motor-test",
    category: "product",
    title: { "zh-TW": "馬達測試", en: "Motor testing" },
    summary: {
      "zh-TW": "不需程式即可點動、定時或按角度測試馬達，了解停止行為與復原流程。",
      en: "Jog, timed and angle motor tests without writing code, with stop behavior and recovery guidance.",
    },
    content: { "zh-TW": motorTestZh, en: motorTestEn },
  },
  {
    slug: "language-support",
    category: "product",
    title: { "zh-TW": "語言支援政策", en: "Language support policy" },
    summary: {
      "zh-TW": "Basic Plus 相容性與後續語言前端的支援界線。",
      en: "Basic Plus compatibility and boundaries for future language frontends.",
    },
    content: { "zh-TW": languageSupportZh, en: languageSupportEn },
  },
  {
    slug: "device-support",
    category: "technical",
    title: { "zh-TW": "設備與平台支援", en: "Device and platform support" },
    summary: {
      "zh-TW": "USB、Wi-Fi 與跨平台硬體驗收的支援狀態。",
      en: "Support status for USB, Wi-Fi, and cross-platform hardware validation.",
    },
    content: { "zh-TW": deviceSupportZh, en: deviceSupportEn },
  },
  {
    slug: "architecture",
    category: "technical",
    title: { "zh-TW": "架構與公共契約", en: "Architecture and public contracts" },
    summary: {
      "zh-TW": "Kobrixa 的系統邊界、建置、裝置與安全契約。",
      en: "Kobrixa's system boundaries, build, device, and security contracts.",
    },
    content: { "zh-TW": architectureZh, en: architectureEn },
  },
  {
    slug: "roadmap",
    category: "technical",
    title: { "zh-TW": "路線圖", en: "Roadmap" },
    summary: {
      "zh-TW": "從 v1 到後續語言前端的產品方向。",
      en: "Product direction from v1 through future language frontends.",
    },
    content: { "zh-TW": roadmapZh, en: roadmapEn },
  },
];

export function findDocument(slug: string | undefined) {
  return documents.find((document) => document.slug === slug);
}
