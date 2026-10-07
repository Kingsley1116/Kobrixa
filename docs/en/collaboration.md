# Cloud collaboration

> **Release candidate.** Cloud collaboration is implemented on the candidate branch and is not part of a published release yet. Running it requires a configured collaboration service; deployment of the default public endpoint is separate from this implementation.

Several people can edit one Kobrixa project at the same time through a Kobrixa-operated collaboration service. No account is needed: the host starts a room and shares an invite code, and guests join with that code. Everyone sees the same files, cursors and chat; only one person at a time controls the EV3.

## Starting and joining a room

**Host:** open a project, then open the tools panel's **Collaborate** tab. Enter a display name and select **Start a room**. The tab shows an invite code such as `ABCD-EFGH-JK23`; share it with the people you want to invite.

**Guest:** open the **Collaborate** tab, enter the invite code and a display name, and join. Guests do not need a copy of the project; it arrives from the room.

- Display names are up to 40 characters. A room holds up to 16 participants.
- Anyone who has the invite code can join. Treat it like a password and share it only with the intended people.
- Room access tokens are signed by the service and are valid for seven days.

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
- Do not post invite codes publicly; anyone with the code can read and, as an editor, change the project.
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

Run `pnpm build:core && pnpm test:collab:live` to exercise the real local Worker with two clients, including file mirrors, edits, chat, control permissions, role changes, removal and persistence across a Worker restart. Run `KOBRIXA_SMOKE_COLLAB_LINKED=1 pnpm test:desktop:smoke` for the integrated desktop workflow. Both use local test data.

## Acceptance status

The candidate has automated unit, local Worker and Electron integration coverage. Public-service deployment and release acceptance remain separate steps before this feature ships.
