/**
 * 639 [GL7](34), unit 1: what a store waits on from one buyer, on their
 * orders page (lib/buyer-waiting.ts, app/[handle]/orders/page.tsx). Only
 * what was sent to this address and its own page would still act on; each
 * linked to that page; payment requests only where they take payment; the
 * words in every language the store can speak.
 */
import { readFileSync } from "node:fs";
import type { Agreement } from "@/lib/agreement-rules";
import { ORDERS_WORDS } from "@/lib/buyer-words/orders";
import { WAITING_SHOWN, openAgreementsFor, openRequestsFor, waitingFor } from "@/lib/buyer-waiting";
import type { PaymentRequest } from "@/lib/payment-request-rules";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
import { personKey } from "@/lib/person-key";

async function main(): Promise<void> {
  const NOW = Date.UTC(2026, 10, 4, 12);
  const DAY = 86_400_000;
  const request = (id: string, over: Partial<PaymentRequest> = {}): PaymentRequest =>
    ({ id: id.padEnd(32, "0"), sid: "s1", email: "ana@example.com", name: "", lines: [], note: "", currency: "usd", total: 5000, createdAt: NOW - DAY, dueDate: "", expiresAt: NOW + 30 * DAY, state: "open", autoReminders: 0, sent: [NOW - DAY], failed: "", ...over }) as PaymentRequest;
  const agreement = (id: string, over: Partial<Agreement> = {}): Agreement =>
    ({ id: id.padEnd(32, "0"), sid: "s1", kind: "proposal", email: "ana@example.com", name: "", createdAt: NOW - DAY, expiresAt: NOW + 10 * DAY, state: "open", versions: [{ n: 1, sha256: "x", createdAt: NOW - DAY, signature: null }], sent: [NOW - DAY], failed: "", payRequest: "", copies: 0, closedAt: 0, ...over }) as Agreement;

  part("Payment requests");
  const requests = [
    request("a1", { dueDate: "2026-11-20" }),
    request("a2", { dueDate: "2026-11-10" }),
    request("a3"),
    request("a4", { email: "someone@example.com" }),
    request("a5", { state: "paid" }),
    request("a6", { state: "canceled" }),
    request("a7", { expiresAt: NOW - 1 }),
    request("a8", { email: " ANA@example.com " }),
    request("a9", { sent: [], failed: "The month's emails are used." }),
  ];
  const open = openRequestsFor(requests, "ana@example.com", NOW);
  is("only those emailed to this address that still take payment (one whose email never went is not shown)", open.map((r) => r.id.slice(0, 2)), ["a2", "a1", "a3", "a8"]);
  is("soonest due first, undated after, oldest first", open.map((r) => r.dueDate), ["2026-11-10", "2026-11-20", "", ""]);
  is("with only what the page needs", Object.keys(open[0]).sort(), ["dueDate", "expiresAt", "id", "total"]);
  is("all of them, for the count", openRequestsFor(Array.from({ length: WAITING_SHOWN + 5 }, (_, i) => request(`b${i}`)), "ana@example.com", NOW).length, WAITING_SHOWN + 5);

  part("Proposals and agreements to sign");
  const signed = agreement("c3", { versions: [{ n: 1, sha256: "x", createdAt: NOW - DAY, signature: { name: "Ana", at: NOW - 1 } as never }] });
  const agreements = [agreement("c1", { expiresAt: NOW + 20 * DAY }), agreement("c2", { expiresAt: NOW + 2 * DAY }), signed, agreement("c4", { state: "withdrawn" }), agreement("c5", { expiresAt: NOW - 1 }), agreement("c6", { email: "someone@example.com" }), agreement("c7", { sent: [] })];
  is("only those sent to this address still taking a signature, the first to stop first", openAgreementsFor(agreements, "ana@example.com", NOW).map((a) => a.id.slice(0, 2)), ["c2", "c1"]);
  is("a store whose lists cannot be read shows nothing and says it could not read them", await waitingFor({ sid: "", statsId: null } as unknown as Store, "ana@example.com", NOW), { requests: [], agreements: [], requestsTotal: 0, agreementsTotal: 0, unread: true });

  part("Read from the person's own records, whatever the store keeps");
  const sid = "f".repeat(32);
  const shop = { sid, statsId: null } as unknown as Store;
  const mine = Array.from({ length: 14 }, (_, i) => request(`d${i.toString(16).padStart(2, "0")}`, { sid }));
  await redis.pipeline([
    ...mine.map((r) => ["SET", `nl:payreq:r:${r.id}`, JSON.stringify(r)]),
    ["SADD", `nl:payreq:p:${sid}:${personKey(sid, "ana@example.com")}`, ...mine.map((r) => r.id)],
    // Another buyer's, in the store's own list only: never read for Ana.
    ["SET", `nl:payreq:r:${"e".repeat(32)}`, JSON.stringify(request("e", { sid, email: "bob@example.com" }))],
  ]);
  const keep = redis.pipeline.bind(redis);
  let commands = 0;
  redis.pipeline = (async (list: (string | number)[][]) => {
    commands += list.length;
    return keep(list);
  }) as typeof redis.pipeline;
  const read = await waitingFor(shop, "ana@example.com", NOW);
  redis.pipeline = keep;
  is("ten shown, fourteen counted, all read", [read.requests.length, read.requestsTotal, read.unread], [WAITING_SHOWN, 14, false]);
  is("three commands for a person with requests and no agreements: their two sets and their records", commands, 3);
  is("the page says how many more there are", ORDERS_WORDS.en.waitingMore(4), "And 4 more. Open the email each one came in to see it.");
  await redis.pipeline([["SET", `nl:payreq:r:${mine[0].id}`, "not a record"]]);
  is("a record that does not read: the page says it could not read what waits", (await waitingFor(shop, "ana@example.com", NOW)).unread, true);
  is("where requests take no payment they are not read, so their failure says nothing", await waitingFor(shop, "ana@example.com", NOW, false), { requests: [], agreements: [], requestsTotal: 0, agreementsTotal: 0, unread: false });


  part("On the orders page");
  const page = readFileSync("app/[handle]/orders/page.tsx", "utf8");
  is("a named section with its heading, before the bookings", page.includes('aria-labelledby="waiting-title"') && page.includes('<h2 id="waiting-title"') && page.indexOf("<WaitingList") < page.indexOf('aria-labelledby="calls-title"'), true);
  is("each linked to the page that was emailed to them", page.includes("href={`/@${store.handle}/pay/${request.id}`}") && page.includes("href={`/@${store.handle}/sign/${agreement.id}`}"), true);
  is("payment requests read and shown only where their page takes payment; a surprise failure is 'could not be read'", page.includes("waitingFor(store, email, undefined, requestsOpen(store)).catch(() => ({ ...waiting, unread: true }))"), true);
  is("a list that cannot be read is said, never 'nothing to open'", page.includes("{waiting.unread ? (") && page.includes("{words.waitingUnread}") && page.includes("|| waiting.unread) ? null"), true);
  is("the dates and amounts as their own pages say them", page.includes("rw.due(day(request.dueDate))") && page.includes("aw.until(said.date(agreement.expiresAt))") && page.includes("said.money(request.total)"), true);
  is("buttons tall enough to tap", (page.match(/btn st-btn btn-wrap mt-3 inline-flex min-h-11/g) ?? []).length, 2);

  part("Each link says by itself what it opens (WCAG 2.4.9)");
  const en = ORDERS_WORDS.en;
  is("two payment requests never read the same", en.openRequest("$50.00", "November 20, 2026") !== en.openRequest("$80.00", "November 20, 2026") && en.openRequest("$50.00", "November 10, 2026") !== en.openRequest("$50.00", "November 20, 2026"), true);
  is("in plain words, with the amount and the date", [en.openRequest("$50.00", "November 20, 2026"), en.openRequest("$50.00", "")], ["Open the $50.00 payment request due November 20, 2026", "Open the $50.00 payment request"]);
  is("two agreements never read the same", [en.openToSign("Website redesign"), en.openToSign("Monthly retainer")], ["Read and sign “Website redesign”", "Read and sign “Monthly retainer”"]);
  is("in the link's own text, not only for screen readers", page.includes("{words.openRequest(said.money(request.total), request.dueDate ? day(request.dueDate) : \"\")}") && page.includes("{words.openToSign(agreement.title)}") && !/aria-label=\{words\.open/.test(page), true);
  is("a long title wraps inside its card", (page.match(/btn-wrap mt-3 inline-flex min-h-11 items-center \[overflow-wrap:anywhere\]/g) ?? []).length, 2);

  part("In every language the store can speak");
  const said = (words: (typeof ORDERS_WORDS)["en"]) => [words.waiting, words.openRequest("$50.00", "November 20, 2026"), words.openRequest("$50.00", ""), words.openToSign("Website redesign")];
  is("each language has the words, with the amount, the date and the title in them", Object.values(ORDERS_WORDS).every((words) => { const [w, dated, undated, sign] = said(words); return w.length > 0 && dated.includes("$50.00") && dated.includes("November 20, 2026") && undated.includes("$50.00") && sign.includes("Website redesign"); }), true);
  is("and its own, not English", Object.entries(ORDERS_WORDS).filter(([code]) => code !== "en").every(([, words]) => said(words).every((text, i) => text !== said(ORDERS_WORDS.en)[i])), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
