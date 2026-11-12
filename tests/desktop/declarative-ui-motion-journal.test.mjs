import assert from "node:assert/strict";
import test from "node:test";
import { requireMotionJournalFilesystem } from "./declarative-ui-motion-journal.ts";

test("motion requires a working journal and fails loudly on unavailable Windows adapters", async () => {
  let initialized = 0;
  await requireMotionJournalFilesystem(
    {
      initialize: async () => {
        initialized++;
      },
    },
    "win32",
  );
  assert.equal(initialized, 1);
  for (const [platform, code] of [
    ["win32", "ENOTSUP"],
    ["win32", "EIO"],
    ["linux", "ENOTSUP"],
  ]) {
    const original = Object.assign(new Error("actual native failure"), { code });
    await assert.rejects(
      requireMotionJournalFilesystem(
        {
          initialize: async () => {
            throw original;
          },
        },
        platform,
      ),
      (error) => {
        if (platform === "win32" && code === "ENOTSUP") {
          assert.match(error.message, /Windows production safety journal unavailable \(ENOTSUP\)/);
          assert.doesNotMatch(error.message, /blocked-by-W02b/);
          assert.equal(error.cause, original);
        } else assert.equal(error, original);
        return true;
      },
    );
  }
});
