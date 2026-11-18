// Dedicated public acceptance replaces the retired service-injected Lab smoke.
export function sensorLabAcceptanceHandoff(environment = process.env) {
  const command = "node tests/desktop/sensor-lab-public-run.mjs --run";
  if (environment.KOBRIXA_SMOKE_SENSOR_LAB_ONLY)
    throw new Error(
      `KOBRIXA_SMOKE_SENSOR_LAB_ONLY is retired. Run dedicated public Lab acceptance: ${command}`,
    );
  return `Lab acceptance NOT RUN by workbench smoke; required separately: ${command}. Pure feature oracles do not replace native acceptance.`;
}
