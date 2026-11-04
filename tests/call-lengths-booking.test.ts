/**
 * A call with several lengths, booked and moved (637 [GL5], unit 2; added
 * 2 November 2026), with Stripe and the email service mocked, on synthetic
 * records only:
 *
 *   - the setup keeps two or three lengths only in the shape the rules allow
 *     (lib/call-setup.ts, readSetup), and one length is no list at all;
 *   - a new booking is held, checked and charged at the length chosen, at
 *     that length's own price, which is said on the line and kept on the
 *     sale; a length the call does not have, a package, a deposit or a code
 *     with another length than the setup's own, and a product whose price
 *     was changed since, are refused before anything is held or opened;
 *   - a paid booking moves at its own length, whatever the setup's is, also
 *     once the list is gone; a price changed elsewhere sells only the setup's
 *     own length, at the price now;
 *   - the studio's save route refuses several lengths until the pages say
 *     each of them (the editor unit).
 */
import { MAX_SETUP_LENGTHS, readSetup, type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { MAX_CALL_LENGTHS, bookingLength, ownLength } from "@/lib/call-lengths";
import { callCheckoutBody, holdAndCheckout, moveBooking, slotsForMove, type CallListing } from "@/lib/calls";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import type { Product, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const bodies: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    bodies.push(new URLSearchParams(String(init?.body ?? "")));
    const id = `cs_test_len${String(bodies.length).padStart(14, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "POST" && /^\/checkout\/sessions\/[^/]+\/expire$/.test(path)) return answer({ status: "expired" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 30, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] };
const LENGTHS = [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 8000 }];

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
  process.env.STRIPE_SECRET_KEY = "sk_test_call_lengths_only";
  process.env.RESEND_API_KEY = "re_test_call_lengths_only";

  part("The setup keeps them only in the shape the rules allow");
  const kept = readSetup({ ...weekly, lengths: LENGTHS }) as CallSetup;
  is("two lengths, shortest first, the first the setup's own", kept.lengths, LENGTHS);
  is("one length, or none, is no list", [readSetup({ ...weekly, lengths: [{ minutes: 30, cents: 4500 }] }), readSetup({ ...weekly, lengths: [] }), readSetup(weekly)].map((s) => "lengths" in (s as CallSetup)), [false, false, false]);
  const refused = [
    { ...weekly, lengths: [{ minutes: 60, cents: 8000 }, { minutes: 30, cents: 4500 }] },
    { ...weekly, lengths: [{ minutes: 45, cents: 6000 }, { minutes: 60, cents: 8000 }] },
    { ...weekly, lengths: [{ minutes: 30, cents: 4500 }, { minutes: 30, cents: 5000 }] },
    { ...weekly, lengths: [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 0 }] },
    { ...weekly, lengths: [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 80.5 }] },
    { ...weekly, lengths: [{ minutes: 30, cents: 4500 }, { minutes: 61, cents: 8000 }] },
    { ...weekly, lengths: [{ minutes: 30, cents: 4500 }, { minutes: 45, cents: 6000 }, { minutes: 60, cents: 8000 }, { minutes: 90, cents: 9000 }] },
    { ...weekly, seats: 3, lengths: LENGTHS },
    { ...weekly, weekly: [[], [[540, 580]], [], [], [], [], []], lengths: LENGTHS },
    { ...weekly, place: "12 Harbor Street", deposit: 4500, lengths: LENGTHS },
    { ...weekly, lengths: [{ minutes: 45, cents: 4500 }] },
    { ...weekly, lengths: "30,60" },
  ];
  is("out of order, not the setup's own first, twice, no price, a part of a cent, an unknown length, four, a group, too long for the hours, a deposit not below every price, one that is not the setup's own, not a list", refused.map((r) => readSetup(r)), refused.map(() => "lengths"));
  is("the setup and the rules allow the same number of lengths", MAX_SETUP_LENGTHS, MAX_CALL_LENGTHS);
  is("a deposit below every price is kept", (readSetup({ ...weekly, place: "12 Harbor Street", deposit: 2000, lengths: LENGTHS }) as CallSetup).lengths, LENGTHS);

  part("The length of a new booking");
  is("none sent is the setup's own; one of the list at its own price", [bookingLength(kept, 4500, undefined), bookingLength(kept, 4500, ""), bookingLength(kept, 4500, "60"), bookingLength(kept, 4500, 60)], [LENGTHS[0], LENGTHS[0], LENGTHS[1], LENGTHS[1]]);
  is("a length the call does not have is refused", [bookingLength(kept, 4500, "45"), bookingLength(kept, 4500, "60x"), bookingLength(kept, 4500, -60)], [null, null, null]);
  is("a product whose price was changed elsewhere sells only the setup's own length, at the price now", [bookingLength(kept, 5000, "60"), bookingLength(kept, 5000, undefined)], [null, { minutes: 30, cents: 5000 }]);
  is("a call with one length: its own length at the product's price, and nothing else", [bookingLength(readSetup(weekly) as CallSetup, 4500, undefined), bookingLength(readSetup(weekly) as CallSetup, 4500, "60")], [{ minutes: 30, cents: 4500 }, null]);
  is("dated sessions have their own lengths", bookingLength({ kind: "live", minutes: 30 }, 4500, undefined), null);
  is("a paid booking keeps its own length when it moves, with or without the list", [ownLength(kept, 3_600_000), ownLength(kept, 1_800_000), ownLength(kept, 61 * 60_000), ownLength(readSetup(weekly) as CallSetup, 3_600_000), ownLength(readSetup(weekly) as CallSetup, 61 * 60_000), ownLength({ kind: "live" }, 3_600_000)], [60, 30, "unknown", 60, null, null]);

  part("Booked and charged at the length chosen");
  const OWNER = "lena@example.com";
  await claimHandle(OWNER, "lena", "Lena Coaching", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLena00001", true);
  await setSubscription(OWNER, { customerId: "cus_lena00001", subscriptionId: "sub_lena00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, kept);
  const store = (await storeForEmail(OWNER)) as Store;
  const listing = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, listing.id)) as Product & { call: CallSetup };
  is("the product carries them", [full.priceCents, listing.call.lengths], [4500, LENGTHS]);
  const at = weekdayAt(3, 600);
  const long = await holdAndCheckout({ store, product: full, start: at, buyerTz: NY, origin: "https://marktmorgen.com", minutes: "60" });
  if (!long.ok) throw new Error(`no hold: ${long.reason}`);
  const paid = bodies.at(-1)!;
  is("the hour is charged at the hour's price, said on the line and kept on the sale", [paid.get("line_items[0][price_data][unit_amount]"), paid.get("line_items[0][price_data][product_data][name]")?.startsWith("Coaching · 60 minutes — "), paid.get("metadata[minutes]"), Number(paid.get("metadata[end]")) - Number(paid.get("metadata[start]"))], ["8000", true, "60", 3_600_000]);
  const after = at + 30 * 60_000;
  const clash = await holdAndCheckout({ store, product: full, start: after, buyerTz: NY, origin: "https://marktmorgen.com", minutes: "30" });
  is("its whole hour is held: half an hour inside it cannot be booked", clash, { ok: false, reason: "taken" });
  const short = await holdAndCheckout({ store, product: full, start: at + 2 * 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!short.ok) throw new Error("no short hold");
  is("none chosen is the setup's own, at the product's price", [bodies.at(-1)!.get("line_items[0][price_data][unit_amount]"), bodies.at(-1)!.get("metadata[minutes]")], ["4500", "30"]);
  const opened = bodies.length;
  const tries = [
    await holdAndCheckout({ store, product: full, start: at + 4 * 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", minutes: "45" }),
    await holdAndCheckout({ store, product: { ...full, priceCents: 5000 }, start: at + 4 * 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", minutes: "60" }),
    await holdAndCheckout({ store, product: full, start: at + 4 * 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", minutes: "60", fromPackage: { id: "cs_test_pkg", coupon: "c1", email: "ana@example.com", back: "https://marktmorgen.com/@lena" } }),
    await holdAndCheckout({ store, product: { ...full, call: { ...full.call, deposit: 2000 } }, start: at + 4 * 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", minutes: "60" }),
    await holdAndCheckout({ store, product: full, start: at + 4 * 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", minutes: "60", code: { id: "promo_1", code: "SAVE", figures: { charged: 1000, rest: 3000, off: 500 } as never } }),
  ];
  is("refused before anything is opened: an unknown length, a price changed since, another length from a package, with a deposit or with a code", [tries.map((t) => t), bodies.length - opened], [tries.map(() => ({ ok: false, reason: "invalid" })), 0]);
  const plain = callCheckoutBody({ store, product: { ...full, call: readSetup(weekly) as CallSetup }, start: at, end: at + 1_800_000, buyerTz: NY, origin: "https://marktmorgen.com", via: null, fromPackage: null, length: { minutes: 60, cents: 8000 } });
  is("a call with one length is charged its own price, whatever is passed", [plain.get("line_items[0][price_data][unit_amount]"), plain.has("metadata[minutes]")], ["4500", false]);

  part("A paid booking moves at its own length");
  const later = at + 6 * 3_600_000;
  const moved = await moveBooking({ store, product: listing, session: long.session, booked: { start: at, end: at + 3_600_000, email: "ana@example.com", buyerTz: NY }, start: later, origin: "https://marktmorgen.com" });
  is("an hour stays an hour, though the setup's own is half of one", moved.ok ? [moved.start, moved.end - moved.start] : moved, [later, 3_600_000]);
  const odd = await moveBooking({ store, product: listing, session: short.session, booked: { start: at + 2 * 3_600_000, end: at + 2 * 3_600_000 + 61 * 60_000, email: "bo@example.com", buyerTz: NY }, start: later + 3 * 3_600_000, origin: "https://marktmorgen.com" });
  is("a booking whose length is not one a call may have is never moved at a guess", odd, { ok: false, reason: "error" });
  const offer = await slotsForMove(store, listing, long.session, later, 3_600_000);
  const lastStart = Math.max(...(offer?.days ?? []).flatMap((d) => d.starts));
  const dayEnd = (() => { const d = new Date(lastStart); const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d); return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value); })();
  is("the times offered to move it are a whole hour each: none starts after 4 p.m.", dayEnd <= 16 * 60, true);
  const { readFileSync } = await import("node:fs");
  is("the studio's save route refuses several lengths for now", readFileSync("app/api/store/call/route.ts", "utf8").includes('if (setup.lengths) return Response.json({ ok: false, error: "lengths" }, { status: 400 });'), true);

  part("Once the list is gone, a paid hour still moves as an hour");
  await setProductCall(OWNER, made.product.id, readSetup(weekly) as CallSetup);
  const plainListing = (await readListing(store, made.product.id)) as CallListing;
  const again = await moveBooking({ store, product: plainListing, session: long.session, booked: { start: later, end: later + 3_600_000, email: "ana@example.com", buyerTz: NY }, start: at + 3 * 3_600_000, origin: "https://marktmorgen.com" });
  is("the setup's own is half an hour, the booking stays an hour", again.ok ? again.end - again.start : again, 3_600_000);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
