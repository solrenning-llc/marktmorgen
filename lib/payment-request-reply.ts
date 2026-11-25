import { ID_PATTERN } from "@/lib/payment-request-rules";

export type RequestAction = "create" | "remind" | "cancel" | "delete" | "outside";
export type RequestActionReply = { ok: boolean; message?: string; sent?: boolean };

/** An HTTP error or an incomplete receipt never confirms a request action. */
export function paymentRequestReply(httpOk: boolean, value: unknown, action: RequestAction): RequestActionReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const data = value as Record<string, unknown>;
  const own = (key: string) => Object.prototype.hasOwnProperty.call(data, key);
  const message = own("message") && typeof data.message === "string" && data.message.trim()
    ? data.message.trim().slice(0, 600) : undefined;
  if (!httpOk || !own("ok") || data.ok !== true) return message ? { ok: false, message } : { ok: false };
  if (action === "create" && (!own("id") || typeof data.id !== "string" || !ID_PATTERN.test(data.id))) return { ok: false };
  if (action === "create" || action === "remind") {
    if (!own("sent") || typeof data.sent !== "boolean") return { ok: false };
    return { ok: true, sent: data.sent };
  }
  return { ok: true };
}

/** What the studio shows for one request's refunds read on their own (action "refunds"). */
export type RefundCheckReply = { checked: true; state: "paid" | "refunded"; refunded: number } | { checked: false; message: string };

/** Said when the answer itself could not be read: never a check, never 0 refunded. */
export const REFUND_CHECK_UNREAD = "Refunds were not checked: the answer could not be read. Try again in a minute, or look the payment up in your Stripe dashboard.";

/**
 * The route's answer to a refund check, only when it is exactly what the
 * route sends: an HTTP error, a missing or odd field, or a state other than
 * paid or refunded is not checked, with the route's own sentence when it
 * gave one.
 */
export function refundCheckReply(httpOk: boolean, value: unknown): RefundCheckReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { checked: false, message: REFUND_CHECK_UNREAD };
  const data = value as Record<string, unknown>;
  const own = (key: string) => Object.prototype.hasOwnProperty.call(data, key);
  const message = own("message") && typeof data.message === "string" && data.message.trim() ? data.message.trim().slice(0, 600) : REFUND_CHECK_UNREAD;
  if (!httpOk || !own("ok") || data.ok !== true || !own("checked") || data.checked !== true) return { checked: false, message };
  if (!own("state") || (data.state !== "paid" && data.state !== "refunded")) return { checked: false, message: REFUND_CHECK_UNREAD };
  if (!own("refunded") || !Number.isSafeInteger(data.refunded) || (data.refunded as number) < 0) return { checked: false, message: REFUND_CHECK_UNREAD };
  return { checked: true, state: data.state, refunded: data.refunded as number };
}
