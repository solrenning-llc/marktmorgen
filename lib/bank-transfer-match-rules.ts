/**
 * Matching a bank transfer received by the LLC to the invoice it pays:
 * 438 [FC1] (b), unit 1 (11 November 2026). Pure: the rules only. Built OFF:
 * nothing here reads a bank, opens an account, sends bank details or charges
 * anybody; the bank's API, the payment option and its margin per plan
 * (lib/receiving-costs.ts) wait for the account to exist and the owner to
 * decide. Until then PV1(i)'s transfer through Stripe stays the way.
 *
 *   - Each invoice has its own reference, MM- and ten characters from an
 *     alphabet with no 0/O, 1/I/L, read exactly (isTransferReference). The
 *     bank's memo line may carry it among other words; two references in one
 *     memo are in doubt.
 *   - Only the whole amount, in the invoice's currency, starts the period
 *     (with credit kept from earlier transfers). Less is kept as credit and
 *     starts nothing. More is never lost: the invoice is paid and the rest is
 *     kept for review.
 *   - No reference, a reference that is not an open invoice, another
 *     currency, an amount that is not a whole positive number of cents, or a
 *     receipt with no id of its own: review, and nothing starts. The review
 *     line carries the receipt's id, amount, currency and reason only: never
 *     the payer's name, account or memo text (reviewLine).
 *   - The same receipt never counts twice (its id, seen before).
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const REFERENCE = new RegExp(`^MM-[${ALPHABET}]{10}$`);
// A whole word on both sides: no letter or digit just before or after it (Claude 3 on #3811).
const IN_MEMO = new RegExp(`(?<![A-Z0-9])MM-[${ALPHABET}]{10}(?![A-Z0-9])`, "g");

/**
 * A new reference for an invoice: MM- and ten characters drawn from the
 * alphabet by the platform's cryptographic random source (about 49 bits).
 * The caller stores it with the invoice only if no open invoice has it.
 */
export function newTransferReference(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  // 256 is not a multiple of 31: drawing again past the last whole multiple keeps every character equally likely.
  let out = "";
  for (let i = 0; out.length < 10; i += 1) {
    if (i >= bytes.length) {
      globalThis.crypto.getRandomValues(bytes);
      i = 0;
    }
    if (bytes[i] < 248) out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `MM-${out}`;
}

export function isTransferReference(raw: unknown): raw is string {
  return typeof raw === "string" && REFERENCE.test(raw);
}

export type OpenInvoice = { reference: string; currency: string; amountCents: number; creditCents: number };
export type Receipt = { id: unknown; reference: unknown; amountCents: unknown; currency: unknown };
export type ReviewReason = "no_reference" | "unknown_reference" | "two_references" | "currency" | "amount" | "receipt";

export type MatchResult =
  | { kind: "paid"; reference: string; creditCents: number; overCents: number }
  | { kind: "partial"; reference: string; creditCents: number; shortCents: number }
  | { kind: "review"; reason: ReviewReason }
  | { kind: "duplicate" };

const isCents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** What one receipt does to the open invoices. Pure: the caller keeps the credit and the receipts seen. */
export function matchReceipt(receipt: Receipt, open: ReadonlyMap<string, OpenInvoice>, seen: ReadonlySet<string>): MatchResult {
  if (typeof receipt.id !== "string" || !receipt.id || receipt.id.length > 128) return { kind: "review", reason: "receipt" };
  if (seen.has(receipt.id)) return { kind: "duplicate" };
  const memo = typeof receipt.reference === "string" ? receipt.reference : "";
  // A bank may print the memo in lower case; the references are upper case, so the memo is read as such.
  const found = [...new Set(memo.toUpperCase().match(IN_MEMO) ?? [])];
  if (found.length === 0) return { kind: "review", reason: "no_reference" };
  if (found.length > 1) return { kind: "review", reason: "two_references" };
  const invoice = open.get(found[0]);
  if (!invoice || invoice.reference !== found[0]) return { kind: "review", reason: "unknown_reference" };
  if (typeof receipt.currency !== "string" || receipt.currency.toLowerCase() !== invoice.currency) return { kind: "review", reason: "currency" };
  if (!isCents(receipt.amountCents)) return { kind: "review", reason: "amount" };
  if (!isCents(invoice.amountCents) || !Number.isSafeInteger(invoice.creditCents) || invoice.creditCents < 0) return { kind: "review", reason: "amount" };
  const total = invoice.creditCents + receipt.amountCents;
  if (!Number.isSafeInteger(total)) return { kind: "review", reason: "amount" };
  if (total >= invoice.amountCents) return { kind: "paid", reference: invoice.reference, creditCents: invoice.amountCents, overCents: total - invoice.amountCents };
  return { kind: "partial", reference: invoice.reference, creditCents: total, shortCents: invoice.amountCents - total };
}

/** The line kept for review: the receipt's own id, amount, currency and the reason, never the payer's details or memo. */
export function reviewLine(receipt: Receipt, reason: ReviewReason): { receipt: string; amountCents: number | null; currency: string | null; reason: ReviewReason } {
  return {
    receipt: typeof receipt.id === "string" ? receipt.id.slice(0, 128) : "",
    amountCents: isCents(receipt.amountCents) ? receipt.amountCents : null,
    currency: typeof receipt.currency === "string" && /^[a-z]{3}$/i.test(receipt.currency) ? receipt.currency.toLowerCase() : null,
    reason,
  };
}
