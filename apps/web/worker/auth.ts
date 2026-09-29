import { GalleryError } from "../src/shared/gallery.js";
import type { GalleryUser } from "../src/shared/gallery.js";
export type GalleryEnv = Env & { GITHUB_CLIENT_SECRET?: string };
const now = () => Math.floor(Date.now() / 1000);
export function token() {
  return crypto.randomUUID() + crypto.randomUUID();
}
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function cookieName(env: GalleryEnv, purpose: string) {
  return `${env.SITE_ORIGIN.startsWith("https:") ? "__Host-" : ""}kobrixa-${purpose}`;
}
function readCookie(req: Request, name: string) {
  return req.headers
    .get("Cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function cookie(env: GalleryEnv, purpose: string, value: string, age: number) {
  return `${cookieName(env, purpose)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${env.SITE_ORIGIN.startsWith("https:") ? "; Secure" : ""}`;
}
export async function userFor(req: Request, env: GalleryEnv): Promise<GalleryUser | null> {
  const value = readCookie(req, cookieName(env, "session"));
  if (!value) return null;
  const row = await env.DB.prepare(
    "SELECT users.id, users.login FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires_at>?",
  )
    .bind(await hash(value), now())
    .first<{ id: string; login: string }>();
  return row
    ? {
        ...row,
        admin: env.GALLERY_ADMIN_IDS.split(",")
          .map((s) => s.trim())
          .includes(row.id),
      }
    : null;
}
export function requireUser(user: GalleryUser | null): GalleryUser {
  if (!user) throw new GalleryError("unauthorized", 401);
  return user;
}
export function checkOrigin(req: Request, env: GalleryEnv) {
  if (
    req.headers.get("Origin") !== env.SITE_ORIGIN ||
    req.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    throw new GalleryError("forbidden", 403);
}
export async function authRoute(req: Request, env: GalleryEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/api/auth/me" && req.method === "GET")
    return Response.json({
      user: await userFor(req, env),
      loginAvailable: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    });
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const value = readCookie(req, cookieName(env, "session"));
    if (value)
      await env.DB.prepare("DELETE FROM sessions WHERE token=?")
        .bind(await hash(value))
        .run();
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": cookie(env, "session", "", 0) } },
    );
  }
  if (req.method !== "GET") throw new GalleryError("not_found", 404);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
    throw new GalleryError("unavailable", 503);
  const callback = `${env.SITE_ORIGIN}/api/auth/callback`;
  if (url.pathname === "/api/auth/github") {
    const state = token(),
      verifier = token();
    await env.DB.prepare("INSERT INTO oauth_states(state,verifier,expires_at) VALUES(?,?,?)")
      .bind(await hash(state), verifier, now() + 600)
      .run();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const target = new URL("https://github.com/login/oauth/authorize");
    target.search = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: callback,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return new Response(null, {
      status: 302,
      headers: { Location: target.href, "Set-Cookie": cookie(env, "oauth", state, 600) },
    });
  }
  if (url.pathname !== "/api/auth/callback") throw new GalleryError("not_found", 404);
  try {
    const state = url.searchParams.get("state"),
      code = url.searchParams.get("code");
    if (!state || !code || readCookie(req, cookieName(env, "oauth")) !== state)
      throw new Error("state");
    const saved = await env.DB.prepare(
      "DELETE FROM oauth_states WHERE state=? AND expires_at>? RETURNING verifier",
    )
      .bind(await hash(state), now())
      .first<{ verifier: string }>();
    if (!saved) throw new Error("expired");
    const exchange = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: callback,
        code_verifier: saved.verifier,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const access = await exchange.json<{ access_token?: string }>();
    if (!exchange.ok || !access.access_token) throw new Error("exchange");
    const profileResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${access.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Kobrixa-Gallery",
      },
      signal: AbortSignal.timeout(10000),
    });
    const profile = await profileResponse.json<{ id: number; login: string }>();
    if (!profileResponse.ok || !Number.isSafeInteger(profile.id) || !profile.login)
      throw new Error("profile");
    const session = token();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users(id,login) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login",
      ).bind(String(profile.id), profile.login),
      env.DB.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)").bind(
        await hash(session),
        String(profile.id),
        now() + 604800,
      ),
    ]);
    const headers = new Headers({ Location: `${env.SITE_ORIGIN}/gallery/submit` });
    headers.append("Set-Cookie", cookie(env, "session", session, 604800));
    headers.append("Set-Cookie", cookie(env, "oauth", "", 0));
    return new Response(null, { status: 302, headers });
  } catch {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.SITE_ORIGIN}/gallery?auth=failed`,
        "Set-Cookie": cookie(env, "oauth", "", 0),
      },
    });
  }
}
