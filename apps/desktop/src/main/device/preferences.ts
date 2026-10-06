import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_DEVICE_PREFERENCES,
  USB_RETRY_INTERVALS,
  USB_RETRY_LIMITS,
  WIFI_CONNECT_TIMEOUTS,
  WIFI_HANDSHAKE_TIMEOUTS,
  type DevicePreferences,
} from "../../shared/device-preferences.js";

const choice = <T extends string | number>(choices: readonly T[]) =>
  z.custom<T>((value) => choices.includes(value as T));
export const devicePreferencesSchema = z
  .object({
    skipUnchangedAssets: z.boolean(),
    usbAutoReconnect: z.boolean(),
    usbRetryInterval: choice(USB_RETRY_INTERVALS),
    usbRetryLimit: choice(USB_RETRY_LIMITS),
    wifiConnectTimeout: choice(WIFI_CONNECT_TIMEOUTS),
    wifiHandshakeTimeout: choice(WIFI_HANDSHAKE_TIMEOUTS),
  })
  .strict();
export const devicePreferencesPatchSchema = devicePreferencesSchema
  .partial()
  .transform(
    (value) =>
      Object.fromEntries(
        Object.entries(value).filter(([, item]) => item !== undefined),
      ) as Partial<DevicePreferences>,
  );

/** Main-process ownership prevents renderer reloads from changing recovery policy. */
export class DevicePreferencesStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private value: DevicePreferences = { ...DEFAULT_DEVICE_PREFERENCES },
    private persist: (value: DevicePreferences) => Promise<void> = async () => {},
  ) {}
  get = (): DevicePreferences => ({ ...this.value });
  set(
    patch: Partial<DevicePreferences>,
    applied: (value: DevicePreferences) => void,
  ): Promise<DevicePreferences> {
    const validated = devicePreferencesPatchSchema.parse(patch);
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        const next = { ...this.value, ...validated };
        await this.persist(next);
        this.value = next;
        applied(this.get());
        return this.get();
      });
    this.writes = write;
    return write;
  }
}

export async function loadDevicePreferences(directory: string): Promise<DevicePreferencesStore> {
  const file = path.join(directory, "device-settings.json");
  let value = { ...DEFAULT_DEVICE_PREFERENCES };
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    // Recover each valid preference independently when upgrading or repairing a file.
    if (raw && typeof raw === "object") {
      for (const key of Object.keys(value) as (keyof DevicePreferences)[]) {
        const parsed = devicePreferencesPatchSchema.safeParse({ [key]: raw[key] });
        if (parsed.success) value = { ...value, ...parsed.data };
      }
    }
  } catch {
    /* First launch or unreadable preferences: use defaults. */
  }
  return new DevicePreferencesStore(value, async (next) => {
    await mkdir(directory, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  });
}
