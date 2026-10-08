# Cloud collaboration

> **Release candidate.** Cloud collaboration is included starting with `v0.1.0-v1-candidate.12`. The default service is `https://collab.kobrixa.com`. Room recovery and the independent collaboration pane are included starting with `v0.1.0-v1-candidate.13`; the original `.12` desktop does not retain room recovery credentials.

Several people can edit one Kobrixa project at the same time through a Kobrixa-operated collaboration service. No account is needed: the host starts a room and shares an invite code, and guests join with that code and the optional room password. Everyone sees the same files, cursors and chat; only one person at a time controls the EV3.

## Starting and joining a room

**Host:** open a project, then select **Collaborate** in the top toolbar and **Start a room**. Enter a display name in the dialog. You can set a room password in the dialog or leave it blank. The room header shows an invite code such as `ABCD-EFGH-JK23`; share it with the people you want to invite.

**Guest:** select **Collaborate** in the top toolbar, choose **Join a room**, and enter the invite code, a display name and the room password if the host set one, and join. You can join from the welcome screen without opening a local project or connecting an EV3. The project arrives from the room.

- Display names are up to 40 characters. A room holds up to 16 online identities; offline members do not occupy seats. A new connection for the same identity replaces its previous window.
- Without a room password, anyone with the invite code can join. With a password, both are required. Share them only with the intended people.
- Room passwords are case-sensitive, preserve spaces and allow up to 128 characters. The service stores a salted password verifier, not the password.
- Recovery credentials are kept only by the main process, in an atomically written file restricted to the current user. Collaboration does not use the system keychain or save room passwords. Return from recent rooms without entering a password; the service restores your existing identity and current role. Older rooms whose host credential was never saved cannot recover ownership by name or password. Open the retained project and create a new room.
- Room access tokens are signed by the service and are valid for seven days and renewed using the saved recovery credential.

## Roles

| Role   | Can do                                                                            |
| ------ | --------------------------------------------------------------------------------- |
| Host   | Everything an editor can, plus change participants' roles and remove participants |
| Editor | Edit files, create/rename/delete files, post in chat; the default role for guests |
| Viewer | Watch edits and post in chat; cannot edit files or obtain EV3 control             |

Removing a participant disconnects them and revokes their access and recovery credential.

Changing roles reconnects that participant using the room's confirmed document state. Changes rejected while the participant was a viewer are discarded instead of being resent after promotion.

## Editing together

`.bp`, `.bpi`, `.bpm` and `.json` project files are edited together in real time. Each participant's cursor and selection appears in the editor, labelled with their name and color. The file tree is shared too: creating, renaming or deleting a file propagates to everyone.

A shared project can contain up to 200 files, each up to 1 MiB, with at most 8 MiB of shared text in total (measured as UTF-8). Directories do not count toward the file limit. Before sharing, the create dialog lists supported files and files excluded by format or size limits. Synchronization errors include a retry action.

Editing, file operations and chat sending pause during disconnection and initial synchronization. Concurrent shared-text edits are merged automatically with Yjs. Local disk changes still use revision checks; the app reports file-write errors and external-change conflicts when they need attention.

## Where files live

- **Host:** edits are written to the host's own project folder, as in a normal session.
- **Guests:** the project is mirrored into a folder inside the app's user data directory, `<userData>/collab/<room>/`. Guests can build and use the simulator from this mirror, and upload to their EV3 while holding device control.

Returning hosts reopen the original project rather than the currently selected project. If its path is missing, choose its location.

Before rejoining, Kobrixa compares the local project with the last room sync. If files were added, changed or removed since then, a dialog lists them and offers three choices:

- **Keep a local copy, then join** (default): saves the current files, including unsaved drafts, to a separate folder under `<userData>/collab-backups/`, then joins. Synchronization cannot overwrite local files until the copy succeeds; if it fails, nothing changes and an error is shown. The status bar shows where the copy was saved.
- **Replace with room version**: joins without a separate copy, so the room's version overwrites the local changes. Earlier versions of overwritten files can still be restored from local history while **Record local history** is turned on.
- **Cancel**: returns to the lobby without changing anything.

Guest mirrors show **Shared** or **Offline**, with a **Save shared project copy** action.

Closing or switching the right pane only changes visibility. **Leave room** saves drafts and finishes local writes before disconnecting only you. Shared edits that have not been acknowledged are saved as a separate copy before exit; failed writes keep the room open for retry. The host can choose **End room** from the room menu and confirm to disconnect everyone and invalidate the room. Local projects remain. Host ownership never transfers automatically when the host goes offline.

## Device control

To prevent several people driving the same EV3 at once, only the participant who holds device control can upload, run or deploy programs, start motor tests, manage EV3 files or change sensor modes. The host holds control by default. Other participants can request control; the host grants it or takes it back.

Stopping a running program is always allowed, whoever holds control.

## Chat

The collaboration pane includes a plain-text chat with the room header always visible. Messages are limited to 2,000 characters, and the room keeps the most recent 500 messages. Viewers can post too. Authors and timestamps come from the server; persistent message IDs prevent duplicate retries. Drafts clear only after confirmation and remain available after leaving or restarting. Reading older messages does not force scrolling; select **View new messages** to return to the bottom. Messages count as read only at the bottom while the window is visible.

## Workbench panels

**Collaborate** and **EV3** are independent toolbar entries that share the right side. Clicking the active entry collapses it; switching preserves connection, work, selected tabs and scroll positions. The EV3 pane contains Connection, Monitor and EV3 files. Member management and device-control requests live in collaboration. **Activity** is beside **Diagnostics** at the bottom. The right pane defaults to 360 px and resizes from 320–520 px; narrow windows use an overlay. The existing EV3 shortcut remains, and a customizable collaboration command is available.

## Privacy and data

- Room content, including project files, chat messages and display names, is stored on the collaboration service while the room is in use. It is deleted automatically after seven days without any connection.
- The service runs on Cloudflare, so source code passes through Cloudflare's network.
- Do not post invite codes or room passwords publicly; people who can join can read and, as editors, change the project.
- The app connects only to the configured collaboration origin. Its Content-Security-Policy allows that origin and no other collaboration endpoint.

Do not use collaboration for content you are not allowed to share with a third-party service.

## For developers

The default service is `https://collab.kobrixa.com`. Set the `KOBRIXA_COLLAB_URL` environment variable before launching the desktop app to use another service, for example a local one:

```sh
cp apps/collab/.dev.vars.example apps/collab/.dev.vars   # then set COLLAB_SECRET
pnpm --filter @kobrixa/collab dev
KOBRIXA_COLLAB_URL=http://localhost:8787 pnpm dev
```

`COLLAB_SECRET` is the HMAC key used to sign room tokens; any long random string works locally. `.dev.vars` is ignored by Git. Use the address printed by `wrangler dev` if it differs from the example. The service boundaries are described in [Architecture and public contracts](../en/architecture.md#cloud-collaboration).

Encoded Yjs documents and individual WebSocket messages are limited to 16 MiB to bound synchronization and history overhead. Oversized updates are rejected before acceptance. These service limits keep room snapshots below the platform's message and memory constraints.

Run `pnpm build:core && pnpm test:collab:live` to exercise the real local Worker with two clients, including passwordless and protected rooms, rejected passwords, persistent identities and role recovery, file mirrors, edits, chat, control permissions, role changes, removal and persistence across a Worker restart. Run `KOBRIXA_SMOKE_COLLAB_LINKED=1 pnpm test:desktop:smoke` for the integrated desktop workflow. Both use local test data.

After deploying a service, run `pnpm test:collab:remote https://collab.kobrixa.com` to verify the same two-client workflow against that origin. This creates two rooms containing only synthetic test data, ends the main test room and closes all clients; any remaining test room expires under the normal seven-day idle policy. It verifies server state and revoked access across fresh client connections without restarting the deployed Worker. The origin must be provided explicitly; HTTP is accepted only for loopback addresses.

## Acceptance status

The candidate has automated unit, local Worker and Electron integration coverage. The default public service was deployed and passed the two-client remote workflow, including optional room passwords, on 2026-10-08. The workbench matrix covers 980×650 and 1420×900 windows, 320/360/520 px panels, English/Traditional Chinese, dark/light themes and 100%/125% scale on macOS. Platform packaging is checked separately in CI. Physical EV3 acceptance remains separate; it is not completed by these collaboration tests.

Desktop requests advertise `X-Collab-Capabilities: resume-v1` to enable additive recovery response fields. Deploy the compatible Worker before distributing the updated desktop; `.12` strict response shapes remain unchanged without the header.
