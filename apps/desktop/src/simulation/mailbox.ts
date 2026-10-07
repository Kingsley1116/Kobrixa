import type { RobotConfig } from "../shared/simulator.js";

type RobotIdentity = Pick<RobotConfig, "id" | "name" | "team">;
export type SimulationMailboxKind = "text" | "number";
interface Slot {
  name: string;
  kind: SimulationMailboxKind;
  unread?: string | number;
}
interface Delivery {
  targetId: string;
  name: string;
  kind: SimulationMailboxKind;
  value: string | number;
  senderId: string;
  sequence: number;
}

/** Local teammate transport: writes become visible only when the world commits a tick. */
export class SimulationMailboxBus {
  private readonly robots = new Map<string, RobotIdentity>();
  private readonly aliases = new Map<string, string>();
  private readonly slots = new Map<string, Map<number, Slot>>();
  private readonly pending = new Map<string, Delivery>();
  private readonly sequence = new Map<string, number>();

  constructor(robots: ReadonlyArray<RobotIdentity>) {
    for (const robot of robots) {
      if (this.robots.has(robot.id))
        throw new Error(`Duplicate simulation robot id '${robot.id}'.`);
      this.robots.set(robot.id, { ...robot });
      this.slots.set(robot.id, new Map());
      for (const alias of new Set([robot.id, robot.name])) {
        const other = this.aliases.get(alias);
        if (other && other !== robot.id)
          throw new Error(`Ambiguous simulation robot name '${alias}'.`);
        this.aliases.set(alias, robot.id);
      }
    }
  }

  connect(senderId: string, target: string): string {
    const sender = this.robots.get(senderId);
    if (!sender) throw new Error(`Unknown simulation sender '${senderId}'.`);
    if (!target || target === "*")
      throw new Error(
        "Simulation mailboxes require an explicit teammate robot id or name; broadcast is unavailable.",
      );
    const targetId = this.aliases.get(target);
    const receiver = targetId ? this.robots.get(targetId) : undefined;
    if (!receiver) throw new Error(`Unknown simulation teammate '${target}'.`);
    if (receiver.team !== sender.team)
      throw new Error("Simulation mailboxes can communicate only with robots on the same team.");
    return receiver.id;
  }

  open(robotId: string, handle: number, name: string, kind: SimulationMailboxKind): number {
    const slots = this.slots.get(robotId);
    if (!slots) throw new Error(`Unknown simulation robot '${robotId}'.`);
    if (!Number.isInteger(handle) || handle < 0 || handle >= 30)
      throw new Error("A simulation program supports at most 30 statically allocated mailboxes.");
    if (!name || name.length > 251)
      throw new Error("Simulation mailbox names must contain 1–251 characters.");
    // A loop reopens its static EV3 handle instead of leaking a new handle on every iteration.
    slots.set(handle, { name, kind });
    return handle;
  }

  send(
    senderId: string,
    target: string,
    name: string,
    kind: SimulationMailboxKind,
    value: string | number,
  ): void {
    const targetId = this.connect(senderId, target);
    if (!name || name.length > 251)
      throw new Error("Simulation mailbox names must contain 1–251 characters.");
    if (kind === "number" && typeof value !== "number")
      throw new Error("A numeric mailbox requires a number.");
    if (kind === "text" && (typeof value !== "string" || value.length > 251))
      throw new Error("A text mailbox requires at most 251 characters.");
    const sequence = (this.sequence.get(senderId) ?? 0) + 1;
    this.sequence.set(senderId, sequence);
    const key = `${targetId}\0${name}`;
    const previous = this.pending.get(key);
    // Multiple senders are ordered by stable robot id, then each sender's program order.
    // Controller iteration order must not change a tick's result.
    if (
      !previous ||
      senderId > previous.senderId ||
      (senderId === previous.senderId && sequence > previous.sequence)
    ) {
      if (!previous && this.pending.size >= 120)
        throw new Error("Simulation mailbox pending-name limit exceeded (120 per tick).");
      this.pending.set(key, {
        targetId,
        name,
        kind,
        value: kind === "number" ? Math.fround(value as number) : value,
        senderId,
        sequence,
      });
    }
  }

  available(robotId: string, handle: number): boolean {
    return this.slot(robotId, handle).unread !== undefined;
  }

  receive(
    robotId: string,
    handle: number,
    kind: SimulationMailboxKind,
  ): string | number | undefined {
    const slot = this.slot(robotId, handle);
    if (slot.kind !== kind)
      throw new Error(`Simulation mailbox ${handle} has ${slot.kind} values, not ${kind} values.`);
    const value = slot.unread;
    delete slot.unread;
    return value;
  }

  commitTick(): void {
    for (const delivery of this.pending.values()) {
      for (const slot of this.slots.get(delivery.targetId)!.values()) {
        if (slot.name === delivery.name && slot.kind === delivery.kind)
          slot.unread = delivery.value;
      }
    }
    this.pending.clear();
    this.sequence.clear();
  }

  reset(): void {
    for (const slots of this.slots.values()) slots.clear();
    this.pending.clear();
    this.sequence.clear();
  }

  private slot(robotId: string, handle: number): Slot {
    if (!Number.isInteger(handle)) throw new Error(`Invalid simulation mailbox handle ${handle}.`);
    const slot = this.slots.get(robotId)?.get(handle);
    if (!slot) throw new Error(`Unknown simulation mailbox handle ${handle}.`);
    return slot;
  }
}
