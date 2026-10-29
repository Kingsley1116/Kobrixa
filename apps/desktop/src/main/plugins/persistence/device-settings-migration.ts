import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
import { settingsValidationText } from "../../../../../../packages/plugin-protocol/src/settings.js";
import type { PersistenceBackend } from "./engine-port.js";
import type { HostSettingsNamespace, PersistenceSourcePort } from "./host-port.js";
import { createLegacyImportCoordinator } from "./import-coordinator.js";
import {
  createLegacyWriterBarrier,
  type LegacyImportHostPort,
  type LegacyWriterPort,
  importIdFor,
  parseNonceDocument,
} from "./import-sources.js";
import { deviceSettingsImportDescriptor as descriptor } from "./device-settings-import.js";
import { devicePreferencesResource } from "./device-preferences-port.js";

const identity = (value: HostSettingsNamespace) => JSON.stringify(value);

/** One host-lifetime coordinator retains the original publication/pins across
 * source replacement. Constructing this adapter performs no optional I/O. */
export class DeviceSettingsMigrationGate {
  #coordinator: LegacyImportHostPort | undefined;
  #ready: string | undefined;
  #disposed = false;
  #renderer: CoreWindowScope | undefined;
  #pending: { work: Promise<void>; control: AbortController; waits: number } | undefined;
  #listeners = new Set<() => void>();
  constructor(
    private readonly input: {
      backend: PersistenceBackend;
      sources: PersistenceSourcePort;
      writer: LegacyWriterPort;
      currentScope(scope: CoreWindowScope): boolean;
    },
  ) {
    if (input.writer.sourceKey !== descriptor.targetSourceKey)
      throw new Error("Foreign legacy writer.");
  }
  #namespace(): HostSettingsNamespace {
    const value =
      !this.#disposed && this.input.sources.settingsNamespace?.(descriptor.targetSourceKey);
    if (
      !value ||
      value.owner.sourceKey !== descriptor.targetSourceKey ||
      value.owner.pluginId !== "kobrixa.device-ev3"
    )
      throw new Error("Device settings source is unavailable.");
    return structuredClone(value);
  }
  ready(): boolean {
    try {
      return this.#ready === identity(this.#namespace());
    } catch {
      return false;
    }
  }
  #changed(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        /* Observers cannot alter a durable import. */
      }
    }
  }
  watch(listener: () => void): () => void {
    if (this.#disposed || this.#listeners.size >= 32)
      throw new Error("Device settings observer unavailable.");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  async #rendererSettled(): Promise<void> {
    if (this.#renderer && this.input.currentScope(this.#renderer)) return;
    const before = this.#namespace();
    const check = () => {
      if (identity(this.#namespace()) !== identity(before))
        throw new Error("Stale device settings barrier.");
    };
    // A durable plan already contains the original immutable renderer capture.
    // On restart it must not depend on opening another window or recapturing
    // current localStorage. The coordinator revalidates its original receipts.
    const saved = await this.input.backend.imports.load(
      before.owner,
      importIdFor(descriptor.id, before.owner.sourceKey),
    );
    check();
    if (saved?.plan.devicePreferencesEvidence && saved.plan.preferencesEvidence) return;
    // Capture can commit before a plan exists. Preserve that original consumed
    // nonce as well; issuing a replacement would lose the durable reconciliation key.
    let cursor: string | undefined,
      count = 0,
      bytes = 0;
    do {
      const page = await this.input.backend.evidence.auxiliaryKeys(before.owner, "import", cursor);
      check();
      if (page.keys.length > 64 || (count += page.keys.length) > 512)
        throw new Error("Device settings evidence limit.");
      for (const key of page.keys) {
        if (!key.startsWith("nonce/")) continue;
        const encoded = await this.input.backend.evidence.auxiliary(before.owner, "import", key);
        check();
        if (!encoded || (bytes += encoded.length) > 2097152)
          throw new Error("Device settings evidence unavailable.");
        const nonce = parseNonceDocument(encoded);
        if (
          nonce.descriptorId === descriptor.id &&
          nonce.sourceKey === before.owner.sourceKey &&
          key === "nonce/" + nonce.nonce &&
          nonce.state === "consumed" &&
          nonce.raw &&
          nonce.digest
        )
          return;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    throw new Error("Device preference renderer barrier is pending.");
  }
  #service(): LegacyImportHostPort {
    const admitted = this.#namespace();
    if (this.#coordinator) return this.#coordinator;
    let recoveryOwner = admitted.owner;
    const owner = () => {
      try {
        recoveryOwner = this.#namespace().owner;
      } catch {
        // Only the already-admitted restoration may retain its original owner
        // while the source is withdrawn. New entry points reject before here;
        // currentSource and settingsAuthority independently fence publication.
      }
      return structuredClone(recoveryOwner);
    };
    const rendererWriter: LegacyWriterPort = {
      sourceKey: descriptor.targetSourceKey,
      freezeAdmission() {},
      // Every trusted renderer freezes these keys BEFORE requesting a challenge;
      // a restored immutable capture can continue with no current window.
      settled: () => this.#rendererSettled(),
    };
    const barrier = createLegacyWriterBarrier({
      backend: this.input.backend,
      descriptors: [descriptor],
      writers: [this.input.writer, rendererWriter],
      importOwner: owner,
    });
    this.#coordinator = createLegacyImportCoordinator({
      backend: this.input.backend,
      sources: this.input.backend.sources,
      descriptors: [descriptor],
      barrier,
      currentScope: this.input.currentScope,
      currentSource: (source) => {
        try {
          return source === this.#namespace().owner.sourceKey;
        } catch {
          return false;
        }
      },
      importOwner: owner,
      settingsAuthority: async (expectedOwner) => {
        const before = this.#namespace();
        if (JSON.stringify(before.owner) !== JSON.stringify(expectedOwner))
          throw new Error("Stale settings owner.");
        const resource = await this.input.sources.settings({
          sourceKey: before.owner.sourceKey,
          resourceDigest: before.resourceDigest,
        });
        if (
          identity(this.#namespace()) !== identity(before) ||
          !resource ||
          resource.owner.sourceKey !== before.owner.sourceKey ||
          resource.owner.pluginId !== before.owner.pluginId ||
          resource.owner.uiResourceGeneration !== before.uiResourceGeneration ||
          settingsValidationText(resource.resource) !==
            settingsValidationText(devicePreferencesResource)
        )
          throw new Error("Stale device settings resource.");
        return {
          schemaVersion: resource.resource.schemaVersion,
          validationDigest: resource.validationDigest,
          admissionRevision: before.uiResourceGeneration,
        };
      },
    });
    return this.#coordinator;
  }
  async prepare(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const key = identity(this.#namespace());
    if (this.#ready === key) return;
    if (!this.#pending) {
      const coordinator = this.#service();
      const control = new AbortController();
      const attempt = { control, waits: 0, work: Promise.resolve() };
      this.#pending = attempt;
      attempt.work = coordinator
        .run(descriptor, control.signal)
        .then((progress) => {
          if (identity(this.#namespace()) !== key)
            throw new Error("Device settings source changed.");
          if (progress.state !== "complete")
            throw new Error("Device settings import is pending or blocked.");
          this.#ready = key;
          this.#changed();
        })
        .finally(() => {
          if (this.#pending === attempt) this.#pending = undefined;
        });
      void attempt.work.catch(() => {});
    }
    const attempt = this.#pending;
    if (attempt.waits >= 32) throw new Error("Device settings caller limit.");
    attempt.waits++;
    // A cancelled observer cannot cancel another caller's original publication.
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      attempt.work.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
    signal.throwIfAborted();
    if (!this.ready()) throw new Error("Device settings source changed.");
  }
  async issuePreferences(request: Parameters<LegacyImportHostPort["issuePreferences"]>[0]) {
    if (request.descriptorId !== descriptor.id || !this.input.currentScope(request.scope))
      throw new Error("Stale device settings challenge.");
    this.#namespace();
    this.#renderer = structuredClone(request.scope);
    return this.#service().issuePreferences(request);
  }
  async acceptPreferencesEvidence(
    snapshot: Parameters<LegacyImportHostPort["acceptPreferencesEvidence"]>[0],
  ) {
    const result = await this.#service().acceptPreferencesEvidence(snapshot);
    if (result.state !== "pending") await this.prepare(new AbortController().signal);
    return result;
  }
  retirePreferences(scope: CoreWindowScope): void {
    this.#coordinator?.retirePreferences(scope);
    if (
      this.#renderer?.hostEpoch === scope.hostEpoch &&
      this.#renderer.workbenchInstance === scope.workbenchInstance
    )
      this.#renderer = undefined;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = undefined;
    this.#renderer = undefined;
    this.#pending?.control.abort();
    this.#listeners.clear();
  }
}
