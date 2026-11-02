/**
 * An in-person booking's place in the setup and in what the buyer and the
 * creator are sent (520 [LB1], unit 2; lib/call-setup.ts, lib/calls.ts,
 * lib/call-reminders.ts, app/api/store/ics; added 2 November 2026). Checked,
 * with Stripe and the email service mocked:
 *
 *   - a setup keeps its place, weekly or dated; then its link, video room
 *     and meeting are off, for every session too; an address that cannot be
 *     kept refuses the setup; a setup without one is read exactly as before;
 *   - the calendar file names the address as its LOCATION, with no URL and
 *     no meeting link, and its note says where;
 *   - the confirmation and the moved booking tell the buyer where, never a
 *     link to join nor that one will come, and tell the creator it is in
 *     person at that address; so do the reminders and the calendar file a
 *     reminder links to (read in their source).
 */
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { buyerNote, callInvite, confirmBooking, moveBooking, holdAndCheckout, type CallListing } from "@/lib/calls";
import { bookingWords } from "@/lib/buyer-words/booking";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { zonedToUtc } from "@/lib/call-setup";
import type { Product, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: { to: string; text: string; ics: string }[] = [];
let opened = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string; attachments?: { content?: string }[] };
    emails.push({ to: String(Array.isArray(sent.to) ? sent.to[0] : sent.to), text: sent.text ?? "", ics: sent.attachments?.[0]?.content ? Buffer.from(sent.attachments[0].content, "base64").toString("utf8") : "" });
    return answer({ id: "e" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    opened += 1;
    const id = `cs_test_place${String(opened).padStart(12, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "POST" && /^\/checkout\/sessions\/[^/]+\/expire$/.test(path)) return answer({ status: "expired" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const ADDRESS = ["Bela Studio", "12 Harbor Street", "Portland, ME 04101"];
const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: true, meet: "zoom", seats: 1, sessions: [] };

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
  process.env.STRIPE_SECRET_KEY = "sk_test_call_place_only";
  process.env.RESEND_API_KEY = "re_test_call_place_only";

  part("The setup");
  const kept = readSetup({ ...weekly, place: ADDRESS.join("\n") }) as CallSetup;
  is("a weekly setup keeps its place, and its link, video room and meeting are off", [kept.place, kept.room, kept.video, kept.meet], [{ lines: ADDRESS }, null, false, null]);
  const start = Math.floor((Date.now() + 10 * 86_400_000) / 60_000) * 60_000;
  const live = readSetup({ kind: "live", tz: NY, noticeHours: 1, video: true, meet: "google", place: { lines: ADDRESS }, sessions: [{ id: "s1", start, minutes: 90, seats: 6, room: "https://example.com/s1" }] }) as CallSetup;
  is("dated sessions too, every session without its link", [live.kind, live.place, live.room, live.video, live.meet, live.sessions.map((s) => s.room), live.minutes], ["live", { lines: ADDRESS }, null, false, null, [null], 90]);
  is("an address that cannot be kept refuses the setup", [readSetup({ ...weekly, place: "https://maps.example.com/x" }), readSetup({ ...weekly, place: Array(5).fill("Line") }), readSetup({ kind: "live", tz: NY, noticeHours: 1, place: 7, sessions: [{ id: "s1", start, minutes: 60, seats: 1 }] })], ["place", "place", "place"]);
  const leftover = readSetup({ ...weekly, room: "not a link", place: ADDRESS }) as CallSetup;
  const leftoverLive = readSetup({ kind: "live", tz: NY, noticeHours: 1, place: ADDRESS, sessions: [{ id: "s1", start, minutes: 60, seats: 1, room: "not a link" }] }) as CallSetup;
  is("a link left over in the form is not read when it is in person", [leftover.place, leftover.room, leftoverLive.place, leftoverLive.sessions.map((s) => s.room)], [{ lines: ADDRESS }, null, { lines: ADDRESS }, [null]]);
  const call = readSetup(weekly) as CallSetup;
  is("a setup without one is read exactly as before, with no place at all", ["place" in call, call.room, call.video, call.meet], [false, "https://example.com/room", true, "zoom"]);

  part("The calendar file");
  const b = bookingWords("en");
  const ics = callInvite({ uid: "u1", start, end: start + 3_600_000, title: "Haircut", storeName: "Bela", room: "https://example.com/room", place: kept.place, note: buyerNote(b, { name: "Bela" } as Store, null, kept.place ?? null), words: b });
  is("its LOCATION is the address, with no URL and no link", [ics.includes("LOCATION:Bela Studio\\, 12 Harbor Street\\, Portland\\, ME 04101"), ics.includes("URL:"), ics.includes("example.com/room")], [true, false, false]);
  is("and its note says where", ics.includes("DESCRIPTION:Where: Bela Studio\\, 12 Harbor Street\\, Portland\\, ME 04101"), true);
  is("in the store's language", buyerNote(bookingWords("pt"), { name: "Bela" } as Store, null, { lines: ["Rua Augusta, 900"] }), "Onde: Rua Augusta, 900");

  part("What the buyer and the creator are sent");
  const OWNER = "bela@example.com";
  await claimHandle(OWNER, "bela", "Bela Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBela00001", true);
  await setSubscription(OWNER, { customerId: "cus_bela00001", subscriptionId: "sub_bela00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Haircut", "", "45", null);
  if (!made.ok) throw new Error("no product");
  const saved = await setProductCall(OWNER, made.product.id, { ...weekly, place: ADDRESS.join("\n") } as unknown as CallSetup);
  is("the product record keeps it (stored below the studio's route, which refuses it for now)", (saved as { ok: boolean }).ok, true);
  const store = (await storeForEmail(OWNER)) as Store;
  const listing = (await readListing(store, made.product.id)) as CallListing;
  is("and the product carries it", listing.call.place, { lines: ADDRESS });
  const at = weekdayAt(3, 600);
  const full = (await readProduct(store, listing.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store, product: full, start: at, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error("no hold");
  emails.length = 0;
  await confirmBooking({ store, product: listing, session: held.session, start: at, end: at + 3_600_000, buyerEmail: "ana@example.com", buyerTz: NY, origin: "https://marktmorgen.com" });
  const toBuyer = emails.find((e) => e.to === "ana@example.com");
  const toCreator = emails.find((e) => e.to !== "ana@example.com");
  is("the buyer's confirmation says where, and never a link to join nor that one will come", [toBuyer?.text.includes("Where: Bela Studio, 12 Harbor Street, Portland, ME 04101"), /Join here|send you the link|example\.com\/room/.test(toBuyer?.text ?? "")], [true, false]);
  is("its calendar file names the address", [toBuyer?.ics.includes("LOCATION:Bela Studio\\, 12 Harbor Street\\, Portland\\, ME 04101"), toBuyer?.ics.includes("URL:")], [true, false]);
  is("the creator is told it is in person, at that address, never asked to send a link", [toCreator?.text.includes("In person, at: Bela Studio, 12 Harbor Street, Portland, ME 04101"), /send them one before|meeting link/.test(toCreator?.text ?? "")], [true, false]);
  emails.length = 0;
  const later = at + 2 * 3_600_000;
  const moved = await moveBooking({ store, product: listing, session: held.session, booked: { start: at, end: at + 3_600_000, email: "ana@example.com", buyerTz: NY }, start: later, origin: "https://marktmorgen.com" });
  const movedBuyer = emails.find((e) => e.to === "ana@example.com");
  const movedCreator = emails.find((e) => e.to !== "ana@example.com");
  is("moved: the buyer is told where, the creator that it is in person", [moved.ok, movedBuyer?.text.includes("Where: Bela Studio"), /Join here|send you the link/.test(movedBuyer?.text ?? ""), movedCreator?.text.includes("In person, at: Bela Studio")], [true, true, false, true]);

  part("No meeting, ever");
  const { callMeeting } = await import("@/lib/meet-links");
  const inPersonProduct = { id: listing.id, title: "Haircut", call: kept };
  is("no meeting is made for it, not even on a team host's own calendar", await callMeeting({ store, product: inPersonProduct, session: held.session, start: at, end: at + 3_600_000, buyerEmail: "ana@example.com", team: { hosts: ["maya@example.com"] } }), null);

  part("The reminders (read in their source)");
  const { readFileSync } = await import("node:fs");
  const reminders = readFileSync("lib/call-reminders.ts", "utf8");
  is("the buyer's says where, the creator's that it is in person", [reminders.includes("setup.place ? b.whereAt(placeLine(setup.place))"), reminders.includes("? `In person, at: ${placeLine(setup.place)}`")], [true, true]);
  is("the calendar file a reminder links to names the address too", readFileSync("app/api/store/ics/route.ts", "utf8").includes("note: buyerNote(words, store, room, place)"), true);
  is("no room kept from when it was online is used, in the emails, the reminders, the calendar file or the creator's calendar feed", [
    (readFileSync("lib/calls.ts", "utf8").match(/const room = place \? null : await roomOf/g) ?? []).length,
    (readFileSync("lib/call-reminders.ts", "utf8").match(/const room = setup\.place \? null : await roomOf/g) ?? []).length,
    readFileSync("app/api/store/ics/route.ts", "utf8").includes("const room = order.product.call.place ? null : await roomOf"),
    readFileSync("lib/calendar-sync.ts", "utf8").includes("const room = place ? null :"),
  ], [2, 2, true, true]);
  is("a meeting retried for it later sends no new link", readFileSync("lib/call-meetings.ts", "utf8").includes('whereOf(product.call).kind !== "place"'), true);
  is("and until the booking pages and the editor say where, the studio's save refuses it", readFileSync("app/api/store/call/route.ts", "utf8").includes('if (setup.place) return Response.json({ ok: false, error: "place" }, { status: 400 });'), true);

  done();
}

void main();
