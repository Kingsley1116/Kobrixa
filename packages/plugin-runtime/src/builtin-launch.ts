import type { Id } from "@kobrixa/plugin-protocol";
export type BuiltinPolicy = "required" | "optional";
export type BuiltinLaunchDescriptor = {
  sourceKey: string;
  pluginId: Id;
  policy: "optional";
  runtime: "node";
  packageRoot: string; // host 解析後的 absolute real directory，永不送到 renderer／plugin RPC
  entry: "main.cjs";
  manifest: "kobrixa-plugin.json";
  resourceIndex: "resource-index.json";
};


export type BuiltinResourceIndex = {
  version: 1;
  pluginId: Id;
  files: { path: string; bytes: number; sha256: string }[];
};

export type Stage3BuiltinSource = {
  kind: "builtin";
  manifest: unknown;
  resources: Readonly<Record<string, string>>;
  policy: BuiltinPolicy;
  launch?: BuiltinLaunchDescriptor;
};
