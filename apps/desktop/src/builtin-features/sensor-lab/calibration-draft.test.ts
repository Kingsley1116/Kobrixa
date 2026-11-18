import { expect, it } from "vitest";
import {
  calibrationDraft,
  calibrationForm,
  draftZero,
  draftSlot,
} from "../../../../../plugins/sensor-lab/src/calibration-draft.js";
import {
  identityCalibration,
  calibrate,
} from "../../../../../plugins/sensor-lab/src/model/calibration.js";

it("round-trips applied calibration without changing it while editing the draft", () => {
  const applied = Object.freeze(identityCalibration("cm"));
  const form = {
    ...calibrationForm(applied),
    "two-point": true,
    "source-a": "10",
    "source-b": "30",
    "target-a": "0",
    "target-b": "100",
  };
  const draft = calibrationDraft(form);
  expect(calibrate(20, draft)).toBe(50);
  expect(applied.sourceA).toBe(0);
  expect(draftZero({ ...form, "zero-offset": "broken" }, 20)).toBe("50");
  expect(calibrate(20, calibrationDraft({ ...form, "zero-offset": "50" }))).toBe(0);
});
it.each(["", "  ", "NaN", "Infinity", "1e-99", "1e40"])(
  "rejects invalid numeric draft %j",
  (text) => {
    expect(() =>
      calibrationDraft({ ...calibrationForm(identityCalibration("cm")), "source-a": text }),
    ).toThrow();
  },
);
it("rejects degenerate mapping and invalid units/slots; preserves complete hidden numeric values", () => {
  const form = calibrationForm(identityCalibration("cm"));
  expect(calibrationDraft({ ...form, "source-a": "12", "source-b": "12" }).sourceA).toBe(12);
  expect(() => calibrationDraft({ ...form, "two-point": true, "source-b": "0" })).toThrow(
    "sameSource",
  );
  expect(() => calibrationDraft({ ...form, unit: "\n" })).toThrow("invalidUnit");
  expect(draftSlot({ slot: "3" })).toBe(3);
  expect(() => draftSlot({ slot: "4" })).toThrow();
});
