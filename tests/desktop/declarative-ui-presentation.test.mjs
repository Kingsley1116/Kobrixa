import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";

test(
  "actual native presentation and volatile draft receipt",
  {
    skip: process.env.KOBRIXA_UI_PRESENTATION_REPORT
      ? false
      : "actual Electron receipt required; not acceptance",
  },
  async () => {
    const file = process.env.KOBRIXA_UI_PRESENTATION_REPORT;
    const bytes = await readFile(file);
    const report = JSON.parse((file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
    assert.equal(report.normalClose, true);
    assert.deepEqual(report.remainingPids, []);
    assert.equal(report.productionMain, true);
    assert.equal(report.productionPreload, true);
    assert.equal(report.artifact.presentationInstrumentation, true);
    assert.match(report.artifact.commit, /^[a-f0-9]{40}$/);
    const { cases, draftReopen, siblings, screenReaderSpeech } = report.presentation;
    assert.deepEqual(
      cases.map(({ layout }) => [layout.locale, layout.theme]),
      [
        ["en", "light"],
        ["en", "dark"],
        ["zh-TW", "light"],
        ["zh-TW", "dark"],
      ],
    );
    for (const row of cases) {
      assert.equal(row.scalePercent, 125);
      assert.ok(Math.abs(row.layout.width - 320) <= 1);
      assert.ok(row.layout.scrollWidth <= row.layout.clientWidth + 1);
      assert.equal(row.layout.nodes.length, 14);
      for (const value of [row.invalid, row.afterPatches]) {
        assert.equal(value.value, "-");
        assert.equal(value.invalid, "true");
        assert.equal(value.focused, true);
      }
      assert.equal(row.corrected.draft.speed, 25);
      assert.equal(row.corrected.invalid, "false");
      assert.equal(row.tabbed.activeNode, "level");
      assert.equal(row.hidden.enabled, false);
      assert.equal(row.hidden.alertVisible, false);
      assert.equal(row.shown.enabled, true);
      assert.equal(row.shown.alertVisible, true);
      assert.ok(row.announcements.ended - row.announcements.started >= 2200);
      assert.ok(row.announcements.samples.length >= 1 && row.announcements.samples.length <= 3);
      assert.equal(row.screenshots.length, 2);
      assert.ok(row.accessibilityTree.endsWith(".ax.json"));
    }
    assert.notEqual(
      draftReopen.before.binding.panelInstance,
      draftReopen.after.binding.panelInstance,
    );
    assert.equal(draftReopen.before.binding.processEpoch, draftReopen.after.binding.processEpoch);
    assert.equal(draftReopen.before.binding.hostEpoch, draftReopen.after.binding.hostEpoch);
    assert.deepEqual(draftReopen.before.draft, draftReopen.after.draft);
    assert.deepEqual(draftReopen.before.raw, draftReopen.after.raw);
    assert.equal(draftReopen.after.value, "-");
    assert.equal(draftReopen.after.invalid, "true");
    assert.deepEqual(
      siblings.map((row) => row.panel),
      ["ev3", "collab", "plugins"],
    );
    assert.ok(siblings.every((row) => row.visible.length === 1));
    assert.equal(screenReaderSpeech, "unrun"); // DOM/AX observations cannot claim an actual reader's speech.
  },
);
