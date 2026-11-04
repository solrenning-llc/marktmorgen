/**
 * Passkeys: logging in with the phone or laptop the creator already unlocks.
 *
 * Optional, and never instead of the emailed link: an account with a passkey
 * still logs in by email whenever it wants to, so losing a phone never locks
 * anyone out. A passkey is added from the studio while logged in, and used on
 * /signin with one tap, without typing an address — the browser offers the
 * passkeys it holds for this site (WebAuthn, through @simplewebauthn).
 *
 * What we keep is the public half of each key and a counter; the private
 * half never leaves the creator's device, so there is nothing here that
 * would let anyone log in if it leaked. The key is bound to marktmorgen.com,
 * where the studio lives; a store on a creator's own domain never logs a
 * creator in. Every sign-in with a passkey needs the device's own check — a
 * fingerprint, a face, a PIN — not only its presence.
 *
 *   nl:pk:<hash>             the account's passkeys, as JSON (ten at most)
 *   nl:pk:cred:<hash>        which account a passkey belongs to, by its id
 *   nl:pk:reg:<hash>         the challenge for a passkey being added, 5 minutes,
 *                            tied to the session adding it
 *   nl:pk:auth:<hash>        the challenge for a sign-in, 5 minutes, tied to a
 *                            cookie of that browser; spent by the answer
 *   nl:pk:drop:<hash>        passkeys a session without a second step asked to
 *                            remove, and the day they go (REMOVAL_DAYS later);
 *                            no expiry until applied; only "Keep it" from a
 *                            session with a valid second step calls it off
 *   nl:pk:lock:<hash>        the account's lock while its passkeys change, seconds
 *
 * A session opened with a passkey is the same session an emailed link opens
 * (lib/auth.ts), so "Log out of all devices" closes it like any other.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { dropSecondStep, normaliseEmail, sessionMark } from "@/lib/auth";
import { NIMBUS_FROM, headerText, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { SITE_URL } from "@/lib/site-url";
import { type Held, LockBusyError, deleteIfHeldOnly, setIfHeldOnly, withLock } from "@/lib/redis-lock";
import { removalWhen } from "@/lib/removal-time";
import { recoveryAddressOf, twoStepOn } from "@/lib/two-step";

/** Passkeys one account may hold. */
export const MAX_PASSKEYS = 10;
export const MAX_PASSKEY_NAME = 60;
const CHALLENGE_SECONDS = 5 * 60;
export const PASSKEY_COOKIE = "nl_pk";

/**
 * Where passkeys are bound: marktmorgen.com. A local test run may point this
 * at http://localhost:<port>, and at nothing else, because a passkey for one
 * site can never be used on another and localhost is where a test browser is.
 * The production deployment ignores it, so a variable left behind by mistake
 * can never move sign-ins off marktmorgen.com.
 */
const LOCAL =
  process.env.VERCEL_ENV !== "production" && /^http:\/\/localhost:\d{2,5}$/.test(process.env.PASSKEY_LOCAL_ORIGIN ?? "")
    ? (process.env.PASSKEY_LOCAL_ORIGIN as string)
    : null;
export const RP_ID = LOCAL ? "localhost" : new URL(SITE_URL).hostname;
const ORIGIN = LOCAL ?? SITE_URL;
const RP_NAME = "Marktmorgen";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const listKey = (email: string) => `nl:pk:${sha(`nimbus-passkeys:${normaliseEmail(email)}`).slice(0, 40)}`;
const credKey = (id: string) => `nl:pk:cred:${sha(`nimbus-passkey-id:${id}`).slice(0, 40)}`;
const regKey = (session: string) => `nl:pk:reg:${sha(`nimbus-passkey-reg:${session}`).slice(0, 40)}`;
const authKey = (nonce: string) => `nl:pk:auth:${sha(`nimbus-passkey-auth:${nonce}`).slice(0, 40)}`;
const lockKey = (email: string) => `nl:pk:lock:${sha(`nimbus-passkey-lock:${normaliseEmail(email)}`).slice(0, 40)}`;

/**
 * Every read-change-write of an account's passkeys, and of the passkeys
 * waiting to be removed, holds the account's lock (lib/redis-lock.ts): a
 * sign-in writing its counter, a removal whose wait ran out, a request to
 * remove and a login calling it off would otherwise each write back what they
 * read, bringing back a passkey just removed or undoing a cancellation.
 * Emails go after the lock is let go.
 */
function withPasskeys<T>(email: string, work: (held: Held) => Promise<T>): Promise<T> {
  return withLock(lockKey(email), 5, 4_000, work);
}

/**
 * Writes under the lock are fenced (lib/redis-lock.ts setIfHeld): a request
 * held up past its lock's five seconds writes nothing, so it never puts back
 * a list or a removal record read before somebody else changed it. A lost
 * lock is answered as busy, to try again.
 */
async function fencedSet(held: Held, key: string, value: string): Promise<void> {
  if (!(await setIfHeldOnly(held, key, value))) throw new LockBusyError();
}

async function fencedDel(held: Held, keys: string[]): Promise<void> {
  if (!keys.length) return;
  if (!(await deleteIfHeldOnly(held, keys))) throw new LockBusyError();
}

/** Reads a key and deletes it in one step, so a challenge answers once. */
async function spend(key: string): Promise<string | null> {
  let raw: unknown;
  try {
    [raw] = await redisPipeline([["GETDEL", key]]);
  } catch {
    // Where GETDEL is missing, only the caller whose DEL removed the key wins.
    const [read] = await redisPipeline([["GET", key]]);
    const [removed] = await redisPipeline([["DEL", key]]);
    raw = Number(removed) === 1 ? read : null;
  }
  return typeof raw === "string" && raw ? raw : null;
}

export type Passkey = {
  /** The credential's id, base64url, as the browser gives it. */
  id: string;
  /** The public key, base64url. */
  publicKey: string;
  counter: number;
  transports: string[];
  /** What the creator called it, to tell two apart. */
  name: string;
  createdAt: string;
  lastUsedAt: string;
  /** Whether the passkey is kept in a synced keychain (iCloud, Google). */
  synced: boolean;
};

function parseList(raw: unknown): Passkey[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((p): p is Passkey => Boolean(p) && typeof p.id === "string" && typeof p.publicKey === "string")
      .map((p) => ({
        id: p.id,
        publicKey: p.publicKey,
        counter: typeof p.counter === "number" ? p.counter : 0,
        transports: Array.isArray(p.transports) ? p.transports.filter((t) => typeof t === "string").slice(0, 8) : [],
        name: typeof p.name === "string" ? p.name.slice(0, MAX_PASSKEY_NAME) : "Passkey",
        createdAt: typeof p.createdAt === "string" ? p.createdAt : "",
        lastUsedAt: typeof p.lastUsedAt === "string" ? p.lastUsedAt : "",
        synced: p.synced === true,
      }))
      .slice(0, MAX_PASSKEYS);
  } catch {
    return [];
  }
}

/** The passkeys an account holds, oldest first. */
export async function listPasskeys(email: string): Promise<Passkey[]> {
  if (!isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["GET", listKey(email)]]);
  return parseList(raw);
}

async function saveList(held: Held, email: string, list: Passkey[]): Promise<void> {
  if (list.length) await fencedSet(held, listKey(email), JSON.stringify(list));
  else await fencedDel(held, [listKey(email)]);
}

/**
 * A short plain notice to the account's address when its passkeys change, or
 * to `own.to`, its recovery address (MM-SA-19); `own.ifYou` and
 * `own.ifNotYou` replace the closing lines where a notice has its own.
 */
async function tell(email: string, subject: string, line: string, own: { to?: string; ifYou?: string; ifNotYou?: string[] } = {}): Promise<boolean> {
  const to = own.to ?? email;
  if (!isSenderConfigured()) return false;
  const when = new Date().toISOString().replace("T", " ").slice(0, 16);
  return sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: normaliseEmail(to),
    replyTo: "support@marktmorgen.com",
    subject,
    text: [
      line,
      "",
      `When: ${when} UTC`,
      "",
      own.ifYou ?? "If this was you, there is nothing to do.",
      "",
      ...(own.ifNotYou ?? [
        "If it was not you: log in at",
        `${SITE_URL}/signin`,
        `${to === email ? "with this email address" : `as ${normaliseEmail(email)}`}, remove any passkey you do not recognize, choose “Log out of all devices” at the bottom of your studio, and reply to this email so we can help.`,
      ]),
    ].join("\n"),
  }).catch(() => false);
}

/**
 * What the browser needs to make a new passkey for this account. The
 * challenge is kept against the session asking, so only that session can
 * finish what it started.
 */
export async function registrationOptions(email: string, session: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const address = normaliseEmail(email);
  const existing = await listPasskeys(address);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: address,
    userDisplayName: address,
    // The same handle every time for one address, and nothing that reads
    // back as the address itself.
    userID: new Uint8Array(createHash("sha256").update(`nimbus-passkey-user:${address}`).digest()),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await redisPipeline([["SET", regKey(session), options.challenge, "EX", CHALLENGE_SECONDS]]);
  return options;
}

export type AddResult = { ok: true; passkey: Passkey } | { ok: false; reason: "expired" | "invalid" | "full" | "taken" | "second_step" };

/** Checks the browser's answer and keeps the new passkey. */
export async function addPasskey(
  email: string,
  session: string,
  response: RegistrationResponseJSON,
  rawName: string,
  /** Asked again under the account's lock, so nothing between the route's check and the write lets a passkey in (review of 8b4ddf6ee); it must take no lock. */
  mayAdd: () => Promise<boolean> = async () => true,
): Promise<AddResult> {
  const address = normaliseEmail(email);
  const challenge = await spend(regKey(session));
  if (!challenge) return { ok: false, reason: "expired" };

  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!verified.verified) return { ok: false, reason: "invalid" };

  const { credential, credentialBackedUp } = verified.registrationInfo;
  const kept = await withPasskeys(address, async (held): Promise<AddResult> => {
    if (!(await mayAdd())) return { ok: false, reason: "second_step" };
    const list = await listPasskeys(address);
    if (list.length >= MAX_PASSKEYS) return { ok: false, reason: "full" };
    const [claimed] = await redisPipeline([["SET", credKey(credential.id), address, "NX"]]);
    if (claimed === null) return { ok: false, reason: "taken" };
    const now = new Date().toISOString();
    const made: Passkey = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: (credential.transports ?? []).slice(0, 8),
      name: rawName.replace(/\s+/g, " ").trim().slice(0, MAX_PASSKEY_NAME) || "Passkey",
      createdAt: now,
      lastUsedAt: "",
      synced: credentialBackedUp,
    };
    await saveList(held, address, [...list, made]);
    return { ok: true, passkey: made };
  });
  if (!kept.ok) return kept;
  const passkey = kept.passkey;
  await tell(address, "A passkey was added to your Marktmorgen account", `A passkey called “${headerText(passkey.name, 60)}” was added to your Marktmorgen account (${address}). It can now log in to your studio.`);
  return { ok: true, passkey };
}

/**
 * How long a passkey asked to be removed by a session opened without a second
 * step (an emailed link, Google, a recovery address, or the passkey that is
 * itself set to be removed) waits before it goes: the same days a request to
 * turn two-step login off without a code waits (lib/two-step.ts RESET_DAYS,
 * held equal by tests/second-step-gate.test.ts; not imported, as
 * lib/two-step.ts reads this file), with an email to the account at once. It
 * is the way back for somebody who lost their passkey, and it keeps somebody
 * who only reads the inbox from taking the passkeys away and adding their own.
 *
 * Nothing but "Keep it", pressed from a session with a valid second step,
 * calls a removal off (security review of 3467adf6d): no login does, by a
 * passkey, the app's code, the emailed link or the recovery address, so the
 * owner logging in on their own laptop never brings a stolen passkey back.
 */
export const REMOVAL_DAYS = 7;

const dropKey = (email: string) => `nl:pk:drop:${sha(`nimbus-passkey-drop:${normaliseEmail(email)}`).slice(0, 40)}`;

/**
 * Passkeys waiting to be removed, each with its own moment in ms
 * (security review of 693f44f0b): every passkey waits REMOVAL_DAYS from its
 * own request, never the moment of one asked before it.
 */
export type PendingRemoval = { ids: string[]; atOf: Record<string, number> };

/**
 * The record behind it, and when the account was last emailed about it (the same request asked again within the hour
 * is not emailed again; a new passkey always is). `told` is only ever a notice that was DELIVERED (C3-113): while the
 * first notice of a request is going out, the record says so in `telling`, with that request's own token, and any
 * other request to remove a passkey of the account answers busy (try again) until it is delivered or taken back.
 */
type Telling = { token: string; since: number };
/**
 * `untold`: the passkeys set to go whose notice no delivery has confirmed yet. None of them is ever removed (C3-115):
 * a request that ended between writing the record and settling it (its process stopped) leaves them here, and once
 * its `telling` mark is old they are taken off the record under the lock, the passkeys kept, never removed untold.
 */
type DropRecord = PendingRemoval & { told: number; telling?: Telling; untold: string[] };

function dropOf(atOf: Record<string, number>, told: number, extra: { telling?: Telling; untold?: string[] } = {}): DropRecord {
  const ids = Object.keys(atOf);
  const untold = (extra.untold ?? []).filter((id, i, all) => ids.includes(id) && all.indexOf(id) === i);
  return extra.telling ? { ids, atOf, told, telling: extra.telling, untold } : { ids, atOf, told, untold };
}

/**
 * How long a notice being sent holds the account's other removal requests: longer than both emails can take (each
 * provider call is bounded by its own timeout). Past it, the request that was sending is taken as gone (its process
 * ended), and the next request sends the notice itself, never answering success on a notice nobody confirmed.
 */
const TELLING_MS = 5 * 60 * 1000;

/** Thrown when another request's notice for this account is still going out: nothing was set; try again. */
export class RemovalBusyError extends Error {
  constructor() {
    super("another notice is going out");
    this.name = "RemovalBusyError";
  }
}

/** How long a request asked again waits before it is emailed again. */
const RETELL_MS = 60 * 60 * 1000;

async function readDrop(email: string): Promise<DropRecord | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", dropKey(email)]]);
  try {
    const value = typeof raw === "string" ? (JSON.parse(raw) as { atOf?: unknown; ids?: unknown; at?: unknown; told?: unknown; telling?: unknown; untold?: unknown }) : null;
    if (!value) return null;
    const atOf: Record<string, number> = {};
    if (value.atOf && typeof value.atOf === "object" && !Array.isArray(value.atOf)) {
      for (const [id, at] of Object.entries(value.atOf as Record<string, unknown>)) if (typeof at === "number" && Number.isFinite(at)) atOf[id] = at;
    } else if (Array.isArray(value.ids) && typeof value.at === "number") {
      // A record written before each passkey had its own moment: each takes the one moment it had.
      for (const id of value.ids) if (typeof id === "string") atOf[id] = value.at;
    }
    const ids = Object.keys(atOf).slice(0, MAX_PASSKEYS);
    const t = value.telling as { token?: unknown; since?: unknown } | undefined;
    const telling = t && typeof t === "object" && typeof t.token === "string" && /^[0-9a-f]{32}$/.test(t.token) && typeof t.since === "number" && Number.isFinite(t.since) ? { token: t.token, since: t.since } : undefined;
    const untold = Array.isArray(value.untold) ? value.untold.filter((id): id is string => typeof id === "string") : [];
    return ids.length ? dropOf(Object.fromEntries(ids.map((id) => [id, atOf[id]])), typeof value.told === "number" ? value.told : 0, { telling, untold }) : null;
  } catch {
    return null;
  }
}

/**
 * Kept with no expiry until it is applied: a removal must happen however long
 * nobody opens the studio. It is applied at the next login of any kind, at
 * every check of a session's second step and on every passkey change
 * (pendingRemoval, removeDue), and it goes with the account when it moves.
 */
async function writeDrop(held: Held, email: string, record: DropRecord): Promise<void> {
  if (!record.ids.length) await fencedDel(held, [dropKey(email)]);
  else await fencedSet(held, dropKey(email), JSON.stringify({ atOf: record.atOf, told: record.told, ...(record.telling ? { telling: record.telling } : {}), ...(record.untold.length ? { untold: record.untold } : {}) }));
}

/** The record without `gone`, the passkeys it no longer waits on (a notice going out stays marked). */
function without(record: DropRecord, gone: (id: string) => boolean): DropRecord {
  return dropOf(Object.fromEntries(Object.entries(record.atOf).filter(([id]) => !gone(id))), record.told, { telling: record.telling, untold: record.untold });
}

/**
 * The same notice to the confirmed recovery address too, which whoever holds
 * the sign-in inbox cannot read (MM-SA-19), read as two-step login reads it.
 */
async function tellRecovery(address: string, subject: string, line: string, own: { ifYou?: string; ifNotYou?: string[] } = {}): Promise<boolean> {
  const backup = await recoveryAddressOf(address).catch(() => "");
  if (!backup || normaliseEmail(backup) === address) return false;
  return tell(address, subject, `This is the recovery address for the Marktmorgen account ${address}, so you get this notice too.\n\n${line}`, { ...own, to: backup });
}

/**
 * Whether the session asking still has a valid second step, read under the
 * account's lock (security review C3-110): a session that is gone (logged
 * out by a removal asked meanwhile, or by the app turned off) has none, and
 * fails closed; the app's marks hold only while the app is on; a passkey's
 * only while it is listed and not set to go.
 */
async function validUnderLock(address: string, session: string | undefined, list: Passkey[], record: DropRecord | null): Promise<boolean> {
  const mark = await sessionMark(session, address);
  if (!mark) return false;
  if (mark === "app" || mark === "recovery") return twoStepOn(address);
  if (!mark.startsWith("passkey:")) return false;
  const id = mark.slice("passkey:".length);
  return id !== "" && list.some((p) => p.id === id) && !record?.ids.includes(id);
}

/** Thrown when the email that tells the account about a passkey set to go could not be sent: nothing was set. */
export class RemovalUnsentError extends Error {
  constructor() {
    super("the notice could not be sent");
    this.name = "RemovalUnsentError";
  }
}

/** Thrown when moving passkeys failed in a way that could not be put back cleanly: the move is left for the repair. */
export class MoveSplitError extends Error {
  constructor() {
    super("moving passkeys could not be put back");
    this.name = "MoveSplitError";
  }
}

/**
 * Asked by a session opened without a valid second step: the passkey is
 * removed REMOVAL_DAYS after its own first request (asking again does not
 * move its moment; another passkey asked later waits its own full days). The
 * account is told at once whenever a passkey is added to the list, and again
 * for the same list only an hour or more later; the email lists every passkey
 * set to go with its own moment. The sessions the passkey opened are logged
 * out at once, under the lock (`session`, the one asking, only loses its
 * mark), so nothing it opened before stays open through the wait. `appOn`:
 * whether the account has an authenticator app, for the email's words.
 * Answers the passkey's moment, or null when the account has no such passkey.
 */
export async function scheduleRemoval(email: string, id: string, session: string, appOn = false, now = Date.now()): Promise<number | null> {
  const address = normaliseEmail(email);
  let gone: Due = NONE;
  const asked = await withPasskeys(address, async (held) => {
    gone = (await removeDue(held, address, now)) ?? NONE;
    const list = await listPasskeys(address);
    const row = list.find((p) => p.id === id);
    if (!row) return null;
    const before = await readDrop(address);
    // Another request's notice still going out: nothing is set or answered as set until it is delivered (C3-113).
    if (before?.telling && now - before.telling.since < TELLING_MS) return "busy" as const;
    const atOf = { ...(before?.atOf ?? {}) };
    const isNew = atOf[id] === undefined;
    if (isNew) atOf[id] = now + REMOVAL_DAYS * 86_400_000;
    // A notice marked as going out long ago was never confirmed: this request sends it.
    const tellNow = isNew || !before || now - before.told >= RETELL_MS || !!before.telling;
    const token = randomBytes(16).toString("hex");
    // A new passkey is untold until a delivery is confirmed; one already waiting keeps what it was.
    const untold = [...(before?.untold ?? []), ...(isNew ? [id] : [])];
    await writeDrop(held, address, dropOf(atOf, before?.told ?? 0, { telling: tellNow ? { token, since: now } : undefined, untold }));
    // Logged out under the same lock, the first time it is asked: nothing P opened stays open past this request
    // (asked again, the owner's own sessions are not logged out again).
    if (isNew) await dropSecondStep(address, (mark) => mark === `passkey:${id}`, session);
    // Whether a second step is left that can still keep it: another passkey not set to go, or the app.
    const another = list.some((p) => atOf[p.id] === undefined);
    const waiting = list.filter((p) => atOf[p.id] !== undefined).map((p) => ({ name: p.name, at: atOf[p.id] }));
    return { at: atOf[id], name: row.name, tellNow, another, waiting, isNew, token };
  });
  await afterDue(address, gone);
  if (asked === "busy") throw new RemovalBusyError();
  if (!asked) return null;
  if (asked.tellNow) {
    // Owner C3-96 and the reviews of 3467adf6d and 693f44f0b: when each goes, and what to do if it was not them, in plain words.
    const when = removalWhen(asked.at);
    const canStop = asked.another || appOn;
    const subject = "A passkey is set to be removed from your Marktmorgen account";
    const all = asked.waiting.length > 1 ? `\n\nEvery passkey set to be removed now, each on its own day:\n${asked.waiting.map((p) => `- “${headerText(p.name, 60)}”: ${removalWhen(p.at)}`).join("\n")}` : "";
    const line = `Somebody logged in to your Marktmorgen account (${address}) and asked to remove the passkey called “${headerText(asked.name, 60)}”. Every browser that logged in with it was logged out.\n\nIt will be removed on ${when}.${all}`;
    const own = {
      ifYou: "If this was you, there is nothing to do: each is removed on its day.",
      ifNotYou: canStop
        ? [
            `If it was not you, stop it before ${when}:`,
            `1. Log in at ${SITE_URL}/signin with ${asked.another ? "a passkey that is not on that list" : ""}${asked.another && appOn ? ", or " : ""}${appOn ? "the emailed link and the code from your authenticator app" : ""}.`,
            "2. Open Account in your studio and press “Keep it” next to each passkey you want to keep. Only “Keep it” stops a removal: logging in alone does not, and logging in with a passkey that is being removed cannot.",
            "Then choose “Log out of all devices” at the bottom of your studio, and reply to this email so we can help.",
          ]
        : [
            "If it was not you: every passkey on your account is set to be removed and you have no authenticator app, so nothing can stop it. Nobody can use these passkeys to add new ones in the meantime.",
            `On ${when}, log in at ${SITE_URL}/signin with the emailed link, and add a new passkey or turn on an authenticator app under Account in your studio. On that day, anyone who can open this email inbox can do the same and add a passkey of their own, so keep the inbox safe and add yours first.`,
            "Now, choose “Log out of all devices” at the bottom of your studio, change your email password, and reply to this email so we can help.",
          ],
    };
    const toAccount = await tell(address, subject, line, own);
    // Told to the confirmed recovery address too, as whoever asked may hold the sign-in inbox (MM-SA-19).
    const toRecovery = await tellRecovery(address, subject, line, own);
    // Only the request whose notice this is changes the record after it, compared under the lock by its own token:
    // another request that took over a notice left too long never has its record undone or marked by this one.
    const settle = (next: (record: DropRecord) => DropRecord) =>
      withPasskeys(address, async (held) => {
        const record = await readDrop(address);
        if (record?.telling?.token === asked.token) await writeDrop(held, address, next(record));
      });
    if (!toAccount && !toRecovery) {
      // No email went out: a removal nobody was told about is never kept (security review C3-110). A new one is
      // taken back, an older one keeps its moment and is told again next time; the request answers as busy.
      const undo = (record: DropRecord) => {
        const kept = asked.isNew ? without(record, (x) => x === id) : record;
        return dropOf(kept.atOf, kept.told, { untold: kept.untold });
      };
      // Tried twice (the lock may be held a moment by another change); were both to fail, the mark ages out and the
      // next request for the account tells again, every passkey set to go listed in it.
      await settle(undo).catch(() => settle(undo)).catch(() => {});
      throw new RemovalUnsentError();
    }
    // Delivered: now it is told, and the account's other requests go on. Not marked (the lock or the write failed),
    // the mark ages out and the next request tells again: more email, never a removal answered as set untold.
    // The email listed every passkey set to go: none is untold any more.
    await settle((record) => dropOf(record.atOf, now)).catch(() => {});
  }
  return asked.at;
}

/**
 * Removes, with the account's lock already held, the passkeys whose wait has
 * run out; answers them (empty when none were due), or null when nothing
 * waits or the moment has not come.
 */
type Due = { gone: Passkey[]; ids: string[] };
const NONE: Due = { gone: [], ids: [] };

async function removeDue(held: Held, address: string, now: number): Promise<Due | null> {
  let record = await readDrop(address);
  if (!record) return null;
  // Never applied while a notice is unconfirmed (C3-115): a request still sending it leaves the record as it is.
  if (record.telling && now - record.telling.since < TELLING_MS) return null;
  // One that stopped before settling (its mark old): its untold passkeys are taken off the record and kept, never
  // removed; the rest were told and keep their moments. A later request asks again and tells.
  if (record.telling || record.untold.length) {
    const cleaned = without(record, (id) => record!.untold.includes(id));
    record = dropOf(cleaned.atOf, cleaned.told);
    await writeDrop(held, address, record);
    if (!record.ids.length) return null;
  }
  const kept = record;
  const due = (id: string) => (kept.atOf[id] ?? Infinity) <= now;
  if (!kept.ids.some(due)) return null;
  const list = await listPasskeys(address);
  const removed = list.filter((p) => due(p.id));
  await saveList(held, address, list.filter((p) => !due(p.id)));
  await fencedDel(held, removed.map((p) => credKey(p.id)));
  await writeDrop(held, address, without(record, due));
  // The sessions are logged out by the record's ids, not the list's: a passkey already off the list
  // (a lock lost between the two writes) still has its sessions closed (review of 8b4ddf6ee).
  return { gone: removed, ids: record.ids.filter(due) };
}

/** What follows a removal that waited its days, once the lock is let go: its sessions logged out, the account told. */
async function afterDue(address: string, due: Due): Promise<void> {
  if (due.ids.length) {
    const marks = due.ids.map((id) => `passkey:${id}`);
    await dropSecondStep(address, (mark) => marks.includes(mark));
  }
  const gone = due.gone;
  if (!gone.length) return;
  await tell(address, "Passkeys were removed from your Marktmorgen account", `${gone.map((p) => `“${headerText(p.name, 60)}”`).join(", ")} ${gone.length === 1 ? "was" : "were"} removed from your Marktmorgen account (${address}) after the wait. ${gone.length === 1 ? "It cannot" : "They cannot"} log in anymore. You can add a new passkey in your studio.`);
}

/**
 * The passkeys waiting to be removed, after removing those whose moment has
 * come; null when none wait. Called at every login, before anything asks
 * whether the account has a second step or which one to offer, so a removal
 * that has waited its days counts at once. The sessions those passkeys
 * opened are logged out with them.
 */
export async function pendingRemoval(email: string, now = Date.now()): Promise<PendingRemoval | null> {
  const address = normaliseEmail(email);
  const pending = await readDrop(address);
  if (!pending) return null;
  if (pending.ids.every((id) => now < pending.atOf[id])) return { ids: pending.ids, atOf: pending.atOf };
  const gone = await withPasskeys(address, (held) => removeDue(held, address, now));
  if (gone === null) {
    const left = await readDrop(address);
    return left ? { ids: left.ids, atOf: left.atOf } : null;
  }
  await afterDue(address, gone);
  const left = await readDrop(address);
  return left ? { ids: left.ids, atOf: left.atOf } : null;
}

/**
 * "Keep it" next to one passkey: the only thing that calls a removal off.
 * The caller has checked the session's second step; it is checked again here,
 * under the lock: a session opened with a passkey that is set to be removed
 * keeps nothing, and a removal whose days are over is applied, not kept.
 */
export async function cancelRemoval(email: string, id: string, session: string | undefined, now = Date.now()): Promise<"kept" | "unknown" | "second_step"> {
  const address = normaliseEmail(email);
  let gone: Due = NONE;
  const answer = await withPasskeys(address, async (held): Promise<"kept" | "unknown" | "second_step"> => {
    gone = (await removeDue(held, address, now)) ?? NONE;
    const record = await readDrop(address);
    if (session !== undefined && !(await validUnderLock(address, session, await listPasskeys(address), record))) return "second_step";
    if (!record || !record.ids.includes(id)) return "unknown";
    await writeDrop(held, address, without(record, (x) => x === id));
    return "kept";
  });
  await afterDue(address, gone);
  if (answer === "kept") {
    const line = `“Keep it” was pressed in the studio of your account (${address}), so a passkey that was set to be removed stays.`;
    await tell(address, "Your passkey stays on your Marktmorgen account", line);
    // The recovery address too (MM-SA-19): keeping a passkey is a change whoever holds the sign-in inbox should not hide.
    await tellRecovery(address, "Your passkey stays on your Marktmorgen account", line);
  }
  return answer;
}

/**
 * Removes one of the account's passkeys at once (a session with a valid
 * second step). Checked again under the lock: a session opened with a
 * passkey that is set to be removed, or gone, removes nothing at once. The
 * sessions the removed passkey opened are logged out; `keep`, the session
 * removing it, only loses its mark.
 */
export async function removePasskey(email: string, id: string, keep?: string, now = Date.now()): Promise<"removed" | "unknown" | "second_step"> {
  const address = normaliseEmail(email);
  let due: Due = NONE;
  const answer = await withPasskeys(address, async (held): Promise<Passkey | "unknown" | "second_step"> => {
    due = (await removeDue(held, address, now)) ?? NONE;
    const list = await listPasskeys(address);
    const record = await readDrop(address);
    // Asked by a request (a session given, even an empty one): checked under the lock, failing closed. Left out only
    // by the application's own calls, which act for the account itself.
    if (keep !== undefined && !(await validUnderLock(address, keep, list, record))) return "second_step";
    const row = list.find((p) => p.id === id);
    if (!row) return "unknown";
    await saveList(held, address, list.filter((p) => p.id !== id));
    await fencedDel(held, [credKey(id)]);
    if (record?.ids.includes(id)) await writeDrop(held, address, without(record, (x) => x === id));
    return row;
  });
  await afterDue(address, due);
  if (typeof answer === "string") return answer;
  await dropSecondStep(address, (mark) => mark === `passkey:${id}`, keep);
  const line = `The passkey called “${headerText(answer.name, 60)}” was removed from your Marktmorgen account (${address}). It cannot log in anymore.`;
  await tell(address, "A passkey was removed from your Marktmorgen account", line);
  // A passkey is one of the ways the owner calls off a login without two-step login (lib/two-step.ts),
  // so its removal is told to the confirmed recovery address too (MM-SA-19).
  await tellRecovery(address, "A passkey was removed from your Marktmorgen account", line);
  return "removed";
}

/**
 * What the browser needs to offer its passkeys for this site. The challenge
 * is kept against a random value the browser holds in a cookie, so the answer
 * has to come back from the very browser that asked.
 */
export async function signInOptions(): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; nonce: string }> {
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required" });
  const nonce = randomBytes(32).toString("hex");
  await redisPipeline([["SET", authKey(nonce), options.challenge, "EX", CHALLENGE_SECONDS]]);
  return { options, nonce };
}

/**
 * Checks a sign-in answer and says whose account it opens, or null. The
 * challenge is spent first, so an answer can only ever be used once.
 */
export async function signInWith(nonce: string, response: AuthenticationResponseJSON): Promise<{ email: string; id: string; doomed: boolean } | null> {
  if (!/^[0-9a-f]{64}$/.test(nonce) || typeof response?.id !== "string") return null;
  const challenge = await spend(authKey(nonce));
  if (!challenge) return null;

  const [owner] = await redisPipeline([["GET", credKey(response.id)]]);
  if (typeof owner !== "string" || !owner) return null;

  // All under the account's lock, removals whose wait ran out first: a
  // passkey due to go never logs in, and one removed meanwhile (in the
  // studio, or by its wait) is never written back.
  let gone: Due = NONE;
  let doomed = false;
  const signed = await withPasskeys(owner, async (held) => {
    gone = (await removeDue(held, owner, Date.now())) ?? NONE;
    // Read under the same lock: whether this passkey is set to be removed (it then calls nothing off at login).
    doomed = (await readDrop(owner))?.ids.includes(response.id) === true;
    const list = await listPasskeys(owner);
    const passkey = list.find((p) => p.id === response.id);
    if (!passkey) return false;
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
          counter: passkey.counter,
          transports: passkey.transports,
        },
      });
    } catch {
      return false;
    }
    if (!verified.verified) return false;
    const newCounter = verified.authenticationInfo.newCounter;
    await saveList(held, owner, list.map((p) => (p.id === passkey.id ? { ...p, counter: newCounter, lastUsedAt: new Date().toISOString() } : p)));
    return true;
  });
  await afterDue(owner, gone);
  return signed ? { email: owner, id: response.id, doomed } : null;
}

/**
 * Runs `work` only while this passkey is not set to be removed, with the
 * account's lock held throughout, so a removal asked meanwhile waits for it
 * (a passkey set to go calls nothing off at login: app/api/auth/passkey/
 * signin). True when it ran.
 */
export async function unlessSetToGo(email: string, id: string, work: () => Promise<void>): Promise<boolean> {
  const address = normaliseEmail(email);
  return withPasskeys(address, async () => {
    if ((await readDrop(address))?.ids.includes(id)) return false;
    await work();
    return true;
  });
}

/**
 * Points every passkey on the address's list back at the address, under its lock: the list is what an account
 * holds, and an index left on another address (a move whose answer was lost midway, C3-117) would refuse every
 * sign-in with it. Run by the repair of a broken move (lib/move-repair.ts). Answers how many were pointed back.
 */
export async function repointPasskeys(email: string): Promise<number> {
  const address = normaliseEmail(email);
  return withPasskeys(address, async (held) => {
    const list = await listPasskeys(address);
    if (!list.length) return 0;
    const owners = await redisPipeline(list.map((p) => ["GET", credKey(p.id)]));
    let fixed = 0;
    for (const [i, p] of list.entries()) {
      if (owners[i] === address) continue;
      await fencedSet(held, credKey(p.id), address);
      fixed += 1;
    }
    return fixed;
  });
}

/** What waits to be removed, read without the lock and without applying anything: for checks made under another lock. */
export async function pendingNow(email: string): Promise<PendingRemoval | null> {
  const record = await readDrop(normaliseEmail(email));
  return record ? { ids: record.ids, atOf: record.atOf } : null;
}

/**
 * Forgets every passkey of an address, and what waited to be removed: only
 * for a move that has to be undone, where whatever the address gained in the
 * meantime must not stay (app/api/auth/move). True when there was any.
 */
export async function discardPasskeys(email: string): Promise<boolean> {
  const address = normaliseEmail(email);
  return withPasskeys(address, async (held) => {
    const list = await listPasskeys(address);
    const record = await readDrop(address);
    if (!list.length && !record) return false;
    await fencedDel(held, [listKey(address), dropKey(address), ...list.map((p) => credKey(p.id))]);
    return true;
  });
}

/**
 * Whether an address holds passkeys of its own, or a removal record: an
 * account is never moved onto one (app/api/auth/move, security review of
 * da5191515), so two addresses' ways in are never merged.
 */
export async function holdsPasskeys(email: string): Promise<boolean> {
  return (await listPasskeys(email)).length > 0 || (await readDrop(normaliseEmail(email))) !== null;
}

/**
 * Carries an account's passkeys to its new address, when it moves, with
 * what waits to be removed, each passkey keeping its own moment. Refused,
 * with nothing changed, when the new address holds passkeys or a removal
 * record of its own (the move route refuses that case first): the two are
 * never merged. What is due is applied first.
 */
export async function movePasskeys(from: string, to: string, now = Date.now()): Promise<void> {
  const source = normaliseEmail(from);
  const address = normaliseEmail(to);
  let due: Due = NONE;
  await withPasskeys(source, (heldFrom) =>
    withPasskeys(address, async (heldTo) => {
      if (await holdsPasskeys(address)) throw new Error("the new address holds passkeys of its own");
      due = (await removeDue(heldFrom, source, now)) ?? NONE;
      const list = await listPasskeys(source);
      const pending = await readDrop(source);
      // Tried: every write that may have been applied, put back by the undo even when its answer was lost (C3-117).
      // Confirmed: every write that answered as applied, the only ones that may say the move went through (C3-120).
      const tried: string[] = [];
      const confirmed: string[] = [];
      let listWritten = false;
      let dropWritten = !pending;
      try {
        if (list.length) {
          await fencedSet(heldTo, listKey(address), JSON.stringify(list));
          listWritten = true;
          for (const p of list) {
            tried.push(p.id);
            await fencedSet(heldTo, credKey(p.id), address);
            confirmed.push(p.id);
          }
        }
        if (pending) {
          await writeDrop(heldTo, address, pending);
          dropWritten = true;
        }
        await fencedDel(heldFrom, [listKey(source), dropKey(source)]);
      } catch (error) {
        // The old address's list already gone and every write to the new one confirmed: the answer of the last step
        // (the old address's delete) was lost, not the step, and the new address keeps it all (security review
        // C3-110). An old list gone while a write to the new address is unconfirmed proves nothing (a lock that ran
        // out, and another change took it): never "moved" then (Codex D, C3-120).
        if (list.length && listWritten && dropWritten && confirmed.length === list.length && (await listPasskeys(source)).length === 0) return;
        // A lock lost midway: what may have been written goes back, fenced, so the passkeys are never on both
        // addresses or neither; each step is tried even when another failed, and when any cannot be done, the
        // move is left for the repair (MoveSplitError).
        let undone = true;
        // The new address's lock is the one that may have run out: taken again for the undo when it did.
        await fencedDel(heldTo, [listKey(address), dropKey(address)])
          .catch(() => withPasskeys(address, (again) => fencedDel(again, [listKey(address), dropKey(address)])))
          .catch((undo) => {
            console.error("taking passkeys off the new address failed", undo);
            undone = false;
          });
        for (const id of tried) {
          await fencedSet(heldFrom, credKey(id), source).catch((undo) => {
            console.error("putting a passkey's index back failed", undo);
            undone = false;
          });
        }
        if (!undone) throw new MoveSplitError();
        throw error;
      }
    }),
  );
  await afterDue(source, due);
}
