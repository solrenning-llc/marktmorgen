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
 *   nl:auth:sessions:<hash> -> the set of a creator's live sessions, so that
 *                              they can close every one of them at once
 *   nl:auth:move:<hash>     -> a move from one address to another, 15 minutes,
 *                              spent on the tap that finishes it
 *   nl:auth:devices:<hash>  -> the browsers an account has signed in from,
 *                              each by a one-way hash of its nl_device cookie
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
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isHouseAddress } from "@/lib/house-store";
import { withPrefill } from "@/lib/handle-prefill";

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_LENGTH = 254;
export const SESSION_COOKIE = "nl_session";

const LINK_TTL_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
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

const sessionKey = async (id: string) =>
  `nl:auth:session:${(await sha256Hex(`nimbus-auth-session:${id}`)).slice(0, 40)}`;

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
  const [found] = await redisPipeline([["EXISTS", await freshKey(id)]]);
  return Number(found) === 1;
}

const sessionsKey = async (email: string) =>
  `nl:auth:sessions:${(await sha256Hex(`nimbus-auth-sessions:${email}`)).slice(0, 40)}`;

const rateKey = async (ip: string) =>
  `nl:rl:signin:${(await sha256Hex(`nimbus-signin:${ip}`)).slice(0, 32)}`;

const moveKey = async (token: string) =>
  `nl:auth:move:${(await sha256Hex(`nimbus-auth-move:${token}`)).slice(0, 40)}`;

const addressKey = async (email: string) =>
  `nl:rl:address:${(await sha256Hex(`nimbus-signin-address:${email}`)).slice(0, 32)}`;

/** Five sign-in emails an hour from one address on the internet. */
export async function withinRateLimit(ip: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const key = await rateKey(ip);
  const [, count] = await redisPipeline([
    ["SET", key, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
    ["INCR", key],
  ]);
  return Number(count) <= RATE_LIMIT;
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

/** Opens a session for an address that has just proved it holds the inbox. */
export async function openSession(email: string): Promise<string> {
  const id = randomToken();
  const opened = await sessionKey(id);
  const owned = await sessionsKey(normaliseEmail(email));
  await redisPipeline([
    ["SET", opened, normaliseEmail(email), "EX", SESSION_TTL_SECONDS],
    ["SET", await freshKey(id), "1", "EX", FRESH_LOGIN_SECONDS],
    ["SADD", owned, opened],
    ["EXPIRE", owned, SESSION_TTL_SECONDS + 86_400],
  ]);
  return id;
}

/** Eight sign-in emails an hour to one address, however many machines ask. */
export async function withinAddressLimit(email: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const key = await addressKey(normaliseEmail(email));
  const [, count] = await redisPipeline([
    ["SET", key, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
    ["INCR", key],
  ]);
  return Number(count) <= ADDRESS_LIMIT;
}

/** Creates the one-time link and emails it. Returns false if nothing was sent. */
export async function sendSignInLink(
  email: string,
  origin: string,
  handle?: unknown,
): Promise<boolean> {
  const address = normaliseEmail(email);
  // The demo store's owner is nobody (lib/house-store.ts): no link is made
  // for that address, so no session can ever be opened as it. The caller
  // answers as it does for any address, and says nothing about this one.
  if (isHouseAddress(address)) return false;
  const token = randomToken();

  await redisPipeline([
    ["SET", await linkKey(token), address, "EX", LINK_TTL_SECONDS],
  ]);

  // The link lands on a page that asks for one tap. It deliberately does not
  // land on something a mail filter could spend by merely opening it.
  // The store address typed on the home page rides in the link itself, only
  // when it is a valid one, so the address step opens with it filled in
  // (lib/handle-prefill.ts). It is not stored with the token or anywhere else.
  const link = withPrefill(`${origin}/signin/confirm?token=${token}`, handle);
  return sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: address,
    subject: "Your Marktmorgen login link",
    text: [
      "Here is your link to log in to Marktmorgen.",
      "",
      link,
      "",
      "It works once and stops working in 15 minutes.",
      "If you did not ask for it, ignore this email — nothing happens.",
    ].join("\n"),
  });
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
  const key = await linkKey(token);
  let email: unknown;
  try {
    [email] = await redisPipeline([["GETDEL", key]]);
  } catch {
    const [read] = await redisPipeline([["GET", key]]);
    const [removed] = await redisPipeline([["DEL", key]]);
    email = Number(removed) === 1 ? read : null;
  }
  return typeof email === "string" && email ? email : null;
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

export async function emailForSession(
  id: string | undefined,
): Promise<string | null> {
  if (!id || !isRedisConfigured()) return null;
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const [email] = await redisPipeline([["GET", await sessionKey(id)]]);
  return typeof email === "string" && email ? email : null;
}

export async function endSession(id: string | undefined): Promise<void> {
  if (!id || !isRedisConfigured()) return;
  if (!/^[0-9a-f]{64}$/.test(id)) return;
  try {
    const key = await sessionKey(id);
    const [email] = await redisPipeline([["GET", key]]);
    const commands: (string | number)[][] = [["DEL", key]];
    if (typeof email === "string" && email) {
      commands.push(["SREM", await sessionsKey(email), key]);
    }
    await redisPipeline(commands);
  } catch (error) {
    console.error("sign-out failed", error);
  }
}

/**
 * Closes every session this creator has open, anywhere.
 *
 * This is the answer to a session cookie that walked off on a borrowed laptop:
 * without it, a thirty-day session is thirty days whatever the creator does.
 * Returns how many were closed.
 */
export async function endAllSessions(email: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const owned = await sessionsKey(normaliseEmail(email));
  try {
    const [members] = await redisPipeline([["SMEMBERS", owned]]);
    const keys = Array.isArray(members)
      ? members.filter((key): key is string => typeof key === "string")
      : [];
    await redisPipeline([
      ...keys.map((key) => ["DEL", key] as (string | number)[]),
      ["DEL", owned],
    ]);
    return keys.length;
  } catch (error) {
    console.error("sign-out everywhere failed", error);
    return 0;
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
export type SignInWay = "link" | "passkey" | "invitation" | "google";

const WAY_WORDS: Record<SignInWay, string> = {
  link: "with a login link sent to this address",
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
    const [known, count] = await redisPipeline([
      ["SISMEMBER", key, seen],
      ["SCARD", key],
    ]);
    if (Number(known) === 1) {
      await redisPipeline([["EXPIRE", key, DEVICE_TTL_SECONDS]]);
      return cookie;
    }
    if (Number(count) < MAX_DEVICES) {
      await redisPipeline([
        ["SADD", key, seen],
        ["EXPIRE", key, DEVICE_TTL_SECONDS],
      ]);
    }
    if (Number(count) > 0 && !options.quiet && isSenderConfigured()) {
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
