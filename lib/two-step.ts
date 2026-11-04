/**
 * Two-step login (added 13 October 2026): after the emailed link, a six-digit
 * code from an authenticator app (lib/totp.ts), for a creator who turns it on.
 * Off until they do, because the emailed link alone is how everybody here has
 * always logged in, and a second step somebody did not ask for is a door they
 * can be locked out of.
 *
 * What it protects against: somebody who gets into the creator's inbox, or
 * finds a login link in it, still cannot open the studio without the phone.
 *
 * What counts as the second step:
 *
 *   - the code the app shows now, or one step either side for a phone clock a
 *     little off, used once: a code already used does not open anything again;
 *   - one of ten recovery codes, shown once when it is turned on, each good
 *     once and kept only as a hash. Using one emails the account;
 *   - a passkey (lib/passkeys.ts), which already asks the device for its own
 *     check — a fingerprint, a face, a PIN — so it is never asked for a code.
 *
 * Turning it on needs a login from the last fifteen minutes and a right code
 * from the app; turning it off, or making new recovery codes, needs a right
 * code. Each of the three emails the account. Five wrong codes end a waiting
 * login, and an account answers ten codes an hour at most, so six digits
 * cannot be guessed by trying.
 *
 * Nobody is locked out, and nobody here has to unlock anybody by hand. Turning
 * it on asks for a recovery address — a second inbox, confirmed with a code
 * sent to it — and a creator who has lost the phone, the recovery codes and
 * every passkey has a link sent there from the code page: opening it turns
 * two-step login off and logs them in at once. Somebody who got into the
 * sign-in inbox alone cannot, because the link goes to the other one.
 *
 * When the recovery inbox is lost as well (or for an account set up before
 * there was one), the creator still gets in at once, from the same page, with
 * the emailed link alone — into a studio where what could take money, data or
 * the account itself away is locked for RESET_DAYS (LOCKED_NEEDS: payments,
 * the plan, the team, deleting, exports, settings, sending to the list,
 * imports, the sign-in address, passkeys, two-step login). They can sell, edit
 * their products and pages, answer buyers and read their numbers meanwhile.
 * After those days two-step login turns off and nothing is locked. In that
 * time the account is emailed, every browser still logged in shows it, and any
 * login with a right code or a passkey — or one press of Cancel in the studio —
 * calls it off and logs the locked sessions out. So somebody who only has the
 * inbox gets nothing that matters before the owner can see it, and the owner
 * who really lost everything is back at work the same minute, without writing
 * to anyone. Exchanges and banks hold withdrawals after a recovery the same
 * way; NIST SP 800-63B-4 asks for the notices.
 *
 * The app's secret is sealed at rest (lib/secret-box.ts), bound to the
 * account's address, so a copy of the database alone opens nothing. If the
 * deployment's root secret were ever rolled the app's codes could no longer be
 * checked; the recovery codes and passkeys still let the creator in, and the
 * page says so.
 *
 *   nl:2fa:<hash>         the account's record: the sealed secret, when it was
 *                         turned on, the recovery codes' hashes, the last step used
 *   nl:2fa:setup:<hash>   a secret being set up, 10 minutes, tied to the session
 *   nl:2fa:hold:<hash>    a login that has passed the emailed link and waits
 *                         for its code, 10 minutes, tied to a cookie of that browser
 *   nl:2fa:rescue:<hash>  a link sent to the recovery address, 15 minutes, spent once
 *   nl:2fa:locked:<hash>  a session opened without the second step: until when it is locked
 *   nl:2fa:lockedset:<hash> the account's locked sessions, to log them out on Cancel
 */
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, endSession, normaliseEmail, openSession } from "@/lib/auth";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinLimit } from "@/lib/request-guard";
import { seal, unseal } from "@/lib/secret-box";
import { SITE_URL } from "@/lib/site-url";
import { newSecret, otpauthUri, stepOf } from "@/lib/totp";
import { alignRecoveryLock, endRecoveryLock, hideAddress, keepRecoveryAddress, recoveryAddress } from "@/lib/recovery-address";

export { hideAddress };

export const TWO_STEP_COOKIE = "nl_2fa";
export const HOLD_SECONDS = 10 * 60;
const SETUP_SECONDS = 10 * 60;
const TRIES = 5;
const CODES_PER_HOUR = 10;
export const RECOVERY_CODES = 10;
const CODE_LETTERS = "abcdefghjkmnpqrstuvwxyz23456789";
/** How long a request to turn it off without a code waits before it does. */
export const RESET_DAYS = 7;
const ISSUER = "Marktmorgen";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const recordKey = (email: string) => `nl:2fa:${sha(`nimbus-2fa:${normaliseEmail(email)}`).slice(0, 40)}`;
const setupKey = (session: string) => `nl:2fa:setup:${sha(`nimbus-2fa-setup:${session}`).slice(0, 40)}`;
const lockedKey = (session: string) => `nl:2fa:locked:${sha(`nimbus-2fa-locked:${session}`).slice(0, 40)}`;
const lockedSetKey = (email: string) => `nl:2fa:lockedset:${sha(`nimbus-2fa-lockedset:${normaliseEmail(email)}`).slice(0, 40)}`;
const rescueKey = (token: string) => `nl:2fa:rescue:${sha(`nimbus-2fa-rescue:${token}`).slice(0, 40)}`;
const holdKey = (token: string) => `nl:2fa:hold:${sha(`nimbus-2fa-hold:${token}`).slice(0, 40)}`;
const context = (email: string) => `two-step|${normaliseEmail(email)}`;
// Not bound to the address, so a move of the sign-in address keeps them; each code is random enough on its own.
const codeHash = (code: string) => sha(`nimbus-2fa-code:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`);

/**
 * `reset`: when a request to turn it off without a code takes effect, in ms; 0 for none.
 * `backup`: the recovery address, confirmed when it was turned on; "" on a record from before.
 */
type TwoStep = { s: string; since: number; codes: string[]; last: number; reset: number; backup: string };

function parse(raw: unknown): TwoStep | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<TwoStep>;
    if (typeof v.s !== "string") return null;
    return {
      s: v.s,
      since: typeof v.since === "number" ? v.since : 0,
      codes: Array.isArray(v.codes) ? v.codes.filter((c): c is string => typeof c === "string" && /^[0-9a-f]{64}$/.test(c)) : [],
      last: typeof v.last === "number" ? v.last : -1,
      reset: typeof v.reset === "number" && v.reset > 0 ? v.reset : 0,
      backup: typeof v.backup === "string" && EMAIL_PATTERN.test(v.backup) ? v.backup : "",
    };
  } catch {
    return null;
  }
}

async function read(email: string): Promise<TwoStep | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", recordKey(email)]]);
  return parse(raw);
}

async function write(email: string, record: TwoStep): Promise<void> {
  await redisPipeline([["SET", recordKey(email), JSON.stringify(record)]]);
}

/** Ten recovery codes, "abcd-efgh", each from 31 letters and digits nobody misreads. */
function newCodes(): string[] {
  return Array.from({ length: RECOVERY_CODES }, () => {
    const bytes = randomBytes(8);
    const text = Array.from(bytes, (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("");
    return `${text.slice(0, 4)}-${text.slice(4)}`;
  });
}

/** A short plain notice to the account's address when its second step changes or is used. */
async function tell(email: string, subject: string, line: string): Promise<void> {
  if (!isSenderConfigured()) return;
  const when = new Date().toISOString().replace("T", " ").slice(0, 16);
  await sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: normaliseEmail(email),
    replyTo: "support@marktmorgen.com",
    subject,
    text: [
      line,
      "",
      `When: ${when} UTC`,
      "",
      "If this was you, there is nothing to do.",
      "",
      "If it was not you: log in at",
      `${SITE_URL}/signin`,
      "choose “Log out of all devices” at the bottom of your studio, make new recovery codes under Two-step login, and reply to this email so we can help.",
    ].join("\n"),
  }).catch(() => false);
}

/**
 * `reset`: when a pending request to turn it off without a code takes effect, in ms; 0 for none.
 * `backup`: the recovery address, partly hidden ("v•••@g•••.com"), or "" when there is none.
 */
export type TwoStepStatus = { on: boolean; since: number; codesLeft: number; reset: number; backup: string };


/** The account's recovery address (lib/recovery-address.ts); a record from before kept its own. */
async function backupOf(email: string, record: TwoStep): Promise<string> {
  return (await recoveryAddress(email)) || record.backup;
}

export async function twoStepStatus(email: string): Promise<TwoStepStatus> {
  // A request whose days are over turns it off here too, so the studio never shows it as pending.
  await resetIfDue(email);
  const record = await read(email);
  return record
    ? { on: true, since: record.since, codesLeft: record.codes.length, reset: record.reset, backup: await backupOf(email, record).then((b) => (b ? hideAddress(b) : "")) }
    : { on: false, since: 0, codesLeft: 0, reset: 0, backup: "" };
}

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * What a session opened without the second step may not do until its days
 * are over (lib/studio-route.ts studioAccess): everything that moves money or
 * data out, changes who can get in, or cannot be undone.
 */
export const LOCKED_NEEDS: readonly string[] = ["billing", "payments", "team", "delete", "export", "settings", "send", "import"];

/** Until when a session is locked, in ms, or 0 for a session that is not. */
export async function lockedUntil(session: string | undefined, now = Date.now()): Promise<number> {
  if (!session || !/^[0-9a-f]{64}$/.test(session) || !isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["GET", lockedKey(session)]]);
  const until = Number(raw);
  return Number.isFinite(until) && until > now ? until : 0;
}

/**
 * Asked from the code page by somebody who has just opened an emailed link and
 * has neither a code, a passkey nor their recovery inbox: a session opens at
 * once, locked (LOCKED_NEEDS) until two-step login turns off by itself
 * RESET_DAYS after the first such request, unless the owner calls it off.
 * Asking again does not move the day. Answers the session to set.
 */
export async function enterLocked(token: string, now = Date.now()): Promise<{ session: string; email: string; until: number } | null> {
  const held = await heldInfo(token);
  const email = held?.email ?? null;
  const record = email ? await read(email) : null;
  if (!email || !record) return null;
  const through = held?.viaRecovery ? "a login link sent to your recovery address" : "a login link sent to this address";
  // Spent, as a right code spends it: one waiting login, one session.
  const [removed] = await redisPipeline([["DEL", holdKey(token)]]);
  if (Number(removed) !== 1) return null;
  const first = record.reset === 0;
  const until = first ? now + RESET_DAYS * 86_400_000 : record.reset;
  if (first) await write(email, { ...record, reset: until });
  const session = await openLockedSession(email, until, now);
  // The same day for a later login through the recovery address, which then opens everything once it has passed.
  await alignRecoveryLock(email, until, now);
  await tell(
    email,
    first ? "Your Marktmorgen account was opened without two-step login" : "Your Marktmorgen account was opened again without two-step login",
    `Somebody who opened ${through} said they no longer have your authenticator app, your recovery codes, a passkey or your recovery address, and was let in. Until ${day(until)}, payments, your plan, your team, exports, settings, sending to your list, your sign-in address, passkeys and two-step login are locked for them; after that, two-step login turns off.

If that was you, keep working: everything else is open.

If it was not you, somebody can read your email: log in with your app's code or a passkey, or open your studio in a browser that is still logged in and press Cancel. That logs them out and keeps two-step login on. Then change your email password.`,
  );
  return { session, email, until };
}

/** Opens a session locked (LOCKED_NEEDS) until `until`, logged out by Cancel or a full login. */
export async function openLockedSession(email: string, until: number, now = Date.now()): Promise<string> {
  const session = await openSession(email);
  const seconds = Math.max(60, Math.ceil((until - now) / 1000));
  await redisPipeline([
    ["SET", lockedKey(session), String(until), "EX", seconds],
    ["SADD", lockedSetKey(email), session],
    ["EXPIRE", lockedSetKey(email), seconds + 86_400],
  ]);
  return session;
}

/**
 * A full login — the sign-in inbox without two-step login, a right code or a
 * passkey — ends what the recovery address opened (lib/recovery-address.ts):
 * its locked sessions are logged out, and the account is told when there were any.
 */
export async function endRecoveryAccess(email: string): Promise<void> {
  if (!(await endRecoveryLock(email))) return;
  await endLocked(email);
  await tell(email, "What your recovery address opened was closed", "Your account was just logged in with your sign-in email, a code or a passkey, so the browsers that got in through your recovery address were logged out.");
}

/** Logs out every session opened without the second step. */
async function endLocked(email: string): Promise<void> {
  const [members] = await redisPipeline([["SMEMBERS", lockedSetKey(email)]]);
  const sessions = (Array.isArray(members) ? members : []).filter((m): m is string => typeof m === "string");
  for (const session of sessions) await endSession(session);
  await redisPipeline([["DEL", lockedSetKey(email), ...sessions.map((session) => lockedKey(session))]]);
}

/** Calls off a pending request: the owner logged in with a code or a passkey, or pressed Cancel. The locked sessions are logged out. */
export async function cancelReset(email: string, why: "login" | "studio"): Promise<boolean> {
  const record = await read(email);
  if (!record || record.reset === 0) return false;
  await write(email, { ...record, reset: 0 });
  await endLocked(email);
  await endRecoveryLock(email);
  await tell(
    email,
    "Two-step login stays on for your Marktmorgen account",
    why === "login"
      ? "Your account was just logged in with a code or a passkey, so the request to turn off two-step login was canceled, and the browsers let in without it were logged out."
      : "The request to turn off two-step login was canceled from your studio, and the browsers let in without it were logged out.",
  );
  return true;
}

/**
 * For the emailed link: whether a request to turn it off has waited its days.
 * When it has, two-step login is turned off here, and the link logs in alone.
 */
export async function resetIfDue(email: string, now = Date.now()): Promise<boolean> {
  const record = await read(email);
  if (!record || record.reset === 0 || now < record.reset) return false;
  await redisPipeline([["DEL", recordKey(email), lockedSetKey(email)]]);
  await tell(email, "Two-step login is off for your Marktmorgen account", `Two-step login was turned off ${RESET_DAYS} days after you got in without it, and nothing in your studio is locked any more. You can turn it on again in your studio, with a new app setup and new recovery codes.`);
  return true;
}

export async function twoStepOn(email: string): Promise<boolean> {
  return (await read(email)) !== null;
}

/** A six-digit code for confirming the recovery address, and its hash. */
function confirmCode(): { code: string; hash: string } {
  const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
  return { code, hash: sha(`nimbus-2fa-backup:${code}`) };
}

export type SetupStart = { secret: string; uri: string } | "already" | "backup" | "same" | "limited" | "unsent";

/**
 * A new secret for the app, kept against the session setting it up, and a
 * code sent to the recovery address to confirm it is one the creator reads.
 */
export async function startSetup(email: string, session: string, backupRaw: string): Promise<SetupStart> {
  if (await twoStepOn(email)) return "already";
  // An account that already has a confirmed recovery address uses it, with no new code.
  const existing = await recoveryAddress(email);
  if (existing) {
    const secret = newSecret();
    await redisPipeline([["SET", setupKey(session), JSON.stringify({ e: normaliseEmail(email), s: seal(secret, context(email)), b: existing, c: "" }), "EX", SETUP_SECONDS]]);
    return { secret, uri: otpauthUri(secret, normaliseEmail(email), ISSUER) };
  }
  const backup = normaliseEmail(backupRaw);
  if (!backup || backup.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(backup)) return "backup";
  if (backup === normaliseEmail(email)) return "same";
  if (!(await withinLimit("two-step-backup", normaliseEmail(email), 5, 60 * 60))) return "limited";
  const secret = newSecret();
  const confirm = confirmCode();
  const sent = isSenderConfigured()
    ? await sendEmail({ meter: { by: "company" },
        from: NIMBUS_FROM,
        to: backup,
        replyTo: "support@marktmorgen.com",
        subject: `${confirm.code} is your code to confirm a recovery address`,
        text: [
          `The Marktmorgen account ${normaliseEmail(email)} is choosing this address to recover it, if its owner ever loses their phone.`,
          "",
          `Your code: ${confirm.code}`,
          "",
          "It works for ten minutes. If you did not expect this, ignore it: nothing happens unless the code is typed in.",
        ].join("\n"),
      }).catch(() => false)
    : false;
  if (!sent) return "unsent";
  await redisPipeline([["SET", setupKey(session), JSON.stringify({ e: normaliseEmail(email), s: seal(secret, context(email)), b: backup, c: confirm.hash }), "EX", SETUP_SECONDS]]);
  return { secret, uri: otpauthUri(secret, normaliseEmail(email), ISSUER) };
}

/** Turns it on once the app shows a right code and the recovery address's code is right; returns the recovery codes, shown this once. */
export async function finishSetup(
  email: string,
  session: string,
  typed: string,
  backupCode: string,
  now = Date.now(),
): Promise<{ codes: string[] } | "expired" | "wrong" | "backup-wrong" | "already"> {
  if (await twoStepOn(email)) return "already";
  const [raw] = await redisPipeline([["GET", setupKey(session)]]);
  let pending: { e?: unknown; s?: unknown; b?: unknown; c?: unknown } = {};
  try {
    pending = typeof raw === "string" ? (JSON.parse(raw) as typeof pending) : {};
  } catch {
    pending = {};
  }
  if (pending.e !== normaliseEmail(email) || typeof pending.s !== "string" || typeof pending.b !== "string" || typeof pending.c !== "string") return "expired";
  // "" for an address the account had already confirmed (startSetup).
  if (pending.c !== "" && sha(`nimbus-2fa-backup:${backupCode.replace(/\D/g, "")}`) !== pending.c) return "backup-wrong";
  const opened = unseal(pending.s, context(email));
  if (!opened.ok) return "expired";
  const step = stepOf(opened.value, typed, now);
  if (step === null) return "wrong";
  const codes = newCodes();
  await write(email, { s: pending.s, since: now, codes: codes.map((c) => codeHash(c)), last: step, reset: 0, backup: "" });
  // The account's recovery address from now on, for losing the email too (lib/recovery-address.ts).
  await keepRecoveryAddress(email, pending.b);
  await redisPipeline([["DEL", setupKey(session)]]);
  await tell(email, "Two-step login is on for your Marktmorgen account", `Two-step login was turned on for your Marktmorgen account. From now on, logging in with the emailed link also asks for the code in your authenticator app. If you ever lose your phone and your recovery codes, a link sent to your recovery address (${hideAddress(pending.b)}) lets you back in.`);
  return { codes };
}

/**
 * From the code page, for somebody with neither a code nor a passkey: a link
 * to the recovery address that turns two-step login off and logs in. Three
 * an hour. False when the account has no recovery address.
 */
export async function sendRescue(token: string, origin: string): Promise<"sent" | "none" | "limited" | "expired" | "unsent"> {
  const held = await heldInfo(token);
  const email = held?.email ?? null;
  const record = email ? await read(email) : null;
  if (!email || !record) return "expired";
  // A login that came through the recovery address cannot be rescued by it again.
  if (held?.viaRecovery) return "none";
  const backup = await backupOf(email, record);
  if (!backup) return "none";
  if (!(await withinLimit("two-step-rescue", normaliseEmail(email), 3, 60 * 60))) return "limited";
  const rescue = randomBytes(32).toString("hex");
  await redisPipeline([["SET", rescueKey(rescue), normaliseEmail(email), "EX", 15 * 60]]);
  const sent = isSenderConfigured()
    ? await sendEmail({ meter: { by: "company" },
        from: NIMBUS_FROM,
        to: backup,
        replyTo: "support@marktmorgen.com",
        subject: "Get back into your Marktmorgen account",
        text: [
          `This is the recovery address of the Marktmorgen account ${normaliseEmail(email)}. Somebody logging in to it said the phone, the recovery codes and the passkeys are lost.`,
          "",
          "This link turns two-step login off and logs you in. It works once, for 15 minutes:",
          `${origin}/signin/rescue?token=${rescue}`,
          "",
          "If you did not ask for this, ignore it: nothing changes unless the link is used.",
        ].join("\n"),
      }).catch(() => false)
    : false;
  return sent ? "sent" : "unsent";
}

/** Spends a link sent to the recovery address: two-step login is turned off, and the account's address is told. */
export async function spendRescue(token: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token) || !isRedisConfigured()) return null;
  let email: unknown;
  try {
    [email] = await redisPipeline([["GETDEL", rescueKey(token)]]);
  } catch {
    const [readBack] = await redisPipeline([["GET", rescueKey(token)]]);
    const [removed] = await redisPipeline([["DEL", rescueKey(token)]]);
    email = Number(removed) === 1 ? readBack : null;
  }
  if (typeof email !== "string" || !email || !(await twoStepOn(email))) return null;
  await redisPipeline([["DEL", recordKey(email)]]);
  await tell(email, "Two-step login is off for your Marktmorgen account", "Two-step login was turned off with a link sent to your recovery address, and your account was logged in. Turn it on again in your studio, with your phone, to get new recovery codes.");
  return email;
}

export type CodeCheck = "app" | "recovery" | "wrong" | "unreadable" | "limited";

/**
 * Checks a code for an account that has it on: the app's code for now, used
 * once, or a recovery code, spent. Ten tries an hour per account.
 */
export async function checkCode(email: string, typed: string, now = Date.now()): Promise<CodeCheck> {
  const record = await read(email);
  if (!record) return "wrong";
  if (!(await withinLimit("two-step", normaliseEmail(email), CODES_PER_HOUR, 60 * 60))) return "limited";
  const cleaned = typed.trim();
  if (/^\d[\d\s]{4,8}$/.test(cleaned)) {
    const opened = unseal(record.s, context(email));
    if (!opened.ok) return "unreadable";
    const step = stepOf(opened.value, cleaned, now, record.last);
    if (step === null) return "wrong";
    await write(email, { ...record, last: step });
    return "app";
  }
  const hash = codeHash(cleaned);
  if (!record.codes.includes(hash)) return "wrong";
  const left = record.codes.filter((c) => c !== hash);
  await write(email, { ...record, codes: left });
  await tell(email, "A recovery code was used on your Marktmorgen account", `One of your recovery codes was used to log in to your Marktmorgen account. ${left.length} ${left.length === 1 ? "is" : "are"} left; you can make new ones under Two-step login in your studio.`);
  return "recovery";
}

/** Turns it off, with a right code. */
export async function turnOff(email: string, typed: string): Promise<CodeCheck> {
  const checked = await checkCode(email, typed);
  if (checked !== "app" && checked !== "recovery") return checked;
  await redisPipeline([["DEL", recordKey(email)]]);
  await tell(email, "Two-step login is off for your Marktmorgen account", "Two-step login was turned off for your Marktmorgen account. Logging in now needs only the emailed link or a passkey.");
  return checked;
}

/** Ten new recovery codes in place of the old ones, with a right code. */
export async function replaceCodes(email: string, typed: string): Promise<{ codes: string[] } | CodeCheck> {
  const checked = await checkCode(email, typed);
  if (checked !== "app" && checked !== "recovery") return checked;
  const record = await read(email);
  if (!record) return "wrong";
  const codes = newCodes();
  await write(email, { ...record, codes: codes.map((c) => codeHash(c)) });
  await tell(email, "New recovery codes for your Marktmorgen account", "New recovery codes were made for your Marktmorgen account. The old ones no longer work.");
  return { codes };
}

/** A login that has passed the emailed link and now waits for its code: the token for the browser's cookie. */
export async function holdSignIn(email: string, viaRecovery = false, byGoogle = false): Promise<string> {
  const token = randomBytes(32).toString("hex");
  // `g`: the first step was Google (lib/google-signin.ts), so the new-browser email says so.
  await redisPipeline([["SET", holdKey(token), JSON.stringify({ e: normaliseEmail(email), n: 0, ...(viaRecovery ? { v: 1 } : {}), ...(byGoogle ? { g: 1 } : {}) }), "EX", HOLD_SECONDS]]);
  return token;
}

export type HoldAnswer = { ok: true; email: string; how: "app" | "recovery"; byGoogle: boolean } | { ok: false; reason: "expired" | "wrong" | "unreadable" | "limited" };

/** Finishes a waiting login with its code. Five wrong codes end it. */
export async function finishSignIn(token: string, typed: string, now = Date.now()): Promise<HoldAnswer> {
  if (!/^[0-9a-f]{64}$/.test(token) || !isRedisConfigured()) return { ok: false, reason: "expired" };
  const key = holdKey(token);
  const [raw] = await redisPipeline([["GET", key]]);
  let hold: { e?: unknown; n?: unknown; v?: unknown; g?: unknown } = {};
  try {
    hold = typeof raw === "string" ? (JSON.parse(raw) as typeof hold) : {};
  } catch {
    hold = {};
  }
  if (typeof hold.e !== "string") return { ok: false, reason: "expired" };
  const tries = Number(hold.n) || 0;
  if (tries >= TRIES) {
    await redisPipeline([["DEL", key]]);
    return { ok: false, reason: "expired" };
  }
  const checked = await checkCode(hold.e, typed, now);
  if (checked === "app" || checked === "recovery") {
    // Spent: only the caller whose delete removed it opens the session.
    const [removed] = await redisPipeline([["DEL", key]]);
    if (Number(removed) !== 1) return { ok: false, reason: "expired" };
    // The owner has the second step after all: anything opened without it is called off.
    await cancelReset(hold.e, "login");
    await endRecoveryAccess(hold.e);
    return { ok: true, email: hold.e, how: checked, byGoogle: hold.g === 1 };
  }
  if (checked === "wrong") await redisPipeline([["SET", key, JSON.stringify({ e: hold.e, n: tries + 1, ...(hold.v === 1 ? { v: 1 } : {}), ...(hold.g === 1 ? { g: 1 } : {}) }), "EX", HOLD_SECONDS]]);
  return { ok: false, reason: checked };
}

/** Whose login is waiting behind a token, for the page that asks for the code. */
export async function heldInfo(token: string): Promise<{ email: string; viaRecovery: boolean } | null> {
  if (!/^[0-9a-f]{64}$/.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", holdKey(token)]]);
  try {
    const hold = typeof raw === "string" ? (JSON.parse(raw) as { e?: unknown; v?: unknown }) : {};
    return typeof hold.e === "string" ? { email: hold.e, viaRecovery: hold.v === 1 } : null;
  } catch {
    return null;
  }
}

export async function heldFor(token: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", holdKey(token)]]);
  try {
    const hold = typeof raw === "string" ? (JSON.parse(raw) as { e?: unknown }) : {};
    return typeof hold.e === "string" ? hold.e : null;
  } catch {
    return null;
  }
}

/** Carries the second step to a new sign-in address (app/api/auth/move), sealed again for it. */
export async function moveTwoStep(from: string, to: string): Promise<void> {
  const record = await read(from);
  if (!record) return;
  const opened = unseal(record.s, context(from));
  // The app's secret is sealed again for the new address. One that no longer
  // opens (the root secret was rolled) still moves, so its recovery codes go
  // on letting the person in rather than the second step quietly ending.
  await write(to, opened.ok ? { ...record, s: seal(opened.value, context(to)) } : record);
  await redisPipeline([["DEL", recordKey(from)]]);
}
