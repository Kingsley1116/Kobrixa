import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
let mf, db, bucket;
const origin = "https://gallery.test";
const digest = (s) => createHash("sha256").update(s).digest("hex");
const image = new Uint8Array([2, 2, 1, 2]);
const sound = new Uint8Array([1, 0, 0, 3, 31, 64, 0, 0, 0, 128, 255]);
let failGitHub = false;
before(async () => {
  const bundle = await build({
    entryPoints: [new URL("index.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-09-06",
      d1Databases: ["DB"],
      r2Buckets: ["MEDIA"],
      bindings: {
        SITE_ORIGIN: origin,
        GITHUB_CLIENT_ID: "client",
        GITHUB_CLIENT_SECRET: "secret",
        GALLERY_ADMIN_IDS: "2",
      },
      outboundService: async (req) => {
        if (failGitHub) return Response.json({ error: "failed" }, { status: 500 });
        const url = new URL(req.url);
        if (url.hostname === "github.com") return Response.json({ access_token: "test-access" });
        if (url.hostname === "api.github.com")
          return Response.json({ id: 99, login: "oauth-user" });
        return new Response(null, { status: 404 });
      },
    }),
  );
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("MEDIA");
  const migration = await readFile(
    new URL("../migrations/0001_gallery.sql", import.meta.url),
    "utf8",
  );
  // exec accepts one SQL statement per line; triggers contain multiple semicolons.
  const statements = migration.match(/CREATE TRIGGER[\s\S]*?\nEND;|CREATE (?!TRIGGER)[\s\S]*?;/g);
  for (const sql of statements) await db.prepare(sql).run();
  for (const [id, login] of [
    ["1", "author"],
    ["2", "admin"],
    ["3", "other"],
  ]) {
    await db.prepare("INSERT INTO users VALUES(?,?)").bind(id, login).run();
    await db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .bind(digest(login), id, Math.floor(Date.now() / 1000) + 3600)
      .run();
  }
});
after(async () => {
  await mf?.dispose();
});
async function request(path, { user, method = "GET", body, headers = {} } = {}) {
  const h = { ...headers };
  if (user) h.Cookie = `__Host-kobrixa-session=${user}`;
  if (method !== "GET") h.Origin ??= origin;
  if (body && !(body instanceof FormData)) {
    h["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  if (body instanceof FormData) {
    const encoded = new Request(origin, { method: "POST", body });
    h["Content-Type"] = encoded.headers.get("Content-Type");
    body = await encoded.arrayBuffer();
  }
  return mf.dispatchFetch(`${origin}/api/${path}`, {
    method,
    headers: h,
    ...(body ? { body } : {}),
    redirect: "manual",
  });
}
async function upload({
  user = "author",
  bytes = image,
  name = "hello.rgf",
  id,
  version = 1,
  title = "Example",
} = {}) {
  const form = new FormData();
  form.set("title", title);
  form.set("description", "A test work");
  form.set("version", String(version));
  form.append("files", new Blob([bytes]), name);
  return request(`gallery${id ? `/${id}` : ""}`, { user, method: id ? "PUT" : "POST", body: form });
}
async function create(options) {
  const res = await upload(options);
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}
async function action(entry, verb, user = "author", extra = {}) {
  return request(`gallery/${entry.id}/${verb}`, {
    user,
    method: "POST",
    body: { version: entry.version, agreement: true, ...extra },
  });
}
async function published(options) {
  let e = await create(options);
  e = await (await action(e, "submit")).json();
  return (await action(e, "approve", "admin")).json();
}
test("drafts and pending objects stay private, approved files download byte-for-byte", async () => {
  let e = await create();
  for (const suffix of ["", "/preview", "/archive", "/files/0"]) {
    assert.equal((await request(`gallery/${e.id}${suffix}`)).status, 404);
    assert.equal((await request(`gallery/${e.id}${suffix}`, { user: "other" })).status, 404);
  }
  assert.equal((await request(`gallery/${e.id}/preview`, { user: "admin" })).status, 200);
  e = await (await action(e, "submit")).json();
  assert.equal(e.status, "pending");
  assert.equal((await request(`gallery/${e.id}/files/0`)).status, 404);
  assert.equal((await action(e, "approve", "other")).status, 404);
  e = await (await action(e, "approve", "admin")).json();
  assert.equal(e.status, "published");
  const file = await request(`gallery/${e.id}/files/0`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), image);
  assert.match(await (await request(`gallery/${e.id}/preview`)).text(), /<svg/);
  assert.equal((await request(`gallery/${e.id}/files/4`)).status, 404);
  const list = await (await request("gallery")).json();
  assert.ok(list.items.some((i) => i.id === e.id));
});
test("author editing requires withdrawal and stale decisions fail", async () => {
  let e = await published();
  assert.equal((await upload({ id: e.id, version: e.version })).status, 409);
  const old = e;
  e = await (await action(e, "withdraw")).json();
  assert.equal((await request(`gallery/${e.id}/preview`)).status, 404);
  assert.equal((await action(old, "takedown", "admin", { reason: "removed" })).status, 409);
  e = await (await upload({ id: e.id, version: e.version, title: "Revised" })).json();
  const pending = await (await action(e, "submit")).json();
  assert.equal((await action(e, "submit")).status, 409);
  const withdrawn = await (await action(pending, "withdraw")).json();
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal((await action(pending, "approve", "admin")).status, 409);
});
test("rejection and admin removal cannot be publicly fetched or author-published", async () => {
  let e = await create();
  e = await (await action(e, "submit")).json();
  assert.equal((await action(e, "reject", "admin")).status, 400);
  e = await (await action(e, "reject", "admin", { reason: "Please revise" })).json();
  assert.equal(e.reason, "Please revise");
  assert.equal((await request(`gallery/${e.id}/archive`)).status, 404);
  e = await (await action(e, "submit")).json();
  e = await (await action(e, "approve", "admin")).json();
  e = await (await action(e, "takedown", "admin", { reason: "Rights issue" })).json();
  assert.equal((await action(e, "approve")).status, 403);
  assert.equal((await request(`gallery/${e.id}`)).status, 404);
});
test("validation, same-origin writes and account boundaries", async () => {
  assert.equal((await request("gallery", { method: "POST" })).status, 401);
  assert.equal(
    (
      await request("gallery", {
        user: "author",
        method: "POST",
        headers: { Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  assert.equal((await upload({ name: "image.rgf", bytes: sound })).status, 400);
  assert.equal((await upload({ name: "evil.zip" })).status, 400);
  assert.equal((await upload({ bytes: new Uint8Array(1024 * 1024 + 1) })).status, 413);
  const e = await create();
  assert.equal((await upload({ user: "other", id: e.id })).status, 404);
  assert.equal((await request("gallery?scope=admin", { user: "author" })).status, 403);
  assert.equal((await request("gallery?scope=mine")).status, 401);
  assert.equal((await request("gallery?page=NaN")).status, 400);
});
test("sound preview and archive derive only from validated PCM", async () => {
  const e = await published({ bytes: sound, name: "sound.rsf", title: "Unique audio" });
  const wav = new Uint8Array(await (await request(`gallery/${e.id}/preview`)).arrayBuffer());
  assert.deepEqual([...wav.slice(44, 47)], [0, 128, 255]);
  const zip = await (await request(`gallery/${e.id}/archive`)).text();
  assert.match(zip, /ATTRIBUTION.txt/);
  assert.match(zip, /CC BY 4.0/);
  const list = await (await request("gallery?kind=audio&q=Unique")).json();
  assert.deepEqual(
    list.items.map((i) => i.id),
    [e.id],
  );
});
test("missing uploaded object never becomes reviewable", async () => {
  const e = await create();
  await bucket.delete(e.files[0].key);
  assert.equal((await action(e, "submit")).status, 503);
  assert.equal(
    (await (await request(`gallery/${e.id}`, { user: "author" })).json()).status,
    "draft",
  );
});
test("atomic moderation permits only one concurrent decision", async () => {
  let e = await create();
  e = await (await action(e, "submit")).json();
  const responses = await Promise.all([
    action(e, "approve", "admin"),
    action(e, "reject", "admin", { reason: "No" }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
});
test("OAuth state is bound to a cookie, one-time, and errors do not create sessions", async () => {
  const start = await request("auth/github"),
    target = new URL(start.headers.get("location"));
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.equal(target.searchParams.get("scope"), null);
  const cookie = start.headers.get("set-cookie").split(";")[0],
    state = target.searchParams.get("state");
  const denied = await request(`auth/callback?state=${state}&code=code`);
  assert.match(denied.headers.get("location"), /auth=failed/);
  const success = await request(`auth/callback?state=${state}&code=code`, {
    headers: { Cookie: cookie },
  });
  assert.match(success.headers.get("location"), /gallery\/submit$/);
  assert.match(success.headers.get("set-cookie"), /HttpOnly/);
  const replay = await request(`auth/callback?state=${state}&code=code`, {
    headers: { Cookie: cookie },
  });
  assert.match(replay.headers.get("location"), /auth=failed/);
  failGitHub = true;
  const retry = await request("auth/github"),
    retryUrl = new URL(retry.headers.get("location"));
  const failed = await request(
    `auth/callback?state=${retryUrl.searchParams.get("state")}&code=bad`,
    { headers: { Cookie: retry.headers.get("set-cookie").split(";")[0] } },
  );
  assert.match(failed.headers.get("location"), /auth=failed/);
  failGitHub = false;
});
test("daily submission quota is enforced inside the database", async () => {
  const e = await create({ user: "other" });
  for (let i = 0; i < 20; i++)
    await db
      .prepare(
        "INSERT INTO reviews(entry_id,actor_id,status,version,reason,created_at) VALUES(?,'3','pending',1,'',?)",
      )
      .bind(e.id, Math.floor(Date.now() / 1000))
      .run();
  const limited = await action(e, "submit", "other");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "quota");
});
test("long audio segments keep order in previews and ZIP playback code", async () => {
  const form = new FormData();
  form.set("title", "Sequence");
  form.set("description", "Two parts");
  form.append("files", new Blob([sound]), "part-1.rsf");
  form.append("files", new Blob([sound]), "part-2.rsf");
  let e = await (await request("gallery", { user: "author", method: "POST", body: form })).json();
  e = await (await action(e, "submit")).json();
  e = await (await action(e, "approve", "admin")).json();
  const wav = new Uint8Array(await (await request(`gallery/${e.id}/preview`)).arrayBuffer());
  assert.deepEqual([...wav.slice(44)], [0, 128, 255, 0, 128, 255]);
  const zip = await (await request(`gallery/${e.id}/archive`)).text();
  assert.match(zip, /sound-001.rsf/);
  assert.match(zip, /sound-002.rsf/);
  assert.match(zip, /play-sequence.bp/);
  assert.match(zip, /Speaker.Wait/);
});
test("stale file replacement stays orphaned and daily cleanup preserves referenced media", async () => {
  let e = await create();
  const oldKey = e.files[0].key;
  e = await (await upload({ id: e.id, version: e.version })).json();
  assert.equal((await upload({ id: e.id, version: 1 })).status, 409);
  const keys = await bucket.list();
  assert.ok(keys.objects.some((o) => o.key === oldKey));
  const cutoff = Math.floor(Date.now() / 1000) - 90000;
  await db.prepare("UPDATE upload_batches SET created_at=?").bind(cutoff).run();
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: "17 3 * * *" });
  assert.equal(await bucket.head(oldKey), null);
  assert.ok(await bucket.head(e.files[0].key));
  assert.equal((await request(`gallery/${e.id}/files/0`, { user: "author" })).status, 200);
});
test("metadata-only edit retains bytes and does not make a draft public", async () => {
  const e = await create();
  const form = new FormData();
  form.set("title", "Changed title");
  form.set("description", "");
  form.set("version", String(e.version));
  const response = await request(`gallery/${e.id}`, { user: "author", method: "PUT", body: form });
  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.equal(updated.title, "Changed title");
  assert.deepEqual(updated.files, e.files);
  assert.equal((await request(`gallery/${e.id}/files/0`)).status, 404);
});
test("expired sessions and logout revoke access", async () => {
  await db.prepare("INSERT INTO sessions VALUES(?,?,?)").bind(digest("expired"), "1", 1).run();
  assert.equal((await (await request("auth/me", { user: "expired" })).json()).user, null);
  assert.equal((await request("auth/logout", { user: "other", method: "POST" })).status, 200);
  assert.equal((await (await request("auth/me", { user: "other" })).json()).user, null);
});
