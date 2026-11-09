/**
 * Web Push, by hand: the key pair that identifies us to the push services,
 * the encrypted message, and the one request that hands it over.
 *
 * A phone that turned notifications on for the studio (lib/phone-alerts.ts)
 * gave us a subscription: an https address at its browser's push service
 * (Apple's for Safari on iPhone and Mac, Google's for Chrome and Android,
 * Mozilla's for Firefox, Microsoft's for Edge on Windows) and two keys of the
 * browser's own. A notification is a POST to that address, and two standards
 * say what goes in it:
 *
 *   - RFC 8292 (VAPID): the request carries a short token signed with our
 *     P-256 key, and the public half of that key, so the push service knows
 *     the message comes from whoever the browser subscribed with. The browser
 *     was given that public key when it subscribed, and the service refuses a
 *     message signed with any other.
 *   - RFC 8291 with RFC 8188 (aes128gcm): the message is encrypted for the
 *     browser alone, with a fresh key pair for every message, so the push
 *     service carries it without being able to read it.
 *
 * Why not the `web-push` npm package: its last release was in January 2024,
 * and what it does fits in this file with nothing but node:crypto, which
 * also lets every request go through lib/safe-fetch.ts.
 *
 * The VAPID key pair is not a new environment variable. It is derived, with
 * HKDF-SHA256 and the fixed label VAPID_LABEL, from the deployment's
 * existing server secret (lib/secret-box.ts explains which one, and why): the
 * 32 bytes are the private scalar, used only if 1 <= d < n, the order of the
 * P-256 group — otherwise the next counter value is tried, which for
 * HKDF output happens about once in four billion — and the public key is
 * computed from it. So the key is the same on every deploy and every
 * instance, nobody has to create or copy it, and it changes only if that
 * server secret is rolled; a subscription made under the old key is then
 * recognised by its fingerprint and the phone is asked to turn notifications
 * on again (the studio does it by itself when it is next opened there). When
 * the root moves from the Stripe key to NIMBUS_DATA_KEY, the pair derived
 * from the Stripe key is kept for the phones that subscribed with it
 * (vapidKeysFor), so none of them goes quiet in between.
 *
 * The addresses messages may go to are a fixed list of push services
 * (PUSH_HOST), checked before anything is sent, and the request itself goes
 * through lib/safe-fetch.ts, which refuses private networks and follows no
 * redirect: a subscription is written by a browser, and a browser is written
 * to by whoever holds it.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { deriveKey, deriveLegacyKey, keyFingerprint } from "@/lib/secret-box";
import { SafeFetchError, problemWords, safeFetch, type SafeFetchOptions } from "@/lib/safe-fetch";

/** The label the VAPID private key is derived under. Changing it changes every phone's key. */
export const VAPID_LABEL = "nimbus-labs/web-push/vapid-p256/v1";
/** Who the push services may write to about our messages. */
export const VAPID_SUBJECT = "mailto:support@marktmorgen.com";
/** The order n of the P-256 group: a private key is a number from 1 to n - 1. */
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
/** How long a signed token is good for. RFC 8292 allows up to a day. */
const TOKEN_SECONDS = 12 * 3600;
/** The record size written in the message header. One record carries the whole message. */
const RECORD_SIZE = 4096;
/** The longest message sent, in bytes before encryption; push services accept about 4 KB. */
export const MAX_PAYLOAD_BYTES = 3000;
/** How long a push service may take to take a message. */
const SEND_TIMEOUT_MS = 8_000;

/**
 * The push services a subscription may point at: Google (Chrome, Android,
 * Edge on Android, Opera, Brave, Samsung Internet), Mozilla, Apple (Safari on
 * iPhone, iPad and Mac) and Microsoft (Edge on Windows).
 */
export const PUSH_HOST = /^(?:fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]{1,63}\.notify\.windows\.com)$/;

export type VapidKeys = {
  /** The uncompressed public key, base64url: what the browser subscribes with. */
  publicKey: string;
  privateKey: KeyObject;
  /** A short fingerprint of the public key, kept with each subscription. */
  kid: string;
};

/** Key pairs already worked out, by a fingerprint of the seed they come from. */
const cached = new Map<string, VapidKeys>();

function vapidFrom(derive: (label: string, length: number) => Buffer | null): VapidKeys | null {
  for (let counter = 0; counter < 16; counter += 1) {
    const seed = derive(counter ? `${VAPID_LABEL}#${counter}` : VAPID_LABEL, 32);
    if (!seed) return null;
    const tag = keyFingerprint(seed);
    const known = cached.get(tag);
    if (known) return known;
    const d = BigInt(`0x${seed.toString("hex")}`);
    // Outside [1, n-1] is not a P-256 private key: derive the next one.
    if (d < BigInt(1) || d >= P256_ORDER) continue;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(seed);
    const pub = ecdh.getPublicKey();
    const privateKey = createPrivateKey({
      key: {
        kty: "EC",
        crv: "P-256",
        d: seed.toString("base64url"),
        x: pub.subarray(1, 33).toString("base64url"),
        y: pub.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    const keys: VapidKeys = { publicKey: pub.toString("base64url"), privateKey, kid: keyFingerprint(pub) };
    if (cached.size > 8) cached.clear();
    cached.set(tag, keys);
    return keys;
  }
  return null;
}

/**
 * Our VAPID key pair, derived from the server secret (see above). Null when
 * that secret is not set, in which case nothing can be sent or subscribed.
 * Every new subscription is made with this one.
 */
export function vapidKeys(): VapidKeys | null {
  return vapidFrom(deriveKey);
}

/**
 * The key pair a subscription was made with, by the fingerprint kept with
 * it: today's, or the one derived from the Stripe key before NIMBUS_DATA_KEY
 * was set. Null when it is neither, and the phone has to subscribe again.
 */
export function vapidKeysFor(kid: string): VapidKeys | null {
  const now = vapidKeys();
  if (now && now.kid === kid) return now;
  const before = vapidFrom(deriveLegacyKey);
  return before && before.kid === kid ? before : null;
}

/** The Authorization header for one push service, signed now. */
export function vapidAuthorization(audience: string, keys: VapidKeys, now = Date.now()): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: Math.floor(now / 1000) + TOKEN_SECONDS, sub: VAPID_SUBJECT })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

export type PushKeys = { p256dh: string; auth: string };
export type Subscription = { endpoint: string } & PushKeys;

function decoded(value: string, bytes: number): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const buffer = Buffer.from(value.replace(/=+$/, ""), "base64url");
  return buffer.length === bytes ? buffer : null;
}

/**
 * Whether an address is one of the push services above, over https on its
 * standard port, with nothing in it that would send the request elsewhere.
 */
export function isPushEndpoint(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 1000) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && PUSH_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Reads what a browser sent as its subscription (PushSubscription.toJSON()),
 * or says why it is not one we can send to: a push service not on the list,
 * or keys that are not a P-256 point and a 16-byte secret.
 */
export function readSubscription(raw: unknown): Subscription | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  const p256dh = typeof value.keys?.p256dh === "string" ? value.keys.p256dh : "";
  const auth = typeof value.keys?.auth === "string" ? value.keys.auth : "";
  if (!isPushEndpoint(endpoint)) return null;
  const point = decoded(p256dh, 65);
  if (!point || point[0] !== 4 || !decoded(auth, 16)) return null;
  try {
    // A key that is not on the curve fails here, not at the first sale.
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(point);
  } catch {
    return null;
  }
  return { endpoint, p256dh, auth };
}

/**
 * Encrypts one message for one browser (RFC 8291, aes128gcm). `seams` lets a
 * check fix the salt and the key pair; the app always leaves them random.
 */
export function encryptPayload(
  payload: string | Buffer,
  keys: PushKeys,
  seams: { salt?: Buffer; ecdh?: ReturnType<typeof createECDH> } = {},
): Buffer {
  const plain = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  if (plain.length > MAX_PAYLOAD_BYTES) throw new Error("The message is too long to push");
  const uaPublic = decoded(keys.p256dh, 65);
  const authSecret = decoded(keys.auth, 16);
  if (!uaPublic || !authSecret) throw new Error("Those are not a browser's push keys");

  const ecdh = seams.ecdh ?? createECDH("prime256v1");
  if (!seams.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = seams.salt ?? randomBytes(16);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" 0x00 ua_public as_public)
  const info = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));

  // One record, the last: the message, then the delimiter 0x02.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** Test seams for the request; production passes nothing. */
export type PushFetchHooks = Pick<SafeFetchOptions, "resolve" | "agent">;

export type PushResult = {
  /** What the push service answered, 0 when it did not answer. */
  status: number;
  ok: boolean;
  /** The subscription is over (the phone turned it off, or the app was removed): forget it. */
  gone: boolean;
  error: string;
};

/**
 * Sends one message to one subscription. `topic` lets a newer message replace
 * an older one still waiting at the push service (for example a second
 * community report while the phone is off); `urgency` "high" wakes a phone
 * that is saving power, which a sale is worth and a report is not.
 */
export async function sendPush(
  subscription: Subscription,
  payload: string,
  options: { ttlSeconds?: number; urgency?: "normal" | "high"; topic?: string; hooks?: PushFetchHooks; keys?: VapidKeys | null } = {},
  now = Date.now(),
): Promise<PushResult> {
  // Signed with the pair the phone subscribed with (vapidKeysFor), today's by default.
  const keys = options.keys ?? vapidKeys();
  if (!keys) return { status: 0, ok: false, gone: false, error: "Push is not set up on this deployment." };
  if (!isPushEndpoint(subscription.endpoint)) return { status: 0, ok: false, gone: true, error: "Not a push service we send to." };
  const audience = new URL(subscription.endpoint).origin;
  let body: Buffer;
  try {
    body = encryptPayload(payload, subscription);
  } catch {
    return { status: 0, ok: false, gone: true, error: "This device's keys could not be used." };
  }
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization(audience, keys, now),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(Math.max(0, Math.min(options.ttlSeconds ?? 86400, 4 * 7 * 86400))),
    Urgency: options.urgency ?? "normal",
  };
  if (options.topic && /^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) headers.Topic = options.topic;
  try {
    const answer = await safeFetch(subscription.endpoint, {
      method: "POST",
      body,
      headers,
      maxBytes: 8_192,
      // Only the status is read (tests/web-push-big-answer.test.ts).
      statusOnly: true,
      timeoutMs: SEND_TIMEOUT_MS,
      ...(options.hooks ?? {}),
    });
    const status = answer.status;
    if (status >= 200 && status < 300) return { status, ok: true, gone: false, error: "" };
    const gone = status === 404 || status === 410;
    const error = gone
      ? "The device turned notifications off."
      : status === 401 || status === 403
        ? "The push service refused our signature."
        : status === 413
          ? "The message was too long."
          : status === 429
            ? "The push service asked us to slow down."
            : `The push service answered ${status}.`;
    return { status, ok: false, gone, error };
  } catch (error) {
    return { status: 0, ok: false, gone: false, error: error instanceof SafeFetchError ? problemWords(error) : "The push service could not be reached." };
  }
}
