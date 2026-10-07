import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const text = (selector) =>
  `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "").trim()`;
const setInput = (selector, value) =>
  `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`;
const click = (selector) => `document.querySelector(${JSON.stringify(selector)}).click()`;

const expected = {
  en: {
    tab: "Collaborate",
    title: "Work together",
    invalid: /doesn't look like an invite code/,
    unavailable: "Collaboration isn't available right now. Try again later.",
  },
  "zh-TW": {
    tab: "協作",
    title: "一起協作",
    invalid: /邀請碼格式不正確/,
    unavailable: "協作功能目前無法使用，請稍後再試。",
  },
};

/**
 * Collaboration lobby against the smoke fakes: every collab request fails with
 * `unavailable` and preferences live in the smoke main process.
 */
export async function checkCollab({ js, until, pause, win, temporary, collabPreferences }) {
  const originalSettings = await js("smoke.settingsStore.getSnapshot().values");
  win.setSize(980, 650);
  await js(
    'smoke.settingsStore.set("deviceWidth",320);smoke.settingsStore.set("deviceOpen",true);smoke.settingsStore.set("toolTab","collab");smoke.settingsStore.set("locale","en")',
  );
  await until(
    `Boolean(document.querySelector('#tool-panel-collab [data-testid="collab-lobby"]')) && !document.querySelector('[data-testid="collab-display-name"]').disabled && Math.abs(document.querySelector(".device-panel").getBoundingClientRect().width - 320) <= 0.5`,
  );
  assert.equal(await js('Boolean(document.querySelector("[data-testid=collab-chip]"))'), false);
  // The smoke project is open, so starting a room is possible once a name is set.
  assert.equal(await js('document.querySelector("[data-testid=collab-start]").disabled'), true);

  await js(setInput('[data-testid="collab-display-name"]', "Ada Lovelace"));
  await js('document.querySelector("[data-testid=collab-display-name]").blur()');
  for (let i = 0; i < 50 && collabPreferences().displayName !== "Ada Lovelace"; i++)
    await pause(50);
  assert.equal(collabPreferences().displayName, "Ada Lovelace", "display name persisted");
  await until('!document.querySelector("[data-testid=collab-start]").disabled');

  for (const locale of ["en", "zh-TW"]) {
    const copy = expected[locale];
    await js(`smoke.settingsStore.set("locale",${JSON.stringify(locale)})`);
    await until(`document.documentElement.lang === ${JSON.stringify(locale)}`);
    assert.equal(await js(text("#tool-tab-collab")), copy.tab);
    assert.equal(await js(text(".collab-lobby h3")), copy.title);
    assert.equal(
      await js('document.querySelector("[data-testid=collab-display-name]").value'),
      "Ada Lovelace",
    );

    await js(click('[data-testid="collab-start"]'));
    await until('Boolean(document.querySelector(".collab-create-dialog"))');
    await js(click('.collab-create-dialog button[type="submit"]'));
    await until(
      `${text('[data-testid="collab-start-error"]')} === ${JSON.stringify(copy.unavailable)}`,
    );

    await js(click('.collab-create-dialog button[type="button"]'));
    await until('!document.querySelector(".collab-create-dialog")');
    await js(click('[data-testid="collab-join"]'));
    await until('Boolean(document.querySelector("[data-testid=collab-invite-code]"))');
    await until('document.activeElement?.dataset.testid === "collab-invite-code"');
    await js(setInput('[data-testid="collab-invite-code"]', "abcd efgh"));
    assert.equal(
      await js('document.querySelector("[data-testid=collab-invite-code]").value'),
      "ABCD-EFGH",
    );
    await js(click('.collab-join-dialog button[type="submit"]'));
    await until(`${text('[data-testid="collab-join-error"]')} !== ""`);
    assert.match(await js(text('[data-testid="collab-join-error"]')), copy.invalid);
    assert.equal(
      await js(
        'document.querySelector("[data-testid=collab-invite-code]").getAttribute("aria-invalid")',
      ),
      "true",
    );

    await js(setInput('[data-testid="collab-invite-code"]', "abcd-efgh-jk23"));
    assert.equal(
      await js('document.querySelector("[data-testid=collab-invite-code]").value'),
      "ABCD-EFGH-JK23",
    );
    await js(click('.collab-join-dialog button[type="submit"]'));
    await until(
      `${text('[data-testid="collab-join-error"]')} === ${JSON.stringify(copy.unavailable)}`,
    );
    await pause(150);
    await fs.writeFile(
      path.join(temporary, `collab-${locale}-join-320px.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js(click(".collab-join-dialog button[type='button']"));
    await until('!document.querySelector(".collab-join-dialog")');

    assert.equal(
      await js(
        'document.querySelector("#tool-panel-collab").scrollWidth <= document.querySelector("#tool-panel-collab").clientWidth',
      ),
      true,
      `${locale} collaboration panel fits 320px`,
    );
    await fs.writeFile(
      path.join(temporary, `collab-${locale}-lobby-320px.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }

  await js(
    `for (const [key,value] of Object.entries(${JSON.stringify(originalSettings)})) smoke.settingsStore.set(key,value)`,
  );
  win.setSize(1420, 900);
  console.log(
    "Collaboration lobby: display name persistence, invite validation, localized service errors and 320px layout pass",
  );
}
