import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError, MAX_JSON_BODY_BYTES, RateLimiter, readJson } from "./http.js";

const schema = z.object({ a: z.number() }).strict();

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("https://collab.test/x", { method: "POST", body, headers });
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected rejection");
}

describe("readJson", () => {
  it("parses and validates JSON", async () => {
    expect(await readJson(post('{"a":1}'), schema)).toEqual({ a: 1 });
    expect((await rejection(readJson(post('{"a":"1"}'), schema))).status).toBe(400);
    expect((await rejection(readJson(post("{"), schema))).status).toBe(400);
  });

  it("enforces the body size limit even without Content-Length", async () => {
    const big = JSON.stringify({ a: 1, pad: "x".repeat(MAX_JSON_BODY_BYTES) });
    expect((await rejection(readJson(post(big), schema))).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const request = new Request("https://collab.test/x", {
      method: "POST",
      body: stream,
      // @ts-expect-error Node's fetch requires `duplex` for streamed bodies.
      duplex: "half",
    });
    expect((await rejection(readJson(request, schema))).status).toBe(413);
  });
});

describe("RateLimiter", () => {
  it("limits within a sliding window per key", () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 100)).toBe(true);
    expect(limiter.take("a", 200)).toBe(false);
    expect(limiter.take("b", 200)).toBe(true);
    expect(limiter.retryAfter("a", 200)).toBe(1);
    expect(limiter.take("a", 1001)).toBe(true);
    expect(limiter.take("a", 1050)).toBe(false);
  });

  it("bounds the number of tracked keys", () => {
    const limiter = new RateLimiter(1, 1000, 3);
    for (const key of ["a", "b", "c", "d", "e"]) limiter.take(key, 0);
    // Oldest keys were evicted, so they may try again.
    expect(limiter.take("a", 1)).toBe(true);
    expect(limiter.take("e", 1)).toBe(false);
  });
});
