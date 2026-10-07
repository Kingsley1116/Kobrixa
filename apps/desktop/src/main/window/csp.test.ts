import { readFileSync } from "node:fs";
import { DEFAULT_COLLAB_URL } from "@kobrixa/collab-protocol";
import { describe, expect, it, vi } from "vitest";
import { collabConnectSources, resolveCollabServerUrl } from "../collab/server-url.js";
import { rendererContentSecurityPolicy } from "./csp.js";

const directive = (policy: string, name: string) =>
  policy
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([key]) => key === name)
    ?.slice(1);

describe("collab server URL", () => {
  it("accepts https origins and loopback http only", () => {
    const warn = vi.fn();
    expect(resolveCollabServerUrl(undefined, warn)).toBe(DEFAULT_COLLAB_URL);
    expect(resolveCollabServerUrl(" ", warn)).toBe(DEFAULT_COLLAB_URL);
    expect(resolveCollabServerUrl("https://staging.example.com/", warn)).toBe(
      "https://staging.example.com",
    );
    expect(resolveCollabServerUrl("http://127.0.0.1:8787", warn)).toBe("http://127.0.0.1:8787");
    expect(resolveCollabServerUrl("http://localhost:8787/", warn)).toBe("http://localhost:8787");
    expect(warn).not.toHaveBeenCalled();
    for (const bad of [
      "http://collab.example.com",
      "ws://127.0.0.1:8787",
      "https://user:pw@collab.example.com",
      "https://collab.example.com/api",
      "https://collab.example.com/?x=1",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(resolveCollabServerUrl(bad, warn)).toBe(DEFAULT_COLLAB_URL);
    expect(warn).toHaveBeenCalledTimes(7);
  });
});

describe("renderer CSP", () => {
  it("allows only the collab origin over HTTP(S) and WebSocket in production", () => {
    const policy = rendererContentSecurityPolicy("https://collab.kobrixa.com", false);
    expect(directive(policy, "connect-src")).toEqual([
      "https://collab.kobrixa.com",
      "wss://collab.kobrixa.com",
    ]);
    expect(policy).toBe(
      "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src https://collab.kobrixa.com wss://collab.kobrixa.com",
    );
    expect(
      directive(rendererContentSecurityPolicy("http://127.0.0.1:8787", false), "connect-src"),
    ).toEqual(["http://127.0.0.1:8787", "ws://127.0.0.1:8787"]);
    expect(collabConnectSources("https://example.com:8443")).toBe(
      "https://example.com:8443 wss://example.com:8443",
    );
  });

  it("keeps the dev policy permissive for HMR while allowing the collab origin", () => {
    const policy = rendererContentSecurityPolicy("http://localhost:8787", true);
    expect(directive(policy, "script-src")).toContain("'unsafe-eval'");
    expect(directive(policy, "connect-src")).toEqual(
      expect.arrayContaining(["'self'", "ws:", "http://localhost:8787", "ws://localhost:8787"]),
    );
  });

  it("does not let the static index.html CSP block the collab service", () => {
    const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
    const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
    expect(meta).toBeDefined();
    const connect = directive(meta!, "connect-src");
    expect(connect).toEqual(expect.arrayContaining(["https:", "wss:"]));
    expect(connect).toEqual(expect.arrayContaining(["http://127.0.0.1:*", "ws://127.0.0.1:*"]));
    expect(directive(meta!, "script-src")).toBeUndefined();
  });
});
