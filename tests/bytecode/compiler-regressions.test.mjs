import { test } from "node:test";
import { compilerFixtures, runCompilerRegression } from "./support/compiler-regressions.mjs";
import { decode, VM } from "./support/ev3-vm.mjs";

for (const fixture of compilerFixtures) {
  test(fixture.name, () => runCompilerRegression(fixture, (bytes) => new VM(decode(bytes)).run()));
}
