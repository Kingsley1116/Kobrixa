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
  // An empty name is explained and focused instead of silently disabling Join.
  await js(input("[data-testid=collab-display-name]", ""));
  assert.equal(await js('document.querySelector(".collab-join-as") === null'), true);
  await js(click(".collab-join-dialog button[type=submit]"));
  await until('Boolean(document.querySelector("[data-testid=collab-display-name-error]"))');
  assert.equal(
    await js('document.activeElement?.getAttribute("data-testid")'),
    "collab-display-name",
  );
  assert.equal(
    await js(
      'document.querySelector("[data-testid=collab-display-name]").getAttribute("aria-invalid")',
    ),
    "true",
  );
  await js(input("[data-testid=collab-display-name]", "Ada Lovelace"));
  await until('!document.querySelector("[data-testid=collab-display-name-error]")');
  await js(click("[data-testid=collab-join-password-toggle]"));
  assert.equal(
    await js('document.querySelector("[data-testid=collab-join-password]").type'),
    "text",
  );
  await fs.writeFile(
    path.join(temporary, "collab-welcome-join.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js(click(".collab-join-dialog .modal-actions button[type=button]"));
  await js('smoke.settingsStore.set("rightPanel", null)');
}

/** A peer deletes the file open in the host's editor while it has unsaved typing. */
async function checkRemoteDeleteOfUnsavedTab({ js, until, win, temporary }) {
  const editor =
    "smoke.monaco.editor.getEditors().find(editor=>editor.getModel()?.uri.scheme!=='kobrixa-review')";
  await until(`Boolean(${editor}?.getModel())`);
  const file = await js(
    `(() => { const files = window.__collabSmoke.session.doc.getMap("files"); const text = ${editor}.getModel().getValue(); return [...files.keys()].find(file => files.get(file).toString() === text); })()`,
  );
  assert.ok(file, "the active editor shows a shared file");
  await js(
    `${editor}.executeEdits('collab-smoke',[{range:new smoke.monaco.Range(1,1,1,1),text:"' unsaved\\n"}]); void 0`,
  );
  await js(
    `(() => { const peer = window.__collabSmoke.room.sessions[1]; peer.doc.transact(() => { peer.doc.getMap("tree").delete(${JSON.stringify(file)}); peer.doc.getMap("files").delete(${JSON.stringify(file)}); }); })()`,
  );
  await until(
    `document.querySelector("[data-testid=collab-removed-files]")?.textContent.includes(${JSON.stringify(file)})`,
  );
  assert.equal(
    await js('document.activeElement?.getAttribute("data-testid")'),
    "collab-removed-keep",
  );
  await fs.writeFile(
    path.join(temporary, "collab-removed-file.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js(click("[data-testid=collab-removed-keep]"));
  await until('!document.querySelector("[data-testid=collab-removed-files]")');
}

export async function checkCollab(context) {
  const { js, until, pause, win, temporary, collabPreferences, failNextCollabPreview } = context;
  const original = await js("smoke.settingsStore.getSnapshot().values");
  await js(
    'smoke.settingsStore.set("rightPanel","collab"); smoke.settingsStore.set("locale","en")',
  );
  await until('Boolean(document.querySelector("[data-testid=collab-lobby]"))');
  failNextCollabPreview();
  await js(click("[data-testid=collab-start]"));
  await until('Boolean(document.querySelector(".collab-create-dialog"))');
  // A failed share preview is explained in plain language and can be retried.
  await until('Boolean(document.querySelector("[data-testid=collab-share-preview-retry]"))');
  assert.doesNotMatch(
    await js('document.querySelector(".collab-create-dialog").textContent'),
    /smoke: preview unavailable|Error invoking/,
  );
  assert.equal(
    await js('document.querySelector(".collab-create-dialog button[type=submit]").disabled'),
    false,
  );
  await js(click("[data-testid=collab-share-preview-retry]"));
  await until(
    '!document.querySelector("[data-testid=collab-share-preview-retry]") && Boolean(document.querySelector(".collab-create-dialog details summary"))',
  );
  assert.equal(
    await js('Boolean(document.querySelector("[data-testid=collab-create-privacy]"))'),
    true,
  );
  // Control characters are reported instead of the room silently failing to start.
  await js(input("[data-testid=collab-display-name]", "Ada\u0007"));
  await until('Boolean(document.querySelector("[data-testid=collab-display-name-error]"))');
  await until('!document.querySelector(".collab-create-dialog button[type=submit]").disabled');
  await js(click(".collab-create-dialog button[type=submit]"));
  assert.equal(
    await js('document.activeElement?.getAttribute("data-testid")'),
    "collab-display-name",
  );
  assert.equal(await js('Boolean(document.querySelector("[data-testid=collab-room]"))'), false);
  await js(input("[data-testid=collab-display-name]", "Ada Lovelace"));
  await until('!document.querySelector("[data-testid=collab-display-name-error]")');
  await until('!document.querySelector(".collab-create-dialog button[type=submit]").disabled');
  await js(click(".collab-create-dialog button[type=submit]"));
  if (!process.env.KOBRIXA_SMOKE_COLLAB_LINKED) {
    await until(
      'document.querySelector("[data-testid=collab-create-error]")?.textContent.includes("available")',
    );
    await js(click(".collab-create-dialog .modal-actions button[type=button]"));
  } else {
    await until('Boolean(document.querySelector("[data-testid=collab-room]"))');
    await until('window.__collabSmoke.session.doc.getMap("files").size > 0');
    await checkRemoteDeleteOfUnsavedTab({ js, until, win, temporary });
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
    // Messages sit under a "Today" separator and show only the time.
    assert.deepEqual(
      await js(
        '[...document.querySelectorAll("[data-testid=collab-chat-day]")].map(e => e.textContent)',
      ),
      ["Today"],
    );
    assert.equal(
      await js('document.querySelector("[data-testid=collab-chip-label]").textContent'),
      "Collaborate",
    );
    assert.equal(
      await js('Boolean(document.querySelector("[data-testid=collab-chip-unread]"))'),
      false,
    );
    // Reading older messages: new ones raise a floating pill instead of scrolling.
    await js(
      'Promise.all(Array.from({length: 30}, (_, i) => window.__collabSmoke.peerChat.send("peer filler " + i)))',
    );
    await until(
      '(() => { const log = document.querySelector(".collab-chat-log"); return log.scrollHeight > log.clientHeight + 40 && log.scrollHeight - log.scrollTop - log.clientHeight < 24; })()',
    );
    await js(
      '(() => { const log = document.querySelector(".collab-chat-log"); log.scrollTop = 0; log.dispatchEvent(new Event("scroll")); })()',
    );
    await js('window.__collabSmoke.peerChat.send("while you were reading")');
    await until('Boolean(document.querySelector("[data-testid=collab-chat-new]"))');
    await fs.writeFile(
      path.join(temporary, "chat-new-messages.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    assert.equal(
      await js(
        '(() => { const pill = document.querySelector("[data-testid=collab-chat-new]").getBoundingClientRect(), log = document.querySelector(".collab-chat-log").getBoundingClientRect(); return pill.bottom <= log.bottom && pill.top >= log.top && getComputedStyle(document.querySelector("[data-testid=collab-chat-new]")).position === "absolute"; })()',
      ),
      true,
      "new-message pill floats over the log",
    );
    // Whether earlier messages count as read depends on the window being shown,
    // so compare the chip with the pill rather than with a fixed number.
    const unread = await js(
      'document.querySelector("[data-testid=collab-chat-new] .collab-chat-new-count").textContent',
    );
    assert.match(unread, /^[1-9]\d*$/);
    assert.equal(
      await js('document.querySelector("[data-testid=collab-chip-unread]")?.textContent'),
      unread,
    );
    assert.match(
      await js('document.querySelector("[data-testid=collab-chip]").getAttribute("aria-label")'),
      new RegExp(`, ${unread} unread messages?$`),
    );
    await js(click("[data-testid=collab-chat-new]"));
    await until(
      '(() => { const log = document.querySelector(".collab-chat-log"); return log.scrollHeight - log.scrollTop - log.clientHeight < 24; })()',
    );
    await js("window.__collabSmoke.peerControl.request()");
    await until(
      'document.querySelector("[data-testid=collab-chip-requests]")?.textContent === "1"',
    );
    assert.match(
      await js('document.querySelector("[data-testid=collab-chip]").getAttribute("aria-label")'),
      /, 1 control request$/,
    );
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
    // The host can decline; the requester stops waiting and learns why.
    assert.equal(await js("window.__collabSmoke.peerControl.getSnapshot().requested"), true);
    assert.equal(
      await js('document.querySelector("[data-testid=device-control-decline]").textContent'),
      "Decline",
    );
    await js(click("[data-testid=device-control-decline]"));
    await until('!document.querySelector(".device-control-requests")');
    assert.deepEqual(
      await js(
        "(() => { const s = window.__collabSmoke.peerControl.getSnapshot(); return { requested: s.requested, declined: s.declined }; })()",
      ),
      { requested: false, declined: true },
    );
    // Request again so the layout checks below include a pending request.
    await js("window.__collabSmoke.peerControl.request()");
    await until('Boolean(document.querySelector(".device-control-requests"))');
    assert.equal(await js("window.__collabSmoke.peerControl.getSnapshot().declined"), false);
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
    await js('smoke.settingsStore.set("locale","en")');
    assert.match(
      await js('document.querySelector(".collab-invite-label").textContent'),
      /Invite code/,
    );
    await js("window.__collabSmoke.session.drop()");
    await until('Boolean(document.querySelector("[data-testid=collab-reconnect-now]"))');
    assert.match(
      await js('document.querySelector("[data-testid=collab-reconnecting]").textContent'),
      /Editing is paused/,
    );
    await js(click("[data-testid=collab-reconnect-now]"));
    await until(
      'document.querySelector("[data-testid=collab-status]").dataset.status === "connected"',
    );
    await js('window.__collabSmoke.session.close("error")');
    await until('Boolean(document.querySelector("[data-testid=collab-rejoin]"))');
    await js(click("[data-testid=collab-rejoin]"));
    // The smoke service refuses to resume, so the localized error offers a retry.
    await until(
      'document.querySelector("[data-testid=collab-room-error]")?.textContent.includes("isn\'t available")',
    );
    assert.equal(
      await js('Boolean(document.querySelector("[data-testid=collab-room-retry]"))'),
      true,
    );
    await js(click(".collab-room-footer .more-button"));
    await until('Boolean(document.querySelector("[data-testid=collab-save-copy]"))');
    await js(click("[data-testid=collab-save-copy]"));
    await until(
      'document.querySelector("[data-testid=collab-room-message]").textContent.includes("room-copy")',
    );
    await fs.writeFile(
      path.join(temporary, "collab-closed-recovery.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js(click("[data-testid=collab-leave]"));
    await until('Boolean(document.querySelector("[data-testid=collab-lobby]"))');
    // The room just left is listed with its join time and can be forgotten.
    await until('document.querySelectorAll("[data-testid=collab-recent-room]").length === 1');
    assert.match(
      await js('document.querySelector("[data-testid=collab-recent-room]").textContent'),
      /Joined |加入於 /,
    );
    assert.equal(
      await js('document.querySelector("[data-testid=collab-rejoin]").getAttribute("aria-busy")'),
      "false",
    );
    await js(click("[data-testid=collab-forget]"));
    await until('document.querySelectorAll("[data-testid=collab-recent-room]").length === 0');
    assert.equal(collabPreferences().recentRooms.length, 0);
    await checkJoinConflict({ js, until, win, temporary, ...context });
  }
  await js(
    `for (const [key,value] of Object.entries(${JSON.stringify(original)})) smoke.settingsStore.set(key,value)`,
  );
  win.setSize(1420, 900);
  console.log(
    "PASS collaboration welcome entry, share preview retry, room lifecycle, recent-room forget, persistent drafts, server-confirmed chat, keyboard menus, reconnect and closed-room recovery, join conflict choices, participant activity, confirmed demotion, day separators, new-message pill, separate chip badges and 48 layout combinations",
  );
}

/** Starting a room over local changes offers keep-copy, replace and cancel. */
async function checkJoinConflict({
  js,
  until,
  win,
  temporary,
  setCollabPrepareConflict,
  takeCollabPrepareCalls,
}) {
  await js('smoke.settingsStore.set("locale","en")');
  setCollabPrepareConflict([
    { path: "main.bp", change: "changed" },
    { path: "lib/extra.bpm", change: "added" },
  ]);
  takeCollabPrepareCalls();
  // Hosts confirm leaving because the room stays open for everyone else.
  const leaveAsHost = async () => {
    await js(click("[data-testid=collab-leave]"));
    await until('Boolean(document.querySelector("[data-testid=collab-leave-confirmed]"))');
    await js(click("[data-testid=collab-leave-confirmed]"));
    await until('Boolean(document.querySelector("[data-testid=collab-lobby]"))');
  };
  const start = async () => {
    await js(click("[data-testid=collab-start]"));
    await until('Boolean(document.querySelector(".collab-create-dialog"))');
    await until('!document.querySelector(".collab-create-dialog button[type=submit]").disabled');
    await js(click(".collab-create-dialog button[type=submit]"));
    await until('Boolean(document.querySelector(".collab-join-conflict-dialog"))');
  };
  await start();
  assert.match(
    await js('document.querySelector("[data-testid=collab-conflict-files]").textContent'),
    /main\.bp — Changed.*lib\/extra\.bpm — Added/,
  );
  assert.equal(
    await js('document.activeElement?.getAttribute("data-testid")'),
    "collab-conflict-keep",
  );
  await fs.writeFile(
    path.join(temporary, "collab-join-conflict.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  // Cancel returns to the lobby without an error or a session.
  await js(click("[data-testid=collab-conflict-cancel]"));
  await until(
    '!document.querySelector(".collab-join-conflict-dialog") && !document.querySelector(".collab-create-dialog button[type=submit]").disabled',
  );
  assert.equal(await js('Boolean(document.querySelector("[data-testid=collab-room]"))'), false);
  assert.equal(
    await js('document.querySelector("[data-testid=collab-create-error]").textContent'),
    "",
  );
  assert.deepEqual(takeCollabPrepareCalls(), [null]);
  await js(click("[data-testid=collab-create-cancel]"));
  await until('!document.querySelector(".collab-create-dialog")');
  // Replace joins without a copy.
  await start();
  await js(click("[data-testid=collab-conflict-replace]"));
  await until('Boolean(document.querySelector("[data-testid=collab-room]"))');
  assert.deepEqual(takeCollabPrepareCalls(), [null, "replace"]);
  await leaveAsHost();
  // Keep a copy joins and reports where the copy was saved.
  await start();
  await js(click("[data-testid=collab-conflict-keep]"));
  await until('Boolean(document.querySelector("[data-testid=collab-room]"))');
  assert.deepEqual(takeCollabPrepareCalls(), [null, "keep-copy"]);
  await until(
    'document.querySelector(".operation-status")?.title.includes("Local copy saved to /tmp/room-copy")',
  );
  await leaveAsHost();
  setCollabPrepareConflict(null);
}
