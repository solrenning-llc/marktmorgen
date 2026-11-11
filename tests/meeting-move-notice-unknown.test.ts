/**
 * A booking that moves while its meeting record cannot be read (#2619, the
 * MEDIUM of R2, Claude 5 and Claude 1): the calendar file's sequence is
 * unknown, so no file with an invented sequence is attached, but the buyer
 * and the creator are still told the new time. Synthetic Redis, Stripe and
 * email only.
 */
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { confirmBooking, moveBooking, holdAndCheckout, type CallListing } from "@/lib/calls";
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
    const id = `cs_test_movenote${String(opened).padStart(10, "0")}`;
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
  const OWNER = "bela@example.com";
  await claimHandle(OWNER, "bela", "Bela Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBela00001", true);
  await setSubscription(OWNER, { customerId: "cus_bela00001", subscriptionId: "sub_bela00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Haircut", "", "45", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, { ...weekly, place: ADDRESS.join("\n") } as unknown as CallSetup);
  const store = (await storeForEmail(OWNER)) as Store;
  const listing = (await readListing(store, made.product.id)) as CallListing;
  if (!readSetup({ ...weekly, place: ADDRESS.join("\n") })) throw new Error("no setup");
  const at = weekdayAt(3, 600);
  const full = (await readProduct(store, listing.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store, product: full, start: at, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error("no hold");
  await confirmBooking({ store, product: listing, session: held.session, start: at, end: at + 3_600_000, buyerEmail: "ana@example.com", buyerTz: NY, origin: "https://marktmorgen.com" });

  part("The meeting record cannot be read while the booking moves");
  const real = redis.pipeline.bind(redis);
  let refused = 0;
  redis.pipeline = (async (sent: (string | number)[][]) => {
    if (sent.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:meet:r:"))) { refused += 1; throw new Error("Redis request timed out"); }
    return real(sent);
  }) as typeof redis.pipeline;
  emails.length = 0;
  const later = at + 2 * 3_600_000;
  const moved = await moveBooking({ store, product: listing, session: held.session, booked: { start: at, end: at + 3_600_000, email: "ana@example.com", buyerTz: NY }, start: later, origin: "https://marktmorgen.com" });
  redis.pipeline = real;
  const buyer = emails.find((e) => e.to === "ana@example.com");
  const creator = emails.find((e) => e.to !== "ana@example.com");
  is("the read was refused and the move kept", [refused > 0, moved.ok], [true, true]);
  is("the buyer and the creator are still told the new time and where", [Boolean(buyer?.text.includes("Where: Bela Studio")), Boolean(creator?.text.includes("In person, at: Bela Studio"))], [true, true]);
  is("no calendar file with an invented sequence is attached", [buyer?.ics ?? "", creator?.ics ?? ""], ["", ""]);
  is("and neither email says a calendar file is attached", [/calendar file attached/i.test(buyer?.text ?? ""), /calendar file attached/i.test(creator?.text ?? "")], [false, false]);
  done();
}

void main();
