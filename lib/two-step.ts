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
 * the account itself away is locked for RESET_DAYS (LOCKED_NEEDS and
 * LOCKED_ACTIONS, said in the words of lib/locked-words.ts: payments, the
 * plan, the team, exports, imports, settings, email to the list or the
 * members, anything deleted for good, the sign-in address, passkeys,
 * two-step login). They can sell, edit
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
 *   nl:2fa:locked:<hash>  a session opened without the second step: until when it is locked, and when it
 *                         opened; kept as long as the session can last
 *   nl:2fa:lockedset:<hash> the account's locked sessions, to log them out on Cancel
 *   nl:2fa:lockedset:<hash>:kept when they last could not be logged out: those opened before stay locked
 *                         (the same mark under the name "any account": which accounts have one now, by tag)
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, SESSION_COOKIE, SESSION_TTL_SECONDS, SessionsUnknownError, dropSecondStep, endSession, isMoving, normaliseEmail, openSession, sessionKeyOf } from "@/lib/auth";
import { UnknownReplyError, countOf, stringList } from "@/lib/redis-reply";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Held, deleteIfHeldOnly, setIfHeldOnly, withLock } from "@/lib/redis-lock";
import { withinLimit } from "@/lib/request-guard";
import { LOCKED_LIST } from "@/lib/locked-words";
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
/** When the account's locked sessions last could not be logged out (endLocked): those opened before stay locked until they end. */
const keptLockedKey = (email: string) => `${lockedSetKey(email)}:kept`;
/**
 * The accounts whose locked sessions are kept locked now, by accountTag, space-separated: only a session of one
 * of them with no lock of its own asks more. Kept as the mark of a name no address can be ("any account" has a
 * space), in the same family. Each account once, at most KEPT_ANY_MAX of them (KEPT_ANY_MAX × 41 bytes, read by
 * every lockedUntil); past that it is "*" (KEEP_ANY), the safe side: every session with no lock of its own then
 * asks whether it is in its account's kept set (keptListed, three commands more), so none that was is set free,
 * until the list lapses SESSION_TTL_SECONDS and a day after the last failed read.
 */
const KEPT_ANY_KEY = keptLockedKey("any account");
export const KEPT_ANY_MAX = 100;
/** In one command: the account's tag added once (never twice), "*" past KEPT_ANY_MAX, and the expiry set. */
export const KEEP_ANY = `-- marktmorgen:kept-any:v1
local v = redis.call('GET', KEYS[1]) or ''
if v ~= '*' and not string.find(' ' .. v .. ' ', ' ' .. ARGV[1] .. ' ', 1, true) then
  local n = 0
  for _ in string.gmatch(v, '%S+') do n = n + 1 end
  if n >= tonumber(ARGV[2]) then v = '*' elseif v == '' then v = ARGV[1] else v = v .. ' ' .. ARGV[1] end
end
redis.call('SET', KEYS[1], v, 'EX', ARGV[3])
return v == '*' and 0 or 1`;
/** How many times in a month the list was found past its ceiling (endLocked): a count, no account. */
const keptStarKey = (month: string) => `nl:2fa:keptstar:${month}`;

/** For the owner's report: how many times in `month` the list was past its ceiling; null when it cannot be read. */
export async function keptStarMonth(month: string): Promise<number | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", keptStarKey(month)]]);
  if (raw === null) return 0;
  return typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
}

/**
 * The owner's words for it, beside lib/store-forget-retry.ts storeForgetLine (Portuguese, numbers only; to be
 * wired into the monthly owner report with it: lib/company-margin-report.ts, 465 [MR2], Codex E). Empty when none.
 */
export function keptStarLine(month: string, times: number | null): string {
  if (times === null) return "Sessões travadas mantidas: não foi possível ler a contagem deste mês; o estado é desconhecido.";
  if (!times) return "";
  return `Sessões travadas mantidas em ${month}: em ${times} leituras ilegíveis, a lista de contas passou do teto de ${KEPT_ANY_MAX}. Enquanto isso durar, cada verificação de sessão sem trava própria custa 3 comandos Redis a mais, até ${SESSION_TTL_SECONDS / 86_400 + 1} dias depois da última dessas leituras.`;
}

/** A one-way tag of an account: its locked set's own hash, never the address. */
const accountTag = (email: string) => lockedSetKey(email).slice("nl:2fa:lockedset:".length);
const rescueKey = (token: string) => `nl:2fa:rescue:${sha(`nimbus-2fa-rescue:${token}`).slice(0, 40)}`;
/**
 * A code used once: the app's step, or a recovery code, taken with SET NX so
 * two logins that send the same code at the same moment never both pass.
 * Minutes for a step (it is past its window by then), a day for a recovery
 * code (it is gone from the record by then).
 */
const onceKey = (email: string, what: string) => `nl:2fa:once:${sha(`nimbus-2fa-once:${normaliseEmail(email)}:${what}`).slice(0, 40)}`;

async function spendOnce(email: string, what: string, seconds: number): Promise<boolean> {
  const [taken] = await redisPipeline([["SET", onceKey(email, what), "1", "NX", "EX", seconds]]);
  return taken !== null;
}

/**
 * Every read-change-write of an account's two-step record holds its lock, and
 * every write under it is fenced (lib/redis-lock.ts): checking a code,
 * turning it off, new recovery codes, a request to turn it off without a
 * code and calling that off, turning it on, the recovery address's link and
 * a move. Two of them at the same moment never write back what the other
 * changed (an app code and recovery code A checked together never bring A
 * back), and nothing recreates a record turned off meanwhile. Emails go
 * after the lock is let go.
 */
const lockKey = (email: string) => `nl:2fa:lock:${sha(`nimbus-2fa-lock:${normaliseEmail(email)}`).slice(0, 40)}`;

function withTwoStep<T>(email: string, work: (held: Held) => Promise<T>): Promise<T> {
  return withLock(lockKey(email), 5, 4_000, work);
}

async function writeHeld(held: Held, email: string, record: TwoStep, options: { absent?: boolean } = {}): Promise<boolean> {
  return setIfHeldOnly(held, recordKey(email), JSON.stringify(record), options);
}

async function deleteHeld(held: Held, keys: string[]): Promise<boolean> {
  return deleteIfHeldOnly(held, keys);
}

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


/** Ten recovery codes, "abcd-efgh", each from 31 letters and digits nobody misreads. */
function newCodes(): string[] {
  return Array.from({ length: RECOVERY_CODES }, () => {
    // randomInt draws each letter evenly; a byte taken modulo 31 would favour the first eight.
    const text = Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");
    return `${text.slice(0, 4)}-${text.slice(4)}`;
  });
}

/**
 * A short plain notice to the account's address when its second step changes
 * or is used. `backup`: the confirmed recovery address, told the same (in
 * `backupLine`'s words when they differ), for what happens on the path that
 * assumes somebody else may hold the sign-in inbox (MM-SA-19). Never twice to
 * one inbox.
 */
async function tell(email: string, subject: string, line: string, backup = "", backupLine = line): Promise<void> {
  if (!isSenderConfigured()) return;
  const address = normaliseEmail(email);
  await notice(address, subject, line);
  if (backup && normaliseEmail(backup) !== address) {
    await notice(normaliseEmail(backup), subject, `This is the recovery address for the Marktmorgen account ${address}, so you get this notice too.\n\n${backupLine}`);
  }
}

async function notice(to: string, subject: string, line: string): Promise<void> {
  const when = new Date().toISOString().replace("T", " ").slice(0, 16);
  await sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to,
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

/** The same for an address, read whether or not two-step login is on: what lib/passkeys.ts tells as well. */
export async function recoveryAddressOf(email: string): Promise<string> {
  const record = await read(email);
  return record ? backupOf(email, record) : recoveryAddress(email);
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
 * data out, changes who can get in, or cannot be undone. "erase" (deleting a
 * person and everything the store keeps about them, lib/person-erasure.ts)
 * cannot be undone, so it waits too (4 November 2026, C2-76).
 */
export const LOCKED_NEEDS: readonly string[] = ["billing", "payments", "team", "delete", "export", "settings", "send", "import", "erase"];

/**
 * Single actions under a permission the locked session otherwise keeps, that
 * cannot be undone, keyed by permission. Each is matched under every route
 * of that permission, so a name used by one route only ("lesson-remove") is
 * unique to it and never read from the request's path. Adding and editing
 * stay open; what deletes something for good, or emails many people at once,
 * waits (4 November 2026, C2-76, after a review found the same harm through
 * other doors):
 *
 *   - products: "remove" (a product with its files, picture, course and page:
 *     app/api/store/product; a price option and its file: option; a podcast
 *     episode and its audio: podcast; a page funnel: page-funnels; a lesson
 *     video's captions: stream/captions; the product picture: image),
 *     "clear" (every license key: keys; a bundle's list: bundle), "detach"
 *     (the product's file and the buyers' stamped copies: file/attach),
 *     "replace" (a new file, picture, video or audio that deletes the old one,
 *     or a page saved without pictures it showed), and in a course
 *     (app/api/store/course) a lesson, a module or a lesson file taken out
 *     ("lesson-remove", "module-remove", "media-remove"), an assignment taken
 *     off with the work handed in ("task-remove"), a quiz taken off
 *     ("quiz-remove"), a student's certificate withdrawn ("withdraw") and a
 *     lesson comment deleted ("cm-delete"); and "launch" (app/api/store/
 *     waitlist: the product goes on sale with one email, in the creator's
 *     own words, to everyone on its waitlist);
 *   - page: "remove" (a form with its answers, a site page, a saved block, a
 *     link, a short link, the store photo), "delete" (a blog post), "clear"
 *     (the questions the answers and the assistant missed) and "replace";
 *   - events: "cancel" and "delete" (an event, emailing everyone coming) and
 *     "move" (an edit that changes the time, emailing everyone coming);
 *   - community: "report-delete" (a reported post or comment), and, for the
 *     creator inside their own community (app/api/store/community, chat and
 *     the lesson comments, where the owner is known by the address and not
 *     by studioAccess), "email" (an announcement emailed to every member),
 *     "delete", "delete-comment", "unsay" and "clear" (the chat room);
 *   - orders: "remove" (a task on a person), "unnote" (a note on a person),
 *     "undeal" (a deal), "fields-remove" (the store's own fields saved without
 *     one it had, which takes that field's answers off every person: crm),
 *     "unpipeline" (a whole pipeline taken away: its stages go and every deal
 *     in it loses the stage it was in), "resend" (a buyer's purchase email sent again, which carries the
 *     product's thank-you note: a note rewritten in that session would go to
 *     every buyer listed);
 *     stats: "remove" (a note or a spend on the numbers);
 *     draft: "drop" (an outreach pitch), "segment-remove", "draft-remove";
 *     reviews: "photo" (a buyer's photo taken off a review).
 *
 * A route whose action is not its body's `action` names it to
 * guardStoreWrite (lib/store-request.ts); one that learns only from what is
 * kept that a write would delete (a replacement) asks lockedFor first.
 * tests/locked-deletes.test.ts holds every route that deletes to one of them.
 */
export const LOCKED_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  products: ["remove", "clear", "detach", "replace", "launch", "lesson-remove", "module-remove", "media-remove", "task-remove", "quiz-remove", "withdraw", "cm-delete"],
  page: ["remove", "delete", "clear", "replace"],
  events: ["cancel", "delete", "move"],
  community: ["report-delete", "email", "delete", "delete-comment", "unsay", "clear"],
  orders: ["remove", "unnote", "undeal", "unpipeline", "fields-remove", "resend"],
  stats: ["remove"],
  draft: ["drop", "segment-remove", "draft-remove"],
  reviews: ["photo"],
};

/** Whether a locked session may not do `need` (with `action`, when the route names one). */
export function lockedOut(need: string, action = ""): boolean {
  if (LOCKED_NEEDS.includes(need)) return true;
  if (!action || !Object.hasOwn(LOCKED_ACTIONS, need)) return false;
  return LOCKED_ACTIONS[need].includes(action);
}

/**
 * The same question for a route that does not go through studioAccess, or
 * learns only from what is kept that a write deletes something: whether the
 * session in these cookies is locked and may not do it. Asks Redis only when
 * the action is one that waits.
 */
export async function lockedFor(
  request: { cookies: { get(name: string): { value: string } | undefined } },
  need: string,
  action: string,
): Promise<boolean> {
  return lockedOut(need, action) && (await lockedUntil(request.cookies.get(SESSION_COOKIE)?.value)) > 0;
}

/**
 * Until when a session is locked, in ms, or 0 for a session that is not.
 *
 * Past its day, a session let in without the second step is still locked,
 * until it ends, when the account's locked sessions could not be logged out
 * after it was opened (keptLockedKey, review of #2556): Cancel or a full
 * login said it must go, so the day never sets it free.
 */
export async function lockedUntil(session: string | undefined, now = Date.now()): Promise<number> {
  if (!session || !/^[0-9a-f]{64}$/.test(session) || !isRedisConfigured()) return 0;
  // One command (MGET): the session's lock, the accounts whose locked sessions are kept locked now, and the
  // session's owner. Every session of every other account stops here (review of #2556 at df8030300: one command).
  const [reply] = await redisPipeline([["MGET", lockedKey(session), KEPT_ANY_KEY, await sessionKeyOf(session)]]);
  const [raw, anyKept, ownerRaw] = Array.isArray(reply) && reply.length === 3 ? reply : [undefined, undefined, undefined];
  const owner = typeof ownerRaw === "string" && ownerRaw ? ownerRaw : null;
  if (typeof raw !== "string") {
    // No lock of its own: a lock written before 5 November 2026 lapsed on its day (review of #2556 at
    // 47161b86e). A session of an account whose locked sessions are kept locked (listed in KEPT_ANY_KEY,
    // or that list in another shape) asks whether it is still in its account's kept set (keptListed).
    if (!owner || anyKept === null) return 0;
    // "*": more accounts than KEPT_ANY_MAX, so every such session asks (the safe side).
    if (typeof anyKept === "string" && anyKept !== "*" && !anyKept.split(" ").includes(accountTag(owner))) return 0;
    return keptListed(session, owner, now);
  }
  // "<until>|<opened>"; a value written before 5 November 2026 is "<until>" alone, opened at an unknown time.
  const [untilText, openedText] = raw.split("|");
  const until = Number(untilText);
  if (!Number.isFinite(until)) return 0;
  if (until > now) return until;
  if (!owner) return 0;
  const [kept, left] = await redisPipeline([["GET", keptLockedKey(owner)], ["PTTL", lockedKey(session)]]);
  if (kept === null) return 0;
  const since = Number(kept);
  const opened = openedText === undefined ? 0 : Number(openedText);
  // A mark in another shape counts as kept (CX-123 rule 24): locked, never set free.
  if (typeof kept === "string" && Number.isFinite(since) && Number.isFinite(opened) && opened > since) return 0;
  const ms = countOf(left);
  return now + (ms !== null && ms > 0 ? ms : SESSION_TTL_SECONDS * 1000);
}

/**
 * A session whose own lock is gone, of an account whose locked sessions are
 * kept locked (endLocked could not read them): locked, until the account's
 * set ends, when the session is still in it. The set is not read whole: only
 * whether this session is a member; an answer of another shape counts as one.
 * Three commands, only for the sessions of such an account, for as long as its
 * mark lasts (at most SESSION_TTL_SECONDS and a day after the failed read).
 */
async function keptListed(session: string, owner: string, now: number): Promise<number> {
  const [kept, member, left] = await redisPipeline([["EXISTS", keptLockedKey(owner)], ["SISMEMBER", lockedSetKey(owner), session], ["PTTL", lockedSetKey(owner)]]);
  if (countOf(kept) === 0 || countOf(member) === 0) return 0;
  const ms = countOf(left);
  return now + (ms !== null && ms > 0 ? ms : SESSION_TTL_SECONDS * 1000);
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
  // Who is told, read before anything changes: an unknown recovery address (rule 24) throws here, with the waiting
  // login not spent and no reset day started. Read after, it threw once the clock ran, and nobody was told (review of #2883).
  const backup = await backupOf(email, record);
  const through = (to: "sign-in" | "recovery") =>
    held?.viaRecovery ? "a login link sent to your recovery address" : to === "sign-in" ? "a login link sent to this address" : "a login link sent to the sign-in address";
  // Spent, as a right code spends it: one waiting login, one session.
  const [removed] = await redisPipeline([["DEL", holdKey(token)]]);
  if (Number(removed) !== 1) return null;
  const marked = await withTwoStep(email, async (held) => {
    const current = await read(email);
    if (!current) return null;
    const first = current.reset === 0;
    const until = first ? now + RESET_DAYS * 86_400_000 : current.reset;
    if (first && !(await writeHeld(held, email, { ...current, reset: until }))) return null;
    return { first, until };
  });
  if (!marked) return null;
  const { first, until } = marked;
  const session = await openLockedSession(email, until, now);
  // The same day for a later login through the recovery address, which then opens everything once it has passed.
  await alignRecoveryLock(email, until, now);
  const opened = (to: "sign-in" | "recovery") => `Somebody who opened ${through(to)} said they no longer have your authenticator app, your recovery codes, a passkey or your recovery address, and was let in. Until ${day(until)}, ${LOCKED_LIST} are locked for them; after that, two-step login turns off.

If that was you, keep working: everything else is open.

If it was not you, somebody can read your email: log in with your app's code or a passkey, or open your studio in a browser that is still logged in and press Cancel. That logs them out and keeps two-step login on. Then change your email password.`;
  // Told to the recovery address too: this path assumes somebody else may hold the sign-in inbox (MM-SA-19).
  await tell(
    email,
    first ? "Your Marktmorgen account was opened without two-step login" : "Your Marktmorgen account was opened again without two-step login",
    opened("sign-in"),
    backup,
    opened("recovery"),
  );
  return { session, email, until };
}

/** Opens a session locked (LOCKED_NEEDS) until `until`, logged out by Cancel or a full login. */
export async function openLockedSession(email: string, until: number, now = Date.now()): Promise<string> {
  const session = await openSession(email);
  const seconds = Math.max(60, Math.ceil((until - now) / 1000));
  await redisPipeline([
    // Kept as long as the session can last, with when it opened: past its day it says whether the session
    // was opened before its account's locked sessions could not be logged out (lockedUntil).
    ["SET", lockedKey(session), `${until}|${now}`, "EX", Math.max(seconds, SESSION_TTL_SECONDS)],
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
  if (await endLocked(email)) {
    await tell(email, "What your recovery address opened was closed", "Your account was just logged in with your sign-in email, a code or a passkey, so the browsers that got in through your recovery address were logged out.");
    return;
  }
  await tell(email, "Log out of all devices to close what your recovery address opened", `Your account was just logged in with your sign-in email, a code or a passkey, but the browsers that got in through your recovery address could not be logged out just now. ${STILL_LOCKED}`);
}

/**
 * Said when the locked sessions could not be read (audit SG2, finding 5):
 * they stay locked, as their own marks are kept, and the owner can end them.
 */
export const STILL_LOCKED = `Until they are logged out, ${LOCKED_LIST} stay locked for them. Log them out now: choose “Log out of all devices” at the bottom of your studio.`;

/**
 * Logs out every session opened without the second step. False, with
 * nothing logged out or deleted, when they could not be read in their exact
 * shape (audit SG2, finding 5): the set is the only way to them, so it is
 * kept, and the account is marked with the moment, so that every locked
 * session opened before it stays locked until it ends, past its day too
 * (lockedUntil; review of #2556: the day alone would set them free).
 */
async function endLocked(email: string, now = Date.now()): Promise<boolean> {
  const [members] = await redisPipeline([["SMEMBERS", lockedSetKey(email)]]);
  const sessions = stringList(members);
  if (!sessions) {
    console.error("logging out the sessions let in without a second step failed", new UnknownReplyError("the locked sessions"));
    // Not read, only kept: the set outlives every session in it, so a lock that lapses on its day (one written
    // before 5 November 2026) still finds its session listed (lockedUntil, keptListed).
    const [, listed] = await redisPipeline([
      ["SET", keptLockedKey(email), String(now), "EX", SESSION_TTL_SECONDS + 86_400],
      // Listed by a one-way tag of the account, never its address: once, at most KEPT_ANY_MAX (KEEP_ANY).
      ["EVAL", KEEP_ANY, 1, KEPT_ANY_KEY, accountTag(email), KEPT_ANY_MAX, SESSION_TTL_SECONDS + 86_400],
      ["EXPIRE", lockedSetKey(email), SESSION_TTL_SECONDS + 86_400],
    ]);
    // The list past its ceiling ("*", or an answer of another shape): every session with no lock of its own now
    // pays LOCKED_UNTIL_STAR_EXTRA (tests/plan-cost-registry.ts) on each lockedUntil. Said, and counted for the
    // owner's report (keptStarMonth, keptStarLine; review of #2556 at 4d8ac350e), never only kept.
    if (listed !== 1) {
      console.error(`more than ${KEPT_ANY_MAX} accounts' locked sessions could not be logged out: every session with no lock of its own is checked, three commands more a load, until ${SESSION_TTL_SECONDS / 86_400 + 1} days after the last`);
      const month = new Date(now).toISOString().slice(0, 7);
      await redisPipeline([["INCR", keptStarKey(month)], ["EXPIRE", keptStarKey(month), 400 * 86_400]]);
    }
    return false;
  }
  for (const session of sessions) await endSession(session);
  await redisPipeline([["DEL", lockedSetKey(email), ...sessions.map((session) => lockedKey(session))]]);
  // A passkey removal one of them asked for stays: only "Keep it" calls one off (lib/passkeys.ts).
  return true;
}

/**
 * Calls off a pending request: the owner logged in with a code or a passkey,
 * or pressed Cancel. The locked sessions are logged out: true. "kept-locked"
 * when they could not be read, so they were not logged out and stay locked
 * until they end (endLocked); whoever says so to the owner never says they
 * were logged out (review of #2556).
 */
export async function cancelReset(email: string, why: "login" | "studio"): Promise<boolean | "kept-locked"> {
  const called = await withTwoStep(email, async (held) => {
    const record = await read(email);
    if (!record || record.reset === 0) return false;
    return writeHeld(held, email, { ...record, reset: 0 });
  });
  if (!called) return false;
  const ended = await endLocked(email);
  await endRecoveryLock(email);
  const canceled =
    why === "login"
      ? "Your account was just logged in with a code or a passkey, so the request to turn off two-step login was canceled"
      : "The request to turn off two-step login was canceled from your studio";
  await tell(
    email,
    "Two-step login stays on for your Marktmorgen account",
    ended ? `${canceled}, and the browsers let in without it were logged out.` : `${canceled}, but the browsers let in without it could not be logged out just now. ${STILL_LOCKED}`,
  );
  return ended ? true : "kept-locked";
}

/**
 * For the emailed link: whether a request to turn it off has waited its days.
 * When it has, two-step login is turned off here, and the link logs in alone.
 */
export async function resetIfDue(email: string, now = Date.now()): Promise<boolean> {
  // Never during a move, or while one is left broken (lib/auth.ts isMoving): the app is one of the ways in
  // being carried, and the owner's way back in while the move cannot be read.
  if (await isMoving(email)) return false;
  const backup = await withTwoStep(email, async (held) => {
    const record = await read(email);
    if (!record || record.reset === 0 || now < record.reset) return null;
    // Read before the record goes: an account from before kept its recovery address on it.
    const kept = await backupOf(email, record);
    return (await deleteHeld(held, [recordKey(email), lockedSetKey(email)])) ? kept : null;
  });
  if (backup === null) return false;
  // What the app opened goes with it (lib/auth.ts dropSecondStep). Sessions that could not be read keep marks that
  // hold nothing while no app is on, and that turning one on again takes first (finishSetup); the account is told all the same.
  await dropAppSessions(email);
  await tell(email, "Two-step login is off for your Marktmorgen account", `Two-step login was turned off ${RESET_DAYS} days after you got in without it, and nothing in your studio is locked any more. You can turn it on again in your studio, with a new app setup and new recovery codes.`, backup);
  return true;
}

/**
 * Logs out what the app opened, once it is off. Sessions that could not be
 * read (lib/auth.ts SessionsUnknownError) are logged as an error and not said
 * as logged out; the notices that follow say only that the app is off. Their
 * marks hold nothing while no app is on (lib/second-step-gate.ts), and
 * turning an app on again takes them first (finishSetup), or refuses.
 */
async function dropAppSessions(email: string): Promise<void> {
  try {
    await dropSecondStep(email, (mark) => mark === "app" || mark === "recovery");
  } catch (error) {
    if (!(error instanceof SessionsUnknownError)) throw error;
    console.error("logging out what the app opened failed", error);
  }
}

export async function twoStepOn(email: string): Promise<boolean> {
  return (await read(email)) !== null;
}

/** A six-digit code for confirming the recovery address, and its hash. */
function confirmCode(): { code: string; hash: string } {
  const code = String(randomInt(1_000_000)).padStart(6, "0");
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
  /** Asked again under the record's lock, just before it is written (review of 8b4ddf6ee); it must take no lock. */
  mayAdd: () => Promise<boolean> = async () => true,
): Promise<{ codes: string[] } | "expired" | "wrong" | "backup-wrong" | "already" | "second_step" | "sessions"> {
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
  // Only where none is there yet, under the lock: turning it on twice at once makes one record, never two sets of codes.
  const made = await withTwoStep(email, async (held) => {
    if (!(await mayAdd())) return "second_step" as const;
    // What an app turned on before opened goes before a new one is on (review of #2556): a mark "app" or
    // "recovery" left on a session whose logout could not be read (resetIfDue, spendRescue) would otherwise hold
    // again for the new app. This session only loses its mark. Unread: the app is not turned on.
    try {
      await dropSecondStep(email, (mark) => mark === "app" || mark === "recovery", session);
    } catch (error) {
      if (!(error instanceof SessionsUnknownError)) throw error;
      console.error("logging out what an earlier app opened failed", error);
      return "sessions" as const;
    }
    return (await writeHeld(held, email, { s: pending.s as string, since: now, codes: codes.map((c) => codeHash(c)), last: step, reset: 0, backup: "" }, { absent: true })) ? ("made" as const) : ("already" as const);
  });
  if (made !== "made") return made;
  // The account's recovery address from now on, for losing the email too (lib/recovery-address.ts).
  // Two-step login is on either way, and its codes are answered once: a keep Redis did not confirm is said as not
  // kept, never as a way back in (review of #2883).
  const keptBackup = await keepRecoveryAddress(email, pending.b);
  await redisPipeline([["DEL", setupKey(session)]]);
  const way = keptBackup
    ? `If you ever lose your phone and your recovery codes, a link sent to your recovery address (${hideAddress(pending.b)}) lets you back in.`
    : `Your recovery address (${hideAddress(pending.b)}) could not be saved just now: add it again under Account in your studio, so a link sent there can let you back in if you ever lose your phone and your recovery codes.`;
  await tell(email, "Two-step login is on for your Marktmorgen account", `Two-step login was turned on for your Marktmorgen account. From now on, logging in with the emailed link also asks for the code in your authenticator app. ${way}`);
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
  if (typeof email !== "string" || !email) return null;
  const address = email;
  // Never for an address in a move, or left by one that broke (lib/auth.ts isMoving): its two-step login stays.
  const off = await withTwoStep(address, async (held) => !(await isMoving(address)) && (await twoStepOn(address)) && deleteHeld(held, [recordKey(address)]));
  if (!off) return null;
  // What the app opened goes with it (lib/auth.ts dropSecondStep), as in resetIfDue.
  await dropAppSessions(email);
  await tell(email, "Two-step login is off for your Marktmorgen account", "Two-step login was turned off with a link sent to your recovery address, and your account was logged in. Turn it on again in your studio, with your phone, to get new recovery codes.");
  return email;
}

export type CodeCheck = "app" | "recovery" | "wrong" | "unreadable" | "limited";

/**
 * Checks a code for an account that has it on: the app's code for now, used
 * once, or a recovery code, spent. Ten tries an hour per account. With the
 * record's lock already held (withTwoStep): what it writes is fenced, read
 * under the same lock.
 */
async function checkHeld(held: Held, email: string, typed: string, now: number): Promise<{ check: CodeCheck; left?: number }> {
  const record = await read(email);
  if (!record) return { check: "wrong" };
  if (!(await withinLimit("two-step", normaliseEmail(email), CODES_PER_HOUR, 60 * 60))) return { check: "limited" };
  const cleaned = typed.trim();
  if (/^\d[\d\s]{4,8}$/.test(cleaned)) {
    const opened = unseal(record.s, context(email));
    if (!opened.ok) return { check: "unreadable" };
    const step = stepOf(opened.value, cleaned, now, record.last);
    if (step === null) return { check: "wrong" };
    if (!(await spendOnce(email, `step:${step}`, 5 * 60))) return { check: "wrong" };
    if (!(await writeHeld(held, email, { ...record, last: step }))) return { check: "wrong" };
    return { check: "app" };
  }
  const hash = codeHash(cleaned);
  if (!record.codes.includes(hash)) return { check: "wrong" };
  if (!(await spendOnce(email, `code:${hash}`, 86_400))) return { check: "wrong" };
  const left = record.codes.filter((c) => c !== hash);
  if (!(await writeHeld(held, email, { ...record, codes: left }))) return { check: "wrong" };
  return { check: "recovery", left: left.length };
}

async function toldCodeUsed(email: string, left: number): Promise<void> {
  await tell(email, "A recovery code was used on your Marktmorgen account", `One of your recovery codes was used to log in to your Marktmorgen account. ${left} ${left === 1 ? "is" : "are"} left; you can make new ones under Two-step login in your studio.`);
}

/** Checks a code (checkHeld), under the record's lock. */
export async function checkCode(email: string, typed: string, now = Date.now()): Promise<CodeCheck> {
  const out = await withTwoStep(email, (held) => checkHeld(held, email, typed, now));
  if (out.check === "recovery") await toldCodeUsed(email, out.left ?? 0);
  return out.check;
}

/** Turns it off, with a right code, in one hold of the lock. */
export async function turnOff(email: string, typed: string): Promise<CodeCheck> {
  const out = await withTwoStep(email, async (held) => {
    const checked = await checkHeld(held, email, typed, Date.now());
    if (checked.check !== "app" && checked.check !== "recovery") return checked;
    return (await deleteHeld(held, [recordKey(email)])) ? checked : { check: "wrong" as CodeCheck };
  });
  if (out.check !== "app" && out.check !== "recovery") return out.check;
  if (out.check === "recovery") await toldCodeUsed(email, out.left ?? 0);
  await tell(email, "Two-step login is off for your Marktmorgen account", "Two-step login was turned off for your Marktmorgen account. Logging in now needs only the emailed link or a passkey.");
  return out.check;
}

/** Ten new recovery codes in place of the old ones, with a right code, in one hold of the lock. */
export async function replaceCodes(email: string, typed: string): Promise<{ codes: string[] } | CodeCheck> {
  const out = await withTwoStep(email, async (held) => {
    const checked = await checkHeld(held, email, typed, Date.now());
    if (checked.check !== "app" && checked.check !== "recovery") return { checked, codes: null };
    const record = await read(email);
    if (!record) return { checked: { check: "wrong" as CodeCheck }, codes: null };
    const codes = newCodes();
    if (!(await writeHeld(held, email, { ...record, codes: codes.map((c) => codeHash(c)) }))) return { checked: { check: "wrong" as CodeCheck }, codes: null };
    return { checked, codes };
  });
  if (!out.codes) return out.checked.check;
  await tell(email, "New recovery codes for your Marktmorgen account", "New recovery codes were made for your Marktmorgen account. The old ones no longer work.");
  return { codes: out.codes };
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
/**
 * Forgets an address's two-step record: only for a move that has to be
 * undone, where whatever the address gained in the meantime must not stay
 * (app/api/auth/move). True when there was one.
 */
export async function discardTwoStep(email: string): Promise<boolean> {
  return withTwoStep(email, async (held) => (await read(email)) !== null && deleteHeld(held, [recordKey(email)]));
}

export async function moveTwoStep(from: string, to: string): Promise<void> {
  await withTwoStep(from, (heldFrom) =>
    withTwoStep(to, async (heldTo) => {
      const record = await read(from);
      if (!record) return;
      // Never onto an address with a two-step record of its own: two accounts' codes are never merged (app/api/auth/move refuses it first).
      if (await read(to)) throw new Error("the new address has two-step login of its own");
      // As finishSetup does (review of #2556): a mark "app" or "recovery" an earlier app of `to` left on one of its
      // sessions would hold again once this app is there, so those sessions go first. Unread
      // (SessionsUnknownError), nothing moves: the move is refused, or the repair waits (lib/move-repair.ts).
      await dropSecondStep(to, (mark) => mark === "app" || mark === "recovery");
      const opened = unseal(record.s, context(from));
      // The app's secret is sealed again for the new address. One that no longer
      // opens (the root secret was rolled) still moves, so its recovery codes go
      // on letting the person in rather than the second step quietly ending.
      if (!(await writeHeld(heldTo, to, opened.ok ? { ...record, s: seal(opened.value, context(to)) } : record, { absent: true }))) throw new Error("moving two-step login lost its lock");
      if (!(await deleteHeld(heldFrom, [recordKey(from)]))) {
        // Never on both addresses: the copy goes again, and the move is refused.
        await deleteHeld(heldTo, [recordKey(to)]);
        throw new Error("moving two-step login lost its lock");
      }
    }),
  );
}
