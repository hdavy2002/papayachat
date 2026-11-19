import { MEMBERFUL_PROBLEM_PARAM } from "@ember/protocol";
import { authenticate, clientOf, cookieValues, hostCookie, hostCookieName, isCrossSite, newSessionToken, sessionCookie, tokenDigest } from "./auth";
import { bytesUpTo, MAX_JSON_BODY_BYTES } from "./bodies";
import { contentSecurityPolicy, inlineScriptHashes } from "./csp";
import { escapeHtml } from "./encoding";
import type { Env } from "./env";
import { notFound } from "./error-pages";
import { clerkUserOf, memberfulKeysOf } from "./memberful-api";
import { PAPAYA_DESKTOP_ORIGINS } from "./papaya-origins";
import { withCookies } from "./pages";
import { urlOf } from "./request-url";
import { workspace } from "./workspace";

// Papaya Chat in its own window on the Papaya OS desktop, already signed in.
//
// Papaya OS (yellow.papayaos.app) opens this chat in a window: an iframe of `/auth/papaya/embed`. The
// person is signed in to the desktop with Clerk already, so the desktop hands the frame their Clerk
// session token by postMessage (never in an address, where logs would keep it). The page posts it to
// `/auth/papaya/token`, which checks the token's signature against Clerk's public keys, and signs the
// browser in exactly as "Sign in with Papaya" does (Workspace.signInWithMemberful), by the same Clerk
// user id, so it is the same chat account either way. The chat is on the same site as the desktop
// (papayaos.app), so its SameSite=Lax session cookie works inside the frame.

export const PAPAYA_EMBED_PATH = "/auth/papaya/embed";
export const PAPAYA_TOKEN_PATH = "/auth/papaya/token";


/** The suite's account route, which says who a Clerk session token belongs to, with their name and email. */
const PAPAYA_ME = "https://papayaos.app/api/me";
const PAPAYA_ME_TIMEOUT_MS = 3000;
/** The suite's stand-in address for an account without a real email. */
const PLACEHOLDER_EMAIL = /@users\.davylabs\.dev$/i;

/** Whose desktop signed this browser in: their Clerk user id, so a window opened by someone else signs in again. */
const DESKTOP_USER_COOKIE = "papaya_desktop_user";
const DESKTOP_USER_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const json = (body: unknown, status = 200, ...cookies: string[]) =>
  withCookies(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }), ...cookies);

/** A page of the chat to open after signing in: a path here, never another site. */
function returnPathOf(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.length > 1024) return "/";
  return value;
}

const fromBase64url = (text: string) => {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

let jwks: { at: number; site: string; keys: Map<string, CryptoKey> } | null = null;

async function clerkKey(site: string, kid: string): Promise<CryptoKey | null> {
  if (!jwks || jwks.site !== site || Date.now() - jwks.at > 3600e3 || !jwks.keys.has(kid)) {
    const answer = await fetch(new URL("/.well-known/jwks.json", site), { signal: AbortSignal.timeout(5000) });
    if (!answer.ok) return null;
    const { keys } = (await answer.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const map = new Map<string, CryptoKey>();
    for (const key of keys ?? []) {
      if (key.kty !== "RSA") continue;
      map.set(key.kid, await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    jwks = { at: Date.now(), site, keys: map };
  }
  return jwks.keys.get(kid) ?? null;
}

type Claims = { sub?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown; azp?: unknown; email?: unknown; name?: unknown };

/** The claims of a Clerk session token that `site` (the Clerk instance) signed, still in date, minted on the desktop; null otherwise. */
export async function verifiedClerkToken(token: string, site: string): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8192) return null;
  try {
    const header = JSON.parse(decoder.decode(fromBase64url(parts[0]!))) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) return null;
    const key = await clerkKey(site, header.kid);
    if (!key) return null;
    const signed = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(parts[2]!), encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!signed) return null;
    const claims = JSON.parse(decoder.decode(fromBase64url(parts[1]!))) as Claims;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== new URL(site).origin) return null;
    if (typeof claims.exp !== "number" || claims.exp < now - 5) return null;
    if (typeof claims.nbf === "number" && claims.nbf > now + 5) return null;
    if (typeof claims.azp === "string" && !PAPAYA_DESKTOP_ORIGINS.includes(claims.azp)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** The name and email the suite keeps for the token's owner, when it answers in time. */
async function papayaProfile(token: string, sub: string): Promise<{ name: string | null; email: string | null }> {
  try {
    const answer = await fetch(PAPAYA_ME, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PAPAYA_ME_TIMEOUT_MS) });
    if (!answer.ok) return { name: null, email: null };
    const { user } = (await answer.json()) as { user?: { name?: unknown; email?: unknown; clerkId?: unknown } | null };
    if (!user || (typeof user.clerkId === "string" && user.clerkId !== sub)) return { name: null, email: null };
    const email = typeof user.email === "string" && !PLACEHOLDER_EMAIL.test(user.email) ? user.email : null;
    return { name: typeof user.name === "string" ? user.name : null, email };
  } catch {
    return { name: null, email: null };
  }
}

/** The page that waits for the desktop's token. Plain script, no build: it only has to post one token. */
function embedPage(returnPath: string): string {
  const script = `(function(){var o=${JSON.stringify(PAPAYA_DESKTOP_ORIGINS)},b=document.getElementById("p").getAttribute("data-back"),d=!1;function g(u){if(!d){d=!0;location.replace(u)}}addEventListener("message",function(e){var m=e.data;if(o.indexOf(e.origin)<0||e.source!==parent||!m||m.type!=="papaya-chat:token")return;if(!m.token){g("/session/new");return}fetch(${JSON.stringify(PAPAYA_TOKEN_PATH + "?return_to=")}+encodeURIComponent(b),{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:m.token})}).then(function(r){return r.json()}).then(function(a){g(a&&a.location?a.location:"/session/new")},function(){g("/session/new")})});if(parent!==window)parent.postMessage({type:"papaya-chat:ready"},"*");else g(b);setTimeout(function(){g("/session/new")},15000)})();`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Papaya Chat</title><style>html,body{margin:0;height:100%;background:#1b1b1b;color:#eee;font:15px system-ui,sans-serif}#p{display:flex;height:100%;align-items:center;justify-content:center;opacity:.7}</style></head><body><div id="p" data-back="${escapeHtml(returnPath)}">Opening Papaya Chat…</div><script>${script}</script></body></html>`;
}

/**
 * `GET /auth/papaya/embed?return_to=…`: inside a Papaya OS window. Signed in already, it opens the
 * page; otherwise it waits for the desktop to post the person's Clerk session token, and signs in with it.
 */
export async function papayaEmbed(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return notFound(request);
  const returnPath = returnPathOf(urlOf(request).searchParams.get("return_to"));
  // Signed in already, as the person on the desktop (the window names their Clerk user id): open the
  // page. Signed in as anyone else, or not by the desktop, the desktop's token decides who this is.
  const desktopUser = urlOf(request).searchParams.get("for");
  const [kept] = cookieValues(request, hostCookieName(request, DESKTOP_USER_COOKIE));
  if (desktopUser && kept === desktopUser && (await authenticate(request, env))) {
    return new Response(null, { status: 302, headers: { Location: new URL(returnPath, request.url).href, "Cache-Control": "no-store" } });
  }
  const html = embedPage(returnPath);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": contentSecurityPolicy(request, await inlineScriptHashes(html)),
    },
  });
}

/**
 * `POST /auth/papaya/token { token }`, from the embed page only: signs this browser in as the Clerk user
 * whose session token it is, as Sign in with Papaya would. Answers `{ location }`: the page to open,
 * which is the sign-in page, saying why, when it didn't work.
 */
export async function papayaTokenSignIn(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return notFound(request);
  if (isCrossSite(request)) return json({ location: "/session/new" }, 422);
  const failed = (problem: string, status = 403) => json({ location: `/session/new?${MEMBERFUL_PROBLEM_PARAM}=${problem}` }, status);
  const keys = memberfulKeysOf(env);
  if (!keys || keys.provider !== "clerk") return failed("unavailable");
  const body = await bytesUpTo(request, MAX_JSON_BODY_BYTES);
  let token: unknown = null;
  try {
    token = body === null ? null : (JSON.parse(decoder.decode(body)) as { token?: unknown }).token;
  } catch {
    token = null;
  }
  if (typeof token !== "string") return failed("failed", 400);
  if (!(await workspace(env).offersMemberfulSignIn(keys.site))) return failed("off");
  const begun = await workspace(env).beginMemberfulSignIn(request.headers.get("CF-Connecting-IP") ?? "unknown", null);
  if (begun === "limited") return failed("refused", 429);
  if (begun === "expired") return failed("failed");
  const claims = await verifiedClerkToken(token, keys.site);
  if (!claims || typeof claims.sub !== "string") return failed("failed", 401);
  const profile = await papayaProfile(token, claims.sub);
  const member = clerkUserOf({
    sub: claims.sub,
    email: profile.email ?? (typeof claims.email === "string" && !PLACEHOLDER_EMAIL.test(claims.email) ? claims.email : undefined),
    name: profile.name ?? claims.name,
  });
  if (!member) return failed("failed", 401);
  const session = newSessionToken();
  const digest = await tokenDigest(session, env.SESSION_SECRET);
  let user = await workspace(env).signInWithMemberful(keys.site, member, begun.begunAt, digest, clientOf(request));
  // An account here with their (Clerk-verified) email that was never connected: they signed in to the
  // desktop with Papaya, so it's connected now rather than asking for this chat's password too.
  if (user === "taken") user = await workspace(env).signInWithPapayaEmail(keys.site, member, begun.begunAt, digest, clientOf(request));
  if (typeof user === "string") return failed(user);
  const returnPath = returnPathOf(urlOf(request).searchParams.get("return_to"));
  return json({ location: returnPath }, 200, sessionCookie(request, session), hostCookie(request, DESKTOP_USER_COOKIE, claims.sub, DESKTOP_USER_MAX_AGE_SECONDS));
}
