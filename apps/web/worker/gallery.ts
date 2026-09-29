import {
  GalleryError,
  GALLERY_LIMITS,
  validateParts,
  imageSvg,
  audioWav,
  galleryArchive,
} from "../src/shared/gallery.js";
import type { GalleryEntry, GalleryUser, GalleryFile } from "../src/shared/gallery.js";
import { requireUser } from "./auth.js";
import type { GalleryEnv } from "./auth.js";
type Row = Omit<GalleryEntry, "files"> & { files: string; upload_id: string };
const select =
  "SELECT entries.*, users.login AS author FROM entries JOIN users ON users.id=entries.owner_id";
const now = () => Math.floor(Date.now() / 1000);
function decode(row: Row): GalleryEntry {
  return {
    id: row.id,
    owner_id: row.owner_id,
    author: row.author,
    title: row.title,
    description: row.description,
    kind: row.kind,
    status: row.status,
    version: row.version,
    files: JSON.parse(row.files) as GalleryFile[],
    reason: row.reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
  };
}
export async function getEntry(env: GalleryEnv, id: string, user: GalleryUser | null) {
  const row = await env.DB.prepare(`${select} WHERE entries.id=?`).bind(id).first<Row>();
  if (!row || (row.status !== "published" && row.owner_id !== user?.id && !user?.admin))
    throw new GalleryError("not_found", 404);
  return decode(row);
}
export async function limitedBody(
  req: Request,
  limit = GALLERY_LIMITS.requestBytes,
): Promise<ArrayBuffer> {
  if (Number(req.headers.get("Content-Length")) > limit) throw new GalleryError("too_large", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new GalleryError("invalid");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw new GalleryError("too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}
async function json(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await limitedBody(req, 16384)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof GalleryError) throw e;
    throw new GalleryError("invalid");
  }
}
function version(value: unknown) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new GalleryError("invalid");
  return n;
}
async function save(req: Request, env: GalleryEnv, user: GalleryUser, id?: string) {
  const old = id ? await getEntry(env, id, user) : null;
  if (old && old.owner_id !== user.id) throw new GalleryError("forbidden", 403);
  if (old?.status === "published" || old?.status === "pending")
    throw new GalleryError("conflict", 409);
  let form: FormData;
  try {
    form = await new Response(await limitedBody(req), {
      headers: { "Content-Type": req.headers.get("Content-Type") ?? "" },
    }).formData();
  } catch (e) {
    if (e instanceof GalleryError) throw e;
    throw new GalleryError("invalid");
  }
  const title = form.get("title"),
    description = form.get("description");
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.trim().length > 120 ||
    typeof description !== "string" ||
    description.length > 2000
  )
    throw new GalleryError("invalid");
  const expected = old ? version(form.get("version")) : 1;
  const raw = form.getAll("files");
  if ((!old && !raw.length) || raw.length > 8 || raw.some((f) => typeof f === "string"))
    throw new GalleryError("invalid");
  let files = old?.files,
    kind = old?.kind;
  let uploadId: string | undefined;
  if (raw.length) {
    const parts = await Promise.all(
      (raw as File[]).map(async (f) => ({
        name: f.name,
        bytes: new Uint8Array(await f.arrayBuffer()),
      })),
    );
    const infos = validateParts(parts);
    kind = infos[0]!.kind;
    uploadId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO upload_batches(id,owner_id,created_at) VALUES(?,?,?)")
      .bind(uploadId, user.id, now())
      .run();
    files = parts.map((p, i) => ({
      ...infos[i]!,
      name:
        kind === "image"
          ? "image.rgf"
          : parts.length === 1
            ? "sound.rsf"
            : `sound-${String(i + 1).padStart(3, "0")}.rsf`,
      key: `${uploadId}/${i}`,
      size: p.bytes.length,
    }));
    // Register before writing; scheduled cleanup can recover even interrupted uploads.
    for (let i = 0; i < parts.length; i++) await env.MEDIA.put(files[i]!.key, parts[i]!.bytes);
  }
  if (!files || !kind) throw new GalleryError("invalid");
  const entryId = id ?? crypto.randomUUID();
  if (old) {
    const updated = await env.DB.prepare(
      "UPDATE entries SET title=?,description=?,kind=?,files=?,upload_id=COALESCE(?,upload_id),status='draft',reason='',version=version+1,actor_id=?,updated_at=? WHERE id=? AND owner_id=? AND version=? AND status IN ('draft','rejected','withdrawn') RETURNING id",
    )
      .bind(
        title.trim(),
        description.trim(),
        kind,
        JSON.stringify(files),
        uploadId ?? null,
        user.id,
        now(),
        entryId,
        user.id,
        expected,
      )
      .first();
    if (!updated) throw new GalleryError("conflict", 409);
  } else {
    await env.DB.prepare(
      "INSERT INTO entries(id,owner_id,title,description,kind,upload_id,files,actor_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        entryId,
        user.id,
        title.trim(),
        description.trim(),
        kind,
        uploadId!,
        JSON.stringify(files),
        user.id,
        now(),
        now(),
      )
      .run();
  }
  return Response.json(await getEntry(env, entryId, user), { status: old ? 200 : 201 });
}
async function action(
  req: Request,
  env: GalleryEnv,
  user: GalleryUser,
  id: string,
  action: string,
) {
  const entry = await getEntry(env, id, user),
    body = await json(req),
    expected = version(body.version);
  let status: string,
    allowed: string[],
    reason = "";
  if (action === "submit" || action === "withdraw") {
    if (entry.owner_id !== user.id) throw new GalleryError("forbidden", 403);
    if (action === "submit") {
      if (body.agreement !== true) throw new GalleryError("invalid");
      // Verify every object still exists before making the complete submission reviewable.
      for (const f of entry.files)
        if (!(await env.MEDIA.head(f.key))) throw new GalleryError("unavailable", 503);
      status = "pending";
      allowed = ["draft", "rejected", "withdrawn"];
    } else {
      status = "withdrawn";
      allowed = ["published", "pending"];
    }
  } else {
    if (!user.admin) throw new GalleryError("forbidden", 403);
    if (action === "approve") {
      status = "published";
      allowed = ["pending"];
    } else if (action === "reject" || action === "takedown") {
      if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 2000)
        throw new GalleryError("invalid");
      reason = body.reason.trim();
      status = action === "reject" ? "rejected" : "withdrawn";
      allowed = action === "reject" ? ["pending"] : ["published"];
    } else throw new GalleryError("not_found", 404);
  }
  const changed = await env.DB.prepare(
    `UPDATE entries SET status=?,reason=?,version=version+1,actor_id=?,updated_at=?,published_at=CASE WHEN ?='published' THEN ? ELSE published_at END WHERE id=? AND version=? AND status IN (${allowed.map(() => "?").join(",")}) RETURNING id`,
  )
    .bind(status, reason, user.id, now(), status, now(), id, expected, ...allowed)
    .first();
  if (!changed) throw new GalleryError("conflict", 409);
  return Response.json(await getEntry(env, id, user));
}
export async function galleryRoute(
  req: Request,
  env: GalleryEnv,
  user: GalleryUser | null,
): Promise<Response> {
  const url = new URL(req.url),
    path = url.pathname;
  if (path === "/api/gallery" && req.method === "GET") {
    const scope = url.searchParams.get("scope") ?? "public",
      kind = url.searchParams.get("kind") ?? "",
      q = (url.searchParams.get("q") ?? "").trim();
    const page = Number(url.searchParams.get("page") ?? 1);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 10000 ||
      q.length > 120 ||
      !["", "image", "audio"].includes(kind)
    )
      throw new GalleryError("invalid");
    const clauses: string[] = [],
      bindings: (string | number)[] = [];
    if (scope === "mine") {
      clauses.push("owner_id=?");
      bindings.push(requireUser(user).id);
    } else if (scope === "admin") {
      if (!requireUser(user).admin) throw new GalleryError("forbidden", 403);
      clauses.push("status IN ('pending','published','withdrawn','rejected')");
    } else if (scope === "public") clauses.push("status='published'");
    else throw new GalleryError("invalid");
    if (kind) {
      clauses.push("kind=?");
      bindings.push(kind);
    }
    if (q) {
      clauses.push(
        "(instr(lower(title),lower(?))>0 OR instr(lower(description),lower(?))>0 OR instr(lower(users.login),lower(?))>0)",
      );
      bindings.push(q, q, q);
    }
    const rows = await env.DB.prepare(
      `${select} WHERE ${clauses.join(" AND ")} ORDER BY ${scope === "public" ? "published_at" : "updated_at"} DESC, entries.id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, GALLERY_LIMITS.pageSize + 1, (page - 1) * GALLERY_LIMITS.pageSize)
      .all<Row>();
    return Response.json({
      items: rows.results.slice(0, GALLERY_LIMITS.pageSize).map(decode),
      more: rows.results.length > GALLERY_LIMITS.pageSize,
    });
  }
  if (path === "/api/gallery" && req.method === "POST") return save(req, env, requireUser(user));
  const match =
    /^\/api\/gallery\/([a-zA-Z0-9-]+)(?:\/(preview|archive|files\/\d+|submit|withdraw|approve|reject|takedown))?$/.exec(
      path,
    );
  if (!match) throw new GalleryError("not_found", 404);
  const id = match[1]!,
    tail = match[2];
  if (req.method === "PUT" && !tail) return save(req, env, requireUser(user), id);
  if (req.method === "POST" && tail) return action(req, env, requireUser(user), id, tail);
  if (req.method !== "GET") throw new GalleryError("not_found", 404);
  const entry = await getEntry(env, id, user);
  if (!tail) return Response.json(entry);
  if (!["preview", "archive"].includes(tail) && !tail.startsWith("files/"))
    throw new GalleryError("not_found", 404);
  const read = async (f: GalleryFile) => {
    const obj = await env.MEDIA.get(f.key);
    if (!obj) throw new GalleryError("unavailable", 503);
    return new Uint8Array(await obj.arrayBuffer());
  };
  if (tail.startsWith("files/")) {
    const f = entry.files[Number(tail.split("/")[1])];
    if (!f) throw new GalleryError("not_found", 404);
    return new Response(await read(f), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${f.name}"`,
      },
    });
  }
  const parts = await Promise.all(entry.files.map(read));
  if (tail === "archive")
    return new Response(galleryArchive(entry, parts, env.SITE_ORIGIN), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="ev3-media.zip"',
      },
    });
  return entry.kind === "image"
    ? new Response(imageSvg(parts[0]!), {
        headers: {
          "Content-Type": "image/svg+xml",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      })
    : new Response(audioWav(parts), { headers: { "Content-Type": "audio/wav" } });
}
export async function cleanup(env: GalleryEnv) {
  const cutoff = now() - 86400;
  const batches = await env.DB.prepare(
    "SELECT id FROM upload_batches WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM entries WHERE upload_id=upload_batches.id) LIMIT 100",
  )
    .bind(cutoff)
    .all<{ id: string }>();
  for (const batch of batches.results) {
    const objects = await env.MEDIA.list({ prefix: `${batch.id}/` });
    if (objects.objects.length) await env.MEDIA.delete(objects.objects.map((o) => o.key));
    await env.DB.prepare("DELETE FROM upload_batches WHERE id=?").bind(batch.id).run();
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now()),
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(now()),
  ]);
}
