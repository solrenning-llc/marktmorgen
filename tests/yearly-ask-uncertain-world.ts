/**
 * Only the boundaries around the real yearly-offer flow (lib/yearly-ask.ts), with the once-per-membership mark kept
 * in memory so a second run reads what the first one left. No provider is reached; every id is synthetic.
 */
import type { Listing, Store } from "@/lib/store";

export const NOW = Date.parse("2026-11-05T12:00:00Z");
export const world = {
  marks: new Map<string, string>(),
  /** What sendEmail answers: true sent, false refused or not known (the reply may be lost after the provider took it). */
  mail: (): Promise<boolean> => Promise.resolve(true),
  /** Set to make the link fail before anything is handed to the sender. */
  mintFails: false,
  mails: 0, mints: 0,
};
export function reset(): void {
  world.marks.clear();
  world.mail = () => Promise.resolve(true);
  world.mintFails = false;
  world.mails = 0;
  world.mints = 0;
}
export const owner = {
  sid: "a".repeat(32), statsId: "b".repeat(32), listId: "c".repeat(32),
  handle: "syntheticyearlyuncertain", name: "Synthetic store", email: "owner@example.test",
  stripeAccountId: "acct_SynthYearlyU", currency: "usd", tiers: [], language: "en",
  yearlyAsk: { on: true, address: "Synthetic test address" }, mail: null,
} as unknown as Store;
const product = {
  id: "syntheticclub", title: "Synthetic club", priceCents: 2000,
  recurring: { interval: "month", trialDays: 0, payments: 0 }, options: [], pwyw: null,
  yearly: { cents: 20000 },
} as unknown as Listing;
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: unknown[][]): Promise<unknown[]> {
  return commands.map(([name, key]) => {
    if (name === "EXISTS") return world.marks.has(String(key)) ? 1 : 0;
    if (name === "DEL") return world.marks.delete(String(key)) ? 1 : 0;
    if (name === "GET") return null;
    if (name === "SET") return "OK";
    return 1;
  });
}
/** The claim: SET key value NX EX seconds, exactly as Upstash answers it. */
export async function orderWrite(_store: Store, commands: unknown[][]): Promise<unknown[]> {
  return commands.map(([, key, value]) => {
    if (world.marks.has(String(key))) return null;
    world.marks.set(String(key), String(value));
    return "OK";
  });
}
export const platformKey = () => "synthetic-only";
export const isSenderConfigured = () => true;
export async function sendEmail(): Promise<boolean> { world.mails++; return world.mail(); }
export async function storesAfter(): Promise<{ stores: Store[]; next: string }> { return { stores: [], next: "0" }; }
export const sellsMemberships = () => true;
export const fromLine = () => "Synthetic <sender@example.test>";
export const render = (_store: Store, subject: string, body: string) => ({ subject, text: body, headers: {} });
export async function tokensFor(): Promise<Map<string, string>> { return new Map([["member@example.test", "synthetic-unsubscribe"]]); }
export const storeBase = () => "https://example.test";
export async function readListings(): Promise<Listing[]> { return [product]; }
export const canSellProduct = () => true;
export const normaliseEmail = (email: string) => email.trim().toLowerCase();
export async function runningMembers() {
  return { complete: true, rows: [{
    id: "sub_SyntheticYearlyU", status: "active", start_date: NOW / 1000 - 90 * 86_400,
    customer: { id: "cus_SyntheticYearlyU", email: "member@example.test" },
    metadata: { product: product.id },
    items: { data: [{ quantity: 1, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  }] };
}
export const YEARLY_TARGET = "synthetic-yearly";
export async function mintYearlyLink(): Promise<string> {
  world.mints++;
  if (world.mintFails) throw new Error("synthetic: the link could not be made");
  return "synthetic-link";
}
export const priceWords = () => "synthetic price";
