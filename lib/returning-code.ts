/**
 * The check behind a code only for people who already bought from this
 * store (lib/returning-code-rules.ts has the rule; 554 [DS1], unit 2).
 *
 * A typed email proves nothing: anyone may know a past buyer's address. So
 * the code and the email typed on the buy form never open a checkout. They
 * ask for a link: the page answers "sent" for every address that could be
 * checked, at once and the same way, so it never tells who is a customer;
 * after the answer, only an address that paid for an order here before is
 * emailed a link that works once, for half an hour, on that product. Only
 * that link opens the checkout with the coupon, for that address
 * (redeemReturningLink). Independent review of #3666, 11 November 2026.
 *
 * "Paid for an order here" is read strictly from the creator's Stripe
 * account (paidHere): a completed checkout of this store, paid, for more
 * than nothing, and, for a one-time payment, with its charge neither
 * refunded in any part nor disputed; or a purchase the creator brought over.
 * A free trial, a $0 order or one a code made free is not one. A list that
 * cannot be read in full, with nothing found in it, is unknown: no email.
 *
 * What it costs, each ceiling taken before the spend: the store's record,
 * already read, for the code; RETURNING_CODE_REQUEST_UNITS of the store's
 * public requests before the purchases are read (priced as NEXT_OFFER_READ
 * in tests/plan-cost-registry.ts); one of the store's own emails, taken by
 * the email meter before it goes, only for an address that bought here; a
 * key of under a kilobyte for half an hour. Tries are limited per
 * connection and store (the route) and per address and store, here.
 */
import { createHash, randomBytes } from "node:crypto";
import { after } from "next/server";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { displayName, senderAddress } from "@/lib/buyer-orders";
import { sendEmail } from "@/lib/email";
import { importedFor } from "@/lib/imported-purchases";
import { NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { withinLimit } from "@/lib/request-guard";
import { type ReturningCode, readLinkToken, returningCodeFor } from "@/lib/returning-code-rules";
import { returningLinkWords } from "@/lib/buyer-words/returning-link";
import { onAccount } from "@/lib/stripe-account";
import { ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { type Store, saleHandles } from "@/lib/store";

/** Public requests one check counts as: the same reads and Stripe calls as ownedHere for the next product after a purchase. */
export const RETURNING_CODE_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS;

/** How many tries one connection gets on one store in ten minutes: far past a buyer who mistyped, short of a script trying addresses. */
export const RETURNING_TRIES = 6;
export const RETURNING_TRIES_SECONDS = 600;

/** How many links one address can be sent by one store in an hour, so nobody can fill a past buyer's inbox. */
export const RETURNING_LINKS_PER_ADDRESS = 3;

/** How long a link works: half an hour, once. */
export const RETURNING_LINK_SECONDS = 1800;

const linkKey = (token: string) => `nl:rcode:link:${createHash("sha256").update(`nimbus-rcode:${token}`).digest("hex").slice(0, 40)}`;

/** What a link holds: the store, the product, the code and the address it was sent to. Exactly this shape. */
type LinkRecord = { s: string; p: string; c: string; e: string };

export type ReturningAsk = "sent" | "code" | "email" | "unknown" | "busy";

/**
 * The code and the email the buyer typed: refused when the code is not the
 * store's or has ended, or the email is not one; otherwise "sent", the same
 * for every address, with the check and any email done after the answer.
 */
export async function requestReturningLink(input: { store: Store; productId: string; productTitle: string; code: string; email: string; origin: string }): Promise<ReturningAsk> {
  const { store } = input;
  const code = returningCodeFor(store.returningCodes, input.code, Math.floor(Date.now() / 1000));
  if (!code) return "code";
  const email = normaliseEmail(input.email.slice(0, MAX_EMAIL_LENGTH + 1));
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return "email";
  if (!store.stripeAccountId || !isRedisConfigured()) return "unknown";
  // Per address too: whoever tries, one address is sent at most a few links an hour.
  if (!(await withinLimit("returning-code-address", `${store.handle}|${email}`, RETURNING_LINKS_PER_ADDRESS, 3600))) return "busy";
  // The ceiling before the spend: no room this month is unknown, the same for every address.
  if (!(await takeBuyerRead(store, RETURNING_CODE_REQUEST_UNITS).catch(() => false))) return "unknown";
  // Read as typed and as kept here (paidHere tries both); kept and sent to the address as kept here.
  const typed = input.email.trim().slice(0, MAX_EMAIL_LENGTH);
  later(() => sendReturningLink(store, input.productId, input.productTitle, code, email, input.origin, sendEmail, typed));
  return "sent";
}

/** Runs after the answer, so how long the answer takes tells nothing either; at once when there is no request. */
function later(task: () => Promise<void>): void {
  const run = () =>
    task().catch((error) => {
      console.error("a returning-buyer code link could not be sent", error);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}

/** Emails the link only when the address paid for an order here before; anything unknown sends nothing. */
export async function sendReturningLink(store: Store, productId: string, productTitle: string, code: ReturningCode, email: string, origin: string, send: typeof sendEmail = sendEmail, typed = email): Promise<void> {
  if ((await paidHere(store, typed)) !== true) return;
  const token = randomBytes(32).toString("hex");
  const record: LinkRecord = { s: store.handle, p: productId, c: code.code, e: email };
  // Only a SET answered exactly "OK" is a link (CX-123 rule 24): anything else emails nothing.
  const written = repliesFor(await redisPipeline([["SET", linkKey(token), JSON.stringify(record), "EX", RETURNING_LINK_SECONDS]]), 1);
  if (!written || written[0] !== "OK") throw new Error("a returning-buyer code link was not confirmed written");
  const words = returningLinkWords(store.language);
  const link = `${origin}/@${store.handle}/p/${encodeURIComponent(productId)}?rtoken=${token}#returning`;
  const sent = await send({
    meter: { by: "store", store, kind: "transactional" },
    from: `"${words.from(displayName(store.name))}" <${senderAddress()}>`,
    to: email,
    subject: words.subject(store.name),
    text: [words.intro(store.name, code.code, productTitle), "", link, "", words.note, "", words.ignore].join("\n"),
  });
  if (!sent) console.error("a returning-buyer code link could not be emailed");
}

/**
 * The link a buyer opened: its record is read, and spent (spendReturningLink)
 * only once the checkout it opens exists, so a buyer who goes back from
 * Stripe's page, or is sent back for a box, can press buy again. Refused
 * ("link") when it is gone, not in its exact shape, or for another store or
 * product; refused ("code") when its code has since been stopped or ended.
 * Whoever holds it can only open a checkout for the address it was sent to.
 */
export async function redeemReturningLink(store: Store, productId: string, rawToken: string, now = Date.now()): Promise<{ ok: true; code: ReturningCode; email: string } | { ok: false; reason: "link" | "code" | "unknown" }> {
  const token = readLinkToken(rawToken);
  if (!token) return { ok: false, reason: "link" };
  if (!isRedisConfigured()) return { ok: false, reason: "unknown" };
  let raw: unknown;
  try {
    const replies = repliesFor(await redisPipeline([["GET", linkKey(token)]]), 1);
    if (!replies) return { ok: false, reason: "unknown" };
    raw = replies[0];
  } catch {
    return { ok: false, reason: "unknown" };
  }
  if (raw === null) return { ok: false, reason: "link" };
  const record = readRecord(raw);
  if (!record || record.s !== store.handle || record.p !== productId) return { ok: false, reason: "link" };
  const code = returningCodeFor(store.returningCodes, record.c, Math.floor(now / 1000));
  if (!code) return { ok: false, reason: "code" };
  return { ok: true, code, email: record.e };
}

/** Spends a link once its checkout is open; a failure is only logged, the link then runs out by itself within half an hour. */
export async function spendReturningLink(rawToken: string): Promise<void> {
  const token = readLinkToken(rawToken);
  if (!token) return;
  await redisPipeline([["DEL", linkKey(token)]]).catch((error) => console.error("spending a returning-buyer code link failed; it runs out by itself", error));
}

function readRecord(raw: unknown): LinkRecord | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!plainObject(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 4 || keys.join(",") !== "s,p,c,e") return null;
  const { s, p, c, e } = parsed as Record<string, unknown>;
  if (typeof s !== "string" || typeof p !== "string" || typeof c !== "string" || typeof e !== "string") return null;
  if (!EMAIL_PATTERN.test(e) || JSON.stringify({ s, p, c, e }) !== raw) return null;
  return { s, p, c, e };
}

const SESSION_STATUSES = new Set(["open", "complete", "expired"]);

/** Whether this completed checkout of this store was paid for real: more than nothing, and a one-time charge neither refunded nor disputed. */
function paidRow(row: Record<string, unknown>, handles: Set<string>): boolean {
  const meta = ownField(row, "metadata");
  if (!plainObject(meta) || typeof meta.store !== "string" || !handles.has(meta.store)) return false;
  if (ownField(row, "status") !== "complete" || ownField(row, "payment_status") !== "paid") return false;
  const total = ownField(row, "amount_total");
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0) return false;
  const mode = ownField(row, "mode");
  if (mode === "subscription") return true;
  if (mode !== "payment") return false;
  const intent = ownField(row, "payment_intent");
  if (!plainObject(intent) || ownField(intent, "status") !== "succeeded") return false;
  const charge = ownField(intent, "latest_charge");
  return plainObject(charge) && ownField(charge, "refunded") === false && ownField(charge, "amount_refunded") === 0 && ownField(charge, "disputed") === false;
}

/**
 * Whether this address paid for an order in this store before: true on the
 * first such order found, false only when every list was read to its end
 * with every row readable and none was one, null otherwise (unknown is
 * never a discount). Read as typed and as kept here, like ownedHere.
 */
export async function paidHere(store: Store, email: string): Promise<boolean | null> {
  const account = store.stripeAccountId;
  if (!account || !email) return null;
  const handles = saleHandles(store);
  let unsure = false;
  try {
    for (const variant of [...new Set([email.trim(), normaliseEmail(email)])]) {
      const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100", "expand[]": "data.payment_intent.latest_charge" });
      const listed = readStripePage(await onAccount("GET", account, `/checkout/sessions?${query}`), (row) => SESSION_STATUSES.has(String(ownField(row, "status"))));
      if (listed.rows.some((row) => paidRow(row, handles))) return true;
      if (listed.hasMore || listed.unreadable > 0) unsure = true;
    }
    // A purchase the creator brought over is one the creator says was paid.
    if ((await importedFor(store, email)).length > 0) return true;
  } catch (error) {
    console.error("reading whether an address paid here failed", error);
    return null;
  }
  return unsure ? null : false;
}
