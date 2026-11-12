/**
 * Round robin's counts read exactly (rule 24; audit F2 of lib/, 12 November 2026).
 *
 * A round-robin team event type books the free host with the fewest bookings
 * of it so far (lib/team-booking.ts, teamContext; roundRobinOrder). Those
 * counts are one HGETALL. A reply that cannot be read (a failed read, a reply
 * that is not a list of field and count, a count that is not a whole number)
 * is unknown: never every host at zero, which hands the time to the host who
 * comes first by address however many bookings they already had. Checked,
 * against the real code with an in-memory Redis and a stand-in for Stripe:
 *
 *   - known counts: the host with fewer bookings is held;
 *   - a failed read, a reply that is not a list, an odd list or a count
 *     that is not a whole number: the booking is refused as an error and
 *     nobody is held;
 *   - the times on offer do not need the counts: they are still shown.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, slotsForProduct } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { putMember } from "@/lib/team";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { hostId, readClaims } from "@/lib/host-claims";
import { writeTeam } from "@/lib/team-booking";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

let sessions = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_rrcount${String(sessions).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "POST" && /^\/checkout\/sessions\/[^/]+\/expire$/.test(path)) return answer({ status: "expired" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;
const host = (email: string): TeamHost => ({ email, tz: NY, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 8 });

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const realPipeline: Pipeline = redis.pipeline.bind(redis);
/** Answers every HGETALL of a round-robin count with `reply` (a function that throws: a failed read). */
function countsAnswer(reply: (() => unknown) | null): void {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    const rr = commands.findIndex((c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:callteam:rr:"));
    if (!reply || rr < 0) return realPipeline(commands);
    const replies = await realPipeline(commands);
    replies[rr] = reply();
    return replies;
  };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_rr_count_only";
  process.env.RESEND_API_KEY = "re_test_rr_count_only";

  const OWNER = "owner@example.com";
  const ANA = "ana@example.com";
  await claimHandle(OWNER, "rrsalon", "RR Salon", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRrSalon001", true);
  await setSubscription(OWNER, { customerId: "cus_rrsalon0001", subscriptionId: "sub_rrsalon0001", active: true, tier: "pro", period: paidPeriod() });
  await putMember((await storeForEmail(OWNER)) as Store, ANA, "editor");
  const made = await addProduct(OWNER, "Haircut", "", "45", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, weekly);
  const store = (await storeForEmail(OWNER)) as Store;
  const listing = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, listing.id)) as Product & { call: CallSetup };
  await writeTeam(store, listing.id, { mode: "round_robin", hosts: [host(OWNER), host(ANA)], createdAt: "2026-10-01T00:00:00.000Z" });
  // Ana, first by address, has had three bookings of this event; the owner none.
  const rr = `nl:callteam:rr:${store.callsId}:${listing.id}`;
  await realPipeline([["HSET", rr, hostId(ANA), "3", hostId(OWNER), "0"]]);

  const claimsOf = async (email: string) => ((await readClaims([hostId(email)])).get(hostId(email)) ?? []).length;
  const book = (start: number) => holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  const offered = async (start: number) => Boolean((await slotsForProduct(store, listing))?.days.some((d) => d.starts.includes(start)));

  part("Known counts");
  const first = await book(weekdayAt(1, 600));
  is("the host with fewer bookings, the owner, is held", [first.ok, await claimsOf(OWNER), await claimsOf(ANA)], [true, 1, 0]);

  part("Counts that cannot be read");
  const cases: [string, () => unknown][] = [
    ["a failed read", () => { throw new Error("Redis request failed with status 503"); }],
    ["a reply that is not a list", () => "OK"],
    ["an odd list", () => [hostId(ANA)]],
    ["a count that is not a whole number", () => [hostId(ANA), "three", hostId(OWNER), "0"]],
    ["a negative count", () => [hostId(ANA), "-3", hostId(OWNER), "0"]],
  ];
  let day = 2;
  for (const [what, reply] of cases) {
    countsAnswer(reply);
    const start = weekdayAt(day, 600);
    day = day === 5 ? 1 : day + 1;
    const owner = await claimsOf(OWNER);
    const ana = await claimsOf(ANA);
    let outcome: string;
    try {
      const held = await book(start);
      outcome = held.ok ? "held" : held.reason;
    } catch {
      outcome = "error";
    }
    countsAnswer(null);
    is(`${what}: refused as an error, nobody held`, [outcome, (await claimsOf(OWNER)) - owner, (await claimsOf(ANA)) - ana], ["error", 0, 0]);
  }

  part("The times on offer");
  countsAnswer(() => "OK");
  const shown = await offered(weekdayAt(4, 900));
  countsAnswer(null);
  is("with the counts unknown, the free times are still shown", shown, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
