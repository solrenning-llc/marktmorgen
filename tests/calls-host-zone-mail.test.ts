/**
 * Audit proof (calls): a team host in another time zone is told the booking's time in the STORE's zone, the subject
 * with no zone at all, and the body calls it "your time zone" (lib/calls.ts confirmBooking :1691/:1699, tellMoved
 * :1462/:1467). Maya hosts from Lisbon for a New York store: 10:00 AM New York is 3:00 PM for her.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, confirmBooking, holdAndCheckout } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { putMember } from "@/lib/team";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { writeTeam } from "@/lib/team-booking";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let sessions = 0;
const mails: { to: string[] | string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)));
    return answer({ id: "e" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_own${String(sessions).padStart(12, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "POST" && /\/expire$/.test(path)) return answer({ status: "expired" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;
const LISBON = "Europe/Lisbon";
const host = (email: string): TeamHost => ({ email, tz: LISBON, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 });

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(Date.now() + d * DAY));
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

async function storeWithCall(email: string, handle: string, account: string) {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  return { store, product: (await readListing(store, made.product.id)) as CallListing };
}
const hold = async (store: Store, product: CallListing, start: number) =>
  holdAndCheckout({ store, product: (await readProduct(store, product.id)) as Product & { call: CallSetup }, start, buyerTz: NY, origin: "https://marktmorgen.com" });

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_team_scheduling_only";
  process.env.RESEND_API_KEY = "re_test_team_scheduling_only";
  const MAYA = "maya@example.com";
  const harbor = await storeWithCall("owner@example.com", "harbor", "acct_1TestHarbor0001");
  await putMember(harbor.store, MAYA, "editor");
  await writeTeam(harbor.store, harbor.product.id, { mode: "round_robin", hosts: [host(MAYA)], createdAt: "2026-10-01T00:00:00.000Z" });
  const S = weekdayAt(3, 600); // 10:00 AM in New York = 3:00 PM in Lisbon (or 2:00 PM in the weeks the two DSTs differ)
  const held = await hold(harbor.store, harbor.product, S);
  if (!held.ok) throw new Error(`not held: ${held.reason}`);
  await confirmBooking({ store: harbor.store, product: harbor.product, session: held.session, start: S, end: S + HOUR, buyerEmail: "ana@example.com", buyerTz: NY, due: null, cancel: null, origin: "https://marktmorgen.com" });
  const toMaya = mails.find((m) => String(m.to).includes(MAYA) && /New booking/.test(m.subject));
  const lisbon = new Intl.DateTimeFormat("en-US", { timeZone: LISBON, hour: "numeric", minute: "2-digit" }).format(new Date(S));
  const newYork = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit" }).format(new Date(S));
  part(`The host's "New booking" email (New York ${newYork}, Lisbon ${lisbon})`);
  is("it went to Maya", Boolean(toMaya), true);
  is("its subject gives Maya's own time, not the store's zone without a zone name", [toMaya?.subject.includes(lisbon), toMaya?.subject.includes(newYork)], [true, false]);
  is("its body never calls the store's zone 'your time zone' for a host elsewhere", /\((EST|EDT|Eastern[^)]*), your time zone\)/.test(toMaya?.text ?? ""), false);
  done();
}

void main();
