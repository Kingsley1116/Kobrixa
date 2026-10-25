import {
  DEVICE_LIMITS_V1,
  motionSpecSchema,
  type ActuatorDefinition,
  type CommandInvocation,
  type CommandValue,
  type DeviceSessionSnapshot,
  type MotionSnapshot,
  type MotionSpec,
  type SourceCatalog,
  type Text,
  type UiScalar,
} from "@kobrixa/plugin-protocol";

export const PORTS = ["A", "B", "C", "D"] as const;
export type Port = (typeof PORTS)[number];
export type Locale = CommandInvocation["context"]["locale"];
export const DEFAULTS = Object.freeze({
  mode: "jog",
  power: 20,
  seconds: 1,
  degrees: 90,
  direction: "1",
  brake: true,
} as const);
export const fieldKey = (port: Port, name: keyof typeof DEFAULTS): string =>
  `${port.toLowerCase()}-${name}`;

/** Drafts are host-owned scalars; no selected source or operation is restored here. */
export function initialForm(): Record<string, UiScalar> {
  return Object.fromEntries([
    ["port", "A"],
    ...PORTS.flatMap((port) =>
      Object.entries(DEFAULTS).map(([name, value]) => [
        fieldKey(port, name as keyof typeof DEFAULTS),
        value,
      ]),
    ),
  ]);
}

export function isPort(value: unknown): value is Port {
  return PORTS.some((port) => port === value);
}
export const localize = (text: Text, locale: Locale): string => text[locale] ?? text.en;
const text = (en: string, zh: string): Text => ({ en, "zh-TW": zh });
const messages = {
  port: text("Select port A–D.", "請選擇 A–D 連接埠。"),
  mode: text("Select a motion mode.", "請選擇運轉模式。"),
  power: text("Enter a whole power from 1 to 100.", "請輸入 1 至 100 的整數功率。"),
  seconds: text("Enter finite seconds from 0.1 to 5.", "請輸入 0.1 至 5 的有限秒數。"),
  degrees: text("Enter whole degrees from 1 to 3600.", "請輸入 1 至 3600 的整數角度。"),
  direction: text("Select forward or reverse.", "請選擇正向或反向。"),
  brake: text("Choose whether to brake on release.", "請選擇釋放時是否煞車。"),
};
export type MotionValidation =
  | { ok: true; port: Port; spec: MotionSpec }
  | { ok: false; fieldErrors: CommandValue["fieldErrors"] };
const numeric = (value: unknown, min: number, max: number, integer = false): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max &&
  (!integer || Number.isInteger(value));

/** Revalidate an accepted public action snapshot. Inactive fields are deliberately unread. */
export function motionFromForm(
  form: NonNullable<CommandInvocation["context"]["form"]>["values"],
  actuator: ActuatorDefinition,
  jogDirection?: 1 | -1,
): MotionValidation {
  const port = form.port;
  if (!isPort(port)) return { ok: false, fieldErrors: [{ field: "port", message: messages.port }] };
  const get = (name: keyof typeof DEFAULTS) => form[fieldKey(port, name)];
  const fieldErrors: CommandValue["fieldErrors"] = [];
  const invalid = (name: keyof typeof DEFAULTS) =>
    fieldErrors.push({ field: fieldKey(port, name), message: messages[name] });
  const mode = get("mode");
  if (mode !== "jog" && mode !== "timed" && mode !== "relative-angle") invalid("mode");
  const power = get("power");
  const brake = get("brake");
  if (!numeric(power, 1, 100, true)) invalid("power");
  if (typeof brake !== "boolean") invalid("brake");
  const direction = mode === "jog" ? jogDirection : get("direction");
  if (
    mode === "jog" ? direction !== 1 && direction !== -1 : direction !== "1" && direction !== "-1"
  )
    invalid("direction");
  const seconds = mode === "timed" ? get("seconds") : undefined;
  const degrees = mode === "relative-angle" ? get("degrees") : undefined;
  if (mode === "timed" && !numeric(seconds, 0.1, 5)) invalid("seconds");
  if (mode === "relative-angle" && !numeric(degrees, 1, 3600, true)) invalid("degrees");
  if (fieldErrors.length) return { ok: false, fieldErrors };
  // Source readiness/identity is separate from draft validation, never a slot-derived handle.
  if (actuator.portId !== port || actuator.state !== "ready")
    throw new TypeError("A current ready actuator for the selected port is required.");
  const base = {
    actuatorId: actuator.actuatorId,
    power,
    brake,
    direction: direction === -1 || direction === "-1" ? -1 : 1,
  };
  const spec = motionSpecSchema.parse(
    mode === "timed"
      ? { ...base, mode, durationMs: Math.round((seconds as number) * 1000) }
      : mode === "relative-angle"
        ? { ...base, mode, degrees }
        : { ...base, mode },
  );
  return { ok: true, port, spec };
}

export type Selection = Readonly<{
  sessionId: string;
  sourceRevision: number;
  portId: Port;
  actuatorId: string;
}>;
/** Pure current-source resolution; callers still need broker authority and a live motion scope. */
export function selectSource(
  session: DeviceSessionSnapshot,
  sources: SourceCatalog,
  port: Port,
): Selection | null {
  if (
    session.state !== "connected" ||
    !session.capabilities.includes("finiteMotion.v1") ||
    sources.sessionId !== session.sessionId ||
    sources.sourceRevision !== session.sourceRevision
  )
    return null;
  const matches = sources.actuators.filter((actuator) => actuator.portId === port);
  const actuator = matches[0];
  if (matches.length !== 1 || !actuator || actuator.state !== "ready") return null;
  return Object.freeze({
    sessionId: session.sessionId,
    sourceRevision: sources.sourceRevision,
    portId: port,
    actuatorId: actuator.actuatorId,
  });
}
export function selectionCurrent(
  selection: Selection,
  session: DeviceSessionSnapshot,
  sources: SourceCatalog,
): boolean {
  const current = selectSource(session, sources, selection.portId);
  return (
    current !== null &&
    current.sessionId === selection.sessionId &&
    current.sourceRevision === selection.sourceRevision &&
    current.actuatorId === selection.actuatorId
  );
}

export function progress(snapshot: MotionSnapshot, spec: MotionSpec): number | null {
  const ratio =
    spec.mode === "relative-angle"
      ? snapshot.displacement === null
        ? null
        : Math.abs(snapshot.displacement) / spec.degrees
      : snapshot.elapsedMs /
        (spec.mode === "timed" ? spec.durationMs : DEVICE_LIMITS_V1.movementMs);
  return ratio === null ? null : Math.max(0, Math.min(1, ratio));
}
/** Forced safety stops cannot be downgraded by a coast draft. */
export function stopBrake(configured: boolean, snapshot: MotionSnapshot, forced = false): boolean {
  return forced || snapshot.brakeRequired || configured;
}
const phases: Record<MotionSnapshot["phase"], Text> = {
  preparing: text("Preparing", "準備中"),
  running: text("Running", "運轉中"),
  stopping: text("Stopping", "停止中"),
  completed: text("Completed", "已完成"),
  stopped: text("Stopped", "已停止"),
  timeout: text("Timed out", "逾時"),
  failed: text("Failed", "失敗"),
  unconfirmed: text("Stop unconfirmed", "停止未確認"),
};
const stages: Record<MotionSnapshot["stage"], Text> = {
  prepared: text("Prepared", "準備完成"),
  "waiting-read": text("Waiting for reading", "等待讀值"),
  preflight: text("Checking device", "檢查裝置"),
  "uploading-helper": text("Uploading helper", "上傳輔助程式"),
  "awaiting-helper": text("Waiting for helper", "等待輔助程式"),
  arming: text("Arming", "啟動準備"),
  moving: text("Moving", "移動中"),
  readback: text("Reading back", "回讀中"),
  terminal: text("Terminal", "已結束"),
};
const movements: Record<MotionSnapshot["movement"], Text> = {
  "not-started": text("Not started", "尚未啟動"),
  completed: text("Completed", "已完成"),
  interrupted: text("Interrupted", "已中斷"),
  "timed-out": text("Timed out", "逾時"),
  unknown: text("Unknown", "未知"),
};
const dispatches: Record<MotionSnapshot["dispatch"], Text> = {
  "not-sent": text("Not sent", "尚未送出"),
  sent: text("Sent", "已送出"),
  unknown: text("Unknown", "未知"),
};
const confirmations: Record<MotionSnapshot["stopConfirmation"], Text> = {
  "not-required": text("Not required", "不需確認"),
  pending: text("Pending", "待確認"),
  confirmed: text("Confirmed", "已確認"),
  unconfirmed: text("Unconfirmed", "未確認"),
};
export const availabilityText = {
  unavailable: text(
    "Unavailable. Use the connection UI and device/plugin management, then select the current connection.",
    "目前無法使用。請使用連線介面與裝置／插件管理，再明確選取目前連線。",
  ),
  uiFailure: text(
    "Panel update failed. Check core recovery and stop status.",
    "面板更新失敗。請查看核心復原與停止狀態。",
  ),
  transportFailure: text(
    "Request failed; stop is not confirmed. Check core recovery.",
    "請求失敗；尚未確認停止。請查看核心復原。",
  ),
};
export const boundedText = (value: string, max = 1000): string =>
  Array.from(value)
    .filter((c) => {
      const cp = c.codePointAt(0)!;
      return cp !== 127 && cp >= 32 && !(cp >= 0xd800 && cp <= 0xdfff);
    })
    .slice(0, max)
    .join("");

export function presentMotion(snapshot: MotionSnapshot, spec: MotionSpec, locale: Locale) {
  const t = (value: Text) => localize(value, locale);
  const reading = (value: number | null) =>
    value === null ? t(text("No reading", "無讀值")) : `${value}°`;
  const error = snapshot.error;
  return {
    terminal: !["preparing", "running", "stopping"].includes(snapshot.phase),
    stoppedConfirmed: snapshot.stopConfirmation === "confirmed",
    // Preserve the public error code and detail for classification; only display text is bounded.
    ...(error === undefined ? {} : { error }),
    data: {
      operation: snapshot.operationId,
      phase: t(phases[snapshot.phase]),
      stage: t(stages[snapshot.stage]),
      movement: t(movements[snapshot.movement]),
      dispatch: t(dispatches[snapshot.dispatch]),
      "stop-requested": t(snapshot.stopRequested ? text("Yes", "是") : text("No", "否")),
      confirmation: t(confirmations[snapshot.stopConfirmation]),
      angle: reading(snapshot.angle),
      displacement: reading(snapshot.displacement),
      elapsed: `${snapshot.elapsedMs} ms`,
      progress: progress(snapshot, spec),
      error: error ? boundedText(`${error.code}: ${error.message} (${error.detail.reason})`) : "",
      "has-error": error !== undefined,
      summary: `${t(phases[snapshot.phase])} · ${t(confirmations[snapshot.stopConfirmation])}`,
    },
  };
}
