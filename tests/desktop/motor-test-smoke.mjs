// Legacy service-injected motor smoke was retired with the private motor route.
// This marker never runs, substitutes for, or reports success for motor acceptance.
export function motorAcceptanceHandoff(environment = process.env) {
  const command = "node tests/desktop/motor-test-public-run.mjs --all";
  if (environment.KOBRIXA_SMOKE_MOTORS_ONLY)
    throw new Error(
      `KOBRIXA_SMOKE_MOTORS_ONLY is retired. Run dedicated public motor acceptance: ${command}`,
    );
  return `Motor acceptance NOT RUN by workbench smoke; required separately: ${command}. Pure feature oracles do not replace native acceptance.`;
}
