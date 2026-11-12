/**
 * What is left to pay in person, said after paying (520 [LB1], unit 5b-1;
 * the owner's decision of 2 November 2026, 13h53 Fortaleza: the rest appears
 * on Stripe's page, in the confirmation, in the email and in the creator's
 * orders, so nobody pays or charges too much). Checked:
 *
 *   - the sale's note of the rest and of a code is read strictly, and
 *     anything not as callCheckoutBody writes it is not said;
 *   - the buyer's confirmation email says the code, what it took off the
 *     whole price and the rest, with the same sentences as Stripe's page, in
 *     the store's language; the creator's email says the code, the deposit
 *     paid and the rest to collect in person;
 *   - a confirmation not handed the rest reads it from the sale, so neither
 *     email leaves it out; an online call is never read for it;
 *   - every path that confirms a booking hands it on, and the thanks page
 *     shows it under the address;
 *   - the booking page says the rest before paying and its button says the
 *     deposit, not the whole price; the reminder of an abandoned checkout
 *     says it too.
 */
import { readFileSync } from "node:fs";
import { creatorDueLine, dueLines, readDue } from "@/lib/call-deposit";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { confirmBooking, type CallListing } from "@/lib/calls";
import { bookingWords } from "@/lib/buyer-words/booking";
import { LANGUAGE_CODES, LANGUAGES } from "@/lib/store-language";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

const emails: { to: string; text: string }[] = [];
const reads: string[] = [];
let sale: Record<string, unknown> = {};
let stripeDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    emails.push({ to: String(Array.isArray(sent.to) ? sent.to[0] : sent.to), text: sent.text ?? "" });
    return answer({ id: "e" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "GET" && /^\/checkout\/sessions\/cs_test_/.test(path)) {
    reads.push(path);
    return stripeDown ? answer({ error: { message: "down" } }, 500) : answer(sale);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_deposit_rest_only";
  process.env.RESEND_API_KEY = "re_test_deposit_rest_only";

  part("The sale's note, read strictly");
  is(
    "the rest, and a code with what it took off",
    [readDue({ rest: "4000", code: "SPRING", code_off: "2000" }), readDue({ rest: "6000" }), readDue({ code: "SPRING", code_off: "7000" }), readDue({ code: "spring", code_off: "7000" })],
    [{ rest: 4000, code: "SPRING", codeOff: 2000 }, { rest: 6000, code: null, codeOff: 0 }, { rest: 0, code: "SPRING", codeOff: 7000 }, { rest: 0, code: "spring", codeOff: 7000 }],
  );
  is(
    "nothing, or anything not as the checkout writes it, is not said",
    [readDue({}), readDue(null), readDue({ rest: "0" }), readDue({ rest: "-5" }), readDue({ rest: "40.5" }), readDue({ rest: "04000" }), readDue({ code: "SPRING" }), readDue({ code: "spring!", code_off: "2000" }), readDue({ code: "SPRING", code_off: "abc" })],
    Array(9).fill(null),
  );

  part("The sentences");
  const b = bookingWords("en");
  const words = { currency: "usd", locale: "en-US", storeName: "Bela Studio" };
  is(
    "the same as Stripe's page: the code, then the rest, to whom",
    dueLines(b, { rest: 4000, code: "SPRING", codeOff: 2000 }, words),
    ["Code SPRING: $20 off the whole price.", "A deposit to hold your time. The rest, $40, is paid in person to Bela Studio."],
  );
  is("nothing when there is nothing", dueLines(b, null, words), []);
  is(
    "in every language, with the amounts",
    LANGUAGE_CODES.map((code) => {
      const lines = dueLines(bookingWords(code), { rest: 4000, code: "SPRING", codeOff: 2000 }, { currency: "eur", locale: LANGUAGES[code].locale, storeName: "Bela" });
      return [code, lines.length, lines[0].includes("SPRING") && lines[0].includes("20"), lines[1].includes("40") && lines[1].includes("Bela")];
    }),
    LANGUAGE_CODES.map((code) => [code, 2, true, true]),
  );
  is(
    "the creator's: the code, the deposit paid now and the rest to collect in person",
    [creatorDueLine({ rest: 4000, code: "SPRING", codeOff: 2000 }, { paidCents: 2000, currency: "usd" }), creatorDueLine({ rest: 6000, code: null, codeOff: 0 }, { paidCents: 2000, currency: "usd" }), creatorDueLine({ rest: 0, code: "SPRING", codeOff: 7000 }, { paidCents: 1000, currency: "usd" }), creatorDueLine(null, { paidCents: 2000, currency: "usd" })],
    [
      "They used code SPRING: $20 off the whole price. $20 was paid now as a deposit. The rest, $40, is paid to you in person.",
      "$20 was paid now as a deposit. The rest, $60, is paid to you in person.",
      "They used code SPRING: $70 off the whole price.",
      "",
    ],
  );

  part("The emails after paying");
  const OWNER = "bela@example.com";
  await claimHandle(OWNER, "bela", "Bela Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBela00001", true);
  await setSubscription(OWNER, { customerId: "cus_bela00001", subscriptionId: "sub_bela00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Haircut", "", "80", null);
  if (!made.ok) throw new Error("no product");
  const setup = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, sessions: [], place: "Bela Studio\n12 Harbor Street", deposit: 2000 };
  is("the setup keeps the deposit", (readSetup(setup) as CallSetup).deposit, 2000);
  await setProductCall(OWNER, made.product.id, setup as unknown as CallSetup);
  const store = (await storeForEmail(OWNER)) as Store;
  const listing = (await readListing(store, made.product.id)) as CallListing;
  const at = weekdayAt(3, 600);
  const confirm = (session: string, due?: Parameters<typeof confirmBooking>[0]["due"]) =>
    confirmBooking({ store, product: listing, session, start: at, end: at + 3_600_000, buyerEmail: "ana@example.com", buyerTz: NY, amountCents: 2000, currency: "usd", origin: "https://marktmorgen.com", ...(due === undefined ? {} : { due, cancel: null }) });

  emails.length = 0;
  reads.length = 0;
  await confirm("cs_test_rest000000000001", { rest: 4000, code: "SPRING", codeOff: 2000 });
  const toBuyer = emails.find((e) => e.to === "ana@example.com")?.text ?? "";
  const toCreator = emails.find((e) => e.to !== "ana@example.com")?.text ?? "";
  is(
    "the buyer is told the code and the rest, under where",
    [toBuyer.includes("Where: Bela Studio, 12 Harbor Street\nCode SPRING: $20 off the whole price.\nA deposit to hold your time. The rest, $40, is paid in person to Bela Studio.")],
    [true],
  );
  is("the creator is told the code, the deposit and the rest to collect", toCreator.includes("In person, at: Bela Studio, 12 Harbor Street\nThey used code SPRING: $20 off the whole price. $20 was paid now as a deposit. The rest, $40, is paid to you in person."), true);
  is("handed the rest, the sale is not read again", reads.length, 0);

  emails.length = 0;
  sale = {
    id: "cs_test_rest000000000002",
    status: "complete",
    payment_status: "paid",
    amount_total: 2000,
    currency: "usd",
    metadata: { kind: "call", store: "bela", product: listing.id, start: String(at), end: String(at + 3_600_000), tz: NY, deposit: "2000", rest: "6000" },
  };
  await confirm("cs_test_rest000000000002");
  is(
    "not handed it, the rest is read from the sale, so neither email leaves it out",
    [reads.length, (emails.find((e) => e.to === "ana@example.com")?.text ?? "").includes("The rest, $60, is paid in person to Bela Studio."), (emails.find((e) => e.to !== "ana@example.com")?.text ?? "").includes("The rest, $60, is paid to you in person.")],
    [1, true, true],
  );
  emails.length = 0;
  sale = { id: "cs_test_rest000000000003", status: "complete", payment_status: "paid", metadata: { kind: "call", store: "bela", product: listing.id, start: String(at), end: String(at + 3_600_000) } };
  await confirm("cs_test_rest000000000003", null);
  is("with nothing left, nothing is said", /The rest|deposit/.test(emails.map((e) => e.text).join("\n")), false);

  emails.length = 0;
  reads.length = 0;
  stripeDown = true;
  const origError = console.error;
  console.error = () => {};
  await confirm("cs_test_rest000000000004");
  console.error = origError;
  stripeDown = false;
  is("a failed read sends nothing and marks nothing, so the booking is confirmed later", [reads.length, emails.length], [1, 0]);
  await confirm("cs_test_rest000000000004", { rest: 6000, code: null, codeOff: 0 });
  is("and the next confirmation, which carries the rest, sends both emails with it", [emails.length, emails.every((e) => /The rest, \$60, is paid/.test(e.text))], [2, true]);

  part("Every path hands it on, and the pages say it");
  const calls = readFileSync("lib/calls.ts", "utf8");
  is("the sale's note is read with every paid booking", calls.includes("    due: readDue(meta),\n"), true);
  is("the booking catch-up and the daily job hand it to the confirmation", [calls.includes("      due: call.due,\n      cancel: call.cancel,\n      origin,\n    }).catch((error) => console.error(\"catching up a booking failed\""), readFileSync("lib/call-reminders.ts", "utf8").includes("              due: call.due,\n")], [true, true]);
  is(
    "only an in-person booking is read for it, before the once-only mark",
    [calls.includes('const needDue = due === undefined && whereOf(product.call).kind === "place";'), calls.indexOf("const sale = await paidCall(store, session);") < calls.indexOf('const [fresh] = await orderWrite(store, [["SET", confirmedKey(session)')],
    [true, true],
  );
  const thanks = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  is(
    "the thanks page reads the sale for every paid call, hands the rest and the promise on, and shows the rest under the address",
    [thanks.includes("sessionId && order.state === \"paid\" && order.call\n      ? await paidCall(store, sessionId)"), thanks.includes("      due,\n      cancel,\n      origin: SITE_URL,"), thanks.indexOf("data-call-due") > thanks.indexOf("data-call-place")],
    [true, true, true],
  );
  const book = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
  is(
    "the booking page says the rest before paying, and its button the deposit",
    [book.includes("{deposit ? <p className=\"mt-2 text-sm\" data-call-due=\"\">{b.depositRest(money(deposit.rest), store.name)}</p> : null}"), book.includes("const payNow = deposit ? money(deposit.cents) : price;"), (book.match(/Words\(store, b, [^,]+, payNow, false/g) ?? []).length],
    [true, true, 2],
  );
  is("never for a session from a package", book.includes("const due = fromPackage ? null : chargeNow("), true);
  const recovery = readFileSync("lib/checkout-recovery.ts", "utf8");
  is("the reminder of an abandoned checkout says the rest, at today's price", recovery.includes("const deposit = due.rest > 0 ? [bookingWords(store.language).depositRest(money(due.rest), store.name)] : [];") && recovery.includes("g.recoverPrice(price), ...deposit,") && recovery.includes(": lengths.length ? w.fromPrice(money(fromPrice(lengths) as number)) : money(product.priceCents);"), true);

  done();
}

void main();
