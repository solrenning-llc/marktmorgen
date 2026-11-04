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
 *                            remove, and the day they go (REMOVAL_DAYS later):
 *                            a login with a passkey not itself set to be removed or with the app's
 *                            code calls it off, or Keep it from such a login
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
import { dropSecondStep, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, headerText, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { SITE_URL } from "@/lib/site-url";
import { withLock } from "@/lib/redis-lock";
import { removalWhen } from "@/lib/removal-time";

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
function withPasskeys<T>(email: string, work: () => Promise<T>): Promise<T> {
  return withLock(lockKey(email), 5, 4_000, work);
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

async function saveList(email: string, list: Passkey[]): Promise<void> {
  await redisPipeline([list.length ? ["SET", listKey(email), JSON.stringify(list)] : ["DEL", listKey(email)]]);
}

/** A short plain notice to the account's address when its passkeys change. */
async function tell(email: string, subject: string, line: string, own?: { ifYou: string; ifNotYou: string[] }): Promise<void> {
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
      own?.ifYou ?? "If this was you, there is nothing to do.",
      "",
      ...(own?.ifNotYou ?? [
        "If it was not you: log in at",
        `${SITE_URL}/signin`,
        "with this email address, remove any passkey you do not recognize, choose “Log out of all devices” at the bottom of your studio, and reply to this email so we can help.",
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

export type AddResult = { ok: true; passkey: Passkey } | { ok: false; reason: "expired" | "invalid" | "full" | "taken" };

/** Checks the browser's answer and keeps the new passkey. */
export async function addPasskey(
  email: string,
  session: string,
  response: RegistrationResponseJSON,
  rawName: string,
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
  const kept = await withPasskeys(address, async (): Promise<AddResult> => {
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
    await saveList(address, [...list, made]);
    return { ok: true, passkey: made };
  });
  if (!kept.ok) return kept;
  const passkey = kept.passkey;
  await tell(address, "A passkey was added to your Marktmorgen account", `A passkey called “${headerText(passkey.name, 60)}” was added to your Marktmorgen account (${address}). It can now log in to your studio.`);
  return { ok: true, passkey };
}

/**
 * How long a passkey asked to be removed by a session opened without a second
 * step (an emailed link, Google, a recovery address) waits before it goes: the
 * same days a request to turn two-step login off without a code waits
 * (lib/two-step.ts RESET_DAYS, held equal by tests/second-step-gate.test.ts;
 * not imported, as lib/two-step.ts reads this file), with an email to the account at once. It is
 * the way back for somebody who lost their passkey, and it keeps somebody who
 * only reads the inbox from taking the passkeys away and adding their own.
 */
export const REMOVAL_DAYS = 7;

const dropKey = (email: string) => `nl:pk:drop:${sha(`nimbus-passkey-drop:${normaliseEmail(email)}`).slice(0, 40)}`;

/** Passkeys waiting to be removed, and when, in ms. */
export type PendingRemoval = { ids: string[]; at: number };

/**
 * The record behind it: for each passkey, a one-way mark of the session that
 * asked (so closing that session, as a full login closes what the recovery
 * address opened, calls its request off: cancelRemovalsBy), and when the
 * account was last emailed about it (a request asked again within the hour
 * is not emailed again).
 */
type DropRecord = PendingRemoval & { by: Record<string, string>; told: number };

/** How long a request asked again waits before it is emailed again. */
const RETELL_MS = 60 * 60 * 1000;

const askerOf = (session: string) => sha(`nimbus-passkey-asker:${session}`).slice(0, 40);

async function readDrop(email: string): Promise<DropRecord | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", dropKey(email)]]);
  try {
    const value = typeof raw === "string" ? (JSON.parse(raw) as { ids?: unknown; at?: unknown; by?: unknown; told?: unknown }) : null;
    if (!value || !Array.isArray(value.ids) || typeof value.at !== "number") return null;
    const ids = value.ids.filter((id): id is string => typeof id === "string").slice(0, MAX_PASSKEYS);
    const rawBy = value.by && typeof value.by === "object" ? (value.by as Record<string, unknown>) : {};
    const by = Object.fromEntries(ids.filter((id) => typeof rawBy[id] === "string").map((id) => [id, rawBy[id] as string]));
    return ids.length ? { ids, at: value.at, by, told: typeof value.told === "number" ? value.told : 0 } : null;
  } catch {
    return null;
  }
}

async function writeDrop(email: string, record: DropRecord, now: number): Promise<void> {
  const seconds = Math.max(60, Math.ceil((record.at - now) / 1000) + 30 * 86_400);
  await redisPipeline([["SET", dropKey(email), JSON.stringify(record), "EX", seconds]]);
}

/**
 * Asked by a session opened without a second step (an emailed link, Google,
 * a recovery address, an invite, a session from before the mark, or one let
 * in without the second step: lib/two-step.ts enterLocked, so its wait and
 * this one run side by side): the passkey is removed REMOVAL_DAYS after the
 * first such request (asking again does not move the moment), and the
 * account is told now, and again only an hour or more later. Answers the
 * moment, or null when the account has no such passkey.
 */
export async function scheduleRemoval(email: string, id: string, session: string, now = Date.now()): Promise<number | null> {
  const address = normaliseEmail(email);
  const asked = await withPasskeys(address, async () => {
    const row = (await listPasskeys(address)).find((p) => p.id === id);
    if (!row) return null;
    const before = await readDrop(address);
    const at = before?.at ?? now + REMOVAL_DAYS * 86_400_000;
    const tellNow = !before || now - before.told >= RETELL_MS;
    const record: DropRecord = {
      ids: [...new Set([...(before?.ids ?? []), id])],
      at,
      by: { ...(before?.by ?? {}), [id]: askerOf(session) },
      told: tellNow ? now : (before?.told ?? now),
    };
    await writeDrop(address, record, now);
    return { at, name: row.name, tellNow };
  });
  if (!asked) return null;
  if (asked.tellNow) {
    // Owner C3-96: what to do if it was not them, and when it happens, in plain words.
    const when = removalWhen(asked.at);
    await tell(
      address,
      "A passkey is set to be removed from your Marktmorgen account",
      `Somebody logged in to your Marktmorgen account (${address}) without a passkey or an app code and asked to remove the passkey called “${headerText(asked.name, 60)}”.\n\nIt will be removed on ${when}.`,
      {
        ifYou: "If this was you, there is nothing to do: it is removed on that day.",
        ifNotYou: [
          `If it was not you, stop it before ${when}:`,
          `1. Log in at ${SITE_URL}/signin with another of your passkeys, or with the emailed link and the code from your authenticator app. That login stops the removal.`,
          "2. To be sure, open Account in your studio and press “Keep it” next to the passkey.",
          "Logging in with the passkey that is being removed does not stop it.",
          "Then choose “Log out of all devices” at the bottom of your studio, and reply to this email so we can help.",
        ],
      },
    );
  }
  return asked.at;
}

/**
 * Removes, with the account's lock already held, the passkeys whose wait has
 * run out; answers them (empty when none were due), or null when nothing
 * waits or the moment has not come.
 */
async function removeDue(address: string, now: number): Promise<Passkey[] | null> {
  const record = await readDrop(address);
  if (!record || now < record.at) return null;
  const list = await listPasskeys(address);
  const removed = list.filter((p) => record.ids.includes(p.id));
  await saveList(address, list.filter((p) => !record.ids.includes(p.id)));
  await redisPipeline([["DEL", dropKey(address), ...removed.map((p) => credKey(p.id))]]);
  return removed;
}

/** What follows a removal that waited its days, once the lock is let go: its sessions logged out, the account told. */
async function afterDue(address: string, gone: Passkey[]): Promise<void> {
  if (!gone.length) return;
  const ids = gone.map((p) => `passkey:${p.id}`);
  await dropSecondStep(address, (mark) => ids.includes(mark));
  await tell(address, "Passkeys were removed from your Marktmorgen account", `${gone.map((p) => `“${headerText(p.name, 60)}”`).join(", ")} ${gone.length === 1 ? "was" : "were"} removed from your Marktmorgen account (${address}) after the wait. ${gone.length === 1 ? "It cannot" : "They cannot"} log in anymore. You can add a new passkey in your studio.`);
}

/**
 * The passkeys waiting to be removed, after removing those whose moment has
 * come; null when none wait. Read before anything asks whether the account
 * has a second step or which one to offer, so a removal that has waited its
 * days counts at once. The sessions those passkeys opened are logged out
 * with them.
 */
export async function pendingRemoval(email: string, now = Date.now()): Promise<PendingRemoval | null> {
  const address = normaliseEmail(email);
  const pending = await readDrop(address);
  if (!pending) return null;
  if (now < pending.at) return { ids: pending.ids, at: pending.at };
  const gone = await withPasskeys(address, () => removeDue(address, now));
  if (gone === null) {
    const left = await readDrop(address);
    return left ? { ids: left.ids, at: left.at } : null;
  }
  await afterDue(address, gone);
  return null;
}

/**
 * Calls off what waits to be removed, after removing what is already due (a
 * removal whose days are over cannot be called off any more):
 *   - `{ by: "passkey" }`: all of it, for a login with a passkey that is not
 *     itself set to be removed (one that is calls off nothing: lib/second-
 *     step-gate.ts, app/api/auth/passkey/signin);
 *   - `{ by: "code" }`: all of it, for a login with the app's code;
 *   - `{ by: "studio" }`: all of it, for Cancel under Two-step login;
 *   - `{ only }`: one passkey, for "Keep it" next to it in the studio.
 * The caller checks the session's second step first. True when something
 * waiting was called off.
 */
export async function cancelRemoval(email: string, which: { only?: string; by?: "passkey" | "code" | "studio" } = {}, now = Date.now()): Promise<boolean> {
  const address = normaliseEmail(email);
  let gone: Passkey[] = [];
  const called = await withPasskeys(address, async () => {
    gone = (await removeDue(address, now)) ?? [];
    const record = await readDrop(address);
    if (!record) return false;
    const ids = which.only !== undefined ? record.ids.filter((x) => x !== which.only) : [];
    if (ids.length === record.ids.length) return false;
    if (ids.length) await writeDrop(address, { ...record, ids, by: Object.fromEntries(ids.map((x) => [x, record.by[x] ?? ""])) }, now);
    else await redisPipeline([["DEL", dropKey(address)]]);
    return true;
  });
  await afterDue(address, gone);
  if (called) {
    const why =
      which.only !== undefined
        ? `“Keep it” was pressed in the studio of your account (${address}), so a passkey that was set to be removed stays.`
        : which.by === "passkey"
          ? `Your account (${address}) was just logged in with a passkey that is not set to be removed, so the passkeys that were set to be removed stay.`
          : which.by === "code"
            ? `Your account (${address}) was just logged in with your app's code, so the passkeys that were set to be removed stay.`
            : `The removal was canceled in the studio of your account (${address}), so the passkeys that were set to be removed stay.`;
    await tell(address, "Your passkeys stay on your Marktmorgen account", why);
  }
  return called;
}

/**
 * The sessions that asked are gone (lib/two-step.ts: a full login closes what
 * the recovery address or the way in without the second step opened): what
 * they asked to remove stays, unless its days are already over. True when
 * something did.
 */
export async function cancelRemovalsBy(email: string, sessions: readonly string[], now = Date.now()): Promise<boolean> {
  if (!sessions.length) return false;
  const address = normaliseEmail(email);
  const askers = new Set(sessions.map(askerOf));
  let gone: Passkey[] = [];
  const called = await withPasskeys(address, async () => {
    gone = (await removeDue(address, now)) ?? [];
    const record = await readDrop(address);
    if (!record) return false;
    const ids = record.ids.filter((x) => !askers.has(record.by[x] ?? ""));
    if (ids.length === record.ids.length) return false;
    if (ids.length) await writeDrop(address, { ...record, ids, by: Object.fromEntries(ids.map((x) => [x, record.by[x] ?? ""])) }, now);
    else await redisPipeline([["DEL", dropKey(address)]]);
    return true;
  });
  await afterDue(address, gone);
  if (called) await tell(address, "Your passkeys stay on your Marktmorgen account", `The browser that asked to remove a passkey from your account (${address}) was logged out, so what it asked is called off and your passkeys stay.`);
  return called;
}

/**
 * Removes one of the account's passkeys, at once (a session opened with a
 * second step). True when there was one to remove. The sessions it opened
 * are logged out; `keep`, the session removing it, only loses its mark.
 */
export async function removePasskey(email: string, id: string, keep?: string): Promise<boolean> {
  const address = normaliseEmail(email);
  const gone = await withPasskeys(address, async () => {
    const list = await listPasskeys(address);
    const row = list.find((p) => p.id === id);
    if (!row) return null;
    await saveList(address, list.filter((p) => p.id !== id));
    await redisPipeline([["DEL", credKey(id)]]);
    return row;
  });
  if (!gone) return false;
  await dropSecondStep(address, (mark) => mark === `passkey:${id}`, keep);
  await tell(address, "A passkey was removed from your Marktmorgen account", `The passkey called “${headerText(gone.name, 60)}” was removed from your Marktmorgen account (${address}). It cannot log in anymore.`);
  return true;
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
export async function signInWith(nonce: string, response: AuthenticationResponseJSON): Promise<{ email: string; id: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(nonce) || typeof response?.id !== "string") return null;
  const challenge = await spend(authKey(nonce));
  if (!challenge) return null;

  const [owner] = await redisPipeline([["GET", credKey(response.id)]]);
  if (typeof owner !== "string" || !owner) return null;

  // All under the account's lock, removals whose wait ran out first: a
  // passkey due to go never logs in, and one removed meanwhile (in the
  // studio, or by its wait) is never written back.
  let gone: Passkey[] = [];
  const signed = await withPasskeys(owner, async () => {
    gone = (await removeDue(owner, Date.now())) ?? [];
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
    await saveList(owner, list.map((p) => (p.id === passkey.id ? { ...p, counter: newCounter, lastUsedAt: new Date().toISOString() } : p)));
    return true;
  });
  await afterDue(owner, gone);
  return signed ? { email: owner, id: response.id } : null;
}

/**
 * Carries an account's passkeys to its new address, when it moves. Any the
 * new address already had are kept, first, up to the ten an account holds;
 * a passkey that does not fit is forgotten rather than left pointing at an
 * account that no longer lists it.
 */
export async function movePasskeys(from: string, to: string): Promise<void> {
  const list = await listPasskeys(from);
  if (!list.length) return;
  const address = normaliseEmail(to);
  const theirs = await listPasskeys(address);
  const known = new Set(theirs.map((p) => p.id));
  const merged = [...theirs, ...list.filter((p) => !known.has(p.id))].slice(0, MAX_PASSKEYS);
  const kept = new Set(merged.map((p) => p.id));
  await redisPipeline([
    ["SET", listKey(address), JSON.stringify(merged)],
    ...list.map((p) => (kept.has(p.id) ? ["SET", credKey(p.id), address] : ["DEL", credKey(p.id)])),
    ["DEL", listKey(from)],
  ]);
}
