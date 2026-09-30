import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ForgeConfig } from "@electron-forge/shared-types";

type Environment = Record<string, string | undefined>;
export type SigningModes = { macos: boolean; windows: boolean };

export function signingModes(env: Environment = process.env): SigningModes {
  if (env.SIGNING_MODES) {
    const value = JSON.parse(env.SIGNING_MODES) as SigningModes;
    assert.deepEqual(Object.keys(value).sort(), ["macos", "windows"], "Invalid signing snapshot");
    assert.equal(typeof value.macos, "boolean", "Invalid macOS signing mode");
    assert.equal(typeof value.windows, "boolean", "Invalid Windows signing mode");
    return value;
  }
  const flag = (name: string) => {
    const value = env[name] ?? "";
    assert.ok(["", "true", "false"].includes(value), `${name} must be true or false`);
    return value === "true";
  };
  return { macos: flag("MACOS_SIGNING_ENABLED"), windows: flag("WINDOWS_SIGNING_ENABLED") };
}

export function required(env: Environment, name: string): string {
  const value = env[name];
  assert.ok(
    typeof value === "string" && value.trim().length > 0,
    `Missing signing configuration: ${name}`,
  );
  assert.ok(!/[\r\n\0]/.test(value), `Invalid signing configuration: ${name}`);
  return value;
}

export function windowsVersion(version: string): string {
  const core = version.split(/[+-]/)[0]!;
  assert.match(core, /^\d+\.\d+\.\d+$/, "Invalid Windows version");
  assert.ok(
    core.split(".").every((part) => Number(part) <= 65535),
    "Windows version exceeds 65535",
  );
  return `${core}.0`;
}

export function macIdentity(env: Environment): { identity: string; teamId: string } {
  const identity = required(env, "MACOS_SIGNING_IDENTITY");
  const teamId = required(env, "APPLE_TEAM_ID");
  assert.match(teamId, /^[A-Z0-9]{10}$/, "Invalid Apple Team ID");
  assert.ok(
    identity.startsWith("Developer ID Application: ") && identity.endsWith(`(${teamId})`),
    "MACOS_SIGNING_IDENTITY must be a Developer ID Application identity for APPLE_TEAM_ID",
  );
  return { identity, teamId };
}

export function macSigningConfig(
  env: Environment = process.env,
  platform: string = process.platform,
): Pick<NonNullable<ForgeConfig["packagerConfig"]>, "osxSign" | "osxNotarize"> {
  if (platform !== "darwin" || env.KOBRIXA_RELEASE_BUILD !== "true" || !signingModes(env).macos)
    return {};
  const { identity, teamId } = macIdentity(env);
  const entitlements = fileURLToPath(new URL("resources/entitlements.plist", import.meta.url));
  // Packager 18 supports this option at runtime but omits it from OsxSignOptions.
  const failurePolicy = { continueOnError: false };
  return {
    osxSign: {
      ...failurePolicy,
      identity,
      keychain: path.resolve(required(env, "MACOS_KEYCHAIN_PATH")),
      // Packager otherwise defaults to continuing after a signing failure.
      optionsForFile: () => ({ entitlements, hardenedRuntime: true }),
    },
    osxNotarize: {
      appleId: required(env, "APPLE_ID"),
      appleIdPassword: required(env, "APPLE_APP_SPECIFIC_PASSWORD"),
      teamId,
    },
  };
}
