import type { PreviewPort, PreviewValue } from "../preview/virtual-device.js";
import {
  DEFAULT_PIXY2_CONFIG,
  type OpponentLevel,
  type RobotConfig,
  type SimulationSensor,
} from "../shared/simulator.js";
import type { SimulationDevice } from "./device.js";
import { pixy2Observation } from "./pixy2-observation.js";
import { driveVelocity, FIELD, normalizeDegrees, seededRandom, wheelRow } from "./scene.js";

const DEG = Math.PI / 180;
/** Own-half ramp: rises toward the centre line, red top band is the last 50 mm. */
const RAMP = FIELD.ramps[0];
const RED_START = RAMP.x + RAMP.width - 50;
const BLUE_START = RED_START - 100;
const BARRIER = FIELD.barrier;
/** Clear lane behind the barrier's end, used to drive between the upper and lower courts. */
const BYPASS_X = BARRIER.x - 145;

interface Tuning {
  /** Decision period; the robot keeps its last motor command in between. */
  periodMs: number;
  /** Fraction of the slowest wheel's top speed. */
  speed: number;
  /** Allowed shot heading error, degrees. */
  aimTolerance: number;
  /** Extra clearance from the centre line and the red ramp band, beyond the turning radius. */
  margin: number;
  /** How long an unseen ball is remembered; 0 reacts only to the current observation. */
  memoryMs: number;
  /**
   * Candidate shot headings relative to straight across the centre line, degrees. Headings past
   * ±90 are bank shots off the own back wall, for balls too close to it to get behind.
   */
  aims: number[];
}
const TUNING: Record<OpponentLevel, Tuning> = {
  easy: {
    periodMs: 120,
    speed: 0.5,
    aimTolerance: 20,
    margin: 120,
    memoryMs: 0,
    aims: [0],
  },
  standard: {
    periodMs: 50,
    speed: 0.8,
    aimTolerance: 10,
    margin: 60,
    memoryMs: 6000,
    aims: [0, 30, -30],
  },
  hard: {
    periodMs: 30,
    speed: 0.8,
    aimTolerance: 10,
    margin: 45,
    memoryMs: 10_000,
    aims: [0, 25, -25, 45, -45, 150, -150],
  },
};

interface Point {
  x: number;
  y: number;
}
interface Pose extends Point {
  heading: number;
}
interface Command {
  forward: number;
  lateral: number;
  /** Radians per second, counter-clockwise. */
  turn: number;
}
interface Remembered extends Point {
  kind: "orange" | "purple";
  seen: number;
}
interface Observation extends Point {
  /** Ball centre in robot-local millimetres, independent of dead-reckoning error. */
  local: Point;
  bearing: number;
  distance: number;
  /** False for clipped/low-resolution camera bounds; never use them to aim a shot. */
  reliable: boolean;
}
interface Plan {
  kind: "shoot" | "push";
  aim: number;
  /** Pose where the final straight approach begins. */
  pre: Point;
  /** Shooting pose, or the pose at which the pusher meets the ball. */
  stage: Point;
}
interface Task {
  target: Remembered;
  plan: Plan;
  phase: "travel" | "align" | "final" | "fire";
  phaseSince: number;
  deadline: number;
  shooterStart?: number;
  /** Live ball fix at the start of a final-approach window, and the motion commanded since. */
  squeeze?: { since: number; ball: Point; expected: number };
}
const STOP: Command = { forward: 0, lateral: 0, turn: 0 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Sensor-only Double Tennis opponent. It reads the same mounted sensors and motor encoders a
 * user program can, and otherwise knows only the published mat layout and its own build. All
 * planning happens in an "own" frame where the robot's team defends x < midX; the field is
 * point-symmetric, so team B mirrors through the mat centre.
 */
export class BuiltinOpponent {
  private readonly tuning: Tuning;
  private readonly mirrored: boolean;
  private readonly random: () => number;
  private readonly vision: SimulationSensor | undefined;
  private readonly ultrasonic: SimulationSensor | undefined;
  private readonly gyro: SimulationSensor | undefined;
  private readonly color: SimulationSensor | undefined;
  /** Turning radius of the footprint including the pusher. */
  private readonly radius: number;
  private readonly halfWidth: number;
  private readonly maxSpeed: number;
  private readonly lane: "upper" | "lower" | undefined;
  private pose: Pose;
  private counts: Partial<Record<PreviewPort, number>> = {};
  private last: number | undefined;
  private memory: Remembered[] = [];
  private cooldowns: Array<Point & { until: number }> = [];
  private task: Task | undefined;
  private recover: { until: number; turnFrom: number; direction: number } | undefined;
  private search = { index: 0, scan: 0, since: 0 };
  private orange: Observation | undefined;
  private purple: Observation | undefined;
  private obstacle = Infinity;
  private lastColor: number | undefined;
  /** Heading change over the last decision period, degrees. */
  private turned = 0;
  /** Ultrasonic range at the start of a forward run, and the travel commanded since. */
  private progress: { since: number; range: number; expected: number } | undefined;
  private lastSensor: Point | undefined;
  /** Where the sensor last left a black line; re-entering close by means grazing its edge. */
  private blackExit: Point | undefined;

  constructor(
    private readonly config: RobotConfig,
    private readonly device: SimulationDevice,
    options: { level: OpponentLevel; seed: number; teammateActive: boolean },
  ) {
    this.tuning = TUNING[options.level];
    this.mirrored = config.team === "B";
    this.random = seededRandom(options.seed);
    const find = (kind: SimulationSensor["kind"]) => config.sensors.find((s) => s.kind === kind);
    this.vision = find("vision") ?? find("pixy2");
    this.ultrasonic = find("ultrasonic");
    this.gyro = find("gyro");
    this.color = find("color");
    const halfLength = config.length / 2;
    this.halfWidth = config.width / 2;
    this.radius =
      Math.max(
        Math.hypot(halfLength, this.halfWidth),
        config.pusher ? Math.hypot(halfLength + config.pusher.depth, config.pusher.width / 2) : 0,
      ) + 5;
    // 100% EV3 power is 720°/s at the motor shaft.
    this.maxSpeed =
      Math.min(...config.wheels.map((wheel) => (2 * Math.PI * wheel.diameter) / wheel.gearRatio)) *
      this.tuning.speed;
    this.pose = { ...this.own(config.pose), heading: this.ownHeading(config.pose.heading) };
    this.lane = options.teammateActive ? (this.pose.y > FIELD.midY ? "upper" : "lower") : undefined;
  }

  /** Current dead-reckoned pose in mat coordinates, for tests and debugging. */
  get estimate(): Pose {
    return { ...this.own(this.pose), heading: this.ownHeading(this.pose.heading) };
  }

  update(now: number): void {
    if (this.last !== undefined && now - this.last < this.tuning.periodMs) return;
    const first = this.last === undefined;
    this.last = now;
    if (first) this.configureSensors(now);
    this.localize(now);
    this.perceive(now);
    let command = this.decide(now);
    command = this.guard(command);
    this.drive(command, now);
  }

  // ── Frames ──────────────────────────────────────────────────────────────────────────────

  /** Mat ↔ own frame; the mirror is an involution, so one function converts both ways. */
  private own(point: Point): Point {
    return this.mirrored
      ? { x: FIELD.width - point.x, y: FIELD.height - point.y }
      : { x: point.x, y: point.y };
  }
  private ownHeading(degrees: number): number {
    return normalizeDegrees(this.mirrored ? degrees + 180 : degrees);
  }
  private toWorld(local: Point, pose: Pose = this.pose): Point {
    const c = Math.cos(pose.heading * DEG),
      s = Math.sin(pose.heading * DEG);
    return { x: pose.x + local.x * c - local.y * s, y: pose.y + local.x * s + local.y * c };
  }
  private toLocal(point: Point): Point {
    const c = Math.cos(this.pose.heading * DEG),
      s = Math.sin(this.pose.heading * DEG);
    const dx = point.x - this.pose.x,
      dy = point.y - this.pose.y;
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
  }

  // ── Sensing and localization ────────────────────────────────────────────────────────────

  private invoke(operation: string, args: PreviewValue[], now: number): number {
    return Number(this.device.invoke(operation, args, now).value ?? 0);
  }
  private read(sensor: SimulationSensor, index: number, now: number): number {
    return this.invoke("Sensor.ReadSIValue", [sensor.port, index], now);
  }
  private configureSensors(now: number): void {
    if (this.gyro) this.invoke("Sensor.SetMode", [this.gyro.port, 0], now);
    if (this.color) this.invoke("Sensor.SetMode", [this.color.port, 2], now);
    if (this.ultrasonic) this.invoke("Sensor.SetMode", [this.ultrasonic.port, 0], now);
    for (const wheel of this.config.wheels)
      this.counts[wheel.port] = this.invoke("Motor.GetCount", [wheel.port], now);
  }

  private localize(now: number): void {
    const deltas: Partial<Record<PreviewPort, number>> = {};
    for (const wheel of this.config.wheels) {
      const count = this.invoke("Motor.GetCount", [wheel.port], now);
      deltas[wheel.port] = count - (this.counts[wheel.port] ?? count);
      this.counts[wheel.port] = count;
    }
    // With a one-second "interval" the solver returns displacement instead of velocity.
    const motion = driveVelocity(this.config, deltas, 1);
    const before = this.pose.heading;
    const after = this.gyro
      ? this.ownHeading(
          this.config.pose.heading + this.read(this.gyro, 0, now) * (this.gyro.inverted ? -1 : 1),
        )
      : normalizeDegrees(before + motion.angular / DEG);
    this.turned = normalizeDegrees(after - before);
    const mid = before + this.turned / 2;
    const c = Math.cos(mid * DEG),
      s = Math.sin(mid * DEG);
    this.pose = {
      x: this.pose.x + motion.x * c - motion.y * s,
      y: this.pose.y + motion.x * s + motion.y * c,
      heading: after,
    };
    this.correctFromColor(now);
  }

  /**
   * Snap the color sensor's estimated position onto the printed feature it sees. Ramp bands are
   * matched continuously; black lines only on the white→black edge, where the direction of
   * travel tells a vertical line from a horizontal one (driving along a line proves nothing).
   */
  private correctFromColor(now: number): void {
    if (!this.color) return;
    const code = this.read(this.color, 0, now);
    const sensor = this.toWorld(this.color);
    const motion = this.lastSensor
      ? { x: sensor.x - this.lastSensor.x, y: sensor.y - this.lastSensor.y }
      : { x: 0, y: 0 };
    const entered = code !== this.lastColor;
    if (this.lastColor === 1 && code !== 1) this.blackExit = sensor;
    const grazing = this.blackExit !== undefined && distance(this.blackExit, sensor) < 80;
    this.lastColor = code;
    this.lastSensor = sensor;
    const fixes: Array<{ axis: "x" | "y"; lo: number; hi: number; gate: number }> = [];
    const onRamp = sensor.y < RAMP.y + RAMP.height + 30;
    if (code === 5 && onRamp)
      fixes.push({ axis: "x", lo: RED_START, hi: RAMP.x + RAMP.width, gate: 60 });
    else if (code === 2 && onRamp)
      fixes.push({ axis: "x", lo: BLUE_START, hi: RED_START, gate: 60 });
    else if (code === 1 && entered && !grazing) {
      // A wide search window only along a straight drive; a turning sensor sweeps an arc.
      const straight = Math.abs(this.turned) < 3;
      const alongX = straight && Math.abs(motion.x) > 2 * Math.abs(motion.y);
      const alongY = straight && Math.abs(motion.y) > 2 * Math.abs(motion.x);
      for (const line of FIELD.verticalLines)
        if (line.x < FIELD.midX)
          fixes.push({
            axis: "x",
            lo: line.x - line.width / 2,
            hi: line.x + line.width / 2,
            gate: alongX ? 150 : 45,
          });
      for (const y of FIELD.leftLines)
        fixes.push({ axis: "y", lo: y - 10, hi: y + 10, gate: alongY ? 100 : 45 });
    }
    // The least surprising feature wins, and only when no other one is nearly as plausible.
    const shifts = fixes
      .map((fix) => ({
        axis: fix.axis,
        gate: fix.gate,
        shift: clamp(sensor[fix.axis], fix.lo, fix.hi) - sensor[fix.axis],
      }))
      .filter((item) => Math.abs(item.shift) <= item.gate)
      .sort((a, b) => Math.abs(a.shift) - Math.abs(b.shift));
    const [best, rival] = shifts;
    if (best && (!rival || Math.abs(rival.shift) - Math.abs(best.shift) > 30)) {
      this.pose[best.axis] += best.shift;
      this.lastSensor = this.toWorld(this.color);
    }
  }

  private perceive(now: number): void {
    this.obstacle = this.ultrasonic ? this.read(this.ultrasonic, 0, now) * 10 : Infinity;
    this.orange = this.observe(1, now);
    this.purple = this.observe(2, now);
    this.remember("orange", this.orange, now);
    this.remember("purple", this.purple, now);
    this.cooldowns = this.cooldowns.filter((item) => item.until > now);
  }

  private observe(mode: 1 | 2, now: number): Observation | undefined {
    const vision = this.vision;
    if (!vision) return undefined;
    if (vision.kind === "pixy2") {
      const config = vision.pixy2 ?? DEFAULT_PIXY2_CONFIG;
      const signature = mode === 1 ? config.orangeSignature : config.purpleSignature;
      // Shared signatures cannot tell our two ball types apart. Never infer a
      // ball's type from its world position or use the largest-block X SI value
      // as though it were the simulator vision's detection/bearing/range tuple.
      if (!signature || config.orangeSignature === config.purpleSignature) return undefined;
      const reply = this.device.invoke(
        "Sensor.ReadI2CRegisters",
        [vision.port, 1, 0x50 + signature, 5],
        now,
      ).value;
      if (
        !Array.isArray(reply) ||
        !reply.every((value): value is number => typeof value === "number")
      )
        return undefined;
      const observation = pixy2Observation(vision, reply, FIELD.ballRadius);
      return observation ? { ...this.toWorld(observation.local), ...observation } : undefined;
    }
    this.invoke("Sensor.SetMode", [vision.port, mode], now);
    if (!this.read(vision, 0, now)) return undefined;
    const bearing = this.read(vision, 1, now),
      range = this.read(vision, 2, now);
    const angle = (vision.angle + bearing) * DEG;
    const local = {
      x: vision.x + Math.cos(angle) * range,
      y: vision.y + Math.sin(angle) * range,
    };
    return { ...this.toWorld(local), local, bearing, distance: range, reliable: true };
  }

  private remember(kind: Remembered["kind"], seen: Observation | undefined, now: number): void {
    const vision = this.vision;
    if (!vision) return;
    // A clipped camera blob still provides a steering/avoidance cue, but its
    // approximate distance must not replace the last usable localization fix.
    if (seen && !seen.reliable) seen = undefined;
    if (!this.tuning.memoryMs) {
      this.memory = this.memory.filter((ball) => ball.kind !== kind);
      if (seen) this.memory.push({ kind, x: seen.x, y: seen.y, seen: now });
      return;
    }
    let match: Remembered | undefined;
    if (seen)
      for (const ball of this.memory)
        if (
          ball.kind === kind &&
          distance(ball, seen) < 90 &&
          (!match || distance(ball, seen) < distance(match, seen))
        )
          match = ball;
    if (seen && match) {
      match.x = seen.x;
      match.y = seen.y;
      match.seen = now;
    } else if (seen) {
      this.memory.push({ kind, x: seen.x, y: seen.y, seen: now });
    }
    const origin = this.toWorld(vision);
    this.memory = this.memory.filter((ball) => {
      if (ball.kind !== kind || ball === match) return true;
      if (now - ball.seen > this.tuning.memoryMs) return false;
      // Pixy2 returns the largest image block, which need not be the nearest
      // ball. Occlusion and image clipping also differ: keep its last fix until
      // expiry rather than deleting it using the synthetic vision assumption.
      if (vision.kind === "pixy2") return true;
      // Synthetic vision reports the nearest ball. A remembered ball that should
      // be visible and nearer than that observation has moved.
      const local = this.toLocal(ball);
      const range = Math.hypot(local.x - vision.x, local.y - vision.y);
      const bearing = normalizeDegrees(
        Math.atan2(local.y - vision.y, local.x - vision.x) / DEG - vision.angle,
      );
      const visible =
        range < vision.range - 50 &&
        Math.abs(bearing) < vision.fov / 2 - 8 &&
        !segmentHitsRect(origin, ball, BARRIER);
      return !(visible && range < (seen?.distance ?? Infinity) - 60);
    });
    const ofKind = this.memory.filter((ball) => ball.kind === kind);
    if (ofKind.length > 12) {
      const oldest = ofKind.reduce((a, b) => (a.seen <= b.seen ? a : b));
      this.memory.splice(this.memory.indexOf(oldest), 1);
    }
  }

  // ── Decisions ───────────────────────────────────────────────────────────────────────────

  private decide(now: number): Command {
    if (this.recover) {
      if (now < this.recover.until) {
        return now < this.recover.turnFrom
          ? { forward: -0.6 * this.maxSpeed, lateral: 0, turn: 0 }
          : { forward: 0, lateral: 0, turn: this.recover.direction * 2.5 * this.tuning.speed };
      }
      this.recover = undefined;
    }
    if (this.task?.phase === "fire") return this.fire(now);
    const crowded = this.purple && Math.hypot(this.purple.local.x, this.purple.local.y);
    if (crowded && crowded < this.radius + FIELD.ballRadius + 15) {
      // A purple ball within our turning circle: back off before any turn sweeps it away.
      const speed = 0.5 * this.maxSpeed;
      const { x, y } = this.purple!.local;
      return this.config.drive === "differential"
        ? { forward: x > 0 ? -speed : speed, lateral: 0, turn: 0 }
        : { forward: (-x / crowded) * speed, lateral: (-y / crowded) * speed, turn: 0 };
    }
    this.choose(now);
    const command = this.task ? this.pursue(now) : this.patrol(now);
    if (this.blocked(command) || this.stalled(command, now)) {
      this.startRecovery(now);
      return STOP;
    }
    return command;
  }

  private startRecovery(now: number): void {
    if (this.task) this.abandon(now, 3000);
    this.recover = {
      turnFrom: now + 450,
      until: now + 450 + 350 + this.random() * 300,
      direction: this.random() < 0.5 ? -1 : 1,
    };
  }

  private abandon(now: number, cooldownMs: number): void {
    if (!this.task) return;
    this.cooldowns.push({ x: this.task.target.x, y: this.task.target.y, until: now + cooldownMs });
    this.task = undefined;
  }

  /** Something solid sits right in front of a robot that wants to drive forward. */
  private blocked(command: Command): boolean {
    if (command.forward < 40 || this.task?.phase === "final") return false;
    const purpleAhead =
      this.purple &&
      this.purple.distance < 110 &&
      Math.abs(Math.atan2(this.purple.local.y, this.purple.local.x) / DEG) < 35;
    if (purpleAhead) return true;
    if (this.obstacle > 60) return false;
    const ballAhead = [this.orange, this.purple].some((ball) => {
      if (!ball || !this.ultrasonic) return false;
      // Camera bearing/range are relative to its own mount. Compare the ball
      // with the range probe in that probe's frame, even for a side-facing camera.
      const x = ball.local.x - this.ultrasonic.x;
      const y = ball.local.y - this.ultrasonic.y;
      const bearing = normalizeDegrees(Math.atan2(y, x) / DEG - this.ultrasonic.angle);
      return Math.abs(bearing) < 25 && Math.abs(Math.hypot(x, y) - this.obstacle) < 45;
    });
    return !ballAhead;
  }

  /**
   * Wheels are not stall-limited, so a robot pinned against another one keeps counting encoder
   * travel. Commanded forward travel that the ultrasonic range does not reflect means pinned.
   */
  private stalled(command: Command, now: number): boolean {
    const watching = command.forward >= 80 && this.obstacle < 600 && this.task?.phase !== "final";
    if (!watching) {
      this.progress = undefined;
      return false;
    }
    if (!this.progress) {
      this.progress = { since: now, range: this.obstacle, expected: 0 };
      return false;
    }
    this.progress.expected += (command.forward * this.tuning.periodMs) / 1000;
    if (now - this.progress.since < 400) return false;
    const pinned = this.progress.range - this.obstacle < 0.3 * this.progress.expected;
    this.progress = undefined;
    return pinned;
  }

  private inLane(point: Point): boolean {
    if (!this.lane) return true;
    // Behind the barrier both robots can reach either court; split there with a shared band.
    if (point.x < BARRIER.x + this.radius)
      return this.lane === "upper" ? point.y > FIELD.midY - 150 : point.y < FIELD.midY + 150;
    return this.lane === "upper" ? point.y > FIELD.midY : point.y < FIELD.midY;
  }

  private choose(now: number): void {
    const current = this.task;
    if (current) {
      const still = this.memory.find(
        (ball) => ball.kind === "orange" && distance(ball, current.target) < 90,
      );
      if (!still || now > current.deadline) {
        this.abandon(now, still ? 3000 : 500);
      } else if (current.phase !== "travel") {
        // Once lined up, stay committed; replanning would only make it dither.
        current.target = still;
        return;
      }
    }
    let best: { ball: Remembered; plan: Plan; cost: number } | undefined;
    for (const ball of this.memory) {
      if (ball.kind !== "orange") continue;
      // Balls on the centre line (including the untouched central ball) are not ours to play.
      if (ball.x > FIELD.midX - 5 || !this.inLane(ball)) continue;
      if (this.cooldowns.some((item) => distance(item, ball) < 120)) continue;
      const plan = this.plan(ball);
      if (!plan) continue;
      const turn = Math.abs(normalizeDegrees(plan.aim - this.pose.heading));
      const cost = this.pathLength(this.pose, plan.pre) + turn * 1.5;
      if (!best || cost < best.cost) best = { ball, plan, cost };
    }
    const task = this.task;
    if (task) {
      const plan = this.plan(task.target);
      const cost = plan ? this.pathLength(this.pose, plan.pre) : Infinity;
      if (!best || best.ball === task.target || cost < best.cost * 1.4 + 50) {
        if (plan) task.plan = plan;
        else this.abandon(now, 2000);
        return;
      }
    }
    if (!best) {
      this.task = undefined;
      return;
    }
    this.task = {
      target: best.ball,
      plan: best.plan,
      phase: "travel",
      phaseSince: now,
      deadline: now + (best.cost / this.maxSpeed) * 1800 + 4000,
    };
  }

  /** Find a pose that sends the ball across the centre line without crossing it ourselves. */
  private plan(ball: Point): Plan | undefined {
    const shooter = this.config.shooter;
    if (shooter) {
      const standoff = shooter.x + clamp(40, 25, shooter.range - 15);
      for (const aim of this.tuning.aims) {
        const dir = { x: Math.cos(aim * DEG), y: Math.sin(aim * DEG) };
        const side = { x: -dir.y, y: dir.x };
        for (const shift of [0, 15, -15, 30, -30]) {
          const offset = shooter.y + shift;
          const stage = {
            x: ball.x - dir.x * standoff - side.x * offset,
            y: ball.y - dir.y * standoff - side.y * offset,
          };
          if (!this.feasible(stage, aim)) continue;
          return { kind: "shoot", aim, stage, pre: this.backOff(stage, dir, aim, 140) };
        }
      }
    }
    // Push: meet the ball with the pusher (or the body front for an off-centre ball).
    const front = this.config.length / 2 + (this.config.pusher?.depth ?? 0);
    for (const shift of [0, 20, -20, 40, -40, 60, -60]) {
      if (Math.abs(shift) > this.halfWidth - 8) continue;
      const stage = { x: ball.x - front - FIELD.ballRadius - 25, y: ball.y - shift };
      if (!this.feasible(stage, 0) || stage.x > this.maxX(stage.y) - 80) continue;
      return { kind: "push", aim: 0, stage, pre: this.backOff(stage, { x: 1, y: 0 }, 0, 160) };
    }
    return undefined;
  }

  private backOff(stage: Point, dir: Point, heading: number, length: number): Point {
    for (const back of [length, length / 2]) {
      const pre = { x: stage.x - dir.x * back, y: stage.y - dir.y * back };
      if (this.feasible(pre, heading)) return pre;
    }
    return stage;
  }

  /** The footprint fits on the mat clear of the barrier, and turning there cannot cross a line. */
  private feasible(center: Point, heading: number): boolean {
    if (center.x > this.maxX(center.y)) return false;
    const corners = this.footprint({ ...center, heading });
    if (corners.some((p) => p.x < 6 || p.y < 6 || p.x > FIELD.width - 6 || p.y > FIELD.height - 6))
      return false;
    const barrier = {
      x: BARRIER.x - 25,
      y: BARRIER.y - 25,
      width: BARRIER.width + 50,
      height: BARRIER.height + 50,
    };
    return (
      !corners.some((p, i) => segmentHitsRect(p, corners[(i + 1) % corners.length]!, barrier)) &&
      !pointInRect(center, barrier)
    );
  }

  private footprint(pose: Pose): Point[] {
    const front = this.config.length / 2 + (this.config.pusher?.depth ?? 0);
    const halfLength = this.config.length / 2;
    const frontHalf = this.config.pusher
      ? Math.max(this.config.pusher.width / 2, this.halfWidth)
      : this.halfWidth;
    return [
      { x: front, y: frontHalf },
      { x: -halfLength, y: this.halfWidth },
      { x: -halfLength, y: -this.halfWidth },
      { x: front, y: -frontHalf },
    ].map((corner) => this.toWorld(corner, pose));
  }

  /** Furthest safe centre x at this y: any rotation stays out of the far half and red band. */
  private maxX(y: number): number {
    const line = FIELD.midX - this.tuning.margin - this.radius;
    return y - this.radius < RAMP.y + RAMP.height
      ? Math.min(line, RED_START - this.tuning.margin - this.radius)
      : line;
  }

  private pathLength(from: Point, to: Point): number {
    const route = this.route(from, to);
    let total = 0,
      previous = from;
    for (const point of route) {
      total += distance(previous, point);
      previous = point;
    }
    return total;
  }

  /** Straight line, or around the barrier's open end when the two points are on either side. */
  private route(from: Point, to: Point): Point[] {
    const inflated = {
      x: BARRIER.x - this.halfWidth - 15,
      y: BARRIER.y - this.halfWidth - 15,
      width: BARRIER.width + 2 * (this.halfWidth + 15),
      height: BARRIER.height + 2 * (this.halfWidth + 15),
    };
    if (from.y < FIELD.midY === to.y < FIELD.midY || !segmentHitsRect(from, to, inflated))
      return [to];
    const clearance = BARRIER.height / 2 + this.halfWidth + 25;
    const side = (y: number) =>
      y < FIELD.midY ? Math.min(y, FIELD.midY - clearance) : Math.max(y, FIELD.midY + clearance);
    const first = { x: BYPASS_X, y: side(from.y) };
    const second = { x: BYPASS_X, y: side(to.y) };
    return distance(from, first) < 50 ? [second, to] : [first, second, to];
  }

  private pursue(now: number): Command {
    const task = this.task!;
    const plan = task.plan;
    const setPhase = (phase: Task["phase"]) => {
      task.phase = phase;
      task.phaseSince = now;
    };
    if (task.phase === "travel") {
      if (this.onApproach(plan)) setPhase("final");
      else if (distance(this.pose, plan.pre) > 25) return this.navigate(plan.pre, plan.aim);
      else setPhase("align");
    }
    if (task.phase === "align") {
      const error = normalizeDegrees(plan.aim - this.pose.heading);
      if (
        Math.abs(error) > Math.max(2, this.tuning.aimTolerance * 0.5) ||
        distance(this.pose, plan.pre) > 40
      ) {
        if (now - task.phaseSince > 2500) this.abandon(now, 2000);
        return distance(this.pose, plan.pre) > 40
          ? this.navigate(plan.pre, plan.aim)
          : this.face(plan.aim);
      }
      setPhase("final");
    }
    if (now - task.phaseSince > 3000) {
      this.abandon(now, 3000);
      return STOP;
    }
    return plan.kind === "shoot" ? this.line(now) : this.push(now);
  }

  /** Already lined up somewhere between the pre-staging point and the ball. */
  private onApproach(plan: Plan): boolean {
    const dir = { x: Math.cos(plan.aim * DEG), y: Math.sin(plan.aim * DEG) };
    const toStage = { x: plan.stage.x - this.pose.x, y: plan.stage.y - this.pose.y };
    const along = toStage.x * dir.x + toStage.y * dir.y;
    const across = toStage.x * dir.y - toStage.y * dir.x;
    return (
      along >= -10 &&
      along <= distance(plan.pre, plan.stage) + 10 &&
      Math.abs(across) < 20 &&
      Math.abs(normalizeDegrees(plan.aim - this.pose.heading)) <= this.tuning.aimTolerance
    );
  }

  /** Final shooting approach steered by the live vision fix rather than dead reckoning. */
  private line(now: number): Command {
    const task = this.task!;
    const shooter = this.config.shooter!;
    if (this.orange && !this.orange.reliable) {
      this.abandon(now, 500);
      return STOP;
    }
    const live =
      this.orange?.reliable && distance(this.orange, task.target) < 110
        ? this.orange.local
        : undefined;
    const ball = live ?? this.toLocal(task.target);
    const ahead = ball.x - shooter.x;
    const offset = ball.y - shooter.y;
    if (ahead < -5 || Math.abs(offset) > 55) {
      this.abandon(now, 1500);
      return STOP;
    }
    const aimError = normalizeDegrees(task.plan.aim - this.pose.heading);
    const reach = Math.hypot(ahead, offset);
    const purpleReach = this.purple
      ? Math.hypot(this.purple.local.x - shooter.x, this.purple.local.y - shooter.y)
      : Infinity;
    if (purpleReach <= shooter.range) {
      // The shooter fires the nearest ball; never risk launching our own purple away.
      this.abandon(now, 2500);
      return STOP;
    }
    if (
      live &&
      reach <= shooter.range - 8 &&
      Math.abs(offset) <= 35 &&
      Math.abs(aimError) <= this.tuning.aimTolerance
    ) {
      task.phase = "fire";
      task.phaseSince = now;
      task.shooterStart = this.invoke("Motor.GetCount", [shooter.port], now);
      return this.fire(now);
    }
    const forward = clamp((ahead - 40) * 4, -0.3 * this.maxSpeed, 0.45 * this.maxSpeed);
    const lateral =
      this.config.drive === "differential"
        ? 0
        : clamp(offset * 4, -0.3 * this.maxSpeed, 0.3 * this.maxSpeed);
    if (live && this.pinned(task, ball, forward, lateral, now)) {
      this.startRecovery(now);
      return STOP;
    }
    if (this.config.drive !== "differential")
      return { forward, lateral, turn: this.turnToward(task.plan.aim) };
    // A differential base can only fix a lateral offset by steering within the aim tolerance.
    const lean = clamp(
      (Math.atan2(offset, Math.max(ball.x, 1)) / DEG) * 0.8,
      -this.tuning.aimTolerance,
      this.tuning.aimTolerance,
    );
    return { forward, lateral: 0, turn: this.turnToward(task.plan.aim + lean) };
  }

  /**
   * The live ball fix should move as the robot does; if it does not, the robot is pressed
   * against something (often a ball wedged on the barrier) and its encoders are lying.
   */
  private pinned(task: Task, ball: Point, forward: number, lateral: number, now: number): boolean {
    const squeeze = task.squeeze;
    if (!squeeze || Math.hypot(forward, lateral) < 40) {
      task.squeeze = { since: now, ball, expected: 0 };
      return false;
    }
    squeeze.expected += (Math.hypot(forward, lateral) * this.tuning.periodMs) / 1000;
    if (now - squeeze.since < 600) return false;
    task.squeeze = { since: now, ball, expected: 0 };
    return squeeze.expected > 30 && distance(squeeze.ball, ball) < 0.3 * squeeze.expected;
  }

  private fire(now: number): Command {
    const task = this.task!;
    const shooter = this.config.shooter!;
    const stroke = this.invoke("Motor.GetCount", [shooter.port], now) - (task.shooterStart ?? 0);
    if (stroke < shooter.stroke + 5 && now - task.phaseSince < 1000) return STOP;
    this.memory = this.memory.filter((ball) => ball !== task.target);
    this.abandon(now, 1500);
    return STOP;
  }

  private push(now: number): Command {
    const task = this.task!;
    if (this.pose.x >= this.maxX(this.pose.y) - 15) {
      // Let the ball roll on; leave it alone while it does.
      this.abandon(now, 3000);
      return { forward: -0.3 * this.maxSpeed, lateral: 0, turn: 0 };
    }
    return { forward: this.maxSpeed, lateral: 0, turn: this.turnToward(task.plan.aim) };
  }

  private patrol(now: number): Command {
    if (this.orange && !this.orange.reliable && Math.abs(this.orange.bearing) > 8)
      return this.face(this.pose.heading + this.orange.bearing);
    const points = this.patrolPoints();
    const target = points[this.search.index % points.length]!;
    const scans = this.vision ? [0, 65, -65] : [0];
    if (now - this.search.since > 12_000) this.nextWaypoint(now);
    if (distance(this.pose, target) > 40) return this.navigate(target, 0);
    const heading = scans[this.search.scan]!;
    if (Math.abs(normalizeDegrees(heading - this.pose.heading)) > 6) return this.face(heading);
    if (!this.vision) {
      // A blind robot sweeps its lane, pushing whatever is ahead toward the centre line.
      if (this.pose.x < this.maxX(this.pose.y) - 15)
        return { forward: this.maxSpeed, lateral: 0, turn: this.turnToward(0) };
      this.nextWaypoint(now);
      return STOP;
    }
    this.search.scan++;
    if (this.search.scan >= scans.length) this.nextWaypoint(now);
    return STOP;
  }

  private nextWaypoint(now: number): void {
    this.search = { index: this.search.index + 1, scan: 0, since: now };
  }

  private patrolPoints(): Point[] {
    const far = (y: number) => ({ x: Math.max(300, this.maxX(y) - 60), y });
    const upper = [{ x: 300, y: 860 }, far(870)];
    const lower = [{ x: 300, y: FIELD.height - 860 }, far(FIELD.height - 870)];
    if (!this.vision) {
      const rows = (ys: number[]) => ys.map((y) => ({ x: 200, y }));
      const top = rows([700, 860, 1000]);
      const bottom = rows([150, 300, 440]);
      return this.lane === "upper" ? top : this.lane === "lower" ? bottom : [...top, ...bottom];
    }
    return this.lane === "upper" ? upper : this.lane === "lower" ? lower : [...upper, ...lower];
  }

  // ── Motion ──────────────────────────────────────────────────────────────────────────────

  private turnToward(heading: number): number {
    const error = normalizeDegrees(heading - this.pose.heading) * DEG;
    const limit = 3 * this.tuning.speed;
    return clamp(error * 4, -limit, limit);
  }

  private face(heading: number): Command {
    return { forward: 0, lateral: 0, turn: this.turnToward(heading) };
  }

  private navigate(goal: Point, finalHeading: number): Command {
    let next = this.route(this.pose, goal)[0]!;
    next = this.avoidPurple(next);
    const local = this.toLocal(next);
    const gap = Math.hypot(local.x, local.y);
    const speed = Math.min(this.maxSpeed, gap * 3 + 40);
    if (this.config.drive !== "differential")
      return {
        forward: (local.x / Math.max(gap, 1)) * speed,
        lateral: (local.y / Math.max(gap, 1)) * speed,
        turn: this.turnToward(finalHeading),
      };
    const bearing = Math.atan2(local.y, local.x) / DEG;
    // Close to the goal, reverse instead of turning around for a short hop backwards.
    if (gap < 120 && Math.abs(bearing) > 120)
      return {
        forward: -speed * 0.6,
        lateral: 0,
        turn: this.turnToward(this.pose.heading + normalizeDegrees(bearing + 180)),
      };
    if (Math.abs(bearing) > 35) return this.face(this.pose.heading + bearing);
    return {
      forward: speed * Math.cos(bearing * DEG),
      lateral: 0,
      turn: this.turnToward(this.pose.heading + bearing),
    };
  }

  /** Step around a remembered purple ball lying on the way; purple in our half is worth −2. */
  private avoidPurple(next: Point): Point {
    const path = { x: next.x - this.pose.x, y: next.y - this.pose.y };
    const length = Math.hypot(path.x, path.y);
    if (length < 1) return next;
    const dir = { x: path.x / length, y: path.y / length };
    for (const ball of this.memory) {
      if (ball.kind !== "purple") continue;
      const along = (ball.x - this.pose.x) * dir.x + (ball.y - this.pose.y) * dir.y;
      const across = -(ball.x - this.pose.x) * dir.y + (ball.y - this.pose.y) * dir.x;
      const clearance = this.halfWidth + FIELD.ballRadius + 25;
      if (along < 0 || along > Math.min(length, 350) || Math.abs(across) > clearance) continue;
      const side = across >= 0 ? -1 : 1;
      const detour = {
        x: ball.x - dir.y * side * (clearance + 20),
        y: ball.y + dir.x * side * (clearance + 20),
      };
      if (this.feasible(detour, this.pose.heading)) return detour;
    }
    return next;
  }

  /** Never command motion that could carry the footprint across the centre line or into red. */
  private guard(command: Command): Command {
    if (this.color && this.read(this.color, 0, this.last!) === 5) {
      // Red under the front sensor: back straight away from the ramp top whatever the plan.
      const c = Math.cos(this.pose.heading * DEG);
      return { forward: c > 0 ? -0.5 * this.maxSpeed : 0.5 * this.maxSpeed, lateral: 0, turn: 0 };
    }
    const lookahead = 0.25;
    const limit = this.maxX(this.pose.y);
    const allowed = this.pose.x > limit ? -80 : (limit - this.pose.x) / lookahead;
    const c = Math.cos(this.pose.heading * DEG),
      s = Math.sin(this.pose.heading * DEG);
    const vx = command.forward * c - command.lateral * s;
    if (vx <= allowed) return command;
    if (this.config.drive === "differential") {
      if (Math.abs(c) < 0.15) return command;
      return { ...command, forward: allowed / c };
    }
    const vy = command.forward * s + command.lateral * c;
    return { ...command, forward: allowed * c + vy * s, lateral: -allowed * s + vy * c };
  }

  private drive(command: Command, now: number): void {
    const desired = this.config.wheels.map((wheel) => {
      const row = wheelRow(wheel);
      const mmPerSecond =
        row[0] * command.forward + row[1] * command.lateral + row[2] * command.turn;
      // 100% power turns the shaft twice per second.
      return (
        (mmPerSecond / (Math.PI * wheel.diameter)) *
        wheel.gearRatio *
        50 *
        (wheel.inverted ? -1 : 1)
      );
    });
    const scale = Math.max(1, ...desired.map((value) => Math.abs(value) / 100));
    this.config.wheels.forEach((wheel, index) =>
      this.invoke("Motor.Start", [wheel.port, Math.round(desired[index]! / scale)], now),
    );
    const shooter = this.config.shooter;
    if (shooter) {
      if (this.task?.phase === "fire") this.invoke("Motor.Start", [shooter.port, 100], now);
      else this.invoke("Motor.Stop", [shooter.port, true], now);
    }
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}
/** Liang–Barsky clip; returns whether the segment touches the rectangle. */
function segmentHitsRect(a: Point, b: Point, rect: Rect): boolean {
  let t0 = 0,
    t1 = 1;
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const checks: Array<[number, number]> = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.width - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.height - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}
