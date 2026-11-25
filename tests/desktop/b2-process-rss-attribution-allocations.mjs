// Optional independent run. Session.connect() uses this isolate, without opening a socket.
import { Session } from "node:inspector/promises";
import { threadId } from "node:worker_threads";

let session;
export async function allocationSample(action) {
  if (action === "start") {
    session = new Session();
    session.connect();
    await session.post("HeapProfiler.startSampling", {
      samplingInterval: 524288,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    return;
  }
  try {
    const { profile } = await session.post("HeapProfiler.stopSampling");
    const bytes = new Map();
    // Charge each sample to exactly one nearest synchronous product frame. Async
    // fs callbacks without a product frame remain in a separate runtime bucket.
    function visit(node, ancestor) {
      const frame = node.callFrame;
      const site = frame.url.includes("/plugins/persistence/")
        ? frame.url.split("/").pop() + " " + frame.functionName
        : ancestor;
      bytes.set(site, (bytes.get(site) ?? 0) + node.selfSize);
      for (const child of node.children ?? []) visit(child, site);
    }
    visit(profile.head, "outside persistence stack");
    return {
      threadId,
      total: [...bytes.values()].reduce((a, b) => a + b, 0),
      top: [...bytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    };
  } finally {
    session.disconnect();
  }
}
