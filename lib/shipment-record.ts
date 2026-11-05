/** Browser-safe validation shared by fulfillment storage and its confirmation UI. */
export type ShipmentMailLifecycle = "never_activated" | "active" | "retired";
/** Deployment history, not financial evidence. Before first activation,
 * cleanup and its complete failure/retention costs must be funded/enabled.
 * Once used, cleanup/status remain enabled through retirement: never reset
 * to never_activated while payloads or uncertain reserves may still exist.
 * A financial policy is independently required for new storage/sends.
 */
export const CURRENT_SHIPMENT_MAIL_LIFECYCLE: ShipmentMailLifecycle = "never_activated";
export type Shipped = { at: number; tracking: string };
export type ShipmentMailStatus = { state: "queued" | "on_hold" | "accepted" | "acceptance_unknown" | "refused" | "not_recorded"; delayed: boolean };
export function readShipmentMailStatus(raw: unknown): ShipmentMailStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = Object.getOwnPropertyDescriptor(raw, "state");
  const delayed = Object.getOwnPropertyDescriptor(raw, "delayed");
  if (!state || !Object.hasOwn(state, "value") || typeof state.value !== "string" ||
      !["queued", "on_hold", "accepted", "acceptance_unknown", "refused", "not_recorded"].includes(state.value) ||
      !delayed || !Object.hasOwn(delayed, "value") || typeof delayed.value !== "boolean") return null;
  return { state: state.value as ShipmentMailStatus["state"], delayed: delayed.value };
}

/** An HTTPS tracking address of at most 500 characters, or no tracking link. */
export function readTracking(raw: unknown): string | null {
  const typed = typeof raw === "string" ? raw.trim() : "";
  if (!typed) return "";
  if (typed.length > 500) return null;
  try {
    const url = new URL(typed);
    return url.protocol === "https:" && url.hostname.includes(".") && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Unknown storage is not evidence that an order was marked as shipped. */
export function readShippedRecord(raw: unknown): Shipped | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!Object.hasOwn(value, "at") || !Object.hasOwn(value, "tracking")) return null;
  if (typeof value.at !== "number" || !Number.isSafeInteger(value.at) || value.at <= 0 || value.at > 8_640_000_000_000) return null;
  if (typeof value.tracking !== "string") return null;
  const tracking = readTracking(value.tracking);
  return tracking === null ? null : { at: value.at, tracking };
}

/** A successful HTTP response still needs explicit, consistent application proof. */
export function readShipmentConfirmation(raw: unknown, httpOk: boolean): { shipped: Shipped; emailed: boolean; mail?: ShipmentMailStatus } | null {
  if (!httpOk || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!Object.hasOwn(value, "ok") || value.ok !== true || Object.hasOwn(value, "error")) return null;
  if (!Object.hasOwn(value, "emailed") || typeof value.emailed !== "boolean" || !Object.hasOwn(value, "shipped")) return null;
  const shipped = readShippedRecord(value.shipped);
  const mail = Object.hasOwn(value, "mail") ? readShipmentMailStatus(value.mail) : undefined;
  if (mail === null || (mail && (mail.state === "accepted") !== value.emailed)) return null;
  return shipped ? { shipped, emailed: value.emailed, ...(mail ? { mail } : {}) } : null;
}
