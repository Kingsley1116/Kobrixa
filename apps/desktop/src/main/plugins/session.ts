import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SafeModeLock } from "./state-store.js";

const markerSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  thirdPartyRunning: z.boolean(),
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

  constructor(
    userData: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(userData, "plugins", "session.json");
  }

  /** Reads what the previous session left behind, then starts this session's marker. */
  begin(): SafeModeLock["reason"] | undefined {
    const previous = this.#read();
    this.#marker = {
      startedAt: this.now().toISOString(),
      thirdPartyRunning: false,
      rendererUnresponsive: false,
    };
    this.#write();
    if (previous?.rendererUnresponsive) return "renderer-unresponsive";
    if (previous?.thirdPartyRunning) return "unclean-exit";
    return undefined;
  }

  /** `rendererUnresponsive` is sticky for the rest of the session. */
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

  /** A clean exit. The marker stays when the renderer hung, so the next start still recovers. */
  finish(): void {
    const marker = this.#marker;
    if (!marker || this.#finished) return;
    this.#finished = true;
    this.#marker = { ...marker, thirdPartyRunning: false };
    this.#write();
    if (marker.rendererUnresponsive) return;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // The marker left behind no longer claims a running plugin, so it triggers nothing.
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
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(this.#marker), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      // Recovery is best effort: without a marker the next start simply cannot detect a crash.
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Nothing left to clean up. */
      }
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

export function watchRendererHealth(window: RendererHealthSource, onHang: () => void): void {
  window.on("unresponsive", onHang);
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") onHang();
  });
}
