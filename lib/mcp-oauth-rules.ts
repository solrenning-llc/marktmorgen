/**
 * The rules OAuth for the MCP server will run on, pure and tested before any
 * of it is stored or served: 631 [AA1] (f), unit 16 (docs/mcp-oauth-plan.md).
 * Source: the MCP specification 2026-07-28, basic/authorization (official
 * repository, commit d0e246e of 31 October 2026), and the RFCs it names.
 *
 *   - PKCE: only S256 is accepted (the specification has clients use it
 *     when they can, and nothing here gains from "plain"); the verifier is
 *     43 to 128 unreserved characters (RFC 7636 §4.1), and the challenge is
 *     the base64url of its SHA-256 without padding, compared in constant time.
 *   - Redirect URIs match exactly what was registered, character for
 *     character; each is https, or http on localhost or a loopback address,
 *     with no fragment and no user or password in it.
 *   - The resource is this server's canonical address
 *     (https://marktmorgen.com/api/mcp: scheme and host lowercase, no
 *     trailing slash, no query or fragment); a token for anything else is
 *     not for us (RFC 8707 audience).
 *   - Scopes are the three agent scopes of keys (lib/api-key-rules.ts):
 *     `read`, `draft`, `execute`, the widest asked for winning; anything else
 *     is refused, never ignored, so a client cannot ask for more than exists.
 *     Money is in no scope.
 */
import { createHash, timingSafeEqual } from "node:crypto";

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

const base64url = (bytes: Buffer) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The S256 challenge of a verifier (RFC 7636 §4.2). */
export function s256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** Whether a challenge sent with an authorization request can be stored: S256 only, in its exact form. */
export function acceptChallenge(challenge: unknown, method: unknown): boolean {
  return method === "S256" && typeof challenge === "string" && CHALLENGE.test(challenge);
}

/** Whether the verifier sent to the token endpoint matches the stored challenge. */
export function verifierMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER.test(verifier) || !CHALLENGE.test(challenge)) return false;
  const made = Buffer.from(s256(verifier));
  const kept = Buffer.from(challenge);
  return made.length === kept.length && timingSafeEqual(made, kept);
}

/** Whether an address may be registered as a redirect URI. */
export function redirectAllowed(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 2_000 || /[\s\u0000-\u001f\u007f]/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || raw.includes("#")) return false;
  if (url.protocol === "https:") return true;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "http:" && loopback;
}

/** The redirect URI of a request, only if it is exactly one of those registered. */
export function redirectMatch(asked: unknown, registered: readonly string[]): string | null {
  if (typeof asked !== "string" || !redirectAllowed(asked)) return null;
  return registered.includes(asked) ? asked : null;
}

/** This server's canonical resource, from the site's address. */
export function canonicalResource(siteUrl: string): string {
  const url = new URL(siteUrl);
  return `${url.protocol}//${url.host.toLowerCase()}/api/mcp`;
}

/** Whether a `resource` sent by a client names this server (RFC 8707), allowing only case in scheme and host, and one trailing slash. */
export function resourceIsOurs(raw: unknown, siteUrl: string): boolean {
  if (typeof raw !== "string") return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.search || url.hash || url.username || url.password || raw.includes("#") || raw.includes("?")) return false;
  const path = url.pathname.replace(/\/$/, "");
  return `${url.protocol}//${url.host.toLowerCase()}${path}` === canonicalResource(siteUrl);
}

/** What an agent may prepare: the same three values as an agent key's scope (lib/api-key-rules.ts, 631 unit 3). */
export type AgentScope = "none" | "draft" | "execute";

export const OAUTH_SCOPES = ["read", "draft", "execute"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/**
 * A space-separated scope string as what an agent may do: "read" reads only,
 * "draft" also prepares drafts, "execute" also prepares changes that reach
 * people. Empty is "read". Any unknown or repeated-oddly word refuses it all.
 */
export function scopeOf(raw: unknown): { ok: true; agent: AgentScope; granted: OAuthScope[] } | { ok: false } {
  if (raw !== undefined && typeof raw !== "string") return { ok: false };
  const words = (raw ?? "").split(" ").filter(Boolean);
  if (words.length > OAUTH_SCOPES.length || (raw ?? "").length > 64) return { ok: false };
  if (words.some((w) => !(OAUTH_SCOPES as readonly string[]).includes(w))) return { ok: false };
  const agent: AgentScope = words.includes("execute") ? "execute" : words.includes("draft") ? "draft" : "none";
  const granted: OAuthScope[] = agent === "execute" ? ["read", "draft", "execute"] : agent === "draft" ? ["read", "draft"] : ["read"];
  return { ok: true, agent, granted };
}
