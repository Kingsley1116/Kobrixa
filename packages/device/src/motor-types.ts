/** Fixed USER_SLOT globals shared by the bounded motor-test image and CMD_SLOT. */
export const MOTOR_HELPER = {
  globalBytes: 24,
  magic: 0x4b4d5431,
  magicOffset: 0,
  tokenOffset: 4,
  armOffset: 8,
  stateOffset: 12,
  resultOffset: 13,
  portOffset: 14,
  angleOffset: 16,
  states: { waiting: 0, running: 1, finished: 2 },
  results: { none: 0, complete: 1, timeout: 2, cancelled: 3, notArmed: 4 },
} as const;

export interface MotorTestReading {
  sampledAt: number;
  programStopped: boolean;
  outputs: Array<{
    /** Zero-based local output port, A–D. */
    port: number;
    type: number;
    /** Persistent sensor tacho count, never cleared by testing. */
    angle: number | null;
    busy: boolean;
    speed: number | null;
  }>;
}

export interface MotorHelperStatus {
  owned: boolean;
  state: number;
  result: number;
  angle: number | null;
}
