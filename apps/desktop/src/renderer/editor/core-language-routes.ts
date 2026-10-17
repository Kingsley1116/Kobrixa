import ids from "./core-static-language-ids.json" with { type: "json" };

// Generated from runtime; never maintain a second list of installed core ids here.
export const CORE_LANGUAGE_IDS: ReadonlySet<string> = new Set(ids);
if (!CORE_LANGUAGE_IDS.has("plaintext") || !CORE_LANGUAGE_IDS.has("json")) {
  throw new Error("Core language contract is missing plaintext or json");
}
export const CORE_EXTENSION_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  json: ids.find((id) => id === "json")!,
});
