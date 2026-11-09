/**
 * Shared waitlist token identity. Existing store tokens and Redis keys stay
 * byte-for-byte compatible. No Redis, mail, account or provider I/O lives here.
 */
import { createHash, randomBytes } from "node:crypto";
import { CONFIRM_SECONDS, WAIT_SECONDS } from "@/lib/waitlist-rules";

export const WAIT_TOKEN = /^[0-9a-f]{48}$/;
export type StoreWaitlistGrant = {
  s: string; h: string; p: string; e: string; k: "confirm" | "leave";
};
export type PlatformWaitlistGrant = {
  scope: "platform_waitlist";
  version: 1;
  entryId: string;
  generation: string;
  k: "confirm" | "leave";
  issuedAt: number;
  expiresAt: number;
};

export function newWaitlistToken(): string {
  return randomBytes(24).toString("hex");
}
export function waitlistTokenKey(token: string): string {
  return "nl:wl:t:" + createHash("sha256").update(token).digest("hex");
}

function hasDuplicateTopLevelMembers(raw: string): boolean {
  const names = new Set<string>();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let keyStart = -1;
  let expectingKey = false;
  for (let i = 0; i < raw.length; i += 1) {
    const character = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        inString = false;
        if (keyStart >= 0) {
          const name = JSON.parse(raw.slice(keyStart, i + 1)) as unknown;
          if (typeof name !== "string" || names.has(name)) return true;
          names.add(name);
          keyStart = -1;
          expectingKey = false;
        }
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      if (depth === 1 && expectingKey) keyStart = i;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth === 1) expectingKey = true;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    } else if (character === "," && depth === 1) {
      expectingKey = true;
    }
  }
  return false;
}

/** Keep the original store decoder's behavior for legacy persisted grants.
 * A scoped platform grant must never enter a creator's confirm/leave flow.
 */
export function parseStoreWaitlistGrant(raw: unknown): StoreWaitlistGrant | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 2048) return null;
  try {
    const value = JSON.parse(raw);
    if (hasDuplicateTopLevelMembers(raw)) return null;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.hasOwn(value, "scope")) return null;
    const row = value as Record<string, unknown>;
    const route = (field: unknown): field is string =>
      typeof field === "string" && field.length > 0 && !/[\u0000-\u001f\u007f]/.test(field);
    if (!route(row.s) || !route(row.h) || !route(row.p) || !route(row.e) ||
        (row.k !== "confirm" && row.k !== "leave")) return null;
    return { s: row.s, h: row.h, p: row.p, e: row.e, k: row.k };
  } catch {
    return null;
  }
}

/** A platform grant is purpose-, generation- and time-bound. Its entry identity
 * is opaque; no email, country or plan is carried in its public token or result.
 * Validation is not confirmation, authorization, funding or token consumption.
 */
export function parsePlatformWaitlistGrant(
  raw: unknown, purpose: "confirm" | "leave", nowSeconds: number,
): PlatformWaitlistGrant | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 2048 ||
      !["confirm", "leave"].includes(purpose) ||
      !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return null;
  try {
    const value = JSON.parse(raw);
    if (hasDuplicateTopLevelMembers(raw)) return null;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        value.scope !== "platform_waitlist" || value.version !== 1 ||
        value.k !== purpose || typeof value.entryId !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.entryId) ||
        typeof value.generation !== "string" || !/^[0-9a-f]{32}$/.test(value.generation) ||
        !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0 ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.issuedAt ||
        value.issuedAt > nowSeconds || value.expiresAt <= nowSeconds ||
        value.expiresAt - value.issuedAt > (purpose === "confirm" ? CONFIRM_SECONDS : WAIT_SECONDS)) return null;
    // Copy only validated routing data. Unrecognized properties cannot leak
    // into later reporting or introduce authorization/consent claims.
    return {
      scope: "platform_waitlist", version: 1, entryId: value.entryId,
      generation: value.generation, k: purpose,
      issuedAt: value.issuedAt, expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}
