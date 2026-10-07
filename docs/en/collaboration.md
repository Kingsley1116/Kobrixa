# Cloud collaboration

> **Release candidate.** Cloud collaboration is included starting with `v0.1.0-v1-candidate.12`. The default service at `https://collab.kobrixa.com` is deployed and available for this candidate.

Several people can edit one Kobrixa project at the same time through a Kobrixa-operated collaboration service. No account is needed: the host starts a room and shares an invite code, and guests join with that code and the optional room password. Everyone sees the same files, cursors and chat; only one person at a time controls the EV3.

## Starting and joining a room

**Host:** open a project, then open the tools panel's **Collaborate** tab. Enter a display name and select **Start a room**. You can set a room password in the dialog or leave it blank. The tab shows an invite code such as `ABCD-EFGH-JK23`; share it with the people you want to invite.

**Guest:** open the **Collaborate** tab, enter the invite code, a display name and the room password if the host set one, and join. Guests do not need a copy of the project; it arrives from the room.

- Display names are up to 40 characters. A room holds up to 16 participants.
- Without a room password, anyone with the invite code can join. With a password, both are required. Share them only with the intended people.
- Room passwords are case-sensitive, preserve spaces and allow up to 128 characters. The service stores a salted password verifier, not the password.
- The app keeps room access tokens only in memory and does not use the system keychain for collaboration. Passwords are not saved. Quitting the app or leaving the room forgets access; rejoin with the invite code and password if required. A returning host joins as a guest; start a new room to host again.
- Room access tokens are signed by the service and are valid for seven days within that session.

## Roles

| Role   | Can do                                                                                     |
| ------ | ------------------------------------------------------------------------------------------ |
| Host   | Everything an editor can, plus change participants' roles and remove participants          |
| Editor | Edit files, create/rename/delete files, post in chat; the default role for guests          |
| Viewer | Read-only: watch edits and read chat, but cannot edit, post chat messages, or change files |

Removing a participant disconnects them and revokes their token.

Changing roles reconnects that participant using the room's confirmed document state. Changes rejected while the participant was a viewer are discarded instead of being resent after promotion.

## Editing together

`.bp`, `.bpi`, `.bpm` and `.json` project files are edited together in real time. Each participant's cursor and selection appears in the editor, labelled with their name and color. The file tree is shared too: creating, renaming or deleting a file propagates to everyone.

A shared project can contain up to 200 files, each up to 1 MiB, with at most 8 MiB of shared text in total (measured as UTF-8). Directories do not count toward the file limit. Files beyond these limits are skipped during room creation and listed in the sync status.

Concurrent shared-text edits are merged automatically with Yjs. Local disk changes still use revision checks; the app reports file-write errors and external-change conflicts when they need attention.

## Where files live

- **Host:** edits are written to the host's own project folder, as in a normal session.
- **Guests:** the project is mirrored into a folder inside the app's user data directory, `<userData>/collab/<room>/`. Guests can build and use the simulator from this mirror, and upload to their EV3 while holding device control.

## Device control

To prevent several people driving the same EV3 at once, only the participant who holds device control can upload, run or deploy programs, start motor tests, manage EV3 files or change sensor modes. The host holds control by default. Other participants can request control; the host grants it or takes it back.

Stopping a running program is always allowed, whoever holds control.

## Chat

The **Collaborate** tab includes a plain-text chat. Messages are limited to 2,000 characters, and the room keeps the most recent 500 messages. Viewers can read chat but cannot post.

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

Run `pnpm build:core && pnpm test:collab:live` to exercise the real local Worker with two clients, including passwordless and protected rooms, rejected passwords, memory-only credentials, file mirrors, edits, chat, control permissions, role changes, removal and persistence across a Worker restart. Run `KOBRIXA_SMOKE_COLLAB_LINKED=1 pnpm test:desktop:smoke` for the integrated desktop workflow. Both use local test data.

After deploying a service, run `pnpm test:collab:remote https://collab.kobrixa.com` to verify the same two-client workflow against that origin. This creates two rooms containing only synthetic test data, then closes all clients; the rooms expire under the normal seven-day idle policy. It verifies server state and revoked access across fresh client connections without restarting the deployed Worker. The origin must be provided explicitly; HTTP is accepted only for loopback addresses.

## Acceptance status

The candidate has automated unit, local Worker and Electron integration coverage. The default public service was deployed and passed the two-client remote workflow, including optional room passwords, on 2026-10-08. Windows x64, Linux x64 and macOS Apple Silicon builds pass automated packaged-application checks. Physical EV3 acceptance remains separate; it is not completed by these collaboration tests.
