import type { UiOwner, Sha256, SettingsResourceV1, SettingsSnapshot, PluginErrorCode, PersistenceFailureDetail, SettingsRequestMap, SettingKey, LocalId, SettingsScalar } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope } from "./core-actions.js";
export type SettingsFormBinding = {
  owner: UiOwner;
  scope: CoreWindowScope;
  resourceDigest: Sha256;
};
export interface SettingsFormPort {
  open(
    binding: SettingsFormBinding,
    resource: SettingsResourceV1,
    snapshot: SettingsSnapshot,
  ): void;
  replaceSnapshot(binding: SettingsFormBinding, snapshot: SettingsSnapshot): void;
  showFailure(
    binding: SettingsFormBinding,
    error: { code: PluginErrorCode; message: string; detail?: PersistenceFailureDetail },
  ): void;
  dispose(binding: SettingsFormBinding): void;
}
export interface BoundSettingsService {
  open(input:{sourceKey:string; scope:CoreWindowScope; resourceDigest:Sha256}): Promise<{
    binding:SettingsFormBinding; resource:SettingsResourceV1; snapshot:SettingsSnapshot;
  }>;
  read(binding:SettingsFormBinding): Promise<SettingsRequestMap["settings/read"]["result"]>;
  update(binding:SettingsFormBinding, params:SettingsRequestMap["settings/update"]["params"]): Promise<SettingsRequestMap["settings/update"]["result"]>;
  reset(binding:SettingsFormBinding, params:SettingsRequestMap["settings/reset"]["params"]): Promise<SettingsRequestMap["settings/reset"]["result"]>;
  watch(binding:SettingsFormBinding, changed:()=>void): () => void;
  dispose(binding:SettingsFormBinding): void;
}
export interface ContributedSettingsForm extends SettingsFormPort {
  retry(binding:SettingsFormBinding, key:SettingKey): Promise<void>;
  reload(binding:SettingsFormBinding): Promise<void>;
}
export interface SettingsFieldMap {
  field(key:SettingKey): LocalId;
  key(field:LocalId): SettingKey;
  option(key:SettingKey, value:SettingsScalar): LocalId;
  value(key:SettingKey, option:LocalId): SettingsScalar;
}
