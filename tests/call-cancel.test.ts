/**
 * The creator's cancellation deadline (520 [LB1], unit 7a; lib/call-setup.ts
 * cancelHours, lib/calls.ts, the booking page and the studio's call editor;
 * added 2 November 2026). Checked:
 *
 *   - the setup keeps a deadline from the list, for weekly hours and dated
 *     sessions, online and in person; none is no field; anything else
 *     refuses the setup;
 *   - Stripe's page says it before paying, after the deposit's sentence when
 *     there is one, never for a session from a package;
 *   - the buyer's confirmation says it, and the creator's email says what the
 *     buyer was told and that the refund is theirs to make; a session from a
 *     package says neither;
 *   - the booking page and the editor carry it (read in their source), and
 *     every language says it with the hours.
 */
import { readFileSync } from "node:fs";
import { CANCEL_HOURS, readCancelPromise, readSetup, zonedToUtc, type CallSetup } from "@/lib/call-setup";
import { callCheckoutBody, confirmBooking, creatorCancelLine, type CallListing } from "@/lib/calls";
import { bookingWords } from "@/lib/buyer-words/booking";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Product, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: { to: string; text: string }[] = [];
let sale: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    emails.push({ to: String(Array.isArray(sent.to) ? sent.to[0] : sent.to), text: sent.text ?? "" });
    return answer({ id: "e" });
  }
  if ((init?.method ?? "GET") === "GET" && /^\/v1\/checkout\/sessions\/cs_test_/.test(url.pathname)) return answer(sale);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, room: "https://example.com/room", video: false, meet: null };

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * 86_400_000);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_call_cancel_only";
  process.env.RESEND_API_KEY = "re_test_call_cancel_only";

  part("The setup");
  const start = Math.floor((Date.now() + 10 * 86_400_000) / 60_000) * 60_000;
  const live = (patch: Record<string, unknown>) => readSetup({ kind: "live", tz: NY, noticeHours: 1, sessions: [{ id: "s1", start, minutes: 60, seats: 6 }], ...patch });
  is(
    "a deadline from the list is kept: weekly and dated sessions, online and in person",
    [(readSetup({ ...weekly, cancelHours: 24 }) as CallSetup).cancelHours, (readSetup({ ...weekly, place: ["Bela Studio"], cancelHours: 48 }) as CallSetup).cancelHours, (live({ cancelHours: 12 }) as CallSetup).cancelHours, (live({ place: ["Bela Studio"], cancelHours: 72 }) as CallSetup).cancelHours],
    [24, 48, 12, 72],
  );
  is("none, null or zero is no field at all", [readSetup(weekly), readSetup({ ...weekly, cancelHours: null }), readSetup({ ...weekly, cancelHours: 0 }), live({})].map((s) => "cancelHours" in (s as CallSetup)), [false, false, false, false]);
  is("anything else refuses the setup", [5, "24", -2, 24.5, true].map((cancelHours) => readSetup({ ...weekly, cancelHours })).concat([live({ cancelHours: 6 })]), Array(6).fill("cancel"));
  is("the list", [...CANCEL_HOURS], [2, 12, 24, 48, 72]);

  part("Stripe's page, before paying");
  const store = { handle: "bela", name: "Bela Studio", language: "en", currency: "usd", hasDiscounts: false, tax: { enabled: false, included: false, ids: false, invoices: false } } as unknown as Store;
  const product = (call: CallSetup) => ({ id: "p1", title: "Haircut", summary: "A cut and a wash.", priceCents: 8000, call, fields: [] }) as unknown as Product;
  const body = (call: CallSetup, at = start, pkg: { id: string; coupon: string; email: string; back: string } | null = null) =>
    callCheckoutBody({ store, product: product(call), start: at, end: at + 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", via: null, fromPackage: pkg });
  const describe = (b: URLSearchParams) => b.get("line_items[0][price_data][product_data][description]");
  const policy = "Cancel at least 24 hours before the start, by replying to your confirmation email, and Bela Studio refunds what you paid online. If you cancel later or miss it, Bela Studio does not have to refund it. If Bela Studio cancels, you get it all back. This does not affect your rights under the law.";
  const tooLate = "This time starts in less than 24 hours, so if you cancel or miss it, Bela Studio does not have to refund what you paid online. If Bela Studio cancels, you get it all back. This does not affect your rights under the law.";
  const ahead = body(readSetup({ ...weekly, cancelHours: 24 }) as CallSetup);
  is("the deadline after the creator's summary, and the promise kept on the sale", [describe(ahead), ahead.get("metadata[cancel_hours]"), ahead.get("metadata[cancel_late]")], [`A cut and a wash. \u2014 ${policy}`, "24", null]);
  const soon = body(readSetup({ ...weekly, cancelHours: 24 }) as CallSetup, Math.floor((Date.now() + 5 * 3_600_000) / 60_000) * 60_000);
  is("a time already inside the deadline is told so, never promised a refund", [describe(soon), soon.get("metadata[cancel_late]")], [`A cut and a wash. \u2014 ${tooLate}`, "1"]);
  is(
    "after the deposit's sentence when there is one, within Stripe's 500 characters",
    [describe(body(readSetup({ ...weekly, place: ["Bela Studio"], deposit: 2000, cancelHours: 24 }) as CallSetup)), (describe(body(readSetup({ ...weekly, place: ["Bela Studio"], deposit: 2000, cancelHours: 24 }) as CallSetup)) ?? "").length <= 500],
    [`A cut and a wash. \u2014 A deposit to hold your time. The rest, $60, is paid in person to Bela Studio. ${policy}`, true],
  );
  const pkgBody = body(readSetup({ ...weekly, cancelHours: 24 }) as CallSetup, start, { id: "pkg1", coupon: "cpn_x", email: "ana@example.com", back: "https://marktmorgen.com/x" });
  is("never for a session from a package, which pays nothing here", [describe(pkgBody), pkgBody.get("metadata[cancel_hours]")], ["A cut and a wash.", null]);
  is("and nothing new without a deadline", [describe(body(readSetup(weekly) as CallSetup)), body(readSetup(weekly) as CallSetup).get("metadata[cancel_hours]")], ["A cut and a wash.", null]);

  part("The promise, read from the sale");
  is(
    "as kept; anything else is no promise",
    [readCancelPromise({ cancel_hours: "24" }), readCancelPromise({ cancel_hours: "24", cancel_late: "1" }), readCancelPromise({ cancel_hours: "5" }), readCancelPromise({ cancel_hours: "024" }), readCancelPromise({}), readCancelPromise(null)],
    [{ hours: 24, late: false }, { hours: 24, late: true }, null, null, null, null],
  );

  part("The emails after paying");
  const OWNER = "bela@example.com";
  await claimHandle(OWNER, "bela", "Bela Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBela00001", true);
  await setSubscription(OWNER, { customerId: "cus_bela00001", subscriptionId: "sub_bela00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Haircut", "", "80", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, { ...weekly, cancelHours: 24 } as unknown as CallSetup);
  const shop = (await storeForEmail(OWNER)) as Store;
  const listing = (await readListing(shop, made.product.id)) as CallListing;
  is("the product record keeps it", listing.call.cancelHours, 24);
  const at = weekdayAt(3, 600);
  const confirm = (session: string, cancel?: { hours: number; late: boolean } | null) =>
    confirmBooking({ store: shop, product: listing, session, start: at, end: at + 3_600_000, buyerEmail: "ana@example.com", buyerTz: NY, amountCents: 8000, currency: "usd", origin: "https://marktmorgen.com", ...(cancel === undefined ? {} : { cancel }) });
  emails.length = 0;
  await confirm("cs_test_cancel00000000001", { hours: 24, late: false });
  const buyer = emails.find((e) => e.to === "ana@example.com")?.text ?? "";
  const creator = emails.find((e) => e.to !== "ana@example.com")?.text ?? "";
  is("the buyer's confirmation says it, under how to cancel", buyer.includes(`To cancel, reply to this email; the reply goes to Bela Studio.\n${policy}`), true);
  is(
    "the creator is told what the buyer was told, and who makes the refund",
    creator.includes("They were told: cancel at least 24 hours before, by replying, and what they paid online is refunded; if they cancel later or miss it, it does not have to be; if the store cancels, they get it all back. You make a refund in your Stripe dashboard."),
    true,
  );
  emails.length = 0;
  sale = { id: "cs_test_cancel00000000002", status: "complete", payment_status: "paid", metadata: { kind: "call", store: "bela", product: listing.id, start: String(at), end: String(at + 3_600_000), cancel_hours: "72" } };
  await confirm("cs_test_cancel00000000002");
  is(
    "not handed it, the promise is read from the sale: 72 hours as paid, though the product now says 24",
    (emails.find((e) => e.to === "ana@example.com")?.text ?? "").includes("Cancel at least 72 hours before the start"),
    true,
  );
  emails.length = 0;
  sale = { id: "cs_test_cancel00000000005", status: "complete", payment_status: "paid", metadata: { kind: "call", store: "bela", product: listing.id, start: String(at), end: String(at + 3_600_000), cancel_hours: "48" } };
  const turnedOff = { ...listing, call: { ...listing.call, cancelHours: undefined } } as CallListing;
  await confirmBooking({ store: shop, product: turnedOff, session: "cs_test_cancel00000000005", start: at, end: at + 3_600_000, buyerEmail: "ana@example.com", buyerTz: NY, amountCents: 8000, currency: "usd", origin: "https://marktmorgen.com" });
  is(
    "a deadline the creator turned off after the sale is still said: the promise is the sale's, never the product's as it is now",
    [(emails.find((e) => e.to === "ana@example.com")?.text ?? "").includes("Cancel at least 48 hours before the start"), (emails.find((e) => e.to !== "ana@example.com")?.text ?? "").includes("They were told: cancel at least 48 hours before")],
    [true, true],
  );
  emails.length = 0;
  await confirm("cs_test_cancel00000000003", { hours: 24, late: true });
  is("a time booked inside the deadline is told so after paying too", [(emails.find((e) => e.to === "ana@example.com")?.text ?? "").includes(tooLate), (emails.find((e) => e.to !== "ana@example.com")?.text ?? "").includes("within the 24-hour cancellation deadline")], [true, true]);
  emails.length = 0;
  sale = { id: "cs_test_cancel00000000004", status: "complete", payment_status: "paid", metadata: { kind: "call", store: "bela", product: listing.id, start: String(at), end: String(at + 3_600_000), package: "pkg1" } };
  await confirm("cs_test_cancel00000000004");
  is("a session from a package, whose sale promises nothing, says nothing", emails.some((e) => /cancel at least|Cancel at least|cancellation deadline/.test(e.text)), false);
  is("the team's host is told the store's owner makes the refund", creatorCancelLine({ hours: 24, late: false }, false).endsWith("A refund is made by the store's owner, in their Stripe dashboard."), true);

  part("The booking page and the editor");
  const page = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
  is("the booking page says it before paying, never for a session from a package", page.includes('{setup.cancelHours && !fromPackage ? <p className="mt-2 text-sm" data-call-cancel="">{b.cancelPolicy(setup.cancelHours, store.name)}</p> : null}'), true);
  const editor = readFileSync("components/call-editor.tsx", "utf8");
  is(
    "the editor offers it for weekly hours and dated sessions, with its help tied to it, and sends it only when set",
    [(editor.match(/<CancelChoice value=\{draft\.cancelHours\}/g) ?? []).length, (editor.match(/\.\.\.\(draft\.cancelHours \? \{ cancelHours: draft\.cancelHours \} : \{\}\)/g) ?? []).length, editor.includes('<label htmlFor={id} className="field-label">Cancellation deadline</label>') && editor.includes("aria-describedby={help}"), editor.includes("cancelHours: setup.cancelHours ?? 0,")],
    [2, 2, true, true],
  );
  is("the studio says what the problem means", editor.includes('cancel: "Pick a cancellation deadline from the list, or none.",'), true);

  part("In every language");
  is(
    "each says the deadline with its hours",
    LANGUAGE_CODES.map((code) => [code, bookingWords(code).cancelPolicy(48, "Bela").includes("48") && bookingWords(code).cancelTooLate(48, "Bela").includes("Bela")]),
    LANGUAGE_CODES.map((code) => [code, true]),
  );

  done();
}

void main();
