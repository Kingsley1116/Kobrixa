import type { SettingsResourceV1 } from "@kobrixa/plugin-protocol";
import type {
  SettingsFieldMap,
  BoundSettingsService,
  ContributedSettingsForm,
} from "@kobrixa/plugin-runtime";
import type { SettingsControlsPort } from "../plugin-ui/host-ports.js";
export declare function createSettingsFieldMap(resource: SettingsResourceV1): SettingsFieldMap;

export declare function createContributedSettingsForm(
  controls: SettingsControlsPort,
  service: BoundSettingsService,
): ContributedSettingsForm;
