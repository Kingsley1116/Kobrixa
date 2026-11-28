// The settings protocol accounts for the UTF-8 JSON array, including keys and delimiters.
export function rssSettingsValues() {
  const values = Array.from({ length: 128 }, (_, i) => ({
    key: `rss.field${String(i).padStart(3, "0")}`,
    value: "",
  }));
  const remaining = 65536 - JSON.stringify(values).length;
  for (const [i, row] of values.entries())
    row.value = "x".repeat(Math.floor(remaining / 128) + (i < remaining % 128 ? 1 : 0));
  return values;
}
export function rssSettingsResource() {
  return {
    schemaVersion: 1,
    title: { en: "Pressure settings" },
    fields: rssSettingsValues().map(({ key }) => ({
      key,
      type: "string",
      default: "",
      label: { en: key },
      minLength: 0,
      maxLength: 1024,
      maxBytes: 1024,
    })),
  };
}
