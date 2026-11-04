/**
 * Choosing one of a call's lengths on the booking page (637 [GL5], unit 2b;
 * added 2 November 2026), on synthetic records only: the lengths offered,
 * the times drawn at the one chosen, the form that books it, and the words
 * in every language the store can have.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { offeredLengths } from "@/lib/call-lengths";
import { slotsForProduct, type CallListing } from "@/lib/calls";
import { BOOKING_WORDS } from "@/lib/buyer-words/booking";
import { SlotPicker, type SlotWords } from "@/components/slot-picker";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 30, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 14, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] };
const LENGTHS = [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 8000 }];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_call_lengths_page";
  const setup = readSetup({ ...weekly, lengths: LENGTHS }) as CallSetup;

  part("The lengths offered");
  const none = { pkg: false, team: false };
  is("the call's, while the first is its own at the product's price", offeredLengths(setup, 4500, none), LENGTHS);
  is("none for one length, a price changed since, or dated sessions", [offeredLengths(readSetup(weekly) as CallSetup, 4500, none), offeredLengths(setup, 5000, none), offeredLengths({ kind: "live", minutes: 30, lengths: LENGTHS }, 4500, none)], [[], [], []]);
  is("none from a package, with a deposit, or on a team of any kind, which book the call's own length only", [offeredLengths(setup, 4500, { pkg: true, team: false }), offeredLengths({ ...setup, deposit: 2000 }, 4500, none), offeredLengths(setup, 4500, { pkg: false, team: true })], [[], [], []]);

  part("The times, at the length chosen");
  const OWNER = "lena@example.com";
  await claimHandle(OWNER, "lena", "Lena Coaching", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLena00001", true);
  await setSubscription(OWNER, { customerId: "cus_lena00001", subscriptionId: "sub_lena00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, setup);
  const store = (await storeForEmail(OWNER)) as Store;
  const listing = (await readListing(store, made.product.id)) as CallListing;
  const minuteOf = (ms: number) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ms); return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value); };
  const at = async (minutes: number | null) => ((await slotsForProduct(store, listing, null, minutes))?.days ?? []).flatMap((d) => d.starts).map(minuteOf);
  const half = await at(null);
  const hour = await at(60);
  is("half an hour: every half hour, the last at 4:30 p.m.", [half.length > 0, half.every((m) => m % 30 === 0), Math.max(...half)], [true, true, 16 * 60 + 30]);
  is("an hour: on the hour, the last at 4 p.m., so the whole of it is inside the hours", [hour.length > 0, hour.every((m) => m % 60 === 0), Math.max(...hour)], [true, true, 16 * 60]);
  is("a length the call does not have draws the call's own times", await at(45), half);
  is("the page is told the call is no team's, so it may offer lengths", (await slotsForProduct(store, listing, null, 60))?.team, false);

  part("The form that books it");
  const words: SlotWords = { locale: "en-US", pickDay: "Pick a day", pickTime: "Pick a time", noneTitle: "None", noneBody: "None", yours: "Times are in your time zone, {zone}.", creators: "", chosen: " · 60 minutes", submit: "Continue", note: "" };
  const html = renderToStaticMarkup(createElement(SlotPicker, { starts: [Date.now() + 3 * 86_400_000], creatorTz: NY, handle: "lena", productId: "p1", minutes: 60, words }));
  is("sends the length chosen with the time", html.includes('name="minutes" value="60"'), true);
  const priced = renderToStaticMarkup(createElement(SlotPicker, { starts: [Date.now() + 3 * 86_400_000], creatorTz: NY, handle: "lena", productId: "p1", minutes: 60, shownCents: 8000, words }));
  is("and the price it showed for it, only beside a chosen length, only to be compared", [priced.includes('name="shown" value="8000"'), html.includes('name="shown"'), renderToStaticMarkup(createElement(SlotPicker, { starts: [Date.now() + 3 * 86_400_000], creatorTz: NY, handle: "lena", productId: "p1", shownCents: 8000, words })).includes('name="shown"')], [true, false, false]);
  const plain = renderToStaticMarkup(createElement(SlotPicker, { starts: [Date.now() + 3 * 86_400_000], creatorTz: NY, handle: "lena", productId: "p1", words }));
  const moving = renderToStaticMarkup(createElement(SlotPicker, { starts: [Date.now() + 3 * 86_400_000], creatorTz: NY, handle: "lena", productId: "p1", minutes: 60, move: "cs_test_x", words }));
  is("and nothing when there is no choice, or when a booking moves at its own length", [plain.includes('name="minutes"'), moving.includes('name="minutes"')], [false, false]);
  const page = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
  is("each length is a link to its own times in a named group, the one shown marked as current and said", [page.includes('role="group" aria-labelledby={`length-${product.id}`}'), page.includes('href={lengthHref(l.minutes)}'), page.includes('aria-current={l.minutes === chosen.minutes ? "true" : undefined}'), page.includes('<p className="mt-2 text-sm">{b.lengthChosen(')], [true, true, true, true]);
  is(
    "each length's link keeps the rest of the address (a campaign's tags, a chosen host), drops an old notice, and lands on the times",
    [page.includes('if (key === "length" || key === "status" || typeof value !== "string") continue;'), page.includes('return `?${next.toString()}#times`;'), page.includes('<span id="times" />')],
    [true, true, true],
  );
  is("the times are read at the length asked for only where lengths are offered at all", page.includes("const askedLength = offerable ? bookingLength(product.call, product.priceCents, asked) : null;"), true);
  is("no live region on words the server drew: a reader is not told them twice", page.includes('role="status">{b.lengthChosen('), false);
  const route = readFileSync("app/api/store/book/route.ts", "utf8");
  is(
    "back on the booking page after any refusal, the length chosen is still chosen: only a whole number, read against the list again",
    [route.includes("const keptLength = /^\\d{1,4}$/.test(minutes) && Number(minutes) !== product.call.minutes ? `&length=${minutes}` : \"\";"), route.includes("${keptLength}${keptEmbed}`, \"Cache-Control\": \"no-store\""), page.includes("bookingLength(product.call, product.priceCents, asked)")],
    [true, true, true],
  );
  is("offered from the same rule the booking keeps, with the team the times were read for", page.includes("offeredLengths(product.call, product.priceCents, { pkg: Boolean(pkgToken), team: read.team })"), true);
  is("the price said and the line under the title are the length chosen's", [page.includes("money(chosen ? chosen.cents : product.priceCents)"), page.includes("callLine(chosen ? { ...setup, minutes: chosen.minutes } : setup, b)")], [true, true]);

  part("In every language");
  const langs = Object.entries(BOOKING_WORDS);
  is(
    "a length's price changed while the buyer chose is refused and said, never charged at a price the page did not show",
    [route.includes('if (!/^\\d{1,9}$/.test(shown) || now.cents !== Number(shown)) return back("price-changed");'), page.includes("shownCents={chosen ? chosen.cents : undefined}"), langs.every(([, w]) => Boolean(w.notices["price-changed"]?.title && w.notices["price-changed"]?.body.length > 40))],
    [true, true, true],
  );
  is(
    "a length the creator took off meanwhile is said as gone, never as a price that changed; a length sent with no shown price is refused",
    [route.includes('if (!now) return back("length-gone");'), langs.every(([, w]) => Boolean(w.notices["length-gone"]?.title && w.notices["length-gone"]?.body.length > 40)), route.includes("if (minutes && /^")],
    [true, true, false],
  );
  is("in French, a length and its price with no repeated \"pour\", and the no-break space before a semicolon", [BOOKING_WORDS.fr.lengthChosen(BOOKING_WORDS.fr.lengthOption(60, "50 €")), BOOKING_WORDS.fr.notices["price-changed"].body.includes("nouveau\u00a0;")], ["Horaires pour 60 minutes à 50 €.", true]);
  is(
    "a paid booking of a length no call may have is said to be unmovable here, never as times that could not be read",
    [page.includes('const lengthStuck = ownLength(setup, booking.end - booking.start) === "unknown";'), page.includes("const movable = blocked === null && !lengthStuck;"), page.includes("? b.lengthNotMovable"), langs.every(([, w]) => w.lengthNotMovable.length > 20)],
    [true, true, true, true],
  );
  is("a question, each length with its price, and what is shown", langs.map(([, w]) => [Boolean(w.lengthPick), w.lengthOption(60, "$80").includes("60") && w.lengthOption(60, "$80").includes("$80"), w.lengthChosen("X").includes("X")]), langs.map(() => [true, true, true]));
  is("in US English", [BOOKING_WORDS.en.lengthPick, BOOKING_WORDS.en.lengthOption(60, "$80.00"), BOOKING_WORDS.en.lengthChosen("60 minutes, $80.00")], ["How long would you like?", "60 minutes, $80.00", "Showing times for 60 minutes, $80.00."]);
}

is("each length is drawn in the store's own colors, so its focus ring and the chosen fill keep the store's contrast (2.4.13, 1.4.11)", readFileSync("app/[handle]/book/[product]/page.tsx", "utf8").includes('className={`btn ${l.minutes === chosen.minutes ? "st-btn" : "st-btn-ghost"} w-full justify-start`}'), true);
void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
