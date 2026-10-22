import { randomUUID } from "node:crypto";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import {
  PluginError,
  type CoreWindowScope,
  type UserPersistenceActionContext,
  type UserPersistenceActionPort,
} from "@kobrixa/plugin-runtime";

const ownerKey = (o: ResourceOwner) =>
  JSON.stringify([o.sourceKey, o.pluginId, o.generation, o.hostEpoch, o.processEpoch]);

type Entry = {
  owner: ResourceOwner;
  scope: CoreWindowScope;
  uiResourceGeneration: number;
  expires: number;
};
export class UserPersistenceActions implements UserPersistenceActionPort {
  readonly #entries = new Map<string, Entry>();
  count(): number {
    return [...this.#entries.values()].filter(
      (entry) =>
        entry.expires > this.now() &&
        this.current(entry.owner, entry.scope, entry.uiResourceGeneration),
    ).length;
  }
  dispose(): void {
    this.#entries.clear();
  }
  constructor(
    private readonly now: () => number,
    private readonly current: (
      owner: ResourceOwner,
      scope: CoreWindowScope,
      uiResourceGeneration: number,
    ) => boolean,
  ) {}
  mint(owner: ResourceOwner, scope: CoreWindowScope, uiResourceGeneration: number): string {
    for (const [key, value] of this.#entries)
      if (value.expires <= this.now()) this.#entries.delete(key);
    if (!this.current(owner, scope, uiResourceGeneration) || this.#entries.size >= 256)
      throw new PluginError("PLUGIN_E_PERMISSION_DENIED", "A current user action is required.");
    const ref = randomUUID();
    this.#entries.set(ref, {
      owner: { ...owner },
      scope: { ...scope },
      uiResourceGeneration,
      expires: this.now() + 5_000,
    });
    return ref;
  }
  claim(
    context: UserPersistenceActionContext,
    _purpose: "storage.export" | "ui.clipboard",
  ): ReturnType<UserPersistenceActionPort["claim"]> {
    const entry = this.#entries.get(context.actionRef);
    if (
      !entry ||
      entry.expires <= this.now() ||
      ownerKey(entry.owner) !== ownerKey(context.owner) ||
      !this.current(entry.owner, entry.scope, entry.uiResourceGeneration)
    )
      return {
        ok: false,
        error: {
          code: "PLUGIN_E_PERMISSION_DENIED",
          message: "A current user action is required.",
          detail: { kind: "permission", reason: "user-action-required" },
        },
      };
    this.#entries.delete(context.actionRef);
    return { ok: true, value: { action: context.actionRef } };
  }
  revokeWindow(scope: CoreWindowScope): void {
    for (const [key, entry] of this.#entries)
      if (
        entry.scope.hostEpoch === scope.hostEpoch &&
        entry.scope.workbenchInstance === scope.workbenchInstance
      )
        this.#entries.delete(key);
  }
  revokeOwner(owner: ResourceOwner): void {
    for (const [key, entry] of this.#entries)
      if (ownerKey(entry.owner) === ownerKey(owner)) this.#entries.delete(key);
  }
}
