export interface DocumentationRequest {
  code: string;
  helpKey?: string;
  locale: "zh-TW" | "en";
  relatedIndex?: number;
}
