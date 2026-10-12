import { describe, expect, it } from "vitest";
import { calloutVariantFor } from "./callout-label.js";

describe("calloutVariantFor", () => {
  it("recognises the version-notes labels used in the docs", () => {
    expect(calloutVariantFor("Version notes.")).toBe("note");
    expect(calloutVariantFor("版本說明。")).toBe("note");
  });

  it("maps English and Traditional Chinese labels to variants", () => {
    expect(calloutVariantFor("Note:")).toBe("note");
    expect(calloutVariantFor("注意：")).toBe("note");
    expect(calloutVariantFor("Warning")).toBe("warning");
    expect(calloutVariantFor("CAUTION!")).toBe("warning");
    expect(calloutVariantFor("警告！")).toBe("warning");
    expect(calloutVariantFor("Safety reminder.")).toBe("safety");
    expect(calloutVariantFor("安全")).toBe("safety");
    expect(calloutVariantFor(" Tip: ")).toBe("tip");
    expect(calloutVariantFor("提示")).toBe("tip");
  });

  it("leaves other bold openings as plain quotes", () => {
    expect(calloutVariantFor("")).toBeNull();
    expect(calloutVariantFor("Host:")).toBeNull();
    expect(calloutVariantFor("Notebook")).toBeNull();
    expect(calloutVariantFor("主持人：")).toBeNull();
    expect(calloutVariantFor("constructor")).toBeNull();
  });
});
