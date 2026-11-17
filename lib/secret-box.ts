/**
 * Keeping a creator's secrets unreadable at rest, without a new secret to set.
 *
 * Some things a creator gives us are keys to their other accounts: the API
 * key of their Mailchimp, Kit, beehiiv or MailerLite (lib/email-sync.ts).
 * Those are kept in Redis, like everything else, and Redis is reached with a
 * token that sits in more places than we would like — the hosting dashboard,
 * the database provider's console, a developer's shell. So a key like that is
 * sealed before it is written: AES-256-GCM, a fresh random nonce for every
 * seal, and the name of what it belongs to (the store and the purpose) bound
 * in as associated data, so a sealed value copied into another store's record
 * does not open there. Somebody holding a copy of the database, and nothing
 * else, reads noise.
 *
 * The key that seals is not stored anywhere. It is derived, with HKDF-SHA256
 * and a fixed label per purpose, from one root secret the deployment keeps
 * apart from the database:
 *
 *   - NIMBUS_DATA_KEY, when it is set (32 characters or more; `openssl rand
 *     -base64 32` makes one). A secret with no other job, so it never has to
 *     change because something else did.
 *   - Otherwise STRIPE_SECRET_KEY, which every deployment that sells already
 *     has, so the owner creates nothing on deploy.
 *
 * Consequences, each handled rather than hidden:
 *
 *   - The derived keys are one-way: nothing sealed here, and nothing derived
 *     here (the web push key pair in lib/web-push.ts is derived the same way,
 *     with its own label), says anything about the root secret itself, and a
 *     derived key that leaked says nothing about the other derived keys.
 *   - Rolling the root secret changes every derived key. Each sealed value
 *     carries a short fingerprint of the key that sealed it, so a value
 *     sealed under an old one is recognised as such and the studio says so
 *     plainly ("paste your API key again"), and phones are asked to turn
 *     notifications on again, instead of anything failing in silence. With
 *     the Stripe key as the root, a Stripe key rolled after a leak does this
 *     too — the reason NIMBUS_DATA_KEY exists.
 *   - Setting NIMBUS_DATA_KEY on a deployment that has been sealing under
 *     the Stripe key breaks nothing: from then on everything is sealed under
 *     the new key, and what was sealed before still opens with the key
 *     derived from STRIPE_SECRET_KEY (it is only ever used to open, never to
 *     seal) for as long as that key is unchanged. A value opened that way is
 *     sealed again under the new key the next time its settings are saved;
 *     phones subscribed under the old push key keep being sent to with it,
 *     and move to the new one by themselves the next time the studio is
 *     opened on them (components/phone-alerts-panel.tsx).
 *
 * Sealed text looks like "s1.<fingerprint>.<nonce>.<ciphertext and tag>", all
 * base64url, and is only ever handled on the server.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/** Everything derived here is derived under this salt, so no other use of the secret collides with it. */
const SALT = "nimbus-labs/derived-keys/v1";
const VERSION = "s1";

/** The shortest NIMBUS_DATA_KEY accepted; a shorter one is treated as not set. */
export const MIN_DATA_KEY_LENGTH = 32;

function dataKey(): string | null {
  const value = process.env.NIMBUS_DATA_KEY?.trim();
  return value && value.length >= MIN_DATA_KEY_LENGTH ? value : null;
}

function stripeSecret(): string | null {
  const value = process.env.STRIPE_SECRET_KEY?.trim();
  return value ? value : null;
}

/**
 * The deployment's own secret that every derived key comes from (see above).
 * Read at call time, never at import, so a check that sets it later sees it.
 */
function rootSecret(): string | null {
  return dataKey() ?? stripeSecret();
}

/**
 * The secret keys were derived from before NIMBUS_DATA_KEY was set: the
 * Stripe key, while a dedicated key is in use. Only ever used to open what
 * was sealed before, and to sign for phones that subscribed before.
 */
function legacySecret(): string | null {
  return dataKey() ? stripeSecret() : null;
}

/** Which root is in use, for a check or a status line; never the secret itself. */
export function rootName(): "NIMBUS_DATA_KEY" | "STRIPE_SECRET_KEY" | null {
  return dataKey() ? "NIMBUS_DATA_KEY" : stripeSecret() ? "STRIPE_SECRET_KEY" : null;
}

function derive(root: string, label: string, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", root, SALT, label, length));
}

/** Whether anything can be sealed or derived here: the root secret is set. */
export function canSeal(): boolean {
  return rootSecret() !== null;
}

/**
 * A key of `length` bytes for one purpose, the same every time for the same
 * root secret and label, and unrelated to the key for any other label.
 * Null when the root secret is not set.
 */
export function deriveKey(label: string, length = 32): Buffer | null {
  const root = rootSecret();
  return root ? derive(root, label, length) : null;
}

/** The same key as it was derived before NIMBUS_DATA_KEY was set, or null when there is no such earlier root. */
export function deriveLegacyKey(label: string, length = 32): Buffer | null {
  const root = legacySecret();
  return root ? derive(root, label, length) : null;
}

/** A short public name for a key: which key sealed something, never the key. */
export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

const SEAL_LABEL = "nimbus-labs/secret-box/aes-256-gcm/v1";

function sealKey(): Buffer | null {
  return deriveKey(SEAL_LABEL);
}

function legacySealKey(): Buffer | null {
  return deriveLegacyKey(SEAL_LABEL);
}

/** The fingerprint of the key that seals today, or "" when nothing can be sealed. */
export function currentSealId(): string {
  const key = sealKey();
  return key ? keyFingerprint(key) : "";
}

/**
 * Seals `plain` for one use, named by `context` (for example
 * "email-sync|<store>|mailchimp"). Throws when the root secret is not set:
 * a secret is never written in the clear instead.
 */
export function seal(plain: string, context: string): string {
  const key = sealKey();
  if (!key) throw new Error("Nothing can be sealed: neither NIMBUS_DATA_KEY nor STRIPE_SECRET_KEY is set");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return [VERSION, keyFingerprint(key), nonce.toString("base64url"), data.toString("base64url")].join(".");
}

export type Unsealed =
  /** `legacy`: it was opened with the key from before NIMBUS_DATA_KEY, and should be sealed again. */
  | { ok: true; value: string; legacy: boolean }
  | { ok: false; reason: "other-key" | "broken" };

/**
 * Opens what `seal` made for the same `context`. Says "other-key" when it was
 * sealed under a key this deployment no longer derives (the root secret was
 * rolled), and "broken" for anything else that does not open — altered,
 * truncated, or sealed for another store.
 */
export function unseal(sealed: string, context: string): Unsealed {
  const current = sealKey();
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (!current || parts.length !== 4 || parts[0] !== VERSION) return { ok: false, reason: "broken" };
  const earlier = legacySealKey();
  const legacy = parts[1] !== keyFingerprint(current);
  const key = !legacy ? current : earlier && parts[1] === keyFingerprint(earlier) ? earlier : null;
  if (!key) return { ok: false, reason: "other-key" };
  try {
    const nonce = Buffer.from(parts[2], "base64url");
    const data = Buffer.from(parts[3], "base64url");
    if (nonce.length !== 12 || data.length < 17) return { ok: false, reason: "broken" };
    // Node's decoder skips characters outside the alphabet and padding, so an altered text could open: only the
    // exact base64url seal() wrote is a sealed value (input fuzz, Claude 7).
    if (nonce.toString("base64url") !== parts[2] || data.toString("base64url") !== parts[3]) return { ok: false, reason: "broken" };
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    return { ok: true, value: plain.toString("utf8"), legacy };
  } catch {
    return { ok: false, reason: "broken" };
  }
}
