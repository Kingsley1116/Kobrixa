import { threadId } from "node:worker_threads";
import { getHeapStatistics, getHeapCodeStatistics, getHeapSpaceStatistics } from "node:v8";

export function sample() {
  return {
    threadId,
    ms: performance.now(),
    memory: process.memoryUsage(),
    heap: getHeapStatistics(),
    code: getHeapCodeStatistics(),
    spaces: getHeapSpaceStatistics(),
    maxRSSKiB: process.resourceUsage().maxRSS,
  };
}
