import type { PreviewCommand, PreviewResponse } from "./protocol.js";
import { PreviewWorkerSession } from "./worker-session.js";

// Keep this module worker independent of Node, Electron and connected device services.
const channel = globalThis as unknown as {
  postMessage(message: PreviewResponse): void;
  onmessage: ((event: MessageEvent<PreviewCommand>) => void) | null;
};
const session = new PreviewWorkerSession((message) => channel.postMessage(message));
channel.onmessage = (event) => session.receive(event.data);
