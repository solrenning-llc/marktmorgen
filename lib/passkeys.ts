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
 *                            a login with a passkey or the app's code calls it off
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
import { normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, headerText, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { SITE_URL } from "@/lib/site-url";
import { RESET_DAYS } from "@/lib/two-step";

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
      "with this email address, remove any passkey you do not recognize, choose “Log out of all devices” at the bottom of your studio, and reply to this email so we can help.",
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

  const list = await listPasskeys(address);
  if (list.length >= MAX_PASSKEYS) return { ok: false, reason: "full" };
  const { credential, credentialBackedUp } = verified.registrationInfo;
  const [claimed] = await redisPipeline([["SET", credKey(credential.id), address, "NX"]]);
  if (claimed === null) return { ok: false, reason: "taken" };

  const now = new Date().toISOString();
  const passkey: Passkey = {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: (credential.transports ?? []).slice(0, 8),
    name: rawName.replace(/\s+/g, " ").trim().slice(0, MAX_PASSKEY_NAME) || "Passkey",
    createdAt: now,
    lastUsedAt: "",
    synced: credentialBackedUp,
  };
  await saveList(address, [...list, passkey]);
  await tell(address, "A passkey was added to your Marktmorgen account", `A passkey called “${headerText(passkey.name, 60)}” was added to your Marktmorgen account (${address}). It can now log in to your studio.`);
  return { ok: true, passkey };
}

/**
 * How long a passkey asked to be removed by a session opened without a second
 * step (an emailed link, Google, a recovery address) waits before it goes: the
 * same days a request to turn two-step login off without a code waits
 * (lib/two-step.ts RESET_DAYS), with an email to the account at once. It is
 * the way back for somebody who lost their passkey, and it keeps somebody who
 * only reads the inbox from taking the passkeys away and adding their own.
 */
export const REMOVAL_DAYS = RESET_DAYS;

const dropKey = (email: string) => `nl:pk:drop:${sha(`nimbus-passkey-drop:${normaliseEmail(email)}`).slice(0, 40)}`;

/** Passkeys waiting to be removed, and when, in ms. */
export type PendingRemoval = { ids: string[]; at: number };

async function readDrop(email: string): Promise<PendingRemoval | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", dropKey(email)]]);
  try {
    const value = typeof raw === "string" ? (JSON.parse(raw) as { ids?: unknown; at?: unknown }) : null;
    if (!value || !Array.isArray(value.ids) || typeof value.at !== "number") return null;
    const ids = value.ids.filter((id): id is string => typeof id === "string").slice(0, MAX_PASSKEYS);
    return ids.length ? { ids, at: value.at } : null;
  } catch {
    return null;
  }
}

/**
 * Asked by a session opened without a second step: the passkey is removed
 * REMOVAL_DAYS after the first such request (asking again does not move the
 * day), and the account is told now. Answers the day, or null when the
 * account has no such passkey.
 */
export async function scheduleRemoval(email: string, id: string, now = Date.now()): Promise<number | null> {
  const address = normaliseEmail(email);
  const list = await listPasskeys(address);
  const row = list.find((p) => p.id === id);
  if (!row) return null;
  const before = await readDrop(address);
  const at = before?.at ?? now + REMOVAL_DAYS * 86_400_000;
  const ids = [...new Set([...(before?.ids ?? []), id])];
  const seconds = Math.max(60, Math.ceil((at - now) / 1000) + 30 * 86_400);
  await redisPipeline([["SET", dropKey(address), JSON.stringify({ ids, at }), "EX", seconds]]);
  const day = new Date(at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  await tell(
    address,
    "A passkey is set to be removed from your Marktmorgen account",
    `Somebody who logged in to your Marktmorgen account (${address}) with an emailed link, not with a passkey or an app code, asked to remove the passkey called “${headerText(row.name, 60)}”. It will be removed on ${day}. Logging in with any of your passkeys or your app's code before then calls this off.`,
  );
  return at;
}

/**
 * The passkeys waiting to be removed, after removing those whose day has
 * come; null when none wait. Read before anything asks whether the account
 * has a second step, so a removal that has waited its days counts at once.
 */
export async function pendingRemoval(email: string, now = Date.now()): Promise<PendingRemoval | null> {
  const address = normaliseEmail(email);
  const pending = await readDrop(address);
  if (!pending) return null;
  if (now < pending.at) return pending;
  const list = await listPasskeys(address);
  const gone = list.filter((p) => pending.ids.includes(p.id));
  await saveList(address, list.filter((p) => !pending.ids.includes(p.id)));
  await redisPipeline([["DEL", dropKey(address), ...gone.map((p) => credKey(p.id))]]);
  if (gone.length) await tell(address, "Passkeys were removed from your Marktmorgen account", `${gone.map((p) => `“${headerText(p.name, 60)}”`).join(", ")} ${gone.length === 1 ? "was" : "were"} removed from your Marktmorgen account (${address}) after the wait. ${gone.length === 1 ? "It cannot" : "They cannot"} log in anymore. You can add a new passkey in your studio.`);
  return null;
}

/** A login with a passkey or the app's code: whatever waited to be removed stays. True when something did. */
export async function cancelRemoval(email: string): Promise<boolean> {
  const address = normaliseEmail(email);
  if (!(await readDrop(address))) return false;
  await redisPipeline([["DEL", dropKey(address)]]);
  await tell(address, "Your passkeys stay on your Marktmorgen account", `Your account (${address}) was just logged in with a passkey or an app code, so the passkeys that were set to be removed stay.`);
  return true;
}

/** Removes one of the account's passkeys. True when there was one to remove. */
export async function removePasskey(email: string, id: string): Promise<boolean> {
  const address = normaliseEmail(email);
  const list = await listPasskeys(address);
  const gone = list.find((p) => p.id === id);
  if (!gone) return false;
  await saveList(address, list.filter((p) => p.id !== id));
  await redisPipeline([["DEL", credKey(id)]]);
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
export async function signInWith(nonce: string, response: AuthenticationResponseJSON): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(nonce) || typeof response?.id !== "string") return null;
  const challenge = await spend(authKey(nonce));
  if (!challenge) return null;

  const [owner] = await redisPipeline([["GET", credKey(response.id)]]);
  if (typeof owner !== "string" || !owner) return null;
  const list = await listPasskeys(owner);
  const passkey = list.find((p) => p.id === response.id);
  if (!passkey) return null;

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
    return null;
  }
  if (!verified.verified) return null;

  await saveList(
    owner,
    list.map((p) =>
      p.id === passkey.id ? { ...p, counter: verified.authenticationInfo.newCounter, lastUsedAt: new Date().toISOString() } : p,
    ),
  );
  return owner;
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
