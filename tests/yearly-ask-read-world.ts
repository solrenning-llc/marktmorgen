/** Only boundaries around the real yearly-offer flow; no provider is reached. */
import type { Listing, Store } from "@/lib/store";

export const NOW = Date.parse("2026-11-05T12:00:00Z");
export const fixture = {
  seen: [0] as unknown,
  claim: ["OK"] as unknown,
  cursor: [null] as unknown,
  tokens: 0, claims: 0, mints: 0, mails: 0, scans: [] as string[], saves: 0,
};
export function reset(): void {
  Object.assign(fixture, { seen: [0], claim: ["OK"], cursor: [null], tokens: 0, claims: 0, mints: 0, mails: 0, scans: [], saves: 0 });
}
export const owner = {
  sid: "a".repeat(32), statsId: "b".repeat(32), listId: "c".repeat(32),
  handle: "syntheticyearly", name: "Synthetic store", email: "owner@example.test",
  stripeAccountId: "acct_SyntheticYearly", currency: "usd", tiers: [], language: "en",
  yearlyAsk: { on: true, address: "Synthetic test address" }, mail: null,
} as unknown as Store;
const product = {
  id: "syntheticclub", title: "Synthetic club", priceCents: 2000,
  recurring: { interval: "month", trialDays: 0, payments: 0 }, options: [], pwyw: null,
  yearly: { cents: 20000 },
} as unknown as Listing;
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: unknown[][]): Promise<unknown[]> {
  if (commands[0]?.[0] === "EXISTS") return fixture.seen as unknown[];
  if (commands[0]?.[0] === "GET") return fixture.cursor as unknown[];
  if (commands[0]?.[0] === "SET") fixture.saves++;
  return commands.map(() => 1);
}
export async function orderWrite(): Promise<unknown[]> {
  fixture.claims++;
  return fixture.claim as unknown[];
}
export const platformKey = () => "synthetic-only";
export const isSenderConfigured = () => true;
export async function sendEmail(): Promise<boolean> { fixture.mails++; return true; }
export async function storesAfter(cursor: string): Promise<{ stores: Store[]; next: string }> {
  fixture.scans.push(cursor);
  return { stores: [], next: "0" };
}
export const sellsMemberships = () => true;
export const fromLine = () => "Synthetic <sender@example.test>";
export const render = (_store: Store, subject: string, body: string) => ({ subject, text: body, headers: {} });
export async function tokensFor(): Promise<Map<string, string>> { fixture.tokens++; return new Map([["member@example.test", "synthetic-unsubscribe"]]); }
export const storeBase = () => "https://example.test";
export async function readListings(): Promise<Listing[]> { return [product]; }
export const canSellProduct = () => true;
export const normaliseEmail = (email: string) => email.trim().toLowerCase();
export async function runningMembers() {
  return { complete: true, rows: [{
    id: "sub_SyntheticYearly", status: "active", start_date: NOW / 1000 - 90 * 86_400,
    customer: { id: "cus_SyntheticYearly", email: "member@example.test" },
    metadata: { product: product.id },
    items: { data: [{ quantity: 1, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  }] };
}
export const YEARLY_TARGET = "synthetic-yearly";
export async function mintYearlyLink(): Promise<string> { fixture.mints++; return "synthetic-link"; }
export const priceWords = () => "synthetic price";
