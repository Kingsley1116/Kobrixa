interface DocumentationTarget {
  source: string;
  code: string;
  helpKey?: string;
  locale: "zh-TW" | "en";
}
export type DocumentationRequest = DocumentationTarget &
  ({ relatedIndex?: number } | { linkIndex: number });
