/**
 * The print a downloaded affiliate payout batch file leaves behind (issue #4479), so that "Mark the batch as paid"
 * writes down only the file that was paid and never what the book happens to owe when the button is pressed.
 *
 * The download (GET app/api/store/affiliates/payout-batch) sets a cookie holding the time it stops being valid and an
 * HMAC, under a key derived from the deployment's own secret (lib/secret-box.ts), of that time, the store, its currency
 * and every line of the file: each affiliate's id and amount, sorted. Nothing is stored on the server, so there is no
 * new data to keep, count or erase. The confirmation (POST) recomputes the print over the lines the book owes now and
 * writes the batch only when the two are the same: an affiliate who became owed since, a changed amount, a refund
 * in between or a PayPal payment set on its way since all change the lines, and then nothing is written. A missing,
 * unreadable or expired print writes nothing either. No secret: no print is made, and no batch can be confirmed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey } from "@/lib/secret-box";

export const BATCH_PRINT_COOKIE = "nl_paybatch";
/** How long a downloaded file can be confirmed as paid: long enough to pay it in the creator's own provider. */
export const BATCH_PRINT_SECONDS = 30 * 86_400;
const LABEL = "affiliate-batch-file/v1";
const VALUE = /^([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})$/;

type PrintLine = { affiliate: { id: string }; cents: number };

function sign(statsId: string, currency: string, lines: readonly PrintLine[], until: number): string | null {
  const key = deriveKey(LABEL);
  if (!key || !statsId) return null;
  const body = [String(until), statsId, currency.toLowerCase(), ...lines.map((line) => `${line.affiliate.id}:${line.cents}`).sort()].join("|");
  return createHmac("sha256", key).update(body).digest("base64url");
}

/** The cookie's value for a file of these lines, valid BATCH_PRINT_SECONDS from now; null without a secret. */
export function batchPrint(statsId: string, currency: string, lines: readonly PrintLine[], nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  const until = nowSeconds + BATCH_PRINT_SECONDS;
  const signature = sign(statsId, currency, lines, until);
  return signature ? `${until}.${signature}` : null;
}

/** The Set-Cookie header for that value, sent back only to the confirmation route. */
export function batchPrintCookie(value: string): string {
  return `${BATCH_PRINT_COOKIE}=${value}; Path=/api/store/affiliates/payout-batch; Max-Age=${BATCH_PRINT_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

/** The print sent with a request, as the cookie header carries it; "" when there is none. */
export function batchPrintOf(cookieHeader: string | null): string {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === BATCH_PRINT_COOKIE) return rest.join("=");
  }
  return "";
}

/**
 * Whether these lines are exactly the downloaded file's: "same"; "changed" when the print is readable and still valid
 * but the lines differ (or it was altered); "no_file" when there is none, it does not read, it has expired or there
 * is no secret to check it with.
 */
export function matchesBatchPrint(
  value: string,
  statsId: string,
  currency: string,
  lines: readonly PrintLine[],
  nowSeconds = Math.floor(Date.now() / 1000),
): "same" | "changed" | "no_file" {
  const match = VALUE.exec(value);
  if (!match) return "no_file";
  const until = Number(match[1]);
  if (!Number.isSafeInteger(until) || until <= nowSeconds) return "no_file";
  const expected = sign(statsId, currency, lines, until);
  if (!expected) return "no_file";
  const given = Buffer.from(match[2]);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? "same" : "changed";
}
