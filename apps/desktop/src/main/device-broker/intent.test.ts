import { expect, it, vi } from "vitest";
import { IntentRegistry } from "./intent.js";
import { pluginPrincipal, ID } from "./fake-provider.js";
it("F06/A-RF4 trusted pulse edges cannot resurrect expired owner intent", () => {
  let now = 0;
  const stop = vi.fn();
  const intent = new IntentRegistry(() => now, stop);
  const owner = pluginPrincipal().owner;
  const binding = {
    owner,
    contextRef: ID,
    panelInstance: ID,
    uiResourceGeneration: 1,
    workbenchInstance: ID,
  };
  const scope = intent.bindMotionScope(binding);
  expect(() => intent.assert(owner, scope, ID)).toThrow();
  intent.pulsePanel(scope, 1);
  const gesture = intent.beginGesture(scope, 1);
  for (const age of [99, 100, 101, 349]) {
    now = age;
    expect(() => intent.assert(owner, scope, ID, gesture)).not.toThrow();
  }
  now = 350;
  expect(() => intent.assert(owner, scope, ID, gesture)).toThrow();
  intent.pulsePanel(scope, 2);
  expect(() => intent.assert(owner, scope, ID, gesture)).toThrow();
  expect(stop).toHaveBeenCalled();
});
it("F02 foreign scopes and repeated sequences never refresh", () => {
  let now = 0;
  const intent = new IntentRegistry(
      () => now,
      () => {},
    ),
    owner = pluginPrincipal().owner;
  const scope = intent.bindMotionScope({
    owner,
    contextRef: ID,
    panelInstance: ID,
    uiResourceGeneration: 1,
    workbenchInstance: ID,
  });
  intent.pulsePanel(scope, 1);
  now = 349;
  intent.pulsePanel(scope, 1);
  now = 350;
  expect(() => intent.assert(owner, scope, ID)).toThrow();
  expect(() => intent.assert(pluginPrincipal(2).owner, scope, ID)).toThrow();
});
