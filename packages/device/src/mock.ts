import type { DeviceDescriptor, DeviceTransport, Ev3Connection } from "./contracts.js";
import { FramedConnection, frameMessage, parseFrame } from "./framing.js";
import { DeviceOperationError } from "./errors.js";
import { EV3DeviceSession } from "./session.js";

export type MockResponder = (payload: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export class MockConnection extends FramedConnection implements Ev3Connection {
  closed = false;
  private pending = new Set<(error: Error) => void>();

  constructor(private readonly responder: MockResponder) {
    super();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const reject of this.pending)
      reject(new DeviceOperationError("connection", "Mock EV3 disconnected."));
  }

  protected async exchangeFrame(frame: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    if (this.closed) throw new DeviceOperationError("connection", "Mock EV3 disconnected.");
    const request = parseFrame(frame);
    let rejectPending!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectPending = reject;
    });
    const abort = (): void => rejectPending(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    this.pending.add(rejectPending);
    try {
      const reply = await Promise.race([this.responder(request.payload), interrupted]);
      return frameMessage(request.counter, reply);
    } finally {
      signal.removeEventListener("abort", abort);
      this.pending.delete(rejectPending);
    }
  }

  protected async sendFrame(frame: Uint8Array): Promise<void> {
    const request = parseFrame(frame);
    await this.responder(request.payload);
  }
}

export class MockTransport implements DeviceTransport {
  readonly descriptor: DeviceDescriptor = { id: "mock:ev3", name: "Mock EV3", transport: "mock" };

  constructor(private readonly responder: MockResponder) {}

  async discover(signal: AbortSignal): Promise<DeviceDescriptor[]> {
    signal.throwIfAborted();
    return [this.descriptor];
  }

  async connect(target: DeviceDescriptor, signal: AbortSignal): Promise<EV3DeviceSession> {
    signal.throwIfAborted();
    return new EV3DeviceSession(target, new MockConnection(this.responder));
  }
}
