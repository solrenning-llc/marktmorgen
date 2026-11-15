/**
 * 488 [IT5] unit 4: a store preview kept 24 hours and carried into the studio (docs/it5-store-preview.md).
 *
 * Only the draft is kept (its lines, products, questions and answers), never the visitor's words, address or anything
 * else typed, under a random token of 32 bytes in an HttpOnly cookie that only this browser sends, for 24 hours at the
 * most. Carrying it into the studio needs a person signed in with that cookie: it is read and deleted in one command
 * (GETDEL), so it is carried once and a second carry finds nothing, and the cookie is cleared. The visitor deletes it
 * at once, signed in or not. No model is asked for either. Off, both answer 404, as paths that do not exist.
 */
import { randomBytes } from "node:crypto";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { fromAnotherSite } from "@/lib/request-guard";
import { STORE_PREVIEW_ON } from "@/lib/store-preview-rules";

export const PREVIEW_KEEP_SECONDS = 86_400;
export const PREVIEW_TOKEN_COOKIE = "mm_pv";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const keptKey = (token: string) => `nl:storepv:kept:${token}`;
const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });

export type KeptDraft = {
  bios: string[];
  products: { title: string; summary: string; kind: "download" | "course" | "call" | "membership"; price: string }[];
  faq: { q: string; a: string }[];
  questions: { q: string; options: string[] }[];
};

/** The cookie that keeps a token, and the one that clears it. */
export const keepCookie = (token: string) => `${PREVIEW_TOKEN_COOKIE}=${token}; Path=/; Max-Age=${PREVIEW_KEEP_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
const clearCookie = () => `${PREVIEW_TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** One cookie's value in a request's Cookie header; null when absent or given twice. */
export function cookieOf(request: Request, name: string): string | null {
  const found = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
  return found.length === 1 ? found[0] : null;
}

/** The request's token when it reads as one; otherwise a new one. */
export function previewToken(request: Request): string {
  const given = cookieOf(request, PREVIEW_TOKEN_COOKIE);
  return given && TOKEN.test(given) ? given : randomBytes(32).toString("base64url");
}

/** Keeps the draft, and only the draft, under the token for 24 hours. False when it was not kept for certain. */
export async function keepPreview(token: string, draft: { bios: string[]; products: KeptDraft["products"]; faq: KeptDraft["faq"]; questions?: KeptDraft["questions"] }): Promise<boolean> {
  if (!TOKEN.test(token)) return false;
  const value: KeptDraft = { bios: draft.bios, products: draft.products, faq: draft.faq, questions: draft.questions ?? [] };
  try {
    const [set] = await redisPipeline([["SET", keptKey(token), JSON.stringify(value), "EX", PREVIEW_KEEP_SECONDS]]);
    return set === "OK";
  } catch {
    return false;
  }
}

function keptOf(raw: unknown): KeptDraft | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<KeptDraft>;
    return value && Array.isArray(value.bios) && Array.isArray(value.products) && Array.isArray(value.faq) && Array.isArray(value.questions) ? (value as KeptDraft) : null;
  } catch {
    return null;
  }
}

export type KeepOptions = { on?: boolean };

/** POST: the kept draft, carried once into the studio of the person signed in with its cookie. */
export async function answerCarryPreview(request: Request, options: KeepOptions = {}): Promise<Response> {
  if ((options.on ?? STORE_PREVIEW_ON) !== true) return notFound();
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403, headers: NO_STORE });
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unknown" }, { status: 503, headers: NO_STORE });
  const email = await emailForSession(cookieOf(request, SESSION_COOKIE) ?? undefined);
  if (!email) return Response.json({ ok: false, error: "signed_out" }, { status: 401, headers: NO_STORE });
  const token = cookieOf(request, PREVIEW_TOKEN_COOKIE);
  let draft: KeptDraft | null = null;
  if (token && TOKEN.test(token)) {
    try {
      const [raw] = await redisPipeline([["GETDEL", keptKey(token)]]);
      draft = keptOf(raw);
    } catch {
      return Response.json({ ok: false, error: "unknown" }, { status: 503, headers: NO_STORE });
    }
  }
  return Response.json({ ok: true, draft }, { status: 200, headers: { ...NO_STORE, "Set-Cookie": clearCookie() } });
}

/** DELETE: the visitor's kept draft, deleted at once, signed in or not. */
export async function answerForgetPreview(request: Request, options: KeepOptions = {}): Promise<Response> {
  if ((options.on ?? STORE_PREVIEW_ON) !== true) return notFound();
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403, headers: NO_STORE });
  const token = cookieOf(request, PREVIEW_TOKEN_COOKIE);
  if (token && TOKEN.test(token)) {
    if (!isRedisConfigured()) return Response.json({ ok: false, error: "unknown" }, { status: 503, headers: NO_STORE });
    try {
      await redisPipeline([["DEL", keptKey(token)]]);
    } catch {
      return Response.json({ ok: false, error: "unknown" }, { status: 503, headers: NO_STORE });
    }
  }
  return Response.json({ ok: true }, { status: 200, headers: { ...NO_STORE, "Set-Cookie": clearCookie() } });
}
