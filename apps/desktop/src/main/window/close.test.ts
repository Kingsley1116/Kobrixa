import { expect, it, vi } from "vitest";
import { CloseHandshake } from "./close.js";

it("waits for the current successful flush and retries after a failure", () => {
  const send = vi.fn(),
    close = vi.fn();
  const handshake = new CloseHandshake(send, close);
  handshake.request();
  handshake.request();
  expect(send).toHaveBeenCalledTimes(1);
  const first = send.mock.calls[0]![0] as string;
  handshake.finish("stale", true);
  handshake.finish(first, false);
  expect(close).not.toHaveBeenCalled();
  handshake.request();
  const second = send.mock.calls[1]![0] as string;
  handshake.finish(first, true);
  expect(close).not.toHaveBeenCalled();
  handshake.finish(second, true);
  expect(close).toHaveBeenCalledOnce();
  expect(handshake.ready).toBe(true);
});
