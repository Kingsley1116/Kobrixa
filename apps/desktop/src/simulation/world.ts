import { Box, Circle, Vec2, World, type Body, type Contact, type Fixture } from "planck";
import { PreviewRuntime } from "../preview/runtime.js";
import type { PreviewButton, PreviewPort } from "../preview/virtual-device.js";
import {
  DEFAULT_PIXY2_CONFIG,
  SIMULATION_TICK_MS,
  type PreparedSimulation,
  type RobotConfig,
  type SimulationBall,
  type SimulationEvent,
  type SimulationPose,
  type SimulationScene,
  type SimulationSensor,
  type SimulationSnapshot,
  type SimulationTeam,
} from "../shared/simulator.js";
import { SimulationDevice, type SimulationSensorReading } from "./device.js";
import { SimulationMailboxBus } from "./mailbox.js";
import { BuiltinOpponent } from "./opponent.js";
import { ballOccludesCamera, pixy2Blocks } from "./pixy2-camera.js";
import { driveVelocity, FIELD, normalizeDegrees, validateScene } from "./scene.js";
import { floorHeight, intersectRampSegment, rampHeight, type RampGeometry } from "./terrain.js";

export { driveVelocity, normalizeDegrees } from "./scene.js";

const DEG = Math.PI / 180;
const DT = SIMULATION_TICK_MS / 1000;
const ROBOT_HEIGHT = 200;
const INSTRUCTIONS_PER_TICK = 1000;
const MAX_EVENTS = 250;
const MAX_TRACE_POINTS = 2400;
type Surface =
  | { kind: "wall" | "barrier"; height: number }
  | { kind: "ramp"; ramp: RampGeometry }
  | { kind: "robot"; id: string; height: number }
  | { kind: "ball"; id: string };
interface RobotState {
  config: RobotConfig;
  body: Body;
  device: SimulationDevice;
  runtime?: PreviewRuntime;
  distance: number;
  trace: Array<{ x: number; y: number }>;
  shotStroke: number;
  lastShot: number;
  opponent?: BuiltinOpponent;
  violation: boolean;
}
interface BallState {
  initial: SimulationBall;
  body: Body;
  z: number;
  vz: number;
  previous: { x: number; y: number; z: number };
  moved: boolean;
  out: boolean;
  touching?: SimulationTeam;
  lastTouch?: SimulationTeam;
}
const compareId = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
/** The only owner of physics and virtual time. Wall-clock time never enters this class. */
export class SimulationWorld {
  readonly scene: SimulationScene;
  private readonly physics = new World({ gravity: Vec2(0, 0), allowSleep: false });
  private readonly robots = new Map<string, RobotState>();
  private readonly balls = new Map<string, BallState>();
  private readonly mailbox: SimulationMailboxBus;
  private readonly events: SimulationEvent[] = [];
  private readonly collisionTimes = new Map<string, number>();
  private readonly sensorCache = new Map<string, SimulationSensorReading>();
  private nextEvent = 1;
  private state: SimulationSnapshot["status"] = "ready";
  private elapsed = 0;
  private selected: string | undefined;
  private lastScore: Record<SimulationTeam, number> = { A: 0, B: 0 };
  private practiceContinuation = false;
  private durationReached = false;
  private violationPending = false;

  constructor(scene: SimulationScene, prepared: PreparedSimulation = { programs: {} }) {
    this.scene = validateScene(scene);
    this.mailbox = new SimulationMailboxBus(this.scene.robots);
    this.createField();
    for (const config of [...this.scene.robots].sort((a, b) => compareId(a.id, b.id))) {
      const body = this.physics.createDynamicBody({
        position: Vec2(config.pose.x / 1000, config.pose.y / 1000),
        angle: config.pose.heading * DEG,
        bullet: true,
        angularDamping: 0,
        linearDamping: 0,
        active: config.controller.kind !== "disabled",
      });
      const data: Surface = { kind: "robot", id: config.id, height: ROBOT_HEIGHT };
      body.createFixture(Box(config.length / 2000, config.width / 2000), {
        density: 1,
        friction: 0.5,
        restitution: 0.05,
        userData: data,
      });
      if (config.pusher)
        body.createFixture(
          Box(
            config.pusher.depth / 2000,
            config.pusher.width / 2000,
            Vec2((config.length + config.pusher.depth) / 2000, 0),
          ),
          {
            density: 0,
            friction: 0.5,
            restitution: 0.1,
            userData: data,
          },
        );
      body.setMassData({
        mass: config.mass,
        center: Vec2(0, 0),
        I: (config.mass * (config.width ** 2 + config.length ** 2)) / 12_000_000,
      });
      const program =
        config.controller.kind === "program"
          ? prepared.programs[config.controller.entry]
          : undefined;
      if (config.controller.kind === "program" && !program)
        throw new Error(`No compiled program for ${config.name}: ${config.controller.entry}`);
      const device = new SimulationDevice({
        robot: config,
        mailbox: this.mailbox,
        readSensor: (sensor, mode) => this.readSensor(config.id, sensor, mode),
        ...(program ? { files: program.files } : {}),
        ...(program?.ir.program.runtimeDirectory
          ? { runtimeDirectory: program.ir.program.runtimeDirectory }
          : {}),
      });
      const robot: RobotState = {
        config,
        body,
        device,
        distance: 0,
        trace: [{ x: config.pose.x, y: config.pose.y }],
        shotStroke: 0,
        lastShot: -1000,
        violation: false,
      };
      this.robots.set(config.id, robot);
      if (config.controller.kind === "builtin")
        robot.opponent = new BuiltinOpponent(config, device, {
          level: config.controller.level ?? "standard",
          seed: this.robotSeed(config.id),
          teammateActive: this.scene.robots.some(
            (other) =>
              other.id !== config.id &&
              other.team === config.team &&
              other.controller.kind !== "disabled",
          ),
        });
      if (program)
        robot.runtime = new PreviewRuntime(program.ir, device, {
          clock: "external",
          sessionInstructionLimit: null,
          randomSeed: this.robotSeed(config.id),
        });
    }
    for (const ball of [...this.scene.balls].sort((a, b) => compareId(a.id, b.id))) {
      const body = this.physics.createDynamicBody({
        position: Vec2(ball.x / 1000, ball.y / 1000),
        bullet: true,
        linearDamping: 0.6,
      });
      body.createFixture(Circle(FIELD.ballRadius / 1000), {
        density: 2.15,
        friction: 0.2,
        restitution: 0.55,
        userData: { kind: "ball", id: ball.id } satisfies Surface,
      });
      this.balls.set(ball.id, {
        initial: ball,
        body,
        z: Math.max(ball.z, floorHeight(ball.x, ball.y) + FIELD.ballRadius),
        vz: 0,
        previous: {
          x: ball.x,
          y: ball.y,
          z: Math.max(ball.z, floorHeight(ball.x, ball.y) + FIELD.ballRadius),
        },
        moved: !(
          ball.central &&
          ball.kind === "orange" &&
          Math.abs(ball.x - FIELD.midX) < 0.01 &&
          Math.abs(ball.y - FIELD.midY) < 0.01 &&
          Math.abs(ball.z - (FIELD.barrier.elevation + FIELD.ballRadius)) < 0.01
        ),
        out: false,
      });
    }
    this.physics.on("pre-solve", (contact) => {
      this.filterContact(contact);
      if (contact.isEnabled()) this.recordContact(contact);
    });
    this.selected = this.scene.robots[0]?.id;
    this.lastScore = this.score();
    this.event("info", "WRO Double Tennis 2026 · simplified local physics. Lower score wins.");
  }

  get status(): SimulationSnapshot["status"] {
    return this.state;
  }
  get timeMs(): number {
    return this.elapsed;
  }
  get selectedRobotId(): string | undefined {
    return this.selected;
  }

  run(): void {
    if (this.state !== "ready" && this.state !== "paused") return;
    this.continueAfterViolation();
    for (const robot of this.robots.values()) robot.runtime?.resume();
    this.state = "running";
  }
  private continueAfterViolation(): void {
    if (this.violationPending) {
      this.practiceContinuation = true;
      this.violationPending = false;
      this.event("info", "Continuing as training after a rule violation. Scores are provisional.");
    }
  }
  pause(): void {
    if (this.state !== "running" && this.state !== "ready") return;
    for (const robot of this.robots.values()) robot.runtime?.pause();
    this.state = "paused";
  }
  stop(): void {
    if (["stopped", "completed", "error"].includes(this.state)) return;
    this.halt("stopped");
  }
  select(robotId: string): void {
    if (!this.robots.has(robotId)) throw new Error(`Unknown robot ${robotId}.`);
    this.selected = robotId;
  }
  buttons(robotId: string, buttons: PreviewButton[]): void {
    const robot = this.robots.get(robotId);
    if (!robot) throw new Error(`Unknown robot ${robotId}.`);
    robot.device.setInputs({ buttons });
  }
  /** One shared 10 ms tick. Paused stepping advances every robot fairly. */
  step(): void {
    if (["stopped", "completed", "error"].includes(this.state)) return;
    const running = this.state === "running";
    if (!running) {
      this.continueAfterViolation();
      for (const robot of this.robots.values()) robot.runtime?.resume();
      this.state = "running";
    }
    this.tick();
    if (!running && this.state !== "completed" && this.state !== "error") {
      for (const robot of this.robots.values()) robot.runtime?.pause();
      this.state = "paused";
    }
  }
  advance(ticks = 1): void {
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > 1000)
      throw new Error("Invalid simulation tick count.");
    for (let tick = 0; tick < ticks && this.state === "running"; tick++) this.tick();
  }

  snapshot(): SimulationSnapshot {
    const selected = this.selected ? this.robots.get(this.selected) : undefined;
    return {
      status: this.state,
      timeMs: this.elapsed,
      robots: [...this.robots.values()].map((robot) => ({
        id: robot.config.id,
        pose: this.pose(robot),
        elevation: this.robotElevation(robot),
        distance: robot.distance,
        trace: robot.trace.map((point) => ({ ...point })),
        status: robot.runtime?.status ?? robot.config.controller.kind,
      })),
      balls: [...this.balls.values()].map((ball) => ({
        ...ball.initial,
        x: ball.body.getPosition().x * 1000,
        y: ball.body.getPosition().y * 1000,
        z: ball.z,
      })),
      score: this.score(),
      events: this.events.map((event) => ({ ...event })),
      practiceContinuation: this.practiceContinuation,
      ...(this.selected ? { selectedRobotId: this.selected } : {}),
      ...(selected
        ? {
            debug: selected.runtime?.getSnapshot() ?? {
              status: this.state,
              device: selected.device.snapshot(),
              globals: {},
              locals: {},
              callStack: [],
              instructions: 0,
              elapsedMs: this.elapsed,
              threadCount: 0,
            },
          }
        : {}),
    };
  }

  private tick(): void {
    try {
      this.sensorCache.clear();
      this.mailbox.commitTick();
      // All sensor reads see one immutable-by-convention pose snapshot until physics.step below.
      for (const robot of this.robots.values()) {
        if (robot.runtime) {
          const state = robot.runtime.executeAt(this.elapsed, INSTRUCTIONS_PER_TICK);
          if (state.status === "error") {
            this.event(
              "error",
              state.error?.message ?? "Robot program failed.",
              robot.config.id,
              state.error?.span,
            );
            this.halt("error");
            return;
          }
        } else robot.opponent?.update(this.elapsed);
      }
      const previous = new Map<string, SimulationPose>();
      const shaftTravel = new Map<string, Record<PreviewPort, number>>();
      for (const robot of this.robots.values()) {
        previous.set(robot.config.id, this.pose(robot));
        robot.device.advance(SIMULATION_TICK_MS);
        const deltas = robot.device.consumeShaftDeltas();
        shaftTravel.set(robot.config.id, deltas);
        const velocity = driveVelocity(robot.config, deltas);
        const angle = robot.body.getAngle();
        robot.body.setLinearVelocity(
          Vec2(
            (velocity.x * Math.cos(angle) - velocity.y * Math.sin(angle)) / 1000,
            (velocity.x * Math.sin(angle) + velocity.y * Math.cos(angle)) / 1000,
          ),
        );
        robot.body.setAngularVelocity(velocity.angular);
        this.updateShooter(robot, deltas);
      }
      for (const ball of this.balls.values()) {
        const position = ball.body.getPosition();
        ball.previous = { x: position.x * 1000, y: position.y * 1000, z: ball.z };
        this.advanceHeight(ball);
      }
      this.physics.step(DT, 8, 3);
      this.elapsed += SIMULATION_TICK_MS;
      this.sensorCache.clear();
      for (const robot of this.robots.values()) {
        const pose = this.pose(robot),
          before = previous.get(robot.config.id)!;
        if (robot.config.wheelTraction === "grip")
          this.constrainWheelTravel(robot, before, pose, shaftTravel.get(robot.config.id)!);
        robot.distance += Math.hypot(pose.x - before.x, pose.y - before.y);
        if (
          this.elapsed % 50 === 0 &&
          Math.hypot(pose.x - robot.trace.at(-1)!.x, pose.y - robot.trace.at(-1)!.y) > 1
        ) {
          robot.trace.push({ x: pose.x, y: pose.y });
          if (robot.trace.length > MAX_TRACE_POINTS) robot.trace.splice(1, 1);
        }
        this.checkRobotZone(robot);
      }
      this.updateBalls();
      this.sensorCache.clear();
      this.updateScore();
      if (
        this.elapsed >= this.scene.durationMs &&
        !this.durationReached &&
        this.state !== "paused"
      ) {
        this.durationReached = true;
        if (this.scene.mode === "match" && !this.practiceContinuation) {
          const score = this.score();
          this.event(
            "score",
            score.A === score.B
              ? `Time expired: draw (${score.A}–${score.B}).`
              : `Time expired: team ${score.A < score.B ? "A" : "B"} wins (${score.A}–${score.B}; lower wins).`,
          );
          this.halt("completed");
        } else {
          this.practiceContinuation = true;
          this.event(
            "info",
            "Match time elapsed. Practice continues; displayed scores are provisional.",
          );
        }
      }
    } catch (error) {
      this.event("error", error instanceof Error ? error.message : String(error));
      this.halt("error");
    }
  }

  private constrainWheelTravel(
    robot: RobotState,
    before: SimulationPose,
    after: SimulationPose,
    attempted: Record<PreviewPort, number>,
  ): void {
    const angle = before.heading * DEG;
    const dx = after.x - before.x,
      dy = after.y - before.y;
    const forward = dx * Math.cos(angle) + dy * Math.sin(angle);
    const lateral = -dx * Math.sin(angle) + dy * Math.cos(angle);
    const turn = normalizeDegrees(after.heading - before.heading) * DEG;
    for (const wheel of robot.config.wheels) {
      const rolling = wheel.angle * DEG;
      const distance =
        forward * Math.cos(rolling) +
        lateral * Math.sin(rolling) +
        turn * (-wheel.y * Math.cos(rolling) + wheel.x * Math.sin(rolling));
      const measured =
        ((distance * 360 * wheel.gearRatio) / (Math.PI * wheel.diameter)) *
        (wheel.inverted ? -1 : 1);
      const requested = attempted[wheel.port];
      // Contacts may push a robot sideways/backwards. Passive displacement is
      // not extra commanded motor travel in this simplified high-grip model.
      const delivered =
        Math.sign(requested) *
        Math.min(Math.abs(requested), Math.max(0, measured * Math.sign(requested)));
      robot.device.constrainShaftTravel(wheel.port, requested, delivered);
    }
  }

  private createField(): void {
    const boundary = this.physics.createBody();
    const wall = (x: number, y: number, width: number, height: number) =>
      boundary.createFixture(Box(width / 2000, height / 2000, Vec2(x / 1000, y / 1000)), {
        friction: 0.3,
        restitution: 0.55,
        userData: { kind: "wall", height: FIELD.wallHeight } satisfies Surface,
      });
    wall(-15, FIELD.midY, 30, FIELD.height + 60);
    wall(FIELD.width + 15, FIELD.midY, 30, FIELD.height + 60);
    wall(FIELD.midX, -15, FIELD.width + 60, 30);
    wall(FIELD.midX, FIELD.height + 15, FIELD.width + 60, 30);
    const barrier = FIELD.barrier;
    boundary.createFixture(
      Box(
        barrier.width / 2000,
        barrier.height / 2000,
        Vec2((barrier.x + barrier.width / 2) / 1000, (barrier.y + barrier.height / 2) / 1000),
      ),
      {
        friction: 0.3,
        restitution: 0.5,
        userData: { kind: "barrier", height: barrier.elevation } satisfies Surface,
      },
    );
    // The footprint supplies continuous collision detection at the vertical
    // faces. pre-solve lets bodies enter the low edge and travel on the slope;
    // it only keeps contacts whose height intersects the solid wedge.
    for (const ramp of FIELD.ramps)
      boundary.createFixture(
        Box(
          ramp.width / 2000,
          ramp.height / 2000,
          Vec2((ramp.x + ramp.width / 2) / 1000, (ramp.y + ramp.height / 2) / 1000),
        ),
        {
          friction: 0.3,
          restitution: 0.5,
          userData: { kind: "ramp", ramp } satisfies Surface,
        },
      );
  }
  private robotElevation(robot: RobotState): number {
    const position = robot.body.getPosition();
    // One support height under the chassis centre, deliberately without pitch,
    // suspension or wheel climbing over a vertical step.
    return floorHeight(position.x * 1000, position.y * 1000);
  }
  private pose(robot: RobotState): SimulationPose {
    const position = robot.body.getPosition();
    return {
      x: position.x * 1000,
      y: position.y * 1000,
      heading: normalizeDegrees(robot.body.getAngle() / DEG),
    };
  }
  private robotSeed(id: string): number {
    let seed = this.scene.seed;
    for (const char of id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
    return seed;
  }
  private halt(state: SimulationSnapshot["status"]): void {
    this.state = state;
    for (const robot of this.robots.values()) {
      robot.runtime?.stop();
      robot.device.invoke("Motor.Stop", ["ABCD", true], this.elapsed);
      robot.body.setLinearVelocity(Vec2(0, 0));
      robot.body.setAngularVelocity(0);
    }
  }
  private event(
    kind: SimulationEvent["kind"],
    message: string,
    robotId?: string,
    span?: SimulationEvent["span"],
  ): void {
    this.events.push({
      id: this.nextEvent++,
      timeMs: this.elapsed,
      kind,
      message,
      ...(robotId ? { robotId } : {}),
      ...(span ? { span } : {}),
    });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  private filterContact(contact: Contact): void {
    const a = contact.getFixtureA().getUserData() as Surface;
    const b = contact.getFixtureB().getUserData() as Surface;
    const ramp = a.kind === "ramp" ? a : b.kind === "ramp" ? b : undefined;
    if (ramp) {
      const other = a === ramp ? b : a;
      if (other.kind !== "ball" && other.kind !== "robot") return;
      const object = other.kind === "ball" ? this.balls.get(other.id)! : this.robots.get(other.id)!;
      const position = object.body.getPosition();
      const x = position.x * 1000,
        y = position.y * 1000;
      const inside =
        x >= ramp.ramp.x &&
        x <= ramp.ramp.x + ramp.ramp.width &&
        y >= ramp.ramp.y &&
        y <= ramp.ramp.y + ramp.ramp.height;
      const bottom =
        other.kind === "ball"
          ? this.balls.get(other.id)!.z - FIELD.ballRadius
          : this.robotElevation(this.robots.get(other.id)!);
      // At the low edge the surface is at floor level. Side/high-face entries
      // must collide instead of snapping a body up onto the ramp. Bodies already
      // supported by the top can move downhill or leave the edge freely.
      const previous = other.kind === "ball" ? this.balls.get(other.id)!.previous : undefined;
      const supported =
        !previous ||
        (previous.x >= ramp.ramp.x &&
          previous.x <= ramp.ramp.x + ramp.ramp.width &&
          previous.y >= ramp.ramp.y &&
          previous.y <= ramp.ramp.y + ramp.ramp.height);
      if ((inside && supported) || bottom >= rampHeight(ramp.ramp, x) - 0.01)
        contact.setEnabled(false);
      return;
    }
    if (a.kind !== "ball" && b.kind !== "ball") return;
    const ball = this.balls.get(a.kind === "ball" ? a.id : (b as { id: string }).id)!;
    const other = a.kind === "ball" ? b : a;
    if (ball.out) {
      contact.setEnabled(false);
      return;
    }
    if (other.kind === "ball") {
      const second = this.balls.get(other.id)!;
      if (second.out || Math.abs(ball.z - second.z) >= FIELD.ballRadius * 2)
        contact.setEnabled(false);
    } else if (other.kind !== "ramp") {
      const bottom = other.kind === "robot" ? this.robotElevation(this.robots.get(other.id)!) : 0;
      if (
        ball.z - FIELD.ballRadius >= bottom + other.height - 0.01 ||
        ball.z + FIELD.ballRadius <= bottom
      )
        contact.setEnabled(false);
    }
  }
  private recordContact(contact: Contact): void {
    const data = [
      contact.getFixtureA().getUserData(),
      contact.getFixtureB().getUserData(),
    ] as Surface[];
    const robot = data.find((item) => item.kind === "robot");
    if (!robot || robot.kind !== "robot") return;
    const other = data.find((item) => item !== robot)!;
    if (other.kind === "ball") return;
    const key = [robot.id, other.kind === "robot" ? other.id : other.kind].sort().join(":");
    if (this.elapsed - (this.collisionTimes.get(key) ?? -2000) < 1000) return;
    this.collisionTimes.set(key, this.elapsed);
    this.event(
      "collision",
      `${this.robots.get(robot.id)!.config.name} contacted ${other.kind === "robot" ? other.id : other.kind}.`,
      robot.id,
    );
  }
  private advanceHeight(ball: BallState): void {
    if (ball.out || (!ball.moved && ball.initial.central)) return;
    const pos = ball.body.getPosition();
    const ground = floorHeight(pos.x * 1000, pos.y * 1000) + FIELD.ballRadius;
    if (ball.z > ground + 0.01 || ball.vz > 0) {
      ball.vz -= 9810 * DT;
      ball.z += ball.vz * DT;
      ball.body.setLinearDamping(0.05);
      if (ball.z < ground) {
        ball.z = ground;
        ball.vz = ball.vz < -500 ? -ball.vz * 0.35 : 0;
      }
    } else {
      ball.z = ground;
      ball.vz = 0;
    }
    // Landing while moving downhill is still rolling in this tick. Applying
    // gravity only in the else branch makes a ball coast after its first step.
    if (ball.vz === 0 && Math.abs(ball.z - ground) < 0.01) {
      ball.body.setLinearDamping(0.6);
      // Ramp gravity applies only to rolling balls. It deliberately does not model robot pitch.
      for (const ramp of FIELD.ramps)
        if (
          pos.x * 1000 >= ramp.x &&
          pos.x * 1000 <= ramp.x + ramp.width &&
          pos.y * 1000 >= ramp.y &&
          pos.y * 1000 <= ramp.y + ramp.height
        ) {
          const velocity = ball.body.getLinearVelocity();
          ball.body.setLinearVelocity(
            Vec2(
              velocity.x - ((ramp.direction * 9.81 * ramp.elevation) / ramp.width) * DT,
              velocity.y,
            ),
          );
        }
    }
  }
  private constrainBallRampEntry(ball: BallState): void {
    const position = ball.body.getPosition();
    const from = { ...ball.previous, z: ball.previous.z - FIELD.ballRadius };
    const to = { x: position.x * 1000, y: position.y * 1000, z: ball.z - FIELD.ballRadius };
    for (const ramp of FIELD.ramps) {
      const hit = intersectRampSegment(ramp, from, to);
      if (hit === undefined) continue;
      const x = from.x + (to.x - from.x) * hit;
      const y = from.y + (to.y - from.y) * hit;
      const z = from.z + (to.z - from.z) * hit;
      // Entry on the slope is a landing/low-edge climb. Entry below its top
      // through a vertical face is solid, even if a driven heavy chassis has
      // squeezed the 2.7 g ball across the face within one Planck step.
      if (z >= rampHeight(ramp, x) - 0.01) continue;
      const normal =
        Math.abs(x - ramp.x) < 0.01 && to.x > from.x
          ? Vec2(-1, 0)
          : Math.abs(x - ramp.x - ramp.width) < 0.01 && to.x < from.x
            ? Vec2(1, 0)
            : Math.abs(y - ramp.y) < 0.01 && to.y > from.y
              ? Vec2(0, -1)
              : Math.abs(y - ramp.y - ramp.height) < 0.01 && to.y < from.y
                ? Vec2(0, 1)
                : undefined;
      if (!normal) continue;
      ball.body.setTransform(
        Vec2(
          (x + normal.x * (FIELD.ballRadius + 1)) / 1000,
          (y + normal.y * (FIELD.ballRadius + 1)) / 1000,
        ),
        ball.body.getAngle(),
      );
      const velocity = ball.body.getLinearVelocity();
      const inward = Vec2.dot(velocity, normal);
      if (inward < 0)
        ball.body.setLinearVelocity(
          Vec2(velocity.x - 1.5 * inward * normal.x, velocity.y - 1.5 * inward * normal.y),
        );
      break;
    }
  }
  private updateBalls(): void {
    for (const ball of this.balls.values()) {
      delete ball.touching;
      this.constrainBallRampEntry(ball);
      const pos = ball.body.getPosition(),
        x = pos.x * 1000,
        y = pos.y * 1000;
      if (
        !ball.moved &&
        (Math.hypot(x - ball.initial.x, y - ball.initial.y) > 1 ||
          Math.abs(ball.z - ball.initial.z) > 1)
      )
        ball.moved = true;
      if (
        !ball.out &&
        (x < -FIELD.ballRadius ||
          x > FIELD.width + FIELD.ballRadius ||
          y < -FIELD.ballRadius ||
          y > FIELD.height + FIELD.ballRadius)
      ) {
        const responsible = ball.lastTouch ?? (ball.initial.x <= FIELD.midX ? "A" : "B");
        const returnTeam =
          ball.initial.kind === "orange" ? responsible : responsible === "A" ? "B" : "A";
        const returned = this.returnCorner(returnTeam, y < FIELD.midY);
        ball.body.setTransform(Vec2(returned.x / 1000, returned.y / 1000), 0);
        ball.body.setLinearVelocity(Vec2(0, 0));
        ball.body.setAngularVelocity(0);
        ball.z = FIELD.ballRadius;
        ball.vz = 0;
        ball.moved = true;
        this.rulePause(
          `${ball.initial.id} left the field and was returned to team ${returnTeam}'s corner (${ball.initial.kind}).`,
        );
      }
      if (!ball.out) {
        const ground = floorHeight(x, y) + FIELD.ballRadius;
        // The low 2D ramp model raises rolling balls smoothly without teleporting projectiles.
        if (ball.z < ground && ball.vz <= 0) {
          ball.z = ground;
          ball.vz = 0;
        }
      }
    }
    for (let contact = this.physics.getContactList(); contact; contact = contact.getNext()) {
      if (!contact.isTouching() || !contact.isEnabled()) continue;
      const a = contact.getFixtureA().getUserData() as Surface,
        b = contact.getFixtureB().getUserData() as Surface;
      if (a.kind === "ball" && b.kind === "robot") {
        const ball = this.balls.get(a.id)!;
        ball.touching = ball.lastTouch = this.robots.get(b.id)!.config.team;
      }
      if (b.kind === "ball" && a.kind === "robot") {
        const ball = this.balls.get(b.id)!;
        ball.touching = ball.lastTouch = this.robots.get(a.id)!.config.team;
      }
    }
  }
  private updateShooter(robot: RobotState, deltas: Record<PreviewPort, number>): void {
    const shooter = robot.config.shooter;
    if (!shooter) return;
    const movement = deltas[shooter.port];
    robot.shotStroke =
      movement > 0 ? robot.shotStroke + movement : movement < 0 ? 0 : robot.shotStroke;
    if (robot.shotStroke < shooter.stroke) return;
    robot.shotStroke %= shooter.stroke;
    if (this.elapsed - robot.lastShot < 150) return;
    robot.lastShot = this.elapsed;
    const origin = robot.body.getWorldPoint(Vec2(shooter.x / 1000, shooter.y / 1000));
    const candidates = [...this.balls.values()]
      .filter(
        (ball) =>
          !ball.out &&
          ball.z >= this.robotElevation(robot) &&
          ball.z <= this.robotElevation(robot) + 80,
      )
      .map((ball) => ({ ball, distance: Vec2.distance(origin, ball.body.getPosition()) * 1000 }))
      .filter((item) => item.distance <= shooter.range)
      .sort((a, b) => a.distance - b.distance || compareId(a.ball.initial.id, b.ball.initial.id));
    const target = candidates[0]?.ball;
    if (!target) return;
    const angle = robot.body.getAngle() + shooter.angle * DEG;
    const horizontal = (shooter.speed * Math.cos(shooter.elevation * DEG)) / 1000;
    target.body.setLinearVelocity(Vec2(horizontal * Math.cos(angle), horizontal * Math.sin(angle)));
    target.vz = shooter.speed * Math.sin(shooter.elevation * DEG);
    target.moved = true;
    target.lastTouch = robot.config.team;
    this.event("info", `${robot.config.name} fired ${target.initial.id}.`, robot.config.id);
  }
  private returnCorner(team: SimulationTeam, bottom: boolean): { x: number; y: number } {
    const candidates = [40, 80, 120, 160, 200].flatMap((inset) =>
      [bottom, !bottom].map((lower) => ({
        x: team === "A" ? inset : FIELD.width - inset,
        y: lower ? inset : FIELD.height - inset,
      })),
    );
    return (
      candidates.find(
        (point) =>
          [...this.robots.values()].every((robot) => {
            if (robot.config.controller.kind === "disabled") return true;
            const local = robot.body.getLocalPoint(Vec2(point.x / 1000, point.y / 1000));
            const front = robot.config.length / 2 + (robot.config.pusher?.depth ?? 0);
            const width = Math.max(robot.config.width, robot.config.pusher?.width ?? 0);
            return (
              local.x * 1000 < -robot.config.length / 2 - 25 ||
              local.x * 1000 > front + 25 ||
              Math.abs(local.y * 1000) > width / 2 + 25
            );
          }) &&
          [...this.balls.values()].every(
            (other) =>
              Vec2.distance(other.body.getPosition(), Vec2(point.x / 1000, point.y / 1000)) > 0.045,
          ),
      ) ?? candidates[0]!
    );
  }
  private checkRobotZone(robot: RobotState): void {
    if (robot.config.controller.kind === "disabled") return;
    const config = robot.config;
    const rectangles = [
      { x: 0, y: 0, halfX: config.length / 2, halfY: config.width / 2 },
      ...(config.pusher
        ? [
            {
              x: (config.length + config.pusher.depth) / 2,
              y: 0,
              halfX: config.pusher.depth / 2,
              halfY: config.pusher.width / 2,
            },
          ]
        : []),
    ];
    const polygons = rectangles.map((rect) =>
      [
        [-1, -1],
        [-1, 1],
        [1, 1],
        [1, -1],
      ].map(([sx, sy]) => {
        const point = robot.body.getWorldPoint(
          Vec2((rect.x + sx! * rect.halfX) / 1000, (rect.y + sy! * rect.halfY) / 1000),
        );
        return { x: point.x * 1000, y: point.y * 1000 };
      }),
    );
    const points = polygons.flat();
    const outside = points.some(
      (p) => p.x < -6 || p.x > FIELD.width + 6 || p.y < -6 || p.y > FIELD.height + 6,
    );
    const crossed = points.some((p) =>
      config.team === "A" ? p.x > FIELD.midX + 1 : p.x < FIELD.midX - 1,
    );
    const red = FIELD.ramps.some((ramp) =>
      polygons.some((polygon) =>
        polygonsOverlap(polygon, [
          { x: ramp.direction === 1 ? ramp.x + ramp.width - 50 : ramp.x, y: ramp.y },
          { x: ramp.direction === 1 ? ramp.x + ramp.width : ramp.x + 50, y: ramp.y },
          { x: ramp.direction === 1 ? ramp.x + ramp.width : ramp.x + 50, y: ramp.y + ramp.height },
          { x: ramp.direction === 1 ? ramp.x + ramp.width - 50 : ramp.x, y: ramp.y + ramp.height },
        ]),
      ),
    );
    const violation = outside || crossed || red;
    if (violation && !robot.violation)
      this.rulePause(
        `${config.name} ${outside ? "left the mat" : crossed ? "crossed into the opponent half" : "entered a red ramp zone"}. No automatic referee penalty applied.`,
        config.id,
      );
    robot.violation = violation;
  }
  private rulePause(message: string, robotId?: string): void {
    this.event("violation", message, robotId);
    this.violationPending = true;
    this.state = "paused";
    for (const robot of this.robots.values()) robot.runtime?.pause();
  }
  private score(): Record<SimulationTeam, number> {
    const result = { A: 0, B: 0 };
    for (const ball of this.balls.values()) {
      if (ball.out || (!ball.moved && ball.initial.central)) continue;
      const x = ball.body.getPosition().x * 1000;
      const team =
        ball.touching ??
        (Math.abs(x - FIELD.midX) < 0.001 ? undefined : x < FIELD.midX ? "A" : "B");
      if (team) result[team] += ball.initial.kind === "orange" ? 1 : -2;
    }
    return result;
  }
  private updateScore(): void {
    const score = this.score();
    if (score.A !== this.lastScore.A || score.B !== this.lastScore.B) {
      this.event("score", `Provisional score A ${score.A} · B ${score.B} (lower wins).`);
      this.lastScore = score;
    }
  }

  private readSensor(
    robotId: string,
    sensor: SimulationSensor,
    mode: number,
  ): SimulationSensorReading {
    const key = `${robotId}:${sensor.port}:${mode}`;
    const previous = this.sensorCache.get(key);
    if (previous) return previous;
    const reading = this.computeSensor(robotId, sensor, mode);
    this.sensorCache.set(key, reading);
    return reading;
  }
  private computeSensor(
    robotId: string,
    sensor: SimulationSensor,
    mode: number,
  ): SimulationSensorReading {
    const robot = this.robots.get(robotId);
    if (!robot) return { si: [0] };
    const origin = robot.body.getWorldPoint(Vec2(sensor.x / 1000, sensor.y / 1000));
    const heading = robot.body.getAngle() + sensor.angle * DEG;
    const probeHeight = this.robotElevation(robot) + 40;
    if (sensor.kind === "color") {
      const rgb = matColor(origin.x * 1000, origin.y * 1000);
      const light = Math.round(((rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255) * 100);
      const color =
        rgb[0] === 0 && rgb[1] === 0
          ? 1
          : rgb[0] === 255 && rgb[1] === 0
            ? 5
            : rgb[2] > rgb[0]
              ? 2
              : rgb[1] > rgb[0]
                ? 3
                : 6;
      const si =
        mode === 2
          ? [color]
          : mode === 4
            ? rgb.map((value) => value * 4)
            : mode === 3
              ? [light * 10, 0]
              : [light];
      return { si, raw: si.map(Math.trunc), percent: mode === 2 ? color : light };
    }
    if (sensor.kind === "gyro") {
      const direction = sensor.inverted ? -1 : 1;
      const angle = (robot.body.getAngle() / DEG - robot.config.pose.heading) * direction;
      const rate = (robot.body.getAngularVelocity() / DEG) * direction;
      return { si: mode === 3 ? [angle, rate] : mode === 1 || mode === 2 ? [rate] : [angle] };
    }
    if (sensor.kind === "touch") {
      const distance = this.rayDistance(
        origin,
        heading,
        Math.max(10, sensor.range),
        robotId,
        false,
        probeHeight,
        probeHeight,
      );
      const touched = distance < Math.max(10, sensor.range) - 0.01;
      return { si: [Number(touched)], percent: touched ? 100 : 0 };
    }
    if (sensor.kind === "ultrasonic") {
      let distance = sensor.range || 2550;
      for (let ray = -2; ray <= 2; ray++)
        distance = Math.min(
          distance,
          this.rayDistance(
            origin,
            heading + (ray * sensor.fov * DEG) / 4,
            sensor.range || 2550,
            robotId,
            true,
            probeHeight,
            probeHeight,
          ),
        );
      return {
        si: [
          mode === 1 || mode === 4 || mode === 6 ? distance / 25.4 : mode === 2 ? 0 : distance / 10,
        ],
        percent: (distance / (sensor.range || 2550)) * 100,
      };
    }
    if (sensor.kind === "pixy2") {
      const camera = {
        x: origin.x * 1000,
        y: origin.y * 1000,
        z: this.robotElevation(robot) + (sensor.pixy2 ?? DEFAULT_PIXY2_CONFIG).height,
        heading: heading / DEG,
      };
      const balls = [...this.balls.values()]
        .filter((ball) => !ball.out)
        .map((ball) => ({
          ...ball.initial,
          x: ball.body.getPosition().x * 1000,
          y: ball.body.getPosition().y * 1000,
          z: ball.z,
        }));
      const blocks = pixy2Blocks(sensor, camera, balls, FIELD.ballRadius, (ball) => {
        const distance = Math.hypot(ball.x - camera.x, ball.y - camera.y);
        return (
          this.rayDistance(
            origin,
            Math.atan2(ball.y - camera.y, ball.x - camera.x),
            distance,
            robotId,
            false,
            ball.z,
            camera.z,
          ) >=
            distance - FIELD.ballRadius &&
          !balls.some((other) => ballOccludesCamera(camera, ball, other, FIELD.ballRadius))
        );
      });
      return { si: [blocks[0]?.x ?? 0], pixy2: blocks };
    }
    const visible = [...this.balls.values()]
      .filter(
        (ball) =>
          !ball.out &&
          (mode === 0 ||
            (mode === 1 ? ball.initial.kind === "orange" : ball.initial.kind === "purple")),
      )
      .map((ball) => {
        const pos = ball.body.getPosition();
        return {
          ball,
          distance: Vec2.distance(origin, pos) * 1000,
          bearing: normalizeDegrees(
            Math.atan2(pos.y - origin.y, pos.x - origin.x) / DEG - heading / DEG,
          ),
        };
      })
      .filter(
        (item) =>
          item.distance <= sensor.range &&
          Math.abs(item.bearing) <= sensor.fov / 2 &&
          this.rayDistance(
            origin,
            heading + item.bearing * DEG,
            item.distance,
            robotId,
            false,
            item.ball.z,
            probeHeight,
          ) >=
            item.distance - FIELD.ballRadius,
      )
      .sort((a, b) => a.distance - b.distance || compareId(a.ball.initial.id, b.ball.initial.id));
    const target = visible[0];
    return {
      si: target
        ? [1, target.bearing, target.distance, target.ball.initial.kind === "orange" ? 1 : 2]
        : [0, 0, 0, 0],
    };
  }
  private rayDistance(
    origin: Vec2,
    heading: number,
    rangeMm: number,
    ownId: string,
    includeBalls: boolean,
    targetHeight = 40,
    originHeight = 40,
  ): number {
    if (rangeMm <= 0) return 0;
    const end = Vec2(
      origin.x + (Math.cos(heading) * rangeMm) / 1000,
      origin.y + (Math.sin(heading) * rangeMm) / 1000,
    );
    let fraction = 1;
    for (const ramp of FIELD.ramps) {
      const hit = intersectRampSegment(
        ramp,
        { x: origin.x * 1000, y: origin.y * 1000, z: originHeight },
        { x: end.x * 1000, y: end.y * 1000, z: targetHeight },
      );
      if (hit !== undefined) fraction = Math.min(fraction, hit);
    }
    const heightBounds = (data: Exclude<Surface, { kind: "ramp" }>): [number, number] => {
      if (data.kind === "ball") {
        const ball = this.balls.get(data.id)!;
        return [ball.z - FIELD.ballRadius, ball.z + FIELD.ballRadius];
      }
      const bottom = data.kind === "robot" ? this.robotElevation(this.robots.get(data.id)!) : 0;
      return [bottom, bottom + data.height];
    };
    // Box2D rays omit shapes containing the start point. A pressed touch probe can
    // be just inside a fixture due to contact slop, so explicitly detect that case.
    this.physics.queryAABB({ lowerBound: origin, upperBound: origin }, (fixture) => {
      const data = fixture.getUserData() as Surface;
      if (data.kind === "ramp") return true; // Analytic wedge intersection above.
      if (data.kind === "robot" && data.id === ownId) return true;
      if (data.kind === "ball" && !includeBalls) return true;
      const [bottom, top] = heightBounds(data);
      if (originHeight < bottom || originHeight > top) return true;
      if (fixture.testPoint(origin)) {
        fraction = 0;
        return false;
      }
      return true;
    });
    if (fraction === 0) return 0;
    this.physics.rayCast(origin, end, (fixture: Fixture, _point, _normal, hit) => {
      const data = fixture.getUserData() as Surface;
      if (data.kind === "ramp") return -1;
      if (data.kind === "robot" && data.id === ownId) return -1;
      if (data.kind === "ball" && !includeBalls) return -1;
      const [bottom, top] = heightBounds(data);
      const height = originHeight + (targetHeight - originHeight) * hit;
      if (height < bottom || height > top) return -1;
      fraction = Math.min(fraction, hit);
      return fraction;
    });
    return rangeMm * fraction;
  }
}

function polygonsOverlap(
  a: Array<{ x: number; y: number }>,
  b: Array<{ x: number; y: number }>,
): boolean {
  for (const polygon of [a, b])
    for (let i = 0; i < polygon.length; i++) {
      const point = polygon[i]!,
        next = polygon[(i + 1) % polygon.length]!;
      const axis = { x: -(next.y - point.y), y: next.x - point.x };
      const left = a.map((p) => p.x * axis.x + p.y * axis.y),
        right = b.map((p) => p.x * axis.x + p.y * axis.y);
      if (Math.max(...left) <= Math.min(...right) || Math.max(...right) <= Math.min(...left))
        return false;
    }
  return true;
}

/** Same deterministic mat sampler used by all mounted color sensors. */
export function matColor(x: number, y: number): [number, number, number] {
  if (x < 0 || x > FIELD.width || y < 0 || y > FIELD.height) return [0, 0, 0];
  for (const ramp of FIELD.ramps)
    if (x >= ramp.x && x <= ramp.x + ramp.width && y >= ramp.y && y <= ramp.y + ramp.height) {
      const distanceToTop = ramp.direction === 1 ? ramp.x + ramp.width - x : x - ramp.x;
      return distanceToTop <= 50
        ? [255, 0, 0]
        : distanceToTop <= 150
          ? [0, 112, 192]
          : [133, 188, 87];
    }
  if (FIELD.verticalLines.some((line) => Math.abs(x - line.x) <= line.width / 2)) return [0, 0, 0];
  const lines = x < FIELD.midX ? FIELD.leftLines : FIELD.rightLines;
  if (lines.some((line) => Math.abs(y - line) <= 10)) return [0, 0, 0];
  return [255, 255, 255];
}
