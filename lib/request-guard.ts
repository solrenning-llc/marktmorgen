/**
 * The checks every request that changes something has to pass, written once.
 *
 * Until now each route carried its own copy of the origin check, and each
 * copy had the same gap: a request with no Origin header at all was waved
 * through. Browsers send Origin on a cross-site POST today, but they also
 * send Sec-Fetch-Site, which says outright whether the request came from
 * this site, and a check that reads both is a check that does not depend on
 * one header being present. The proxy (proxy.ts) applies this to every
 * request under /api/ that is not a read, so a route added tomorrow is
 * covered before anyone remembers to add the check to it; the routes keep
 * their own checks as well, so neither is the only one.
 *
 * The rest is what those routes kept writing by hand:
 *
 *   - a body read with a ceiling, counted as it arrives rather than trusted
 *     from Content-Length, which a client may leave out;
 *   - a counter per client and per purpose, for the public forms that start
 *     something that costs the creator (a Stripe checkout, a held unit or a
 *     held call time) or fills somebody's inbox;
 *   - a comparison of secrets that takes the same time whether the first
 *     character is wrong or the last, so the scheduled jobs' secret cannot be
 *     found one character at a time by timing the answer;
 *   - the Content-Disposition header for a file whose name somebody typed,
 *     which must survive quotes, accents and emoji without breaking the
 *     response or the header around it.
 *
 * Nothing here needs Node's own modules, so the proxy can use it as it is.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

type HeaderSource = { headers: Headers };

/**
 * True when a request that changes something did not come from this site.
 *
 * An Origin that names another host, or that cannot be read ("null" comes
 * from sandboxed frames and from some cross-site redirects), is another
 * site. Without an Origin, a browser still says where the request came from
 * in Sec-Fetch-Site, and "cross-site" or "same-site" (another subdomain) is
 * refused too. A request with neither header did not come from a browser
 * page — a server, a mail provider's one-click unsubscribe, a test — and
 * cannot carry a visitor's cookies against their will, so it is let through
 * to the route's own checks.
 */
export function fromAnotherSite(request: HeaderSource): boolean {
  const sender = request.headers.get("origin");
  const host = request.headers.get("host");
  if (sender) {
    if (!host) return true;
    try {
      return new URL(sender).host !== host;
    } catch {
      return true;
    }
  }
  const site = request.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

/** A body larger than the route takes. Thrown by `limited`, caught as a bad request. */
export class BodyTooLarge extends Error {
  constructor() {
    super("body too large");
  }
}

/**
 * The same request with its body read into memory, refusing past `maxBytes`.
 *
 * The bytes are counted as they arrive, so a client that sends no
 * Content-Length, or a false one, is stopped at the ceiling rather than read
 * to the end. What comes back is a plain Request with the same method and
 * headers, so `.json()` and `.formData()` work on it exactly as before.
 */
export async function limited(request: Request, maxBytes: number): Promise<Request> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new BodyTooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body: size ? bytes : null });
}

/** The address the request came from, as the platform in front of us reports it. */
export function clientAddress(request: HeaderSource): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Whether one more request of this kind, from this client, fits in the window.
 *
 * `scope` names the purpose ("checkout", "book"…) and `who` whatever it is
 * counted by — an address and a store, usually — which is hashed, so no
 * address is kept in the clear. When Redis cannot be asked (it throws) the
 * answer is yes: these limits keep abuse down, and a buyer must never be
 * kept from paying because a counter was out of reach. A reply that did come
 * back in another shape is an unknown count and the answer is no (SG2 17,
 * Claude 1's decision of 05/11/2026). Work that spends money uses
 * withinEssentialLimit, which says no on both.
 */
/** Essential authenticated actions need a confirmed finite allowance before
 * provider or data work. Same existing counter/key/TTL; uncertainty consumes
 * any committed increment and never authorizes a retry or readback. */
export async function withinEssentialLimit(scope: string, who: string, limit: number, windowSeconds: number): Promise<boolean> {
  return (await essentialLimitState(scope, who, limit, windowSeconds)) === "within";
}

/** What an essential limit's counter says: room, no room, or not known. */
export type LimitState = "within" | "exceeded" | "unknown";

/**
 * The same counter, key and TTL as withinEssentialLimit, with three answers,
 * so a caller can answer "past the limit" (429) apart from "the count is not
 * known" (503) and never tell someone to slow down when the counter could not
 * be read (VR; Codex Z on #2773). "unknown" for Redis not configured or not
 * answering, a reply in any other shape, or a limit or window that is not a
 * positive whole number; an increment that may have been committed is spent,
 * never retried or read back.
 */
export async function essentialLimitState(scope: string, who: string, limit: number, windowSeconds: number): Promise<LimitState> {
  if (!isRedisConfigured() || !Number.isSafeInteger(limit) || limit <= 0 ||
      !Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) return "unknown";
  let reply: unknown;
  try {
    const key = `nl:rl:${scope}:${(await sha256Hex(`nimbus-${scope}:${who}`)).slice(0, 32)}`;
    reply = await redisPipeline([
      ["SET", key, "0", "EX", windowSeconds, "NX"],
      ["INCR", key],
    ]);
  } catch {
    return "unknown";
  }
  let count: number | null;
  try {
    count = counterReply(reply);
  } catch {
    return "unknown";
  }
  if (count === null) return "unknown";
  return count <= limit ? "within" : "exceeded";
}

export async function withinLimit(scope: string, who: string, limit: number, windowSeconds: number): Promise<boolean> {
  if (!isRedisConfigured()) return true;
  let reply: unknown;
  try {
    const key = `nl:rl:${scope}:${(await sha256Hex(`nimbus-${scope}:${who}`)).slice(0, 32)}`;
    reply = await redisPipeline([
      ["SET", key, "0", "EX", windowSeconds, "NX"],
      ["INCR", key],
    ]);
  } catch {
    // Redis could not be asked: open, so a buyer is never kept from paying by a counter out of reach.
    return true;
  }
  // A reply that came back in another shape, or that cannot even be looked at, is an unknown count, never room
  // (SG2 17, Claude 1, 05/11/2026; Codex Q on #2670: reading it is outside the catch above).
  return countWithin(reply, limit);
}

/**
 * Takes `n` at once from withinLimit's counter, in one step on the server
 * (second pre-review of 279 [H3-4] unit 2): the window started as withinLimit
 * starts it (SET NX EX), given its end when a count has none, a count below
 * zero counted from zero, then INCRBY, and past `limit` the same DECRBY,
 * all before anything else runs on the key. So a window that ends between
 * two requests can never make the key again with no end and below zero, and
 * withinLimit asking at the same moment never sees a sum that never stood.
 * Answers the window's end in ms (PEXPIRETIME) when taken, 0 when not; a
 * count that is not a number fails (never room).
 */
export const TAKE_MANY = `-- marktmorgen:take-many:v1
local n, limit, window = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call("SET", KEYS[1], "0", "EX", window, "NX")
if redis.call("TTL", KEYS[1]) < 0 then redis.call("EXPIRE", KEYS[1], window) end
if tonumber(redis.call("GET", KEYS[1])) < 0 then redis.call("SET", KEYS[1], "0", "KEEPTTL") end
local count = redis.call("INCRBY", KEYS[1], n)
if count > limit then
  redis.call("DECRBY", KEYS[1], n)
  return 0
end
return redis.call("PEXPIRETIME", KEYS[1])`;

/**
 * Gives `n` of a take back, only to the window it was taken in (its end the
 * same as TAKE_MANY answered) and only while the count holds at least `n`:
 * never to the next day's count, never below zero, and never making a key
 * that is gone. 1 when given back, 0 when not.
 */
export const GIVE_BACK_MANY = `-- marktmorgen:give-back-many:v1
local n, ends = tonumber(ARGV[1]), tonumber(ARGV[2])
if redis.call("PEXPIRETIME", KEYS[1]) ~= ends then return 0 end
local held = tonumber(redis.call("GET", KEYS[1]))
if held == nil or held < n then return 0 end
redis.call("DECRBY", KEYS[1], n)
return 1`;

/** What a take holds: the counter and its window's end, so only that window gets it back (giveBackMany). */
export type TakenMany = { readonly key: string; readonly ends: number; readonly n: number };

/**
 * A take's answer: taken, or not and why. "full" only when the counter said
 * so (TAKE_MANY answered exactly 0: all `n` do not fit in what is left of the
 * window); "unknown" for everything else, so a caller never says a limit was
 * reached when the count was not known.
 */
export type TakeManyAnswer = (TakenMany & { readonly ok: true }) | { readonly ok: false; readonly why: "full" | "unknown" };

/**
 * Takes `n` at once from a counter of `limit` a window (the same key as
 * withinLimit for the same scope, so both count together): the take when all
 * `n` fit, never a part; "full" when they do not. Closed when the count is
 * not known (Redis not configured or not answering, a reply of another shape,
 * a count that is not a number): "unknown", never a take, so a bound on what
 * is given away is never opened by a counter out of reach. A reply of another
 * shape may have taken: it is kept, never given back on a guess.
 */
export async function takeMany(scope: string, who: string, limit: number, windowSeconds: number, n: number): Promise<TakeManyAnswer> {
  const unknown = { ok: false, why: "unknown" } as const;
  if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(limit) || limit <= 0 ||
      !Number.isSafeInteger(windowSeconds) || windowSeconds <= 0 || !isRedisConfigured()) return unknown;
  try {
    const key = `nl:rl:${scope}:${(await sha256Hex(`nimbus-${scope}:${who}`)).slice(0, 32)}`;
    const ends = onlyReply(await redisPipeline([["EVAL", TAKE_MANY, 1, key, n, limit, windowSeconds]]));
    if (ends === 0) return { ok: false, why: "full" };
    return Number.isSafeInteger(ends) && (ends as number) > 0 ? { ok: true, key, ends: ends as number, n } : unknown;
  } catch {
    return unknown;
  }
}

/** takeMany as a yes or no: yes only when all `n` fit (`n` of 0 always fits, taking nothing); no when full or not known. */
export async function takeManyWithin(scope: string, who: string, limit: number, windowSeconds: number, n: number): Promise<boolean> {
  if (n === 0 && Number.isSafeInteger(limit) && limit > 0) return true;
  return (await takeMany(scope, who, limit, windowSeconds, n)).ok;
}

/**
 * Gives back `n` of a take (at most what it took) when what it was taken for
 * was not given, in one step (GIVE_BACK_MANY). Whether it was given back; a
 * failure keeps it taken, so a refusal never opens more than the limit.
 */
export async function giveBackMany(taken: TakenMany, n: number): Promise<boolean> {
  if (!Number.isSafeInteger(n) || n < 1 || n > taken.n || !isRedisConfigured()) return false;
  try {
    return onlyReply(await redisPipeline([["EVAL", GIVE_BACK_MANY, 1, taken.key, n, taken.ends]])) === 1;
  } catch {
    return false;
  }
}

/** The one reply of a one-command pipeline, read by its own data field (as counterReply reads), or undefined for any other shape. */
function onlyReply(reply: unknown): unknown {
  if (!Array.isArray(reply)) return undefined;
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  if (!length || !Object.hasOwn(length, "value") || length.value !== 1) return undefined;
  const only = Object.getOwnPropertyDescriptor(reply, "0");
  return only && Object.hasOwn(only, "value") ? only.value : undefined;
}

/** Whether a returned SET NX + INCR reply holds a count within `limit`; no for any other shape or a reply that throws when read. */
function countWithin(reply: unknown, limit: number): boolean {
  try {
    const count = counterReply(reply);
    return count !== null && count <= limit;
  } catch {
    return false;
  }
}

/**
 * The count of a SET NX + INCR pipeline, only in its exact shape: two
 * replies, the SET's "OK" or null, and the INCR's own whole number of at
 * least 1; null for anything else. Read by the replies' own data fields,
 * as withinEssentialLimit does, so a getter cannot answer for them.
 */
function counterReply(reply: unknown): number | null {
  if (!Array.isArray(reply)) return null;
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  if (!length || !Object.hasOwn(length, "value") || length.value !== 2) return null;
  const set = Object.getOwnPropertyDescriptor(reply, "0");
  const count = Object.getOwnPropertyDescriptor(reply, "1");
  if (!set || !Object.hasOwn(set, "value") || (set.value !== null && set.value !== "OK")) return null;
  if (!count || !Object.hasOwn(count, "value") || !Number.isSafeInteger(count.value) || count.value < 1) return null;
  return count.value as number;
}

/**
 * The same counter, by the store's allowance window instead of by a window
 * that starts with the first use. Added 17 October 2026 for the allowances
 * whose cost sits in each plan's worst month (tests/plan-cost-registry.ts):
 * a thirty-day window can touch three windows of one month, and a month holds
 * exactly one of these. `window` is the store's window by its name
 * (lib/allowance-window.ts, windowId): its billing month when it pays us,
 * the calendar month otherwise, so one payment buys one month of each. No
 * window known, nothing let through. Kept 32 days, longer than any window.
 * Fails open like withinLimit when Redis cannot be asked: the work it guards
 * cannot run either.
 */
export async function withinMonth(scope: string, who: string, limit: number, window: string | null): Promise<boolean> {
  if (!window || !/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(window)) return false;
  if (!isRedisConfigured()) return true;
  if (!Number.isSafeInteger(limit) || limit <= 0) return false;
  let reply: unknown;
  try {
    const month = window;
    const key = `nl:rlm:${scope}:${(await sha256Hex(`nimbus-${scope}:${who}`)).slice(0, 32)}:${month}`;
    reply = await redisPipeline([
      ["SET", key, "0", "EX", 32 * 86_400, "NX"],
      ["INCR", key],
    ]);
  } catch {
    return true;
  }
  return countWithin(reply, limit);
}

/**
 * Compares two secrets in time that depends only on their length.
 *
 * Both are hashed first, so even the length of the real secret is not given
 * away by how long a wrong guess takes, and every byte of the two hashes is
 * compared whatever the first difference is.
 */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(`nimbus-secret:${given}`), sha256Hex(`nimbus-secret:${expected}`)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0 && given.length > 0;
}

/**
 * Whether a request to a scheduled job may run it.
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` with every scheduled
 * run. With the secret set, only that header opens the door, compared in
 * constant time. Without one, the door is shut everywhere except a local
 * development server, where the jobs are started by hand: a missing secret
 * in production is a closed door, not an open one.
 */
export async function cronAllowed(request: HeaderSource): Promise<boolean> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  return sameSecret(given, secret);
}

/**
 * A Content-Disposition header for a file somebody named.
 *
 * The plain `filename` keeps only characters every browser and every header
 * parser takes (letters, digits, and a few marks), so a quote cannot end it
 * early and a character outside Latin-1 cannot make the response fail to be
 * built. The real name, accents and all, goes in `filename*`, percent-encoded
 * as RFC 6266 says, which every current browser prefers when it is there.
 */
export function contentDisposition(kind: "attachment" | "inline", name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f"\\/]/g, "").trim().slice(0, 150) || "file";
  const ascii =
    cleaned
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9 ._()+-]/g, "_")
      .replace(/_{2,}/g, "_") || "file";
  const encoded = encodeURIComponent(cleaned).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The headers every file handed over by us carries.
 *
 * A file is served to be saved, never to be run in our pages' name: the
 * browser is told not to guess its type, and even if it were opened in a tab,
 * a policy of its own lets it run nothing, fetch nothing and frame nothing.
 * A creator may sell an SVG or an HTML-looking text file; neither can reach
 * a buyer's session on this site.
 */
export function fileHeaders(contentType: string, name: string): Record<string, string> {
  return {
    "Content-Type": contentType || "application/octet-stream",
    "Content-Disposition": contentDisposition("attachment", name),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex",
  };
}
