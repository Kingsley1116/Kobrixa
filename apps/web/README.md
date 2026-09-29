# Kobrixa web

React + Vite website for the product pages, documentation and browser-based EV3 media tools.

> [繁體中文版](README.zh-TW.md)

## Source layout

```text
src/
├── main.tsx                    # React bootstrap; global and shared control styles
├── vite-env.d.ts               # Vite asset import declarations
├── app/
│   ├── app.tsx                # Locale persistence, outlet and route focus/scroll behavior
│   └── router.tsx             # Route table and page wiring
├── components/                # Shared navigation, controls and their CSS
├── features/
│   ├── home/                  # Home page and its content
│   ├── product/               # Features and download pages, with their CSS
│   ├── docs/                  # Documentation pages, Markdown imports and API reference
│   └── tools/
│       ├── tools-page.tsx     # Media studio tabs and page layout
│       ├── tools.css          # Media studio styles
│       ├── components/        # Image/audio editors and tool-specific UI
│       └── lib/               # Conversion, encoding, export helpers and colocated tests
└── styles/
    └── global.css             # Existing site-wide stylesheet, including home/docs styles
```

Keep feature-specific components and logic inside their feature. Put components in
`src/components/` only when multiple page features use them. Keep tests beside the
module they cover as `*.test.ts`; the web Vitest configuration discovers them recursively.
Use direct relative imports with `.js` specifiers for TypeScript modules, matching the
workspace's NodeNext convention. No barrel exports are required.

Documentation Markdown remains in the repository's `docs/` directory and is imported
by `features/docs/docs-content.ts`. Static public files stay in `public/`; source artwork
stays in `artwork/`. The HTML entry point remains `/src/main.tsx`.

## Local commands

Run from the repository root:

```sh
pnpm --filter @kobrixa/web dev
pnpm --filter @kobrixa/web check
pnpm --filter @kobrixa/web test
pnpm --filter @kobrixa/web build
```

## Community Gallery

Production: [kobrixa.com/gallery](https://kobrixa.com/gallery). Deployed on
2026-09-24 with Worker version `bff3c938-3341-4f10-8790-74a76933a7b1` (shared controls across Gallery, tools, and documentation).
Stable version before the shared-controls update for rollback: `3d686fa6-fe64-4f0a-a804-bada65ef3829`.
Pre-Gallery website version: `ce816d79-1a24-4fd4-b5c2-f93ff63fab35`.

The Gallery adds a Worker API to the existing SPA. D1 stores accounts, hashed
sessions, entries and moderation history; the private `MEDIA` R2 binding stores
only validated EV3 files. Originals are decoded locally in the browser and never
sent to the server. Gallery UI and API errors support Traditional Chinese and English.

### Local setup

1. Install workspace dependencies with `pnpm install --frozen-lockfile`.
2. Copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars`. Never commit that file.
3. Create a **separate development GitHub OAuth App** with homepage
   `http://localhost:8787` and callback `http://localhost:8787/api/auth/callback`.
   Fill in its client ID and secret in `.dev.vars`. The app requests no repository scopes.
4. Run `pnpm --filter @kobrixa/web db:local` to apply the migrations to local D1.
5. Run `pnpm --filter @kobrixa/web preview:worker` and open `http://localhost:8787/gallery`.
   Wrangler uses local D1 and R2 by default; no production data is needed.

For Vite hot reload, set `SITE_ORIGIN=http://localhost:5173` in `.dev.vars`, change
the development OAuth callback to `http://localhost:5173/api/auth/callback`, keep
Wrangler running on port 8787, and run `pnpm --filter @kobrixa/web dev`. Vite proxies
`/api` to that Worker. Local HTTP uses a host-only HttpOnly session cookie;
production HTTPS uses a Secure `__Host-` cookie. Do not expose the local server publicly.

`pnpm --filter @kobrixa/web check` generates runtime/binding types from Wrangler
and checks both frontend and Worker TypeScript. Generated runtime types are ignored.
`pnpm --filter @kobrixa/web test` runs media unit tests plus isolated Miniflare
integration tests. `test:worker` can be run separately. Integration tests mock
GitHub's server responses and use temporary D1/R2 data; they do not add a development
login bypass to the application.

### Production setup

The production `kobrixa-gallery` D1 database and private R2 bucket are already
provisioned, and the D1 ID is recorded in `wrangler.jsonc`. The production GitHub
OAuth app is **Kobrixa Gallery** (application ID `3878675`); its public client ID is
also configured. Keep the client secret only in the Worker secret binding.

For a fresh Cloudflare account, run the following from `apps/web`:

```sh
pnpm exec wrangler d1 create kobrixa-gallery
pnpm exec wrangler r2 bucket create kobrixa-gallery
```

Set the returned D1 `database_id` on the `DB` binding in `wrangler.jsonc`. Keep the
R2 bucket private: do **not** enable an r2.dev endpoint or public bucket custom domain.
For a fresh installation, create a production GitHub OAuth App with homepage `https://kobrixa.com` and callback
`https://kobrixa.com/api/auth/callback`. Set `GITHUB_CLIENT_ID` in Wrangler vars, then
store the secret through the interactive prompt:

```sh
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler d1 migrations apply DB --remote
pnpm run deploy
```

`GALLERY_ADMIN_IDS` is a comma-separated list of stable numeric IDs, never usernames.
The server evaluates this list for every authenticated request. No private credentials
belong in `VITE_*` variables. A missing OAuth configuration disables the login entry
point and returns 503 from OAuth endpoints.

The migration only creates Gallery tables and indexes. Before future schema
migrations, back up D1 with `wrangler d1 export DB --remote --output backup.sql`.
Rollback a bad code deployment with `wrangler rollback`; do not drop Gallery data.
The daily cron removes expired OAuth states/sessions and at most 100 orphan upload
batches older than 24 hours. Referenced drafts and rejected works are retained.
Upload batches are recorded _before_ writing R2, so partial/interrupted uploads can
be collected safely. Monitor structured `gallery_request_failed` Worker log events,
OAuth callback failures reported by users, and scheduled invocation failures.

### API and moderation contract

- `GET /api/auth/me`, `GET /api/auth/github`, `GET /api/auth/callback`,
  `POST /api/auth/logout` implement GitHub login, identity and logout.
- `GET /api/gallery?scope=public|mine|admin&kind=image|audio&q=...&page=1`
  returns `{ items, more }`, 24 entries per page. Public results sort by publication
  time, personal/admin results by update time, with an ID tie-breaker.
- `POST /api/gallery` creates a draft; `PUT /api/gallery/:id` edits an owned draft,
  rejected or withdrawn work. Both accept multipart `title`, `description`, and
  ordered `files`. Updates require `version`; omitted files retain existing media.
- `GET /api/gallery/:id` returns metadata. `POST /api/gallery/:id/submit` requires
  `{ version, agreement: true }`; `withdraw`, `approve`, `reject`, and `takedown`
  require `{ version }`, with a nonempty `reason` for rejection/removal.
- `GET /api/gallery/:id/preview`, `/archive`, and `/files/:index` generate a preview,
  an attribution-bearing ZIP, or download the selected EV3 file. Every request
  checks publication/ownership/admin access; all API responses use `no-store`.

A submitted work is read-only until withdrawn or reviewed. Public works must be
withdrawn before editing. Both author withdrawals and admin removals require a new
review before publication. SQL conditional updates prevent stale approvals and
simultaneous decisions; database triggers enforce daily quotas and record changes.
The quota triggers use `SELECT RAISE(...) WHERE ...` to remain compatible with
remote D1 SQL parsing; avoid nested CASE/END in these triggers. Quota days use UTC. Limits are 20 submissions and 100 uploaded batches per account
per day; submission includes an explicit CC BY 4.0 agreement. Drafts do not consume
submission quota. Retry a failed submission from My works; its saved draft remains.

Source limits: images 20 MiB, audio 50 MiB, selected output at most 60 seconds.
Accepted native media: RGF up to 176×128 and uncompressed 8 kHz RSF with exact
payload lengths. Up to eight RSFs can form one ordered work. The multipart request
is capped at 1 MiB, including headers and metadata. Files get canonical generated
names; uploaded archives, scripts, HTML and arbitrary previews are not accepted.
The Gallery's audio preview contains the exact quantized PCM from the RSFs. The
ZIP uses generated playback code, never user-supplied code. EV3 file boundaries
may cause short pauses that the browser preview does not reproduce.

### Release verification

After setting production credentials, use the real GitHub flow to submit an image
and a long audio sample. Confirm the administrator can preview and approve them,
and a signed-out browser can download matching bytes only after approval. Withdraw
or remove each work and verify the list, preview, ZIP and direct file URL no longer
serve it anonymously. Test both locales and narrow/mobile layouts. The automated
suite covers these state and permission boundaries with mocked GitHub responses;
it does not validate production OAuth credentials or physical EV3 playback.

## Shared interface controls

`src/components/ui/` owns the Select, AudioPlayer, FileDrop, and opt-in control
styles. Add the appropriate `ui-control`, `ui-choice`, `ui-range`, or
`ui-disclosure` class instead of introducing broad input/button/fieldset rules.
Select renders its popup in a portal, supports keyboard navigation and typeahead,
and keeps the active option visible without scrolling the page behind it.
AudioPlayer fetches on demand and allows only one Gallery player at a time.
FileDrop retains native file-picker behavior and respects disabled fieldsets.

The jsdom interaction suite covers keyboard selection/cancellation, popup
positioning, audio lifecycle/retry/source replacement, and file selection/drop
states. Run it with `pnpm exec vitest run --project web`; Worker integration
tests remain available through `pnpm --filter @kobrixa/web test:worker`.
