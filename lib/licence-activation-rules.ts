/**
 * How many devices one license key may run on: 610 [WP9], unit 1 (owner's
 * Whop audit, 1 November 2026). Pure and browser-safe: the rules only.
 * Nothing here reads or writes the store, and nothing is switched on; the
 * public key check (lib/licence-keys.ts, checkKey) and the buyer's purchases
 * use these in a later unit, with the record's own ceiling and cost line.
 *
 * The creator may hold a key to a few devices (1 to MAX_ACTIVATIONS). Their
 * software sends the key and an identifier of the device it runs on; the
 * first devices take the places, a device already on the key takes none, and
 * a new one past the limit is refused. The buyer frees a device from their
 * purchases (a new computer, a reinstall), at most RELEASES_PER_WINDOW times
 * in RELEASE_WINDOW_SECONDS, so a key cannot be passed around by releasing it
 * every hour.
 *
 *   - Off by default: a product with no limit set keeps checking its keys
 *     exactly as today, and keeps nothing about devices.
 *   - A revoked key, by the creator or by a refund in full (IssuedKey
 *     revokedBy), never activates, whatever devices it had.
 *   - Unknown is never yes (rule 24): a limit or a record that could not be
 *     read refuses the activation and the release; a missing record is not
 *     an empty one.
 *   - The reply the creator's software gets says whether the device may run,
 *     why not, and how many places are used; never the buyer's email, the
 *     sale or the other devices.
 *   - The identifier is what the creator's software sends, never something
 *     Marktmorgen reads from the device. The unit that stores it keeps a
 *     keyed digest of it, not the identifier itself.
 */

/** The fewest and the most devices a key may be held to, when the creator sets a limit. */
export const MIN_ACTIVATIONS = 1;
export const MAX_ACTIVATIONS = 10;
/** How many times a buyer may free a device from one key in RELEASE_WINDOW_SECONDS. */
export const RELEASES_PER_WINDOW = 3;
export const RELEASE_WINDOW_SECONDS = 30 * 86_400;
/** The device identifier's length bounds, after trimming the spaces around it. */
export const MIN_DEVICE_ID_LENGTH = 8;
export const MAX_DEVICE_ID_LENGTH = 128;

/** Letters, digits and the marks machine identifiers use (GUIDs, MAC-like, base64url); no spaces, no markup. */
const DEVICE_ID = /^[A-Za-z0-9._:{}=+\/-]+$/;

/**
 * The creator's limit: 0 when off, 1 to MAX_ACTIVATIONS devices, or null
 * when the value is not one of those. A product never set (undefined) is off,
 * as every key works today; anything else that is not a whole number in range
 * (null, an empty text, 11, 2.5) is refused, never cut or read as off.
 */
export function parseActivationLimit(raw: unknown): number | null {
  if (raw === undefined) return 0;
  const n = typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw.trim()) : raw;
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  return n === 0 || (n >= MIN_ACTIVATIONS && n <= MAX_ACTIVATIONS) ? n : null;
}

/** The device identifier as sent, spaces around it trimmed, or null when it is not one. */
export function cleanDeviceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (id.length < MIN_DEVICE_ID_LENGTH || id.length > MAX_DEVICE_ID_LENGTH) return null;
  return DEVICE_ID.test(id) ? id : null;
}

export type Activation = {
  /** The device, as the record keeps it. */
  device: string;
  /** When it took its place, in seconds. */
  at: number;
};

/** What one key keeps: the devices on it, oldest first, and when devices were freed. */
export type KeyActivations = { devices: Activation[]; releases: number[] };

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * A key's kept record, whole or null. Null when it is missing or any part is
 * not what this module writes: a device twice, an identifier it would refuse,
 * more devices than any limit allows, a time that is not one. A caller never
 * reads null as a key with no devices.
 */
export function parseKeyActivations(raw: unknown): KeyActivations | null {
  if (!raw || typeof raw !== "object") return null;
  const { devices, releases } = raw as Record<string, unknown>;
  if (!Array.isArray(devices) || !Array.isArray(releases)) return null;
  if (devices.length > MAX_ACTIVATIONS || !releases.every(isTime)) return null;
  const kept: Activation[] = [];
  for (const entry of devices) {
    if (!entry || typeof entry !== "object") return null;
    const { device, at } = entry as Record<string, unknown>;
    const id = cleanDeviceId(device);
    if (!id || id !== device || !isTime(at) || kept.some((d) => d.device === id)) return null;
    kept.push({ device: id, at });
  }
  return { devices: kept, releases: [...releases] };
}

/** What the public check knows about the key itself (lib/licence-keys.ts, KeyCheck). */
export type KeyStanding = "valid" | "revoked" | "unknown";

export type ActivationDecision =
  | { outcome: "activated"; used: number; limit: number; record: KeyActivations }
  | { outcome: "already"; used: number; limit: number }
  | { outcome: "full"; used: number; limit: number }
  | { outcome: "revoked" }
  | { outcome: "unknown_key" }
  | { outcome: "off" }
  | { outcome: "bad_device" }
  | { outcome: "unavailable" };

/**
 * Whether a device may run on a key, and the record to keep when it takes a
 * new place. The key is judged first: revoked or never given, nothing else
 * matters. Then the limit: off keeps nothing. Then the device and the record:
 * a device already on the key runs (even after the creator lowered the
 * limit), a new one takes a place only while one is free.
 */
export function decideActivation(input: { key: KeyStanding; limit: number | null; record: KeyActivations | null; device: string | null; now: number }): ActivationDecision {
  const { key, limit, record, device, now } = input;
  if (key === "revoked") return { outcome: "revoked" };
  if (key !== "valid") return { outcome: "unknown_key" };
  if (limit === 0) return { outcome: "off" };
  if (limit === null || !Number.isInteger(limit) || limit < MIN_ACTIVATIONS || limit > MAX_ACTIVATIONS) return { outcome: "unavailable" };
  if (!device || cleanDeviceId(device) !== device) return { outcome: "bad_device" };
  if (!record) return { outcome: "unavailable" };
  const used = record.devices.length;
  if (record.devices.some((d) => d.device === device)) return { outcome: "already", used, limit };
  if (used >= limit) return { outcome: "full", used, limit };
  return { outcome: "activated", used: used + 1, limit, record: { devices: [...record.devices, { device, at: now }], releases: [...record.releases] } };
}

/** The releases still counted at `now`: those inside the window. */
function recentReleases(record: KeyActivations, now: number): number[] {
  return record.releases.filter((at) => at > now - RELEASE_WINDOW_SECONDS && at <= now).sort((a, b) => a - b);
}

/** How many more devices the buyer may free from this key now. */
export function releasesLeft(record: KeyActivations, now: number): number {
  return Math.max(0, RELEASES_PER_WINDOW - recentReleases(record, now).length);
}

export type ReleaseDecision =
  | { outcome: "released"; record: KeyActivations }
  | { outcome: "not_found" }
  | { outcome: "limit"; nextAt: number }
  | { outcome: "unavailable" };

/**
 * The buyer frees one device from their key. Refused when the record could
 * not be read, when the device is not on the key, or when the window's
 * releases are used, with the time the oldest one stops counting. The kept
 * record drops releases older than the window, so it never grows past
 * RELEASES_PER_WINDOW of them.
 */
export function decideRelease(input: { record: KeyActivations | null; device: string; now: number }): ReleaseDecision {
  const { record, device, now } = input;
  if (!record) return { outcome: "unavailable" };
  if (!record.devices.some((d) => d.device === device)) return { outcome: "not_found" };
  const recent = recentReleases(record, now);
  if (recent.length >= RELEASES_PER_WINDOW) return { outcome: "limit", nextAt: recent[0] + RELEASE_WINDOW_SECONDS };
  return { outcome: "released", record: { devices: record.devices.filter((d) => d.device !== device), releases: [...recent, now] } };
}

export type ActivationReason = "activated" | "already_active" | "device_limit" | "revoked" | "unknown_key" | "no_limit" | "bad_device" | "unavailable";

export type ActivationReply = { valid: boolean; activated: boolean; reason: ActivationReason; used?: number; limit?: number };

/**
 * What the creator's software is told. `valid` is whether the key is good;
 * `activated` whether this device may run on it. Nothing about the buyer,
 * the sale or the other devices; a record that could not be read is never a
 * yes.
 */
export function activationReply(decision: ActivationDecision): ActivationReply {
  switch (decision.outcome) {
    case "activated":
      return { valid: true, activated: true, reason: "activated", used: decision.used, limit: decision.limit };
    case "already":
      return { valid: true, activated: true, reason: "already_active", used: decision.used, limit: decision.limit };
    case "full":
      return { valid: true, activated: false, reason: "device_limit", used: decision.used, limit: decision.limit };
    case "off":
      return { valid: true, activated: false, reason: "no_limit" };
    case "revoked":
    case "unknown_key":
    case "bad_device":
    case "unavailable":
      return { valid: false, activated: false, reason: decision.outcome };
  }
}
