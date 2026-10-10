import type { Diagnostic } from "@kobrixa/compiler";
import type { SourceSpan } from "@kobrixa/ir";
import type { OfflinePreviewProgram } from "./offline-preview.js";
import type { PreviewSnapshot } from "../preview/runtime.js";
import type { PreviewButton, PreviewPort, PreviewSensorPort } from "../preview/virtual-device.js";

/** Scene coordinates are millimetres, +x right, +y up; headings are CCW degrees. */
export interface SimulationPose {
  x: number;
  y: number;
  heading: number;
}
export type SimulationTeam = "A" | "B";
export type SimulationDrive = "differential" | "omni3" | "omni4";
export interface SimulationWheel {
  port: PreviewPort;
  x: number;
  y: number;
  /** Rolling direction relative to chassis forward. */
  angle: number;
  diameter: number;
  gearRatio: number;
  inverted: boolean;
}
export interface SimulationSensor {
  port: PreviewSensorPort;
  kind: "color" | "ultrasonic" | "gyro" | "touch" | "vision" | "pixy2";
  x: number;
  y: number;
  angle: number;
  range: number;
  fov: number;
  /** Reverse gyro angle and angular velocity; omitted means the normal direction. */
  inverted?: boolean | undefined;
  /** Omitted settings use DEFAULT_PIXY2_CONFIG without rewriting older scenes. */
  pixy2?: Pixy2Config | undefined;
}
export interface Pixy2Config {
  /** Camera height above the mat, in millimetres. */
  height: number;
  /** Degrees above the horizontal; negative values tilt down. */
  pitch: number;
  verticalFov: number;
  /** LEGO color signatures 1–7; zero means this ball color is not trained. */
  orangeSignature: number;
  purpleSignature: number;
}
export const DEFAULT_PIXY2_CONFIG: Readonly<Pixy2Config> = {
  height: 100,
  pitch: -10,
  verticalFov: 40,
  orangeSignature: 1,
  purpleSignature: 2,
};
/** LEGO I2C block coordinates use firmware-scaled unsigned bytes, not raw image pixels. */
export interface Pixy2Block {
  signature: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SimulationShooter {
  port: PreviewPort;
  x: number;
  y: number;
  angle: number;
  elevation: number;
  stroke: number;
  speed: number;
  range: number;
}
export const OPPONENT_LEVELS = ["easy", "standard", "hard"] as const;
export type OpponentLevel = (typeof OPPONENT_LEVELS)[number];
export interface RobotConfig {
  id: string;
  name: string;
  team: SimulationTeam;
  controller:
    | { kind: "program"; entry: string }
    /** Omitted level means "standard", so scenes saved before levels existed still load. */
    | { kind: "builtin"; level?: OpponentLevel | undefined }
    | { kind: "disabled" };
  pose: SimulationPose;
  drive: SimulationDrive;
  width: number;
  length: number;
  mass: number;
  wheels: SimulationWheel[];
  /** Omitted means "slip"; "grip" approximates stalled wheels when the body is blocked. */
  wheelTraction?: "slip" | "grip" | undefined;
  sensors: SimulationSensor[];
  pusher: { width: number; depth: number } | null;
  shooter: SimulationShooter | null;
}
export interface SimulationBall {
  id: string;
  kind: "orange" | "purple";
  x: number;
  y: number;
  /** Initial centre height above the mat, in millimetres. */
  z: number;
  central?: boolean | undefined;
}
/** "practice" is a plain line-following mat with one robot and no match rules. */
export type SimulationRuleset = "practice" | "wro-double-tennis-2026";
export interface SimulationScene {
  version: 1;
  ruleset: SimulationRuleset;
  mode: "practice" | "match";
  seed: number;
  durationMs: number;
  robots: RobotConfig[];
  balls: SimulationBall[];
}
export interface PreparedSimulation {
  /** Each distinct project-relative entry maps to an immutable compiled snapshot. */
  programs: Record<string, OfflinePreviewProgram>;
}
export type SimulationPrepareResult =
  | { success: true; prepared: PreparedSimulation; diagnostics: Diagnostic[] }
  | { success: false; diagnostics: Diagnostic[] };
/** A literal port the program uses that the simulated robot has no hardware on. */
export interface PortWarning {
  robotId: string;
  kind: "motor" | "sensor";
  port: string;
  span?: SourceSpan;
}
export interface SimulationEvent {
  id: number;
  timeMs: number;
  kind: "info" | "collision" | "violation" | "error" | "score";
  message: string;
  robotId?: string;
  span?: SourceSpan;
}
export interface SimulationRobotSnapshot {
  id: string;
  pose: SimulationPose;
  /** Chassis support height above the mat in mm (no pitch/suspension model). */
  elevation: number;
  distance: number;
  trace: Array<{ x: number; y: number }>;
  status: string;
}
export interface SimulationSnapshot {
  status: "ready" | "running" | "paused" | "stopped" | "completed" | "error";
  timeMs: number;
  robots: SimulationRobotSnapshot[];
  balls: SimulationBall[];
  score: Record<SimulationTeam, number>;
  events: SimulationEvent[];
  practiceContinuation: boolean;
  selectedRobotId?: string;
  debug?: PreviewSnapshot;
}
export type SimulationCommand =
  | { type: "load"; scene: SimulationScene; prepared: PreparedSimulation }
  | { type: "run" | "pause" | "step" | "stop" | "reset" }
  | { type: "speed"; value: number }
  | { type: "select"; robotId: string }
  | {
      type: "buttons";
      robotId: string;
      buttons: PreviewButton[];
    };
export type SimulationResponse =
  { type: "snapshot"; snapshot: SimulationSnapshot } | { type: "error"; message: string };

export const SIMULATOR_SCENE_FILE = "kobrixa.simulator.json";
export const SIMULATION_TICK_MS = 10;
export const SIMULATION_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
