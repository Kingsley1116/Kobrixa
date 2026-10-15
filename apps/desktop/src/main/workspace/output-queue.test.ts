import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { OutputQueue } from "./output-queue.js";
it("queues canonical output aliases in FIFO order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-fifo-"));
  try {
    const output = path.join(root, "out");
    await mkdir(output);
    const alias = path.join(root, "alias");
    await symlink(output, alias, "dir");
    const queue = new OutputQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const one = queue.run(output, async () => {
      order.push("a-start");
      await gate;
      order.push("a-end");
    });
    const two = queue.run(alias, async () => {
      order.push("b");
    });
    const three = queue.run(output, async () => {
      order.push("c");
    });
    const other = queue.run(path.join(root, "other"), async () => {
      order.push("other");
      release();
    });
    await Promise.all([one, two, three, other]);
    expect(order.indexOf("other")).toBeLessThan(order.indexOf("a-end"));
    expect(order.filter((item) => item !== "other")).toEqual(["a-start", "a-end", "b", "c"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
