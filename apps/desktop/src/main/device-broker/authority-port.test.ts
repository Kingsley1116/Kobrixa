import { expect, expectTypeOf, it } from "vitest";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { AuthorityPort, AuthorityContextRecord } from "./authority-port.js";
import { AuthorityContexts } from "./authority-context.js";

it("implements the frozen three-method authority port", () => {
  const contexts = new AuthorityContexts("00000000-0000-4000-8000-000000000001");
  expectTypeOf(contexts).toMatchTypeOf<AuthorityPort>();
  expectTypeOf<AuthorityPort["current"]>().toEqualTypeOf<
    (principal: Principal, contextRef: string) => AuthorityContextRecord | null
  >();
  expectTypeOf<AuthorityPort["assertContinuation"]>().toEqualTypeOf<
    (principal: Principal, contextRef: string) => void
  >();
  expect(contexts.current({
    kind: "core", adapter: "deployment",
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    workbenchInstance: "00000000-0000-4000-8000-000000000002",
    authorityContext: null,
  }, "00000000-0000-4000-8000-000000000003")).toBeNull();
});
