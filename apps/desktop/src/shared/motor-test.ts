/** A motor test belongs to one connection and one renderer-generated invocation. */
export interface MotorTestRef {
  sessionId: string;
  testId: string;
}
export interface MotorTestRequest extends MotorTestRef {
  port: number;
  power: number;
  direction: 1 | -1;
  mode: "jog" | "timed" | "angle";
  brake: boolean;
  durationMs?: number;
  degrees?: number;
}
export interface MotorTestState {
  request?: MotorTestRequest;
  phase:
    | "idle"
    | "preparing"
    | "running"
    | "stopping"
    | "completed"
    | "stopped"
    | "timeout"
    | "failed"
    | "unconfirmed";
  angle: number | null;
  displacement: number | null;
  elapsedMs: number;
  updatedAt?: number;
  message?: string;
}
export function motorTestActive(state: MotorTestState): boolean {
  return state.phase === "preparing" || state.phase === "running" || state.phase === "stopping";
}
