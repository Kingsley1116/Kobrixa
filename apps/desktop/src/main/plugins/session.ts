import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PluginError } from "@kobrixa/plugin-runtime";
import type { SafeModeLock } from "./state-store.js";

const markerSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  thirdPartyRunning: z.boolean(),
  thirdPartyStaticContributions: z.boolean().default(false),
  thirdPartyUiContributions: z.boolean().default(false),
  rendererUnresponsive: z.boolean(),
});
export type SessionMarker = z.infer<typeof markerSchema>;

/**
 * `<userData>/plugins/session.json` exists while Kobrixa runs; a crash leaves it behind. Writes
 * are synchronous so the clean-exit removal in Electron's quit event cannot be undone by a write
 * that was still pending.
 */
export class SessionMarkerFile {
  readonly file: string;
  #marker: SessionMarker | undefined;
  #finished = false;
  #previousThirdPartyStaticContributions = false;
  #previousThirdPartyUiContributions = false;
  get previousThirdPartyUiContributions(): boolean {
    return this.#previousThirdPartyUiContributions;
  }

  constructor(
    userData: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(userData, "plugins", "session.json");
  }

  get previousThirdPartyStaticContributions(): boolean {
    return this.#previousThirdPartyStaticContributions;
  }

  begin(): SafeModeLock["reason"] | undefined {
    const previous = this.#read();
    this.#previousThirdPartyUiContributions = previous?.thirdPartyUiContributions ?? false;
    this.#previousThirdPartyStaticContributions = previous?.thirdPartyStaticContributions ?? false;
    this.#finished = false;
    this.#marker = {
      startedAt: this.now().toISOString(),
      thirdPartyRunning: false,
      thirdPartyStaticContributions: false,
      thirdPartyUiContributions: false,
      rendererUnresponsive: false,
    };
    this.#write();
    if (previous?.rendererUnresponsive) return "renderer-unresponsive";
    if (
      previous?.thirdPartyRunning ||
      previous?.thirdPartyStaticContributions ||
      previous?.thirdPartyUiContributions
    )
      return "unclean-exit";
    return undefined;
  }

  markThirdPartyUiContributions(): void {
    const marker = this.#marker;
    if (!marker || this.#finished)
      throw new PluginError(
        "PLUGIN_E_STATE_SAVE",
        "PLUGIN_E_STATE_SAVE: No live plugin recovery session.",
      );
    if (marker.thirdPartyUiContributions) return;
    const next = { ...marker, thirdPartyUiContributions: true };
    try {
      this.#persist(next);
    } catch {
      throw new PluginError(
        "PLUGIN_E_STATE_SAVE",
        "PLUGIN_E_STATE_SAVE: Could not save the UI recovery marker.",
      );
    }
    this.#marker = next;
  }
  markThirdPartyStaticContributions(): void {
    const marker = this.#marker;
    if (!marker || this.#finished)
      throw new PluginError(
        "PLUGIN_E_STATE_SAVE",
        "PLUGIN_E_STATE_SAVE: No live plugin recovery session.",
      );
    if (marker.thirdPartyStaticContributions) return;
    const next = { ...marker, thirdPartyStaticContributions: true };
    try {
      this.#persist(next);
    } catch {
      throw new PluginError(
        "PLUGIN_E_STATE_SAVE",
        "PLUGIN_E_STATE_SAVE: Could not save the static-language recovery marker.",
      );
    }
    // Only a completed synchronous write can acknowledge risk as recorded.
    this.#marker = next;
  }

  update(patch: { thirdPartyRunning?: boolean; rendererUnresponsive?: true }): void {
    const marker = this.#marker;
    if (!marker || this.#finished) return;
    const next = {
      ...marker,
      ...patch,
      rendererUnresponsive: marker.rendererUnresponsive || patch.rendererUnresponsive === true,
    };
    if (
      next.thirdPartyRunning === marker.thirdPartyRunning &&
      next.rendererUnresponsive === marker.rendererUnresponsive
    )
      return;
    this.#marker = next;
    this.#write();
  }

  finish(): void {
    const marker = this.#marker;
    if (!marker || this.#finished) return;
    this.#finished = true;
    this.#marker = {
      ...marker,
      thirdPartyRunning: false,
      thirdPartyUiContributions: marker.rendererUnresponsive
        ? marker.thirdPartyUiContributions
        : false,
      thirdPartyStaticContributions: marker.rendererUnresponsive
        ? marker.thirdPartyStaticContributions
        : false,
    };
    this.#write();
    if (marker.rendererUnresponsive) return;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // A failed removal leaves the clean marker when its preceding write succeeded.
    }
  }

  #read(): SessionMarker | undefined {
    try {
      return markerSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      return undefined;
    }
  }

  #write(): void {
    if (!this.#marker) return;
    try {
      this.#persist(this.#marker);
    } catch {
      // Existing process/health updates remain best effort. Static delivery uses the
      // checked entry point above and cannot be authorized by this swallowing wrapper.
    }
  }

  #persist(marker: SessionMarker): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    }
  }
}

/** SIGINT and SIGTERM go through Electron's normal quit, so plugins stop and the marker clears. */
export function quitOnSignals(
  target: { on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown },
  quit: () => void,
): void {
  target.on("SIGINT", quit);
  target.on("SIGTERM", quit);
}

export interface RendererHealthSource {
  on(event: "unresponsive", listener: () => void): unknown;
  webContents: {
    on(
      event: "render-process-gone",
      listener: (event: unknown, details: { reason: string }) => void,
    ): unknown;
  };
}

export function watchRendererHealth(
  window: RendererHealthSource,
  onHang: () => void,
  onGone: () => void = () => {},
): void {
  window.on("unresponsive", onHang);
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") onGone();
  });
}
