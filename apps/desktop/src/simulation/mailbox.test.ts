import { describe, expect, it } from "vitest";
import { SimulationMailboxBus } from "./mailbox.js";

const robots = [
  { id: "a1", name: "Alpha", team: "A" },
  { id: "a2", name: "Beta", team: "A" },
  { id: "a3", name: "Gamma", team: "A" },
  { id: "b1", name: "Opponent", team: "B" },
] as const;

describe("local simulation mailbox transport", () => {
  it("delivers only at tick commit and consumes the latest unread value once", () => {
    const bus = new SimulationMailboxBus(robots);
    bus.open("a2", 0, "strategy", "text");
    bus.send("a1", "Beta", "strategy", "text", "first");
    bus.send("a1", "a2", "strategy", "text", "second");
    expect(bus.available("a2", 0)).toBe(false);
    expect(bus.receive("a2", 0, "text")).toBeUndefined();
    bus.commitTick();
    expect(bus.available("a2", 0)).toBe(true);
    expect(bus.receive("a2", 0, "text")).toBe("second");
    expect(bus.available("a2", 0)).toBe(false);
    bus.send("a1", "a2", "strategy", "text", "old unread");
    bus.commitTick();
    bus.send("a1", "a2", "strategy", "text", "new unread");
    bus.commitTick();
    expect(bus.receive("a2", 0, "text")).toBe("new unread");
  });

  it("resolves simultaneous senders independently of controller execution order", () => {
    const run = (order: string[]) => {
      const bus = new SimulationMailboxBus(robots);
      bus.open("a2", 3, "score", "number");
      for (const id of order) bus.send(id, "a2", "score", "number", id === "a1" ? 1 : 3.25);
      bus.commitTick();
      return bus.receive("a2", 3, "number");
    };
    expect(run(["a1", "a3"])).toBe(3.25);
    expect(run(["a3", "a1"])).toBe(3.25);
  });

  it("keeps handles and teams isolated and rejects unsupported recipients", () => {
    const bus = new SimulationMailboxBus(robots);
    bus.open("a1", 0, "score", "number");
    bus.open("a2", 0, "score", "number");
    expect(() => bus.connect("a1", "Opponent")).toThrow("same team");
    expect(() => bus.connect("a1", "unknown")).toThrow("Unknown");
    expect(() => bus.connect("a1", "*")).toThrow("broadcast");
    expect(() => bus.connect("a1", "")).toThrow("explicit");
    expect(() => bus.receive("a1", 0, "text")).toThrow("number values");
    expect(() => bus.open("a1", 30, "limit", "text")).toThrow("30");
    for (let repeat = 0; repeat < 100; repeat++) bus.open("a2", 0, "score", "number");
    bus.send("a1", "a2", "score", "number", 1.1);
    bus.commitTick();
    expect(bus.receive("a1", 0, "number")).toBeUndefined();
    expect(bus.receive("a2", 0, "number")).toBe(Math.fround(1.1));
    bus.reset();
    expect(() => bus.available("a2", 0)).toThrow("Unknown");
  });
});
