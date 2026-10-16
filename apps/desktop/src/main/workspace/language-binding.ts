import type { ProjectManifest, PublishedDiagnostic } from "@kobrixa/compiler";
import type { LanguageCapability } from "@kobrixa/plugin-protocol";
import type { LanguageServiceResolution } from "@kobrixa/plugin-runtime";
import type { LanguageStatus } from "../../shared/language-services.js";

export class LanguageBindings {
  private nextEpoch = 0;
  private states = new Map<string, { fingerprint: string; status: LanguageStatus }>();
  constructor(
    private readonly factories: Readonly<
      Record<string, { capabilities: readonly LanguageCapability[] }>
    >,
    private readonly log: (message: string) => void = console.error,
  ) {}
  select(
    workspaceId: string,
    manifest: ProjectManifest,
    resolution: LanguageServiceResolution,
    routingKey = "",
  ): LanguageStatus {
    const fingerprint = JSON.stringify([
      routingKey,
      manifest.language,
      manifest.entry,
      manifest.outputDir,
      resolution,
    ]);
    const previous = this.states.get(workspaceId);
    if (previous?.fingerprint === fingerprint) return structuredClone(previous.status);
    const epoch = ++this.nextEpoch;
    let status: LanguageStatus;
    if (!resolution.ok)
      status = {
        epoch,
        availability: {
          kind: "unavailable",
          reason: resolution.reason,
          language: manifest.language,
        },
        conflicts: [...resolution.conflicts],
      };
    else {
      const { frontend, declaration } = resolution;
      const key = `${frontend.pluginId}:${manifest.language}`;
      const factory = this.factories[key];
      if (
        !factory ||
        declaration.capabilities.some((capability) => !factory.capabilities.includes(capability))
      ) {
        this.log(`Language service factory is missing or incompatible: ${key}.`);
        status = {
          epoch,
          conflicts: [frontend.pluginId],
          availability: {
            kind: "unavailable",
            reason: "conflict",
            language: manifest.language,
          },
        };
      } else
        status = {
          epoch,
          conflicts: [],
          availability: {
            kind: "available",
            binding: {
              epoch,
              pluginId: frontend.pluginId,
              sourceKey: frontend.sourceKey,
              language: declaration.language,
              extensions: [...declaration.extensions],
              capabilities: [...declaration.capabilities],
              frontend: structuredClone(frontend.contribution),
            },
          },
        };
    }
    this.states.set(workspaceId, { fingerprint, status });
    return structuredClone(status);
  }
  restart(workspaceId: string): LanguageStatus | undefined {
    const entry = this.states.get(workspaceId);
    if (!entry) return;
    entry.status.epoch = ++this.nextEpoch;
    if (entry.status.availability.kind === "available")
      entry.status.availability.binding.epoch = entry.status.epoch;
    return structuredClone(entry.status);
  }
  projectError(
    workspaceId: string,
    diagnostics: PublishedDiagnostic[],
    routingKey = "",
  ): LanguageStatus {
    const fingerprint = JSON.stringify(["project-error", routingKey, diagnostics]);
    const previous = this.states.get(workspaceId);
    if (previous?.fingerprint === fingerprint) return structuredClone(previous.status);
    const status: LanguageStatus = {
      epoch: ++this.nextEpoch,
      conflicts: [],
      availability: {
        kind: "unavailable",
        reason: "project-error",
        message:
          diagnostics.map((item) => item.message).join("\n") ||
          "Choose an entry file before checking.",
        diagnostics: structuredClone(diagnostics),
      },
    };
    this.states.set(workspaceId, { fingerprint, status });
    return structuredClone(status);
  }
  get(workspaceId: string): LanguageStatus | undefined {
    const status = this.states.get(workspaceId)?.status;
    return status && structuredClone(status);
  }
  forget(workspaceId: string): void {
    this.states.delete(workspaceId);
  }
}
