import type { FrontendDecl, LanguageCapability } from "@kobrixa/plugin-protocol";
export type LanguageBinding = {
  epoch: number;
  pluginId: string;
  sourceKey: string;
  language: string;
  extensions: string[];
  capabilities: LanguageCapability[];
  frontend: FrontendDecl;
};
export type LanguageAvailability =
  | { kind: "available"; binding: LanguageBinding }
  | { kind: "unavailable"; reason: "missing" | "conflict"; language: string };
export interface LanguageStatus {
  epoch: number;
  availability: LanguageAvailability;
  conflicts: string[];
}
export interface LanguageStatusEvent {
  workspaceId: string;
  status: LanguageStatus;
}
export const bindingKey = (binding: LanguageBinding): string =>
  `${binding.pluginId}:${binding.language}`;
export function supportsFile(binding: LanguageBinding, file: string): boolean {
  const name = file.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && binding.extensions.includes(name.slice(dot + 1).toLowerCase());
}
