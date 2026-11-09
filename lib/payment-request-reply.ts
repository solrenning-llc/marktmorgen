import { ID_PATTERN } from "@/lib/payment-request-rules";

export type RequestAction = "create" | "remind" | "cancel" | "delete" | "outside";
/** `uncertain`: an email whose send is not known, so it may still arrive (lib/payment-requests.ts sendRequestEmail). */
export type RequestActionReply = { ok: boolean; message?: string; sent?: boolean; uncertain?: true };

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
    // Read only when its own and true beside a send that did not surely go.
    return own("uncertain") && data.uncertain === true && data.sent === false ? { ok: true, sent: false, uncertain: true } : { ok: true, sent: data.sent };
  }
  return { ok: true };
}
