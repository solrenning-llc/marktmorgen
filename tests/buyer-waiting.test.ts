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

async function main(): Promise<void> {
  const NOW = Date.UTC(2026, 10, 4, 12);
  const DAY = 86_400_000;
  const request = (id: string, over: Partial<PaymentRequest> = {}): PaymentRequest =>
    ({ id: id.padEnd(32, "0"), sid: "s1", email: "ana@example.com", name: "", lines: [], note: "", currency: "usd", total: 5000, createdAt: NOW - DAY, dueDate: "", expiresAt: NOW + 30 * DAY, state: "open", autoReminders: 0, sent: [], failed: "", ...over }) as PaymentRequest;
  const agreement = (id: string, over: Partial<Agreement> = {}): Agreement =>
    ({ id: id.padEnd(32, "0"), sid: "s1", kind: "proposal", email: "ana@example.com", name: "", createdAt: NOW - DAY, expiresAt: NOW + 10 * DAY, state: "open", versions: [{ n: 1, sha256: "x", createdAt: NOW - DAY, signature: null }], sent: [], failed: "", payRequest: "", copies: 0, closedAt: 0, ...over }) as Agreement;

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
  ];
  const open = openRequestsFor(requests, "ana@example.com", NOW);
  is("only those sent to this address that still take payment", open.map((r) => r.id.slice(0, 2)), ["a2", "a1", "a3", "a8"]);
  is("soonest due first, undated after, oldest first", open.map((r) => r.dueDate), ["2026-11-10", "2026-11-20", "", ""]);
  is("with only what the page needs", Object.keys(open[0]).sort(), ["dueDate", "expiresAt", "id", "total"]);
  is("at most a few", openRequestsFor(Array.from({ length: WAITING_SHOWN + 5 }, (_, i) => request(`b${i}`)), "ana@example.com", NOW).length, WAITING_SHOWN);

  part("Proposals and agreements to sign");
  const signed = agreement("c3", { versions: [{ n: 1, sha256: "x", createdAt: NOW - DAY, signature: { name: "Ana", at: NOW - 1 } as never }] });
  const agreements = [agreement("c1", { expiresAt: NOW + 20 * DAY }), agreement("c2", { expiresAt: NOW + 2 * DAY }), signed, agreement("c4", { state: "withdrawn" }), agreement("c5", { expiresAt: NOW - 1 }), agreement("c6", { email: "someone@example.com" })];
  is("only those sent to this address still taking a signature, the first to stop first", openAgreementsFor(agreements, "ana@example.com", NOW).map((a) => a.id.slice(0, 2)), ["c2", "c1"]);
  is("a store with nothing waiting, or nothing readable, shows nothing", await waitingFor({ sid: "", statsId: null } as unknown as Store, "ana@example.com", NOW), { requests: [], agreements: [] });

  part("On the orders page");
  const page = readFileSync("app/[handle]/orders/page.tsx", "utf8");
  is("a named section with its heading, before the bookings", page.includes('aria-labelledby="waiting-title"') && page.includes('<h2 id="waiting-title"') && page.indexOf("<WaitingList") < page.indexOf('aria-labelledby="calls-title"'), true);
  is("each linked to the page that was emailed to them", page.includes("href={`/@${store.handle}/pay/${request.id}`}") && page.includes("href={`/@${store.handle}/sign/${agreement.id}`}"), true);
  is("payment requests only where their page takes payment", page.includes("if (!requestsOpen(store)) waiting = { ...waiting, requests: [] };"), true);
  is("a list that cannot be read leaves the page as it was", page.includes("waitingFor(store, email).catch(() => waiting)"), true);
  is("the dates and amounts as their own pages say them", page.includes("rw.due(day(request.dueDate))") && page.includes("aw.until(said.date(agreement.expiresAt))") && page.includes("said.money(request.total)"), true);
  is("buttons tall enough to tap", (page.match(/btn st-btn mt-3 inline-flex min-h-11/g) ?? []).length, 2);

  part("In every language the store can speak");
  const keys = ["waiting", "openRequest", "openToSign"] as const;
  is("each language has the words", Object.values(ORDERS_WORDS).every((words) => keys.every((key) => typeof words[key] === "string" && words[key].length > 0)), true);
  is("and its own, not English", Object.entries(ORDERS_WORDS).filter(([code]) => code !== "en").every(([, words]) => keys.every((key) => words[key] !== ORDERS_WORDS.en[key])), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
