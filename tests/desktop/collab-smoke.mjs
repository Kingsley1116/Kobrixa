import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const click = (selector) => `document.querySelector(${JSON.stringify(selector)}).click()`;
const input = (selector, value, kind = "HTMLInputElement") =>
  `(() => { const element = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(${kind}.prototype,"value").set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event("input",{bubbles:true})); })()`;

export async function checkCollabWelcome({ js, until, win, temporary }) {
  await js('smoke.settingsStore.set("rightPanel", "collab")');
  await until(
    'Boolean(document.querySelector(".welcome")) && Boolean(document.querySelector("[data-testid=collab-lobby]")) && !document.querySelector("[data-testid=collab-join]").disabled',
  );
  assert.equal(await js('document.querySelector("[data-testid=collab-start]").disabled'), true);
  assert.equal(await js('document.querySelector("[data-testid=collab-join]").disabled'), false);
  assert.equal(await js('Boolean(document.querySelector(".connection-chip"))'), true);
  await js(click("[data-testid=collab-join]"));
  await until('Boolean(document.querySelector(".collab-join-dialog"))');
  await js(input("[data-testid=collab-display-name]", "Ada Lovelace"));
  await fs.writeFile(
    path.join(temporary, "collab-welcome-join.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js(click(".collab-join-dialog button[type=button]"));
  await js('smoke.settingsStore.set("rightPanel", null)');
}

export async function checkCollab({ js, until, pause, win, temporary }) {
  const original = await js("smoke.settingsStore.getSnapshot().values");
  await js(
    'smoke.settingsStore.set("rightPanel","collab"); smoke.settingsStore.set("locale","en")',
  );
  await until('Boolean(document.querySelector("[data-testid=collab-lobby]"))');
  await js(click("[data-testid=collab-start]"));
  await until('Boolean(document.querySelector(".collab-create-dialog"))');
  await js(input("[data-testid=collab-display-name]", "Ada Lovelace"));
  await until('!document.querySelector(".collab-create-dialog button[type=submit]").disabled');
  await js(click(".collab-create-dialog button[type=submit]"));
  if (!process.env.KOBRIXA_SMOKE_COLLAB_LINKED) {
    await until(
      'document.querySelector("[data-testid=collab-create-error]")?.textContent.includes("available")',
    );
    await js(click(".collab-create-dialog button[type=button]"));
  } else {
    await until('Boolean(document.querySelector("[data-testid=collab-room]"))');
    await until('window.__collabSmoke.session.doc.getMap("files").size > 0');
    await js(click("#collab-view-chat"));
    await until('Boolean(document.querySelector(".collab-chat-compose textarea"))');
    await js(
      input(
        ".collab-chat-compose textarea",
        "draft that survives pane changes",
        "HTMLTextAreaElement",
      ),
    );
    await js("window.collabOriginalSession=window.__collabSmoke.session; null");
    await js(click(".connection-chip"));
    await until('smoke.settingsStore.getSnapshot().values.rightPanel === "ev3"');
    assert.equal(await js('document.querySelectorAll(".tools-tabs [role=tab]").length'), 3);
    await js(click(".connection-chip"));
    await until("smoke.settingsStore.getSnapshot().values.rightPanel === null");
    await js(click("[data-testid=collab-chip]"));
    await until('smoke.settingsStore.getSnapshot().values.rightPanel === "collab"');
    assert.equal(await js("window.collabOriginalSession === window.__collabSmoke.session"), true);
    assert.equal(
      await js('document.querySelector(".collab-chat-compose textarea").value'),
      "draft that survives pane changes",
    );
    assert.match(await js('document.querySelector(".collab-room-header").textContent'), /Host/);
    await js(click(".collab-chat-compose button[type=submit]"));
    await until('document.querySelector(".collab-chat-compose textarea").value === ""');
    await until(
      'document.querySelector(".collab-chat-log").textContent.includes("draft that survives")',
    );
    await js("window.__collabSmoke.peerControl.request()");
    await js(click("#collab-view-people"));
    await until('Boolean(document.querySelector(".device-control-requests"))');
    await js(click(".collab-participant .more-button"));
    await until('Boolean(document.querySelector(".collab-participant [role=menu]"))');
    assert.match(await js('document.activeElement?.getAttribute("role") ?? ""'), /menuitem/);
    assert.match(
      await js('document.querySelector(".collab-participant .more-button").ariaLabel'),
      /^Actions for /,
    );
    await js(click(".collab-participant .more-button"));
    // A peer's open file shows as "Editing …"; the host holds device control by default.
    const peerFile = await js(
      '(() => { const file = [...window.__collabSmoke.session.doc.getMap("files").keys()][0]; window.__collabSmoke.room.sessions[1].awareness.setLocalStateField("file", file); return file; })()',
    );
    await until(
      `[...document.querySelectorAll("[data-testid=collab-participant-file]")].some((item) => item.textContent === ${JSON.stringify(`Editing ${peerFile}`)})`,
    );
    assert.equal(
      await js('document.querySelectorAll("[data-testid=collab-control-badge]").length'),
      1,
    );
    await fs.writeFile(
      path.join(temporary, "collab-participants.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    // Demoting asks for confirmation, then reports success.
    await js(click(".collab-participant .more-button"));
    await until('Boolean(document.querySelector(".collab-participant [role=menu]"))');
    await js(click(".collab-participant [role=menuitem]:not(.danger)"));
    await until('Boolean(document.querySelector(".collab-demote-confirm"))');
    assert.equal(
      await js('document.querySelector(".collab-demote-confirm").getAttribute("role")'),
      "alertdialog",
    );
    await js(click("[data-testid=collab-demote-confirm]"));
    await until(
      'document.querySelector("[data-testid=collab-participants-status]")?.textContent.includes("is now a viewer")',
    );
    await until('Boolean(document.querySelector(".collab-participant .collab-role-viewer"))');
    await js(click(".collab-participant .more-button"));
    await until('Boolean(document.querySelector(".collab-participant [role=menu]"))');
    await js(click(".collab-participant [role=menuitem]:not(.danger)"));
    await until(
      'document.querySelector("[data-testid=collab-participants-status]")?.textContent.includes("is now an editor")',
    );
  }
  // Exercise every requested size, width, language, theme and scale combination.
  for (const [width, height] of [
    [980, 650],
    [1420, 900],
  ])
    for (const pane of [320, 360, 520])
      for (const locale of ["en", "zh-TW"])
        for (const theme of ["dark", "light"])
          for (const scale of [100, 125]) {
            win.setSize(width, height);
            await js(
              `smoke.settingsStore.set("locale",${JSON.stringify(locale)});smoke.settingsStore.set("theme",${JSON.stringify(theme)});smoke.settingsStore.set("uiScale",${scale});smoke.settingsStore.set("deviceWidth",${pane})`,
            );
            await until(
              `Math.abs(document.querySelector(".device-panel").getBoundingClientRect().width - ${pane}) < 0.5`,
            );
            await pause(220);
            const geometry = await js(
              `(() => { const pane = document.querySelector('.device-panel'), room = pane.querySelector('.collab-room') ?? pane.querySelector('.collab-lobby'); return { width:pane.getBoundingClientRect().width, overflow:room.scrollWidth > room.clientWidth + 1, bodyOverflow:document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, footer:room.querySelector('.collab-room-footer')?.getBoundingClientRect().bottom, bottom:pane.getBoundingClientRect().bottom }; })()`,
            );
            assert.ok(Math.abs(geometry.width - pane) < 1, JSON.stringify(geometry));
            assert.equal(
              geometry.overflow,
              false,
              `${width}/${pane}/${locale}/${theme}/${scale}: horizontal pane overflow`,
            );
            assert.equal(geometry.bodyOverflow, false, "horizontal workbench overflow");
            if (geometry.footer)
              assert.ok(geometry.footer <= geometry.bottom + 1, "leave button visible");
            const tag = `${width}x${height}-${pane}-${locale}-${theme}-${scale}`;
            await fs.writeFile(
              path.join(temporary, `collab-${tag}.png`),
              (await win.webContents.capturePage()).toPNG(),
            );
            if (process.env.KOBRIXA_SMOKE_COLLAB_LINKED) {
              await js(click("#collab-view-chat"));
              await pause(220);
              const fits = await js(
                '(() => {const input=document.querySelector(".collab-chat-compose").getBoundingClientRect(), pane=document.querySelector(".device-panel").getBoundingClientRect();return input.bottom <= pane.bottom && input.right <= pane.right;})()',
              );
              assert.equal(fits, true, `chat input visible at ${tag}`);
              assert.ok(
                await js('document.querySelector(".collab-chat-log").clientHeight >= 80'),
                `chat reading area at ${tag}`,
              );
              await fs.writeFile(
                path.join(temporary, `chat-${tag}.png`),
                (await win.webContents.capturePage()).toPNG(),
              );
              await js(click("#collab-view-people"));
            }
          }
  if (process.env.KOBRIXA_SMOKE_COLLAB_LINKED) {
    await js(click("[data-testid=collab-leave]"));
    await until('Boolean(document.querySelector("[data-testid=collab-lobby]"))');
  }
  await js(
    `for (const [key,value] of Object.entries(${JSON.stringify(original)})) smoke.settingsStore.set(key,value)`,
  );
  win.setSize(1420, 900);
  console.log(
    "PASS collaboration welcome entry, room lifecycle, persistent drafts, server-confirmed chat, keyboard menus, participant activity, confirmed demotion and 48 layout combinations",
  );
}
