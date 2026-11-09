/**
 * A PayPal sale refunded in part (audit R13, MEDIUM 2). The refund watch
 * (lib/paypal-sales.ts, watchPayPal) wrote down only a capture REFUNDED; a
 * capture PARTIALLY_REFUNDED was rescheduled as if nothing had been given
 * back, so the affiliate book paid the whole commission on money the creator
 * had returned (US$49 at 30% with US$24.50 back: 1470 cents instead of 735),
 * and the store's numbers and the buyer ledger counted the whole sale as kept.
 *
 * What PayPal refunded is not read anywhere in this repository: the watch
 * reads only the capture's status (GET /v2/payments/captures/{id}). So the
 * amount of a partial refund is unknown, and unknown is never zero (CX-123
 * rule 24): the partial refund is written down as a mark beside the refunds
 * in full (same key, same reading, same cost count), and every reader of
 * PayPal's refunds then says its reading is not whole, so no number says
 * "after refunds" without it. In the affiliate book the hold is by sale (the
 * coordinator's review, 9 November 2026): that sale's commission, and a
 * second tier on it, are held out of every payment, shown as held on the
 * creator's list, the affiliate's page and the spreadsheet, and the rest of
 * the book stays checked and payable. Only a mark whose payment cannot be
 * named leaves the whole book unchecked (unknown is never payable). A later
 * refund in full supersedes it with its known amount, counted once. Access
 * and the hand-over are untouched: a partial refund keeps the purchase.
 *
 * Synthetic only: the Redis stub and a stand-in for PayPal's API, answering
 * only the token and the capture's status, the one field the code reads.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Affiliate, type Line, addPayout, bookCsv, creditPayPalSale, bookSize, readBook, tierLines } from "@/lib/affiliates";
import { buyerLedger } from "@/lib/segments";
import { AffiliateCommissionHistory } from "@/components/affiliate-commission-history";
import { AFFILIATES_WORDS } from "@/lib/buyer-words/affiliates";
import * as commissionView from "@/lib/affiliate-commission-view";
import { HELP_SECTIONS } from "@/lib/help-content";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { readPayPalRefundsWithCoverage, refundSeen, type Paid, watchPayPal } from "@/lib/paypal-sales";
import { payableLines } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
// Forty days old: the watch's next look is a day away (nextLook), so "looked at again in an hour" is told apart.
const PAID_AT = NOW - 40 * 86_400;
const SID = "synthetic-partial-refund";
const AFF = "aaaaaaaaaaaa";
const ORDER = "5O190127TN3647102";
const CAPTURE = "3C679366HH908702";
const OTHER_ORDER = "6O190127TN3647106";
const OTHER_CAPTURE = "4C679366HH908706";
const SELLER = "7KNGBPH2U58GQ";

process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
delete process.env.PAYPAL_ENV;

const captures = new Map<string, string>();
let captureReads = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap) {
    captureReads += 1;
    return json({ id: cap, status: captures.get(cap) ?? "COMPLETED" });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const store = {
  sid: "synthetic-partial-store",
  statsId: SID,
  handle: "synthetic-partial-shop",
  name: "Synthetic shop",
  email: "owner@example.com",
  currency: "usd",
  previousHandles: [],
  releasedHandles: [],
  paypalSeller: { merchant: SELLER, at: 1 },
  affiliates: { ...NO_AFFILIATES, enabled: true, percent: 30, hold: 0 },
} as unknown as Store;

const paid: Paid = { store: SID, order: ORDER, capture: CAPTURE, email: "buyer@example.com", product: "course", cents: 4900, currency: "usd", at: PAID_AT, via: { aff: AFF, rate: 30 } } as Paid;
const other: Paid = { ...paid, order: OTHER_ORDER, capture: OTHER_CAPTURE, email: "other@example.com", via: undefined } as Paid;

const on = { handOver: async () => undefined, dropStart: async () => undefined };
const watch = () => watchPayPal(store, Date.now() + 10_000, on);

/** The affiliate, the PayPal sale on the book with its paid record, and the order due on the refund watch. */
async function setup(): Promise<void> {
  redis.clear();
  captures.clear();
  await redis.pipeline([["HSET", `nl:aff:${SID}:people`, AFF, JSON.stringify({ id: AFF, email: "affiliate@example.com", code: "synthetic", status: "approved", appliedAt: 1, decidedAt: 1, note: "" })]]);
  await creditPayPalSale(store, paid, "Synthetic course");
  await redis.pipeline([
    ["SET", `nl:ppsell:paid:${ORDER}`, JSON.stringify(paid)],
    ["ZADD", `nl:ppsell:watch:${SID}`, "0", ORDER],
  ]);
}

async function offered(): Promise<{ checked: boolean; through: number }> {
  const book = await readBook(store);
  const cents = payableLines(book, new Set()).reduce((sum, line) => sum + line.cents, 0);
  return { checked: book.refundsChecked, through: book.refundsChecked ? cents : 0 };
}

const watchScore = async (order: string) => (await redis.pipeline([["ZSCORE", `nl:ppsell:watch:${SID}`, order]]))[0];
/** Moves the payouts written (to `payoutsAt`, seconds) and the partial-refund mark (to `markAt`) back in time. */
async function backdate(payoutsAt: number | null, markAt: number): Promise<void> {
  if (payoutsAt !== null) {
    const [flat] = await redis.pipeline([["HGETALL", `nl:aff:${SID}:payouts`]]);
    const list = Array.isArray(flat) ? (flat as string[]) : [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      await redis.pipeline([["HSET", `nl:aff:${SID}:payouts`, list[i], JSON.stringify({ ...JSON.parse(list[i + 1]), at: payoutsAt * 1000 })]]);
    }
  }
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${SID}`, "XX", String(markAt), `part:${ORDER}`]]);
}
const marks = async () => Number((await redis.pipeline([["ZCARD", `nl:ppsell:refunded:${SID}`]]))[0]);

async function main(): Promise<void> {
  console.error = () => {};

  part("Control: a sale PayPal reports COMPLETED pays its whole commission");
  await setup();
  captures.set(CAPTURE, "COMPLETED");
  await watch();
  const healthy = await offered();
  is("the book is checked", healthy.checked, true);
  is("30% of US$49 offered", healthy.through, 1470);

  part("A sale refunded in part: its commission is held, never paid whole");
  await setup();
  captures.set(CAPTURE, "PARTIALLY_REFUNDED");
  const watched = await watch();
  is("PayPal was asked for the capture", captureReads > 0, true);
  const partly = await offered();
  // The amount given back is not read anywhere (only the capture's status): unknown, never zero, so nothing is paid on
  // that sale. Rule 23: before the coordinator's review the whole book was left unchecked here (false); the hold is
  // now by sale, so the book stays checked and the sale alone is held.
  is("the book stays checked", partly.checked, true);
  is("no commission passes the refund guard", partly.through, 0);
  const heldBook = await readBook(store);
  const heldLine = heldBook.lines.find((l) => l.ref === `paypal:${ORDER}`);
  is("the line says held, not earned", heldLine?.status, "held");
  is("it earns nothing payable while held", heldLine?.commission, 0);
  is("the affiliate's row owes nothing for it", heldBook.rows[0]?.owed, 0);

  part("The creator and the affiliate are told it is held, and why");
  const csv = bookCsv(heldBook, heldBook.rows.map((r) => r.affiliate));
  const csvRow = csv.split("\n").find((row) => row.includes(`paypal:${ORDER}`)) ?? "";
  is("the spreadsheet says held, with the refund and the commission unknown, never 0.00", [csvRow.includes("held: partly refunded, amount unknown"), csvRow.includes("unknown,30,unknown"), csvRow.includes("0.00")], [true, true, false]);
  const studio = renderToStaticMarkup(createElement(AffiliateCommissionHistory, { who: new Map([[AFF, { email: "affiliate@example.com" }]]), refundsChecked: true, invoicesChecked: true, lines: heldBook.lines, total: heldBook.lines.length }));
  is("the creator's list says held, not an amount earned", [studio.includes("Held"), studio.includes("$0.00")], [true, false]);
  // Rule 23 (pre-review of 3b4b8ac4e1, MEDIUM 1): "It stays held" and "until ... known" promised a reading that never
  // happens; the words now say only what is true.
  is("and says why, promising nothing", studio.includes("PayPal refunded part of this payment. The amount refunded can&#x27;t be seen here, so this sale earns nothing."), true);
  is("the affiliate's page has the words in every language", Object.values(AFFILIATES_WORDS).every((w) => typeof w.lineStatus.held === "string" && w.lineStatus.held.length > 0), true);
  is("in English", AFFILIATES_WORDS.en.lineStatus.held, "held: partly refunded, amount unknown");

  part("The program's words say what happens to a PayPal sale refunded in part, in every language");
  // VR 2: "a partly refunded one earns on what was kept" is not true for a PayPal sale, which is held instead. Each of
  // the three places that promise it (the affiliate's terms, a partner share, a partner's invitation) says so.
  // Rule 23 (pre-review of 3b4b8ac4e1, MEDIUM 1): the sentence no longer says "until the amount refunded is known",
  // which never happens (the amount is not read, and the watch lets the order go after PayPal's 180 days).
  const paypalHeld: Record<string, string> = {
    en: "A sale paid with PayPal and partly refunded earns nothing, because the amount refunded can't be seen here.",
    es: "Una venta pagada con PayPal y reembolsada en parte no genera nada, porque aquí no se puede ver el importe reembolsado.",
    fr: "Une vente payée avec PayPal et partiellement remboursée ne rapporte rien, car le montant remboursé n'est pas visible ici.",
    de: "Ein mit PayPal bezahlter und teilweise erstatteter Verkauf bringt nichts ein, weil der erstattete Betrag hier nicht sichtbar ist.",
    it: "Una vendita pagata con PayPal e rimborsata in parte non fa guadagnare nulla, perché qui l'importo rimborsato non è visibile.",
    nl: "Een verkoop die met PayPal is betaald en gedeeltelijk is terugbetaald, levert niets op, omdat het terugbetaalde bedrag hier niet te zien is.",
    pt: "Uma venda paga com PayPal e parcialmente reembolsada não gera nada, porque o valor reembolsado não pode ser visto aqui.",
  };
  is("no language promises the amount will be known", Object.values(AFFILIATES_WORDS).every((w) => !w.termRefunds.includes("until the amount refunded is known") && !w.termRefunds.includes("known")), true);
  is("seven languages", Object.keys(AFFILIATES_WORDS).sort(), Object.keys(paypalHeld).sort());
  for (const [lang, w] of Object.entries(AFFILIATES_WORDS)) {
    const sentence = paypalHeld[lang];
    is(`${lang}: the terms, a partner share and a partner's invitation each say it`, [w.termRefunds.includes(sentence), w.partnerShare(10, "x").includes(sentence), w.partnerTerms(10).includes(sentence)], [true, true, true]);
  }
  const helpText = JSON.stringify(HELP_SECTIONS);
  is("the creator's help says it beside the Stripe rule", helpText.includes(`cancels it or reduces it. ${paypalHeld.en}`), true);

  part("The affiliate's page shows held in place of an amount, never $0.00");
  const shown = (commissionView as Record<string, unknown>).commissionShown as ((line: { status: string; commission: number; currency: string }, money: (c: number, cur: string) => string, held: string) => string) | undefined;
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  const heldWord = (w: unknown) => (w as { heldAmount?: unknown }).heldAmount;
  is("a held line shows the word for held", shown?.({ status: "held", commission: 0, currency: "usd" }, dollars, String(heldWord(AFFILIATES_WORDS.es))), "Retenida");
  is("an earned line shows its amount", shown?.({ status: "earned", commission: 1470, currency: "usd" }, dollars, "Held"), "$14.70");
  is("every language has the word", Object.values(AFFILIATES_WORDS).every((w) => typeof heldWord(w) === "string" && String(heldWord(w)).length > 0), true);
  const affiliatePage = readFileSync(join(process.cwd(), "app/[handle]/affiliates/page.tsx"), "utf8");
  is("the affiliate's page draws a sale's amount through it", affiliatePage.includes("commissionShown(line, money, a.heldAmount)"), true);

  part("A second tier on a held sale is held too, never paid in full");
  const recruit = { id: "bbbbbbbbbbbb", status: "approved", by: { id: AFF, percent: 10 } } as unknown as Affiliate;
  const inviter = { id: AFF, status: "approved", by: null } as unknown as Affiliate;
  const heldSale: Line = { ref: "paypal:x", pi: `paypal:${CAPTURE}`, aff: recruit.id, at: NOW, product: "", title: "", base: 4900, total: 4900, currency: "usd", rate: 30, self: false, how: "click", refunded: 0, commission: 0, status: "held" };
  // Called with a fourth argument (the store's statsId) through a wider type, so this line works with today's three
  // parameters and with claude5/affiliate-tier-self's four (pre-review LEVE 5): an extra argument is ignored by JS.
  const tiersOf = tierLines as unknown as (everyone: Affiliate[], lines: Line[], flags: Map<string, string[]>, statsId: string) => Line[];
  const tier = tiersOf([inviter, recruit], [heldSale], new Map<string, string[]>(), SID);
  is("one second-tier line, held, earning nothing payable", tier.map((l) => [l.how, l.status, l.commission]), [["tier2", "held", 0]]);
  part("A partial refund keeps the purchase");
  is("nothing taken back", watched.revoked, 0);
  is("not seen as a refund in full (the hand-over is not stopped)", await refundSeen(SID, ORDER), false);
  is("still watched, at its next look", Number(await watchScore(ORDER)) > NOW, true);

  part("The store's numbers and the buyer ledger read the same refunds: not whole");
  const read = await readPayPalRefundsWithCoverage(SID, 0);
  is("the reading says it is not whole", read.partial, true);
  is("no refund in full is invented for it", read.rows.length, 0);

  part("Its cost is counted before the book reads it");
  const size = await bookSize(store);
  is("the partial refund is one row counted beforehand", size?.rows, 1);

  part("Looked at again, it is written down once, and not written again");
  await redis.pipeline([["ZADD", `nl:ppsell:watch:${SID}`, "0", ORDER]]);
  const sent: string[] = [];
  const plain = redis.pipeline;
  redis.pipeline = async (commands) => {
    for (const command of commands) if (String(command[1]).startsWith("nl:ppsell:refunded:")) sent.push(String(command[0]));
    return plain.call(redis, commands);
  };
  try {
    await watch();
  } finally {
    redis.pipeline = plain;
  }
  is("one mark, not two", await marks(), 1);
  is("the later look only reads the mark: no ZADD, no EXPIRE", sent, ["ZSCORE"]);

  part("Then refunded in full: the known amount, counted once, and the book checked again");
  captures.set(CAPTURE, "REFUNDED");
  await redis.pipeline([["ZADD", `nl:ppsell:watch:${SID}`, "0", ORDER]]);
  await watch();
  const after = await readBook(store);
  const line = after.lines.find((l) => l.ref === `paypal:${ORDER}`);
  is("the book is checked", after.refundsChecked, true);
  is("refunded once, the sale's cents", line?.refunded, 4900);
  is("no commission", line?.commission, 0);
  is("the line says refunded", line?.status, "refunded");
  const whole = await readPayPalRefundsWithCoverage(SID, 0);
  is("the reading is whole again", whole.partial, false);
  is("one refund in full", whole.rows.map((r) => r.capture), [CAPTURE]);

  part("A commission paid before PayPal refunded part of the sale is not taken back from later sales");
  await setup();
  captures.set(CAPTURE, "COMPLETED");
  await watch();
  await addPayout(store, { aff: AFF, cents: 1470, currency: "usd", date: "2026-10-01", reference: "synthetic" });
  is("before: nothing owed", (await readBook(store)).rows[0]?.owed, 0);
  captures.set(CAPTURE, "PARTIALLY_REFUNDED");
  await redis.pipeline([["ZADD", `nl:ppsell:watch:${SID}`, "0", ORDER]]);
  await watch();
  // The payout written twenty minutes ago, the partial refund seen ten minutes ago: apart, not in the same second.
  await backdate(NOW - 1200, NOW - 600);
  const paidThenPartly = await readBook(store);
  const paidLine = paidThenPartly.lines.find((l) => l.ref === `paypal:${ORDER}`);
  is("the affiliate owes nothing back: no automatic deduction", paidThenPartly.rows[0]?.owed, 0);
  is("the line says paid, partly refunded", [paidLine?.status, paidLine?.commission], ["paid, partly refunded", 1470]);
  is("the affiliate's page has the words in every language", Object.values(AFFILIATES_WORDS).every((w) => typeof w.lineStatus["paid, partly refunded"] === "string"), true);
  is("in English", AFFILIATES_WORDS.en.lineStatus["paid, partly refunded"], "paid, partly refunded, amount unknown");
  const paidCsv = bookCsv(paidThenPartly, paidThenPartly.rows.map((r) => r.affiliate)).split("\n").find((row) => row.includes(`paypal:${ORDER}`)) ?? "";
  is("the spreadsheet says so, its refund unknown", [paidCsv.includes("paid, partly refunded, amount unknown"), paidCsv.includes("unknown,30,14.70")], [true, true]);
  const paidStudio = renderToStaticMarkup(createElement(AffiliateCommissionHistory, { who: new Map([[AFF, { email: "affiliate@example.com" }]]), refundsChecked: true, invoicesChecked: true, lines: paidThenPartly.lines, total: paidThenPartly.lines.length }));
  is("the creator's list says paid, partly refunded, and that nothing is taken back", [paidStudio.includes("Paid, partly refunded, amount unknown"), paidStudio.includes("nothing is taken back from later commissions")], [true, true]);
  const later: Paid = { ...paid, order: "9O190127TN3647109", capture: "9C679366HH908709", email: "later@example.com", at: NOW - 60 } as Paid;
  await creditPayPalSale(store, later, "Synthetic course");
  const afterLater = await readBook(store);
  is("a later sale is owed in full (Mark as paid opens with it alone)", afterLater.rows[0]?.owed, 1470);
  is("and offered in full", payableLines(afterLater, new Set()).reduce((sum, line) => sum + line.cents, 0), 1470);

  part("A commission never paid stays held after a payout made after the partial refund");
  await setup();
  captures.set(CAPTURE, "PARTIALLY_REFUNDED");
  await watch();
  // The partial refund seen ten minutes ago, the payout written now, after it.
  await backdate(null, NOW - 600);
  await addPayout(store, { aff: AFF, cents: 500, currency: "usd", date: "2026-10-02", reference: "synthetic" });
  const notPaid = await readBook(store);
  is("the sale stays held, earning nothing", notPaid.lines.find((l) => l.ref === `paypal:${ORDER}`)?.status, "held");
  is("the later payout is not taken for it", notPaid.rows[0]?.owed, -500);

  part("The buyer ledger says the true reason its counts may be off");
  await setup();
  captures.set(CAPTURE, "PARTIALLY_REFUNDED");
  await watch();
  const ledger = (await buyerLedger({ ...store, pastBuyers: true } as Store)) as unknown as { partial: boolean; more?: boolean; partlyRefunded?: boolean };
  is("partial, because a PayPal sale was refunded in part, not because there is more to read", [ledger.partial, ledger.more, ledger.partlyRefunded], [true, false, true]);
  const emailStudio = readFileSync(join(process.cwd(), "components/email-studio.tsx"), "utf8");
  // Rule 23: the RED commit looked for "can&apos;t", but the words are a JavaScript string inside braces, where an
  // entity would be shown as typed; a plain apostrophe is what renders.
  is("the email studio has the true words for it", emailStudio.includes("Some PayPal sales were refunded in part, and the amount refunded can't be seen here"), true);
  // Rule 23: the RED commit named the studio's flag `more`, a name the composer already uses for its open choices;
  // it is `readMore`.
  is("and the 'more to read' words only when there is more to read", emailStudio.includes('{readMore ? " There is more to read'), true);

  part("Another sale of the same affiliate, not refunded, is paid as usual beside the held one");
  await setup();
  const kept: Paid = { ...paid, order: "8O190127TN3647108", capture: "8C679366HH908708", email: "kept@example.com" } as Paid;
  await creditPayPalSale(store, kept, "Synthetic course");
  await redis.pipeline([["SET", `nl:ppsell:paid:${kept.order}`, JSON.stringify(kept)]]);
  captures.set(CAPTURE, "PARTIALLY_REFUNDED");
  await watch();
  const beside = await offered();
  is("the book stays checked", beside.checked, true);
  is("only the other sale's commission is offered", beside.through, 1470);

  part("A partial refund whose payment cannot be named: the whole book is unknown, nothing is paid");
  await setup();
  await redis.pipeline([
    ["SET", `nl:ppsell:paid:${OTHER_ORDER}`, JSON.stringify({ ...other, capture: "" })],
    ["ZADD", `nl:ppsell:refunded:${SID}`, String(NOW), `part:${OTHER_ORDER}`],
  ]);
  const unnamed = await offered();
  is("the book is not checked", unnamed.checked, false);
  is("nothing passes the refund guard", unnamed.through, 0);

  part("Control: another sale refunded in part, with no affiliate on it, leaves this commission payable");
  await setup();
  await redis.pipeline([
    ["SET", `nl:ppsell:paid:${OTHER_ORDER}`, JSON.stringify(other)],
    ["ZADD", `nl:ppsell:watch:${SID}`, "0", OTHER_ORDER],
  ]);
  captures.set(CAPTURE, "COMPLETED");
  captures.set(OTHER_CAPTURE, "PARTIALLY_REFUNDED");
  await watch();
  const elsewhere = await offered();
  is("the book is checked", elsewhere.checked, true);
  is("this sale's commission offered", elsewhere.through, 1470);
  is("the store's numbers still say their refunds are not whole", (await readPayPalRefundsWithCoverage(SID, 0)).partial, true);

  part("A mark whose write is not known written: looked at again in an hour, never taken as written");
  await setup();
  captures.set(CAPTURE, "PARTIALLY_REFUNDED");
  const original = redis.pipeline;
  redis.pipeline = async (commands) => {
    const replies = await original.call(redis, commands);
    return commands.map((command, i) => (command[0] === "ZADD" && String(command[1]).startsWith("nl:ppsell:refunded:") ? "QUEUED" : replies[i]));
  };
  try {
    await watch();
  } finally {
    redis.pipeline = original;
  }
  const again = Number(await watchScore(ORDER));
  is("asked again within the hour, not at its next daily look", again > NOW && again <= NOW + 3600 + 5, true);

  done();
}

void main();
