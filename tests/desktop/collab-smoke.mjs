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
export async function checkCollab(context) {
  if (process.env.KOBRIXA_SMOKE_COLLAB_LINKED) return checkCollabSuccess(context);
  const { js, until, pause, win, temporary, collabPreferences } = context;
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

/** Successful room UI against linked sessions; live Worker coverage runs separately. */
async function checkCollabSuccess({
  js,
  until,
  pause,
  win,
  temporary,
  key,
  mod,
  choose,
  fixtures,
  collabDeviceControl,
}) {
  const originalSettings = await js("smoke.settingsStore.getSnapshot().values");
  const originalContent = await js("ed.getValue()");
  win.setSize(980, 650);
  await js(
    'smoke.settingsStore.set("autoSave","off");smoke.settingsStore.set("formatOnSave",false)',
  );
  await js(
    'smoke.settingsStore.set("deviceWidth",320);smoke.settingsStore.set("deviceOpen",true);smoke.settingsStore.set("toolTab","collab");smoke.settingsStore.set("locale","en")',
  );
  await until(
    'Boolean(document.querySelector("[data-testid=collab-lobby]")) && !document.querySelector("[data-testid=collab-display-name]").disabled',
  );
  await js(setInput('[data-testid="collab-display-name"]', "Ada Lovelace"));
  await js(click('[data-testid="collab-start"]'));
  await until('Boolean(document.querySelector(".collab-create-dialog"))');
  await js(click('.collab-create-dialog button[type="submit"]'));
  await until(
    'document.querySelector("[data-testid=collab-status]")?.dataset.status === "connected"',
  );
  await until('window.__collabSmoke.session.doc.getMap("files").has("main.bp")');
  await until("!ed.getOption(smoke.monaco.editor.EditorOption.readOnly)");
  await js(
    `ed.executeEdits("collab-smoke", [{ range: new smoke.monaco.Range(1,1,1,1), text: "' host edit\\n" }])`,
  );
  await until(
    'window.__collabSmoke.room.sessions[1].doc.getMap("files").get("main.bp").toString() === ed.getValue()',
  );
  await js(
    `window.__collabSmoke.room.sessions[1].doc.getMap("files").get("main.bp").insert(0, "' peer edit\\n")`,
  );
  await until('ed.getValue().startsWith("\' peer edit\\n")');
  for (
    let i = 0;
    i < 50 &&
    !fixtures
      .get("00000000-0000-4000-8000-000000000001")
      .files["main.bp"].startsWith("' peer edit\n");
    i++
  )
    await pause(50);
  assert.match(
    fixtures.get("00000000-0000-4000-8000-000000000001").files["main.bp"],
    /^' peer edit/,
  );
  assert.equal(await js('document.querySelectorAll(".collab-participant").length'), 3);
  assert.equal(await js(text(".collab-chip-count")), "3");
  assert.equal(await js(text("[data-testid=collab-invite-value]")), "ABCD-EFGH-JK23");
  await js(click('[data-testid="collab-copy-invite"]'));
  await until('document.querySelector(".collab-invite p")?.textContent === "Copied"');
  const peer = '[data-participant="participant-1"]';
  await js(click(`${peer} .collab-participant-actions button:not(.danger)`));
  await until(`Boolean(document.querySelector('${peer} .collab-role-viewer'))`);
  assert.equal(await js("window.__collabSmoke.room.sessions[1].getSnapshot().role"), "viewer");
  await js(click(`${peer} .collab-participant-actions button:not(.danger)`));
  await until(`Boolean(document.querySelector('${peer} .collab-role-editor'))`);

  // The mounted production chat panel sends to the linked peer and shows replies.
  await js(click("#collab-view-chat"));
  await until('Boolean(document.querySelector(".collab-chat-compose textarea"))');
  await js(`(() => {
    const input = document.querySelector(".collab-chat-compose textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Hello from host");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await js(click('.collab-chat-compose button[type="submit"]'));
  await until(
    'window.__collabSmoke.room.sessions[1].doc.getArray("chat").toArray().some(message => message.text === "Hello from host")',
  );
  await js('window.__collabSmoke.peerChat.send("Hello from peer")');
  await until(
    'Array.from(document.querySelectorAll(".collab-chat-text")).some(item => item.textContent === "Hello from peer")',
  );

  // Grant and reclaim real device-control state through the production controls.
  await js('smoke.settingsStore.set("toolTab","connection")');
  await until('Boolean(document.querySelector(".device-control-bar"))');
  await js("window.__collabSmoke.peerControl.request()");
  await until('Boolean(document.querySelector(".device-control-requests .primary"))');
  await js(click(".device-control-requests .primary"));
  await until(
    'window.__collabSmoke.session.doc.getMap("control").get("holder") === "participant-1"',
  );
  for (let i = 0; i < 50 && collabDeviceControl() !== false; i++) await pause(20);
  assert.equal(collabDeviceControl(), false);
  await js(click(".device-control-actions button"));
  await until(
    'window.__collabSmoke.session.doc.getMap("control").get("holder") === "participant-0"',
  );
  for (let i = 0; i < 50 && collabDeviceControl() !== true; i++) await pause(20);
  assert.equal(collabDeviceControl(), true);
  await js('smoke.settingsStore.set("toolTab","collab")');
  await until('Boolean(document.querySelector("#collab-view-people"))');
  await js(click("#collab-view-people"));

  for (const locale of ["en", "zh-TW"]) {
    await js(`smoke.settingsStore.set("locale",${JSON.stringify(locale)})`);
    await until(`document.documentElement.lang === ${JSON.stringify(locale)}`);
    assert.equal(
      await js(
        'document.querySelector("#tool-panel-collab").scrollWidth <= document.querySelector("#tool-panel-collab").clientWidth',
      ),
      true,
    );
    await pause(100);
    await fs.writeFile(
      path.join(temporary, `collab-${locale}-room-320px.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  await js(click(`${peer} .collab-participant-actions .danger`));
  await until('Boolean(document.querySelector(".collab-kick-confirm"))');
  await js(click(".collab-kick-confirm .danger"));
  await until('document.querySelector(".collab-chip-count")?.textContent === "2"');
  assert.equal(
    await js("window.__collabSmoke.room.sessions[1].getSnapshot().closeReason"),
    "kicked",
  );

  // Losing the host role removes controls immediately, without reopening the panel.
  await js('window.__collabSmoke.session.setRole("viewer")');
  await until('document.querySelectorAll(".collab-participant-actions").length === 0');
  await until("ed.getOption(smoke.monaco.editor.EditorOption.readOnly)");
  await js(click("#collab-view-chat"));
  await until('!document.querySelector(".collab-chat-compose textarea")');
  const shared = await js(
    'window.__collabSmoke.session.doc.getMap("files").get("main.bp").toString()',
  );
  choose("00000000-0000-4000-8000-000000000002");
  await key("o", [mod]);
  await until('document.querySelector(".project-tab.active").textContent.includes("Project 2")');
  await until("smoke.monaco.editor.getEditors().length === 1");
  await js("window.ed=smoke.monaco.editor.getEditors()[0];void 0");
  await until("!ed.getOption(smoke.monaco.editor.EditorOption.readOnly)");
  await js(
    `ed.executeEdits("unshared-smoke", [{ range: new smoke.monaco.Range(1,1,1,1), text: "' independent\\n" }])`,
  );
  assert.equal(
    await js('window.__collabSmoke.session.doc.getMap("files").get("main.bp").toString()'),
    shared,
  );
  await js(
    `Array.from(document.querySelectorAll(".project-tab-select")).find(button => button.textContent.includes("Keyboard test")).click()`,
  );
  await until(
    'document.querySelector(".project-tab.active").textContent.includes("Keyboard test")',
  );
  await until("smoke.monaco.editor.getEditors().length === 1");
  await js("window.ed=smoke.monaco.editor.getEditors()[0];void 0");
  await until("ed.getOption(smoke.monaco.editor.EditorOption.readOnly)");
  await js('smoke.settingsStore.set("toolTab","collab")');
  await js(click("#collab-view-people"));
  await js('window.__collabSmoke.session.close("kicked")');
  await until('document.querySelector("[data-testid=collab-status]")?.dataset.status === "closed"');
  await js(click('[data-testid="collab-leave"]'));
  await until('Boolean(document.querySelector("[data-testid=collab-lobby]"))');
  assert.equal(await js('Boolean(document.querySelector("[data-testid=collab-chip]"))'), false);
  // Restore the editor and fixture ownership for the remaining full smoke suite.
  await js('smoke.settingsStore.set("locale","en")');
  await until(
    'document.documentElement.lang === "en" && !ed.getOption(smoke.monaco.editor.EditorOption.readOnly)',
  );
  await js(
    `ed.executeEdits("collab-restore", [{ range: ed.getModel().getFullModelRange(), text: ${JSON.stringify(originalContent)} }]);ed.focus()`,
  );
  await key("s", [mod]);
  await until('!document.querySelector(".project-tab.active .dirty")');
  assert.equal(
    fixtures.get("00000000-0000-4000-8000-000000000001").files["main.bp"],
    originalContent,
  );
  await js(click('[aria-label="Close project: Project 2"]'));
  await until('Boolean(document.querySelector("#close-project-title"))');
  await js(click(".modal-card .danger"));
  await until('document.querySelectorAll(".project-tab").length === 1');
  choose("00000000-0000-4000-8000-000000000001");
  await js(
    `for (const [key,value] of Object.entries(${JSON.stringify(originalSettings)})) smoke.settingsStore.set(key,value)`,
  );
  win.setSize(1420, 900);
  console.log(
    "Collaboration success: room creation, file seed, two-way edits, disk mirror, chat, grant/reclaim, viewer gates, project isolation, clipboard, roles, kick, leave and bilingual 320px room layout pass",
  );
}
