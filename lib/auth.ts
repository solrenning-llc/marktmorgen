/**
 * Signing a creator in, without a password.
 *
 * The creator types their email and we send a link. Clicking it signs them in.
 * There is no password to invent, none to forget, and no table of other
 * people's passwords for us to guard — which is the kind of thing a one-person
 * company should not be guarding.
 *
 * Two short-lived records do the work, both in Redis, both keyed by a one-way
 * hash so the raw token and the raw session id never rest anywhere:
 *
 *   nl:auth:link:<hash>     -> email, 15 minutes, deleted the moment it is used
 *                              (and, under its own salt, a login with Google
 *                              on its way, 10 minutes, lib/google-signin.ts)
 *   nl:auth:session:<hash>  -> email, 30 days, deleted on sign-out
 *   nl:auth:fresh:<hash>    -> that the session was opened in the last 15
 *                              minutes, for the few changes that ask for a
 *                              recent login (adding a passkey)
 *   nl:auth:second:<hash>   -> the second step this session was opened with
 *                              ("app", "recovery" or "passkey:<its id>"), as long as
 *                              the session; none for an emailed link, Google,
 *                              a recovery address or a move (sessionSecondStep)
 *   nl:auth:sessions:<hash> -> the set of a creator's live sessions, so that
 *                              they can close every one of them at once
 *   nl:auth:move:<hash>     -> a move from one address to another, 15 minutes,
 *                              spent on the tap that finishes it
 *   nl:auth:devices:<hash>  -> the browsers an account has signed in from,
 *                              each by a one-way hash of its nl_device cookie
 *   nl:auth:code:<hash>     -> the six-digit code sent with a link (652 [WG12]),
 *                              by the request that asked for it: a hash of the
 *                              code, the link it spends, the tries; 15 minutes
 *   nl:auth:linkcode:<hash> -> from a link to its code, so either spends both
 *   nl:auth:lastcode:<hash> -> an address's newest code: only that one opens
 *   nl:rl:code-addr:<hash>  -> the code tries for one address in the hour, all
 *                              its requests together
 *   nl:rl:code-day:<hash>   -> the same, for a day from the first try
 *   nl:rl:code-ip:<hash>    -> the code tries from one machine in the hour
 *
 * A passkey (lib/passkeys.ts) opens exactly the same kind of session, so
 * everything here — "log out of all devices" included — covers it too.
 *
 * Signing in from a browser the account has not signed in from before sends
 * the creator a plain email saying so, with when and how, and what to do if
 * it was not them. The browser is recognised by a random id in a long-lived
 * cookie of its own; clearing cookies, or a private window, looks like a new
 * browser, which errs on the side of telling. The very first sign-in of an
 * account, and the first after this began, is only written down: the person
 * has just opened the email that let them in.
 *
 * Two counters keep the sending honest: one for the machine that asks, one for
 * the address that would receive. The second one matters because the first one
 * cannot see a flood that arrives from many machines at once.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { deriveKey } from "@/lib/secret-box";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { deleteIfHeldOnly } from "@/lib/redis-lock";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isHouseAddress } from "@/lib/house-store";
import { withPrefill } from "@/lib/handle-prefill";

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_LENGTH = 254;
export const SESSION_COOKIE = "nl_session";

const LINK_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const RATE_LIMIT = 5;
// Deliberately higher than RATE_LIMIT, so one machine that has spent its own
// five cannot, by itself, lock a creator out of their address for an hour.
const ADDRESS_LIMIT = 8;
const RATE_WINDOW_SECONDS = 60 * 60;

export function isAuthConfigured(): boolean {
  return isRedisConfigured() && isSenderConfigured();
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const linkKey = async (token: string) =>
  `nl:auth:link:${(await sha256Hex(`nimbus-auth-link:${token}`)).slice(0, 40)}`;

const codeKey = async (request: string) =>
  `nl:auth:code:${(await sha256Hex(`nimbus-auth-code:${request}`)).slice(0, 40)}`;
const linkCodeKey = async (token: string) =>
  `nl:auth:linkcode:${(await sha256Hex(`nimbus-auth-linkcode:${token}`)).slice(0, 40)}`;
const lastCodeKey = async (address: string) =>
  `nl:auth:lastcode:${(await sha256Hex(`nimbus-auth-lastcode:${address}`)).slice(0, 40)}`;
const codeTriesKey = async (address: string) =>
  `nl:rl:code-addr:${(await sha256Hex(`nimbus-auth-code-tries:${address}`)).slice(0, 32)}`;
const codeDayKey = async (address: string) =>
  `nl:rl:code-day:${(await sha256Hex(`nimbus-auth-code-day:${address}`)).slice(0, 32)}`;
const codeIpKey = async (ip: string) =>
  `nl:rl:code-ip:${(await sha256Hex(`nimbus-auth-code-ip:${ip}`)).slice(0, 32)}`;
/**
 * The code as kept: an HMAC of the request's id and the code under a key
 * derived from the deployment's own secret (lib/secret-box.ts), which the
 * database never holds. The request's id is given to the browser that asked,
 * whoever that is, so a hash of it and six digits alone could be searched in a
 * million tries by anyone who can read the record (Codex CX1 on #2736). null
 * when the deployment has no secret: then no code is made, only the link.
 */
const CODE_KEY_LABEL = "auth-email-code/v1";
const codeHash = (request: string, code: string): string | null => {
  const key = deriveKey(CODE_KEY_LABEL);
  return key ? createHmac("sha256", key).update(`nimbus-auth-code-value:${request}:${code}`).digest("hex") : null;
};

const sessionKey = async (id: string) =>
  `nl:auth:session:${(await sha256Hex(`nimbus-auth-session:${id}`)).slice(0, 40)}`;

/** The key a session id is kept under, for a reader that reads it in the same command as its own keys (lib/two-step.ts lockedUntil). */
export const sessionKeyOf = (id: string) => sessionKey(id);

const freshKey = async (id: string) =>
  `nl:auth:fresh:${(await sha256Hex(`nimbus-auth-fresh:${id}`)).slice(0, 40)}`;

/**
 * How recent a login has to be for a change that would outlive the session
 * itself. Adding a passkey is one: a session cookie that walked off could
 * otherwise add a key of its own, which "Log out of all devices" does not
 * take away. Fifteen minutes, as long as a login link lasts.
 */
export const FRESH_LOGIN_SECONDS = 15 * 60;

/** Whether this session was opened in the last FRESH_LOGIN_SECONDS. */
export async function isFreshSession(id: string | undefined): Promise<boolean> {
  if (!id || !isRedisConfigured() || !/^[0-9a-f]{64}$/.test(id)) return false;
  // EXISTS answers 1 or 0; anything else is unknown, and the session is not taken as fresh (CX-123 rule 24).
  return countOf(repliesFor(await redisPipeline([["EXISTS", await freshKey(id)]]), 1)?.[0]) === 1;
}

/**
 * Named after the session's own key rather than its id, so the account's set
 * of sessions (which holds those keys) reaches every mark: taking a passkey
 * or the app away takes the marks it made (dropSecondStep).
 */
const secondKeyOf = async (opened: string) =>
  `nl:auth:second:${(await sha256Hex(`nimbus-auth-second:${opened}`)).slice(0, 40)}`;
const secondKey = async (id: string) => secondKeyOf(await sessionKey(id));

/**
 * The second step a session was opened with: a code from the authenticator
 * app, one of its recovery codes, or a passkey used to log in. An emailed
 * link, Google, a recovery address, a move or a team invite proves only the
 * inbox, so a session they open has none, even when the account owns a
 * passkey or an app; so has every session opened before this was written down.
 */
export type SecondStep = "app" | "recovery" | "passkey";

const SECOND_STEPS: readonly SecondStep[] = ["app", "recovery", "passkey"];

/**
 * What this session was opened with, for `email` only: a session that is
 * gone, or that belongs to somebody else, has none. Read by what asks for the
 * second step of a session rather than of an account (lib/team.ts).
 */
export async function sessionSecondStep(id: string | undefined, email: string): Promise<SecondStep | null> {
  const mark = await sessionMark(id, email);
  return SECOND_STEPS.find((step) => step === stepOf(mark)) ?? null;
}

const movingKey = async (email: string) =>
  `nl:auth:moving:${(await sha256Hex(`nimbus-auth-moving:${normaliseEmail(email)}`)).slice(0, 40)}`;

/** How long an address stays marked as moving: far longer than a move takes; a move that died midway lets go by itself. */
export const MOVING_SECONDS = 5 * 60;

/**
 * Marks both addresses of a move while it runs (app/api/auth/move): its
 * passkeys and app have left one and not yet settled, so an address that is
 * moving counts as having a second step, and nobody adds a passkey or an app
 * to it until the move is over (lib/second-step-gate.ts, security review of
 * 8b4ddf6ee). Answers the move's own token, or null when either address is
 * already moving or holds a broken move.
 */
export async function markMoving(from: string, to: string): Promise<string | null> {
  if (!isRedisConfigured()) return null;
  if ((await readBrokenMove(from)) || (await readBrokenMove(to))) return null;
  const token = randomToken();
  const [a, b] = await redisPipeline([
    ["SET", await movingKey(from), token, "NX", "EX", MOVING_SECONDS],
    ["SET", await movingKey(to), token, "NX", "EX", MOVING_SECONDS],
  ]);
  if (a === "OK" && b === "OK") return token;
  // Only what this call set is taken back: the other move's mark stays.
  await endMovingOne(from, token);
  await endMovingOne(to, token);
  return null;
}

/** Takes an address's mark away only when it is still this move's (`token`), in one script (lib/redis-lock.ts). */
async function endMovingOne(email: string, token: string): Promise<void> {
  const key = await movingKey(email);
  await deleteIfHeldOnly({ key, token, ttlSeconds: MOVING_SECONDS }, [key]);
}

export async function endMoving(from: string, to: string, token: string): Promise<void> {
  await endMovingOne(from, token);
  await endMovingOne(to, token);
}

const brokenKey = async (email: string) =>
  `nl:auth:move-broken:${(await sha256Hex(`nimbus-auth-move-broken:${normaliseEmail(email)}`)).slice(0, 40)}`;

/**
 * A move that could not be finished nor undone (app/api/auth/move): its two
 * addresses, written on both with no expiry until it is repaired
 * (lib/move-repair.ts). While it is there, both count as moving: nothing is
 * added to them, a second move waits, and a login without a second step is
 * refused (lib/signin-finish.ts and the recovery routes).
 */
export async function markBrokenMove(from: string, to: string): Promise<void> {
  const value = JSON.stringify({ from: normaliseEmail(from), to: normaliseEmail(to), at: Date.now() });
  await redisPipeline([
    ["SET", await brokenKey(from), value],
    ["SET", await brokenKey(to), value],
  ]);
}

export async function readBrokenMove(email: string): Promise<{ from: string; to: string } | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", await brokenKey(email)]]);
  try {
    const value = typeof raw === "string" ? (JSON.parse(raw) as { from?: unknown; to?: unknown }) : null;
    return value && typeof value.from === "string" && typeof value.to === "string" ? { from: value.from, to: value.to } : null;
  } catch {
    return null;
  }
}

export async function clearBrokenMove(from: string, to: string): Promise<void> {
  await redisPipeline([["DEL", await brokenKey(from), await brokenKey(to)]]);
}

/** An EXISTS reply read as a mark: only an exact 0 is "not there"; anything else counts as there (audit SG2, finding 22). */
const markThere = (reply: unknown) => countOf(reply) !== 0;

/**
 * Whether a move of this address is running now (its mark), not counting a
 * broken one. Unknown counts as running: every caller then waits (lib/move-repair.ts).
 */
export async function moveRunning(email: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const [found] = await redisPipeline([["EXISTS", await movingKey(email)]]);
  return markThere(found);
}

/**
 * Whether this address is in a move: running now, or broken and not yet
 * repaired. Unknown counts as moving (audit SG2, finding 22): every caller
 * then refuses what a move forbids (a login without the second step, adding
 * or turning off a way in), never lets it through.
 */
export async function isMoving(email: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const replies = repliesFor(await redisPipeline([["EXISTS", await movingKey(email)], ["EXISTS", await brokenKey(email)]]), 2);
  return !replies || markThere(replies[0]) || markThere(replies[1]);
}

/**
 * The mark itself ("app", "recovery" or "passkey:<id>"), for what has to know
 * which passkey opened the session (lib/second-step-gate.ts liveSecondStep,
 * which every check of a session's second step goes through).
 */
export async function sessionMark(id: string | undefined, email: string): Promise<string | null> {
  if (!id || !isRedisConfigured() || !/^[0-9a-f]{64}$/.test(id)) return null;
  const [owner, mark] = await redisPipeline([
    ["GET", await sessionKey(id)],
    ["GET", await secondKey(id)],
  ]);
  if (typeof owner !== "string" || !owner || owner !== normaliseEmail(email)) return null;
  return typeof mark === "string" && mark ? mark : null;
}

/** The step a mark names: "passkey:<id>" is a passkey. */
function stepOf(mark: unknown): string {
  return typeof mark === "string" ? mark.split(":")[0] : "";
}

/**
 * Thrown when the sessions to log out could not be read in their exact
 * shape: nothing was logged out and nothing deleted, so the caller says the
 * browsers could not be logged out, never that they were (audit SG2, findings 5 and 6).
 */
export class SessionsUnknownError extends UnknownReplyError {
  constructor(what: string) {
    super(what);
    this.name = "SessionsUnknownError";
  }
}

/**
 * Takes away what a second step that is gone had opened: every session of
 * the account whose mark `gone` matches is logged out, except `keep` (the
 * session making the change), which only loses its mark and stays logged in
 * as an emailed link would leave it. Answers how many were logged out.
 * Called when a passkey is removed ("passkey:<id>") and when the app is
 * turned off ("app" and "recovery"). Throws SessionsUnknownError when the
 * sessions or their marks cannot be read (nothing changed then) or when the
 * deletes' answers are not each 0 or 1 (some sessions may have been logged
 * out then); either way it is never said as done.
 */
export async function dropSecondStep(email: string, gone: (mark: string) => boolean, keep?: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const owned = await sessionsKey(normaliseEmail(email));
  const [members] = await redisPipeline([["SMEMBERS", owned]]);
  const keys = stringList(members);
  if (!keys) throw new SessionsUnknownError("an account's sessions");
  if (!keys.length) return 0;
  const marks = await Promise.all(keys.map((key) => secondKeyOf(key)));
  const read = repliesFor(await redisPipeline(marks.map((mark) => ["GET", mark])), marks.length);
  // One answer for each mark, each a mark or none: anything else is not read as "no mark".
  if (!read || read.some((mark) => mark !== null && typeof mark !== "string")) throw new SessionsUnknownError("the second steps of an account's sessions");
  const kept = keep && /^[0-9a-f]{64}$/.test(keep) ? await sessionKey(keep) : "";
  const commands: (string | number)[][] = [];
  let ended = 0;
  keys.forEach((key, i) => {
    const mark = read[i];
    if (typeof mark !== "string" || !gone(mark)) return;
    commands.push(["DEL", marks[i]]);
    if (key === kept) return;
    commands.push(["DEL", key], ["SREM", owned, key]);
    ended += 1;
  });
  // Each delete answers 0 or 1; anything else is not read as logged out (CX-123 rule 24; tests/auth-sessions-exact.test.ts).
  if (commands.length && !removedEach(await redisPipeline(commands), commands.length)) throw new SessionsUnknownError("the logging out of an account's sessions");
  return ended;
}

/** Whether a pipeline of single-key DEL and SREM commands answered each 0 or 1, in its exact shape. */
function removedEach(replies: unknown, commands: number): boolean {
  const answers = repliesFor(replies, commands);
  return answers !== null && answers.every((answer) => countOf(answer) === 0 || countOf(answer) === 1);
}

const sessionsKey = async (email: string) =>
  `nl:auth:sessions:${(await sha256Hex(`nimbus-auth-sessions:${email}`)).slice(0, 40)}`;

const rateKey = async (ip: string) =>
  `nl:rl:signin:${(await sha256Hex(`nimbus-signin:${ip}`)).slice(0, 32)}`;

const moveKey = async (token: string) =>
  `nl:auth:move:${(await sha256Hex(`nimbus-auth-move:${token}`)).slice(0, 40)}`;

const addressKey = async (email: string) =>
  `nl:rl:address:${(await sha256Hex(`nimbus-signin-address:${email}`)).slice(0, 32)}`;

/** Where a sign-in email stands against an hourly limit: inside it, past it, or unknown (CX-123 rule 24). */
export type LimitAnswer = "within" | "over" | "unknown";

/** Counts one more in the hour's window at `key`; a count in any other shape is unknown, and nothing is sent on it. */
async function hourCount(key: string, limit: number): Promise<LimitAnswer> {
  const replies = repliesFor(await redisPipeline([
    ["SET", key, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
    ["INCR", key],
  ]), 2);
  const count = countOf(replies?.[1]);
  return count === null ? "unknown" : count <= limit ? "within" : "over";
}

/** Five sign-in emails an hour from one address on the internet: where this one stands. */
export async function rateLimitAnswer(ip: string): Promise<LimitAnswer> {
  if (!isRedisConfigured()) return "unknown";
  return hourCount(await rateKey(ip), RATE_LIMIT);
}

/** Five sign-in emails an hour from one address on the internet. */
export async function withinRateLimit(ip: string): Promise<boolean> {
  return (await rateLimitAnswer(ip)) === "within";
}

/**
 * Starts a move of the sign-in address, and tells both sides.
 *
 * The link goes to the NEW address, because holding that inbox is the whole
 * proof being asked for. The OLD address gets a plain notice instead of a
 * link, so that a creator whose account is already in someone else's hands
 * learns about it while it is still theirs to save.
 */
export async function sendMoveLink(
  from: string,
  to: string,
  origin: string,
  /** The session that asked. The link works only while it is still open. */
  session: string,
): Promise<boolean> {
  const fromAddress = normaliseEmail(from);
  const toAddress = normaliseEmail(to);
  // Nobody becomes the demo store's owner, by this door either (lib/house-store.ts).
  if (isHouseAddress(toAddress)) return false;
  const token = randomToken();

  await redisPipeline([
    [
      "SET",
      await moveKey(token),
      JSON.stringify({ from: fromAddress, to: toAddress, session }),
      "EX",
      LINK_TTL_SECONDS,
    ],
  ]);

  // Best effort, and deliberately not awaited into the result: the creator's
  // move must not fail because a notice could not be delivered.
  void sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: fromAddress,
    subject: "Someone asked to move your Marktmorgen account",
    text: [
      `A request was made to move your Marktmorgen account to ${toAddress}.`,
      "",
      "If that was you, finish it from the link sent to that address.",
      "",
      `If it was not you, log in at ${origin}/signin with this email address and choose “Log out of all devices” at the bottom of your studio. Nothing has moved yet, and nothing moves until someone opens the link sent to that other address.`,
    ].join("\n"),
  }).catch(() => undefined);

  return sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: toAddress,
    subject: "Finish moving your Marktmorgen account",
    text: [
      `Your Marktmorgen account at ${fromAddress} is being moved here.`,
      "",
      `${origin}/signin/confirm-move?token=${token}`,
      "",
      "It works once and stops working in 15 minutes.",
      "If you did not ask for it, ignore this email — nothing happens.",
    ].join("\n"),
  });
}

/**
 * Spends a move link and says which address is moving where. A link whose
 * asking session has since been closed (logging out, or out of every device,
 * as the notice to the old address advises) moves nothing.
 */
export async function spendMoveLink(
  token: string,
): Promise<{ from: string; to: string } | null> {
  if (!isRedisConfigured()) return null;
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  const key = await moveKey(token);
  let raw: unknown;
  try {
    [raw] = await redisPipeline([["GETDEL", key]]);
  } catch {
    const [read] = await redisPipeline([["GET", key]]);
    const [removed] = await redisPipeline([["DEL", key]]);
    raw = Number(removed) === 1 ? read : null;
  }
  if (typeof raw !== "string" || !raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { from, to, session } = parsed as { from?: unknown; to?: unknown; session?: unknown };
    if (typeof from !== "string" || typeof to !== "string") return null;
    if (!from || !to) return null;
    if (typeof session !== "string" || normaliseEmail((await emailForSession(session)) ?? "") !== from) return null;
    return { from, to };
  } catch {
    return null;
  }
}

/**
 * Opens a session for an address that has just proved it holds the inbox,
 * and, when it was opened with one, the second step it was opened with
 * (SecondStep), kept exactly as long as the session.
 */
export async function openSession(email: string, second?: SecondStep, passkeyId?: string): Promise<string> {
  const id = randomToken();
  const opened = await sessionKey(id);
  const owned = await sessionsKey(normaliseEmail(email));
  const fresh = await freshKey(id);
  const mark = await secondKey(id);
  const writes: (string | number)[][] = [
    ["SET", opened, normaliseEmail(email), "EX", SESSION_TTL_SECONDS],
    ["SET", fresh, "1", "EX", FRESH_LOGIN_SECONDS],
    ...(second ? [["SET", mark, second === "passkey" && passkeyId ? `passkey:${passkeyId}` : second, "EX", SESSION_TTL_SECONDS]] : []),
  ];
  const replies = repliesFor(await redisPipeline([...writes, ["SADD", owned, opened], ["EXPIRE", owned, SESSION_TTL_SECONDS + 86_400]]), writes.length + 2);
  // Every write answered "OK", and the account's set its 0 or 1 twice (CX-123 rule 24): a session the set may not
  // hold is out of reach of "Log out of all devices", so it is taken back and the login fails, never opened
  // (tests/auth-sessions-exact.test.ts). Its id was never given out and no cookie is set: lib/signin-finish.ts and
  // the move route say the login failed; the other routes answer an error page, as a Redis error already did.
  const counted = (reply: unknown) => countOf(reply) === 0 || countOf(reply) === 1;
  if (!replies || !replies.slice(0, writes.length).every((reply) => reply === "OK") || !replies.slice(writes.length).every(counted)) {
    await redisPipeline([["DEL", opened, fresh, mark], ["SREM", owned, opened]]).catch((error: unknown) => console.error("taking back a session that could not be opened failed", error));
    throw new UnknownReplyError("a new session");
  }
  return id;
}

/** Eight sign-in emails an hour to one address, however many machines ask: where this one stands. */
export async function addressLimitAnswer(email: string): Promise<LimitAnswer> {
  if (!isRedisConfigured()) return "unknown";
  return hourCount(await addressKey(normaliseEmail(email)), ADDRESS_LIMIT);
}

/** Eight sign-in emails an hour to one address, however many machines ask. */
export async function withinAddressLimit(email: string): Promise<boolean> {
  return (await addressLimitAnswer(email)) === "within";
}

/** Wrong codes one request may try before its code stops working (the link still works). */
export const EMAIL_CODE_TRIES = 5;
/** Code tries one address may take in the hour, all its requests together (Claude 4 on 652 [WG12]). */
export const EMAIL_CODE_TRIES_PER_ADDRESS_HOUR = 10;
/** Code tries one address may take in a day from its first, all its requests together; past them, only the link opens (Claude 3 on #2736). */
export const EMAIL_CODE_TRIES_PER_ADDRESS_DAY = 20;
/** Code tries one machine may take in the hour, counted before any record is read (Claude 3 on #2736). */
export const EMAIL_CODE_TRIES_PER_IP_HOUR = 30;

/** A day, in seconds: the window of EMAIL_CODE_TRIES_PER_ADDRESS_DAY. */
const CODE_DAY_SECONDS = 24 * 60 * 60;

/**
 * Where a machine stands against its code tries of the hour (Claude 3 on
 * #2736): counted before any record is read, so a machine cannot buy reads
 * of made-up ids without bound; unknown is said as such, and nothing is read.
 */
export async function codeRateAnswer(ip: string): Promise<LimitAnswer> {
  if (!isRedisConfigured()) return "unknown";
  return hourCount(await codeIpKey(ip), EMAIL_CODE_TRIES_PER_IP_HOUR);
}

/** A request's id that opens nothing, for an answer that must look like every other (the form's honeypot). */
export function unusedSignInRequest(): string {
  return randomToken();
}

/** What a request for a link answers: whether it was sent, and the request's id, which only the asking browser holds. */
export type SignInRequest = { sent: boolean; request: string };

/**
 * Creates the one-time link and a six-digit code (652 [WG12]) and emails them
 * together. The request's id goes back to the browser that asked, whatever
 * the address, so it says nothing about who has an account; the code opens
 * only with it. A new request leaves only its own code working.
 */
export async function sendSignInLink(
  email: string,
  origin: string,
  handle?: unknown,
): Promise<SignInRequest> {
  const address = normaliseEmail(email);
  const request = randomToken();
  // The demo store's owner is nobody (lib/house-store.ts): no link is made
  // for that address, so no session can ever be opened as it. The caller
  // answers as it does for any address, and says nothing about this one.
  if (isHouseAddress(address)) return { sent: false, request };
  const token = randomToken();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const link = await linkKey(token);
  const record = await codeKey(request);
  // No deployment secret, no code: the email carries the link alone (codeHash).
  const verifier = codeHash(request, code);

  await redisPipeline([
    ["SET", link, address, "EX", LINK_TTL_SECONDS],
    ...(verifier
      ? [
          ["HSET", record, "k", link, "p", await linkCodeKey(token), "a", await lastCodeKey(address), "t", await codeTriesKey(address), "d", await codeDayKey(address), "h", verifier, "n", 0],
          ["EXPIRE", record, LINK_TTL_SECONDS],
          ["SET", await linkCodeKey(token), record, "EX", LINK_TTL_SECONDS],
          // Only the newest code of an address opens (Claude 4 on 652 [WG12]): an older one is refused by this mark.
          ["SET", await lastCodeKey(address), record, "EX", LINK_TTL_SECONDS],
        ]
      : [["DEL", await lastCodeKey(address)]]),
  ]);

  // The link lands on a page that asks for one tap. It deliberately does not
  // land on something a mail filter could spend by merely opening it.
  // The store address typed on the home page rides in the link itself, only
  // when it is a valid one, so the address step opens with it filled in
  // (lib/handle-prefill.ts). It is not stored with the token or anywhere else.
  const url = withPrefill(`${origin}/signin/confirm?token=${token}`, handle);
  const sent = await sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: address,
    subject: "Your Marktmorgen login link",
    text: [
      "Here is your link to log in to Marktmorgen.",
      "",
      url,
      "",
      ...(verifier
        ? [
            "Or type this code on the page where you asked for the link, without reloading that page:",
            "",
            code,
            "",
            "The link works once and stops working in 15 minutes, and so does the code: using one spends the other.",
          ]
        : ["The link works once and stops working in 15 minutes."]),
      "If you did not ask for it, ignore this email — nothing happens.",
    ].join("\n"),
  });
  return { sent, request };
}

/**
 * Spends a sign-in link and says whose it was, opening nothing: for an
 * account with two-step login, the session waits for its code
 * (lib/two-step.ts). The link is deleted first, so a link that leaks after the
 * fact is already worthless.
 */
export async function takeSignInLink(token: string): Promise<string | null> {
  if (!isRedisConfigured()) return null;
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  // Reading and spending the link must be one step. Two clicks that land at
  // the same moment would otherwise both find the email still there and both
  // open a session. GETDEL does it in a single command; where that command is
  // missing, the fallback keeps the guarantee by trusting the delete, not the
  // read — only the caller whose DEL actually removed the key gets in.
  // Unknown is no address: the link opens nothing (spendLinkKey).
  const email = (await spendLinkKey(await linkKey(token))) ?? null;
  // The link spends its code too (652 [WG12]). Should this fail, the code still cannot open: the link it spends is gone.
  try {
    const [record] = await redisPipeline([["GETDEL", await linkCodeKey(token)]]);
    if (typeof record === "string" && record.startsWith("nl:auth:code:")) await redisPipeline([["DEL", record]]);
  } catch (error) {
    console.error("letting a login link's code go failed", error);
  }
  return email;
}

/** Reads and deletes a link's record in one step: only the caller whose delete removed it gets the address. */
/**
 * Spends a link's record and says whose it was: the address, null when it is
 * gone, undefined when Redis answered in a shape this code does not know
 * (CX-123 rule 24; Codex CX1 on #2736). Every reply is read exactly, so an
 * unknown one never opens anything.
 */
async function spendLinkKey(key: string): Promise<string | null | undefined> {
  let email: unknown;
  try {
    const spent = repliesFor(await redisPipeline([["GETDEL", key]]), 1);
    if (!spent) return undefined;
    email = spent[0];
  } catch {
    const read = repliesFor(await redisPipeline([["GET", key]]), 1);
    const removed = repliesFor(await redisPipeline([["DEL", key]]), 1);
    if (!read || !removed || (removed[0] !== 0 && removed[0] !== 1)) return undefined;
    email = removed[0] === 1 ? read[0] : null;
  }
  if (email === null) return null;
  return typeof email === "string" && email ? email : undefined;
}

/**
 * What typing the emailed code answered: whose it was (the link spent with
 * it, nothing opened yet), a wrong code with the tries left, too many wrong
 * codes, a code past its time or spent, the code's shape, or unknown.
 */
export type CodeAnswer =
  | { owner: string }
  | { wrong: number }
  | "blocked"
  | "address-blocked"
  | "expired"
  | "invalid"
  | "unknown";

/**
 * Spends a request's code (652 [WG12]). Every try is counted before the
 * comparison, for the request and for the address, each read in its exact
 * shape (CX-123 rule 24): unknown refuses and never opens. The comparison is
 * in constant time against a hash. Right, it spends the same link record the
 * link would, so only one of the two can ever open.
 */
export async function takeSignInCode(request: unknown, typed: unknown): Promise<CodeAnswer> {
  if (!isRedisConfigured()) return "unknown";
  if (typeof request !== "string" || !/^[0-9a-f]{64}$/.test(request)) return "expired";
  const code = typeof typed === "string" ? typed.replace(/[\s-]/g, "") : "";
  if (!/^\d{6}$/.test(code)) return "invalid";
  const record = await codeKey(request);
  const read = repliesFor(await redisPipeline([["HMGET", record, "k", "p", "a", "t", "d", "h"]]), 1)?.[0];
  if (!Array.isArray(read) || read.length !== 6) return "unknown";
  if (read.every((field) => field === null)) return "expired";
  const [link, pointer, last, tries, day, hash] = read;
  if ([link, pointer, last, tries, day, hash].some((field) => typeof field !== "string") || !/^[0-9a-f]{64}$/.test(hash as string)) return "unknown";
  // The tries, counted before anything is compared: the address's in the hour and in the day, then the request's own.
  // The record's time is read with them: a record gone since the HMGET is recreated by HINCRBY without one, and is
  // let go here rather than kept forever (Claude 3 on #2736).
  const counted = repliesFor(await redisPipeline([
    ["SET", tries as string, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
    ["INCR", tries as string],
    ["SET", day as string, "0", "EX", CODE_DAY_SECONDS, "NX"],
    ["INCR", day as string],
    ["HINCRBY", record, "n", 1],
    ["TTL", record],
    ["GET", last as string],
  ]), 7);
  const forAddress = countOf(counted?.[1]);
  const forDay = countOf(counted?.[3]);
  const forRequest = countOf(counted?.[4]);
  const left = counted?.[5];
  const newest = counted?.[6];
  if (!counted || forAddress === null || forDay === null || forRequest === null) return "unknown";
  if (typeof left !== "number" || !Number.isSafeInteger(left) || left < -2 || (newest !== null && typeof newest !== "string")) return "unknown";
  if (left === -1 || newest !== record) {
    // Recreated without a time, a newer request for the address, or none left: only the newest code opens.
    await redisPipeline([["DEL", record]]);
    return "expired";
  }
  // Kept until its time runs out, so every later try is told the same: too many wrong codes, use the link.
  if (forRequest > EMAIL_CODE_TRIES) return "blocked";
  if (forAddress > EMAIL_CODE_TRIES_PER_ADDRESS_HOUR || forDay > EMAIL_CODE_TRIES_PER_ADDRESS_DAY) return "address-blocked";
  const verifier = codeHash(request, code);
  if (!verifier) return "expired";
  const expected = Buffer.from(hash as string, "hex");
  const given = Buffer.from(verifier, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { wrong: Math.max(0, EMAIL_CODE_TRIES - forRequest) };
  }
  const owner = await spendLinkKey(link as string);
  // Still the newest after the link was spent (Codex CX1 on #2736): a newer request that finished before the spend has
  // moved the mark, and this code then opens nothing. Read after the spend, so no request can come between the check and
  // the spend; a request that comes after the spend found this code the newest when it was used.
  const after = repliesFor(await redisPipeline([["GET", last as string]]), 1);
  await redisPipeline([["DEL", record, pointer as string]]).catch((error: unknown) => console.error("letting a spent code go failed", error));
  if (owner === undefined || !after || (after[0] !== null && typeof after[0] !== "string")) return "unknown";
  if (after[0] !== record) return "expired";
  return owner ? { owner } : "expired";
}

const googleKey = async (state: string) =>
  `nl:auth:link:${(await sha256Hex(`nimbus-auth-google:${state}`)).slice(0, 40)}`;

/** How long Google's page may stay open before the login it started is gone. */
export const GOOGLE_STATE_SECONDS = 10 * 60;

/**
 * Keeps what a login with Google needs when Google sends the person back
 * (lib/google-signin.ts): the PKCE verifier and the nonce, nothing about the
 * person. Under the sign-in link's own family and salted apart from it, so
 * neither can ever be read as the other.
 */
export async function keepGoogleState(state: string, value: string): Promise<void> {
  await redisPipeline([["SET", await googleKey(state), value, "EX", GOOGLE_STATE_SECONDS]]);
}

/** Spends it, once: two answers that arrive together cannot both read it. */
export async function takeGoogleState(state: string): Promise<string | null> {
  if (!isRedisConfigured()) return null;
  const key = await googleKey(state);
  let value: unknown;
  try {
    [value] = await redisPipeline([["GETDEL", key]]);
  } catch {
    const [read] = await redisPipeline([["GET", key]]);
    const [removed] = await redisPipeline([["DEL", key]]);
    value = Number(removed) === 1 ? read : null;
  }
  return typeof value === "string" && value ? value : null;
}

/**
 * Spends a sign-in link and opens a session. The link is deleted first, so a
 * link that leaks after the fact is already worthless.
 */
export async function spendSignInLink(token: string): Promise<string | null> {
  const email = await takeSignInLink(token);
  return email ? openSession(email) : null;
}

/**
 * Whose session this is, read exactly (CX-123 rule 24): the address; null when the id is not a session's or the
 * session is confirmed gone (GET null); UnknownReplyError for any other answer. For what says something was done
 * with the session (app/api/auth/signout-all), where unknown must never be taken as "nobody's".
 */
export async function sessionEmail(id: string | undefined): Promise<string | null> {
  if (!id || !isRedisConfigured()) return null;
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const reply = repliesFor(await redisPipeline([["GET", await sessionKey(id)]]), 1);
  if (!reply) throw new UnknownReplyError("a session");
  if (reply[0] === null) return null;
  if (typeof reply[0] !== "string" || !reply[0]) throw new UnknownReplyError("a session");
  return reply[0];
}

/** Whose session this is, for a gate: unknown lets nobody in, so it is read as signed out (sessionEmail says which). */
export async function emailForSession(
  id: string | undefined,
): Promise<string | null> {
  return sessionEmail(id).catch((error: unknown) => {
    if (error instanceof UnknownReplyError) return null;
    throw error;
  });
}

/**
 * Logs one session out at the server. True when it is known to be gone: its delete answered 0 or 1, or there was
 * no session to close. False when it may still be open: a failure, or an answer in another shape (CX-123 rule 24),
 * which the caller says as such, never as logged out (app/api/auth/signout; tests/auth-sessions-exact.test.ts).
 * Never throws.
 */
export async function endSession(id: string | undefined): Promise<boolean> {
  if (!id || !isRedisConfigured()) return true;
  if (!/^[0-9a-f]{64}$/.test(id)) return true;
  try {
    const key = await sessionKey(id);
    const email = repliesFor(await redisPipeline([["GET", key]]), 1)?.[0];
    const commands: (string | number)[][] = [["DEL", key], ["DEL", await secondKeyOf(key)]];
    // The account's set is tidied when the owner was read; a key left in it names a session that is gone.
    if (typeof email === "string" && email) {
      commands.push(["SREM", await sessionsKey(email), key]);
    }
    const done = repliesFor(await redisPipeline(commands), commands.length);
    const gone = countOf(done?.[0]);
    return gone === 0 || gone === 1;
  } catch (error) {
    console.error("sign-out failed", error);
    return false;
  }
}

/**
 * Closes every session this creator has open, anywhere.
 *
 * This is the answer to a session cookie that walked off on a borrowed laptop:
 * without it, a thirty-day session is thirty days whatever the creator does.
 * Returns how many were closed, or null when that is not known (nothing read, or a failure).
 */
export async function endAllSessions(email: string): Promise<number | null> {
  if (!isRedisConfigured()) return 0;
  const owned = await sessionsKey(normaliseEmail(email));
  try {
    const [members] = await redisPipeline([["SMEMBERS", owned]]);
    // The set is the only way to the sessions (audit SG2, rule 30): unread, it is kept and nothing is deleted.
    const keys = stringList(members);
    if (!keys) throw new SessionsUnknownError("an account's sessions");
    const marks = await Promise.all(keys.map((key) => secondKeyOf(key)));
    const commands: (string | number)[][] = [...keys.map((key) => ["DEL", key]), ...marks.map((mark) => ["DEL", mark]), ["DEL", owned]];
    // Each delete answers 0 or 1: an answer missing or in another shape is not a session closed (CX-123 rule 24).
    if (!removedEach(await redisPipeline(commands), commands.length)) throw new SessionsUnknownError("the logging out of an account's sessions");
    return keys.length;
  } catch (error) {
    console.error("sign-out everywhere failed", error);
    // Not "none were closed": unknown (audit SG2, rule 30).
    return null;
  }
}

/**
 * Closes every session this creator has open except `keep`, the one asking (757 [STN4], unit 1): the laptop left
 * logged in is shut without logging this browser out too. `keep` stays logged in with its second-step mark and its
 * place in the account's set. Returns how many were closed, or null when that is not known: `keep` not in a
 * session's shape (never read as "keep none", which would close this browser too), the set unread, a delete
 * answered in another shape, or a failure (CX-123 rule 24; tests/sign-out-others.test.ts). Never throws.
 */
export async function endOtherSessions(email: string, keep: string | undefined): Promise<number | null> {
  if (!keep || !/^[0-9a-f]{64}$/.test(keep)) return null;
  if (!isRedisConfigured()) return 0;
  const owned = await sessionsKey(normaliseEmail(email));
  try {
    const kept = await sessionKey(keep);
    const [members] = await redisPipeline([["SMEMBERS", owned]]);
    // As endAllSessions: the set is the only way to the sessions, so an unread one closes nothing.
    const keys = stringList(members);
    if (!keys) throw new SessionsUnknownError("an account's sessions");
    const others = keys.filter((key) => key !== kept);
    if (!others.length) return 0;
    const marks = await Promise.all(others.map((key) => secondKeyOf(key)));
    const commands: (string | number)[][] = [
      ...others.map((key) => ["DEL", key]),
      ...marks.map((mark) => ["DEL", mark]),
      ...others.map((key) => ["SREM", owned, key]),
    ];
    if (!removedEach(await redisPipeline(commands), commands.length)) throw new SessionsUnknownError("the logging out of an account's other sessions");
    return others.length;
  } catch (error) {
    console.error("logging out the other devices failed", error);
    return null;
  }
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

/** A session cookie, as every way of signing in sets it. */
export function sessionCookie(id: string): string {
  const options = SESSION_COOKIE_OPTIONS;
  return [
    `${SESSION_COOKIE}=${id}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    options.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export const DEVICE_COOKIE = "nl_device";
/** As long as a browser keeps a cookie at all. */
const DEVICE_TTL_SECONDS = 400 * 24 * 60 * 60;
/** Browsers remembered per account; past it, a new one is still told about, just not added. */
const MAX_DEVICES = 100;

const devicesKey = async (email: string) =>
  `nl:auth:devices:${(await sha256Hex(`nimbus-auth-devices:${normaliseEmail(email)}`)).slice(0, 40)}`;

/** How a session was opened, for the email that tells the creator about it. */
export type SignInWay = "link" | "code" | "passkey" | "invitation" | "google";

const WAY_WORDS: Record<SignInWay, string> = {
  link: "with a login link sent to this address",
  code: "with a login code sent to this address",
  passkey: "with a passkey",
  invitation: "by accepting an invitation to a store's team",
  google: "with Google, which confirmed this address",
};

/** "Chrome on macOS", or as near as a user agent says. Never more than that. */
export function browserName(userAgent: string): string {
  const ua = userAgent || "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "A browser";
  const system = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return system ? `${browser} on ${system}` : browser;
}

/**
 * Writes down the browser a session was just opened in, and emails the
 * creator when the account has signed in before but never from this browser.
 * Returns the cookie that names the browser, to be set on the response.
 * Never throws: a notice that could not be sent does not undo a sign-in.
 */
export async function noteSignIn(
  email: string,
  deviceCookie: string | undefined,
  way: SignInWay,
  userAgent: string,
  options: { quiet?: boolean } = {},
): Promise<string> {
  const id = deviceCookie && /^[0-9a-f]{64}$/.test(deviceCookie) ? deviceCookie : randomToken();
  const secure = process.env.NODE_ENV === "production";
  const cookie = `${DEVICE_COOKIE}=${id}; Path=/; Max-Age=${DEVICE_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  if (!isRedisConfigured()) return cookie;
  try {
    const key = await devicesKey(email);
    const seen = (await sha256Hex(`nimbus-device:${id}`)).slice(0, 40);
    const replies = repliesFor(await redisPipeline([
      ["SISMEMBER", key, seen],
      ["SCARD", key],
    ]), 2);
    const known = countOf(replies?.[0]);
    const count = countOf(replies?.[1]);
    // SISMEMBER's 0 or 1 and SCARD's count, each in its exact shape (CX-123 rule 24). An unknown SISMEMBER notes
    // nothing and sends nothing, as when Redis does not answer (the catch below); the login itself goes on.
    if (known === null || known > 1) throw new UnknownReplyError("the browsers seen with an account");
    if (known === 1) {
      await redisPipeline([["EXPIRE", key, DEVICE_TTL_SECONDS]]);
      return cookie;
    }
    // A browser surely new with an unknown count is told about in the doubt, once, and not noted (Claude 4, second
    // review of #2717): unnoted, the next login from it is new again, as it would be past MAX_DEVICES.
    if (count !== null && count < MAX_DEVICES) {
      await redisPipeline([
        ["SADD", key, seen],
        ["EXPIRE", key, DEVICE_TTL_SECONDS],
      ]);
    }
    if ((count === null || count > 0) && !options.quiet && isSenderConfigured()) {
      const when = new Date().toISOString().replace("T", " ").slice(0, 16);
      await sendEmail({ meter: { by: "company" },
        from: NIMBUS_FROM,
        to: normaliseEmail(email),
        replyTo: "support@marktmorgen.com",
        subject: "New login to your Marktmorgen account",
        text: [
          `Someone just logged in to your Marktmorgen account (${normaliseEmail(email)}) from a browser that had not been used with it before.`,
          "",
          `When: ${when} UTC`,
          `How: ${WAY_WORDS[way]}`,
          `Browser: ${browserName(userAgent)}`,
          "",
          "If this was you, there is nothing to do.",
          "",
          "If it was not you: log in at",
          "https://marktmorgen.com/signin",
          "with this email address, choose “Log out of all devices” at the bottom of your studio, remove any passkey you do not recognize, and reply to this email so we can help.",
        ].join("\n"),
      }).catch(() => false);
    }
  } catch (error) {
    console.error("noting a sign-in failed", error);
  }
  return cookie;
}

/** Carries the browsers an account knows to its new address, when it moves. */
export async function moveDevices(from: string, to: string): Promise<void> {
  if (!isRedisConfigured()) return;
  const [members] = await redisPipeline([["SMEMBERS", await devicesKey(from)]]);
  const list = Array.isArray(members) ? members.filter((m): m is string => typeof m === "string") : [];
  await redisPipeline([
    ...(list.length ? [["SADD", await devicesKey(to), ...list], ["EXPIRE", await devicesKey(to), DEVICE_TTL_SECONDS]] : []),
    ["DEL", await devicesKey(from)],
  ]);
}
