/**
 * Places and member totals read only in their exact shape (sweep app5, findings 1-3; CX-123 rules 24 and 30; VR item
 * 2). Synthetic only: the in-memory Redis double, a Stripe stand-in that fails, no network.
 *
 * 1. A purchase for several (app/[handle]/group/[group]/page.tsx, lib/group-buy.ts placesTaken): a count Redis
 *    answered in another shape, or could not answer, is unknown, never "nobody took a place". The page says the
 *    places could not be checked and offers no form; a full purchase is never shown as all places open.
 * 2. A community event (lib/community-events.ts rsvpNumbers and rsvp; the event page and the events list): an
 *    unknown count is never "0 going" with places left and the RSVP form; a member's own place is read on its own,
 *    so an unknown count never hides it nor withholds the way in; an unknown place is never "not going"; taking a
 *    place with an unknown answer fails and never leaves somebody over the cap.
 * 3. All your stores (app/studio/totals/page.tsx, lib/account-totals.ts): a store whose members could not be read
 *    is named, and the member figures say they are short (or not known), never a partial sum or $0 as the whole.
 *
 * Healthy controls first in each part.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, setCommunity, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { placesTaken, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { freshConfig, saveConfig } from "@/lib/community";
import { createEvent, rsvp } from "@/lib/community-events";
import { keptMembers } from "@/lib/store-readings";
import { type StoreFigures, memberLines, membersOf, sumStores } from "@/lib/account-totals";
import type { StatsData } from "@/lib/stats";
import GroupPage from "@/app/[handle]/group/[group]/page";
import EventPage from "@/app/[handle]/community/events/[event]/page";
import EventsPage from "@/app/[handle]/community/events/page";
import { lookAs } from "./places-totals-unknown-world";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const noStripe = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

/** Answers `command`'s replies for `key` with `reply` (a throw makes the whole trip throw); everything else as Redis would. */
function onKey(names: string[], key: string, reply: () => unknown): void {
  redis.pipeline = (async (commands: Command[]) => {
    const hit = commands.some((c) => names.includes(String(c[0])) && c[1] === key);
    if (!hit) return real(commands);
    const replies = await real(commands);
    return commands.map((c, i) => (names.includes(String(c[0])) && c[1] === key ? reply() : replies[i]));
  }) as typeof redis.pipeline;
}
const odd = () => ({ unexpected: true });
const unreachable = () => {
  throw new Error("synthetic: Redis unreachable");
};

async function groupPart(): Promise<void> {
  part("1. A purchase for several: healthy control, both places taken");
  const OWNER = "placesgroup@example.com";
  await claimHandle(OWNER, "placesgroup", "Places Group", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPlGrp01", true);
  await setSubscription(OWNER, { customerId: "cus_PlacesGroup0001", subscriptionId: "sub_PlacesGroup0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const started = await startGroup(store, product, "2");
  if (!started.ok) throw new Error("no group");
  const id = started.group.id;
  const session = { id: "cs_test_" + "p".repeat(24), created: 1_900_000_000, amount_total: 9800, currency: "usd", payment_intent: "pi_PlacesGroup0001", metadata: { store: "placesgroup", product: product.id, group: id, people: "2" }, customer_details: { email: "buyer@example.com" } };
  if ((await settleGroup({ store, session, product, base: "https://marktmorgen.com/@placesgroup", from: '"Places" <hello@marktmorgen.com>' })) !== "settled") throw new Error("not settled");
  store = (await storeForEmail(OWNER))!;
  const render = async () => renderToStaticMarkup(await GroupPage({ params: Promise.resolve({ handle: "@placesgroup", group: id }), searchParams: Promise.resolve({}) }));
  const facts = (html: string) => ({
    allTaken: html.includes("All 2 places have been taken."),
    open: /places? (is|are) still open/.test(html),
    form: html.includes("Send me the link to my place"),
    unchecked: html.includes("We could not check how many places are left just now. Try this page again in a moment."),
  });
  is("before anybody joins: 2 of 2 open, with the form", facts(await render()), { allTaken: false, open: true, form: true, unchecked: false });
  for (const email of ["ana@example.com", "ben@example.com"]) {
    const t = Buffer.from(email.padEnd(32, "x").slice(0, 32)).toString("hex");
    await real([["SET", `nl:grp:take:${t}`, JSON.stringify({ g: id, e: email }), "EX", 3600]]);
    await takePlace({ store, token: t, recordStart: async () => {} });
  }
  is("placesTaken reads 2", await placesTaken(id), 2);
  is("the page says every place is taken and offers no form", facts(await render()), { allTaken: true, open: false, form: false, unchecked: false });

  part("1. The count answered in an unknown shape");
  onKey(["GET"], `nl:grp:${id}:n`, odd);
  is("placesTaken refuses it (throws), never 0", await placesTaken(id).then(() => "answered", () => "threw"), "threw");
  is("the page says the places could not be checked, never all open, and offers no form", facts(await render()), { allTaken: false, open: false, form: false, unchecked: true });
  onKey(["GET"], `nl:grp:${id}:n`, () => "2.5");
  is("a count that is not a whole number is refused too", await placesTaken(id).then(() => "answered", () => "threw"), "threw");
  redis.pipeline = real;

  part("1. Redis could not be reached for the count");
  onKey(["GET"], `nl:grp:${id}:n`, unreachable);
  is("the page says the places could not be checked and offers no form", facts(await render()), { allTaken: false, open: false, form: false, unchecked: true });
  redis.pipeline = real;
  is("control again: all taken", facts(await render()), { allTaken: true, open: false, form: false, unchecked: false });
}

async function eventPart(): Promise<void> {
  part("2. A community event: healthy control, both places taken, doors open");
  const OWNER = "placesevent@example.com";
  await claimHandle(OWNER, "placesevent", "Places Event", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PlacesEvent0001", subscriptionId: "sub_PlacesEvent0001", active: true, tier: "pro", period: paidPeriod() });
  const club = (await setCommunity(OWNER, true))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  // Doors open 15 minutes before the start: it starts in 10.
  const made = await createEvent(club, { title: "Live bake-along", about: "", start: Date.now() + 10 * 60_000, minutes: 60, tz: "UTC", cap: 2, where: "room", link: "", meet: null, only: [] });
  if (!made.ok) throw new Error(`no event: ${JSON.stringify(made)}`);
  const event = made.event;
  const key = `nl:cm:${cid}:ev:${event.id}:r`;
  await real([["HSET", key, "member-ana", "1", "member-ben", "1"]]);
  const room = event.room ?? "";
  is("the event has a video room", room.length > 0, true);

  const page = async (who: string) => {
    lookAs({ key: who, owner: false, email: `${who}@example.com` });
    return renderToStaticMarkup(await EventPage({ params: Promise.resolve({ handle: "@placesevent", event: event.id }), searchParams: Promise.resolve({}) }));
  };
  const list = async (who: string) => {
    lookAs({ key: who, owner: false, email: `${who}@example.com` });
    return renderToStaticMarkup(await EventsPage({ params: Promise.resolve({ handle: "@placesevent" }), searchParams: Promise.resolve({}) }));
  };
  const facts = (html: string) => ({
    going: html.includes("You are going"),
    form: html.includes("RSVP and take a place"),
    full: html.includes("Every place is taken"),
    room: html.includes(room),
    zero: html.includes("0 going"),
    countUnchecked: html.includes("who is going could not be checked"),
    placeUnchecked: html.includes("We could not check your place just now. Try this page again in a moment."),
    placesUnchecked: html.includes("We could not check the places left just now. Try this page again in a moment."),
  });
  const base = { going: false, form: false, full: false, room: false, zero: false, countUnchecked: false, placeUnchecked: false, placesUnchecked: false };
  is("ana, who holds a place: told she is going, gets the way in", facts(await page("member-ana")), { ...base, going: true, room: true });
  is("cy, who does not: every place is taken, no form, no way in", facts(await page("member-cy")), { ...base, full: true });
  is("the list: 2 going, full", [(await list("member-cy")).includes("2 going"), (await list("member-cy")).includes("0 going")], [true, false]);

  part("2. The count (HLEN) answered in an unknown shape; each member's own place read exactly");
  onKey(["HLEN"], key, odd);
  is("ana: still told she is going and still gets the way in; the count is said as not checked", facts(await page("member-ana")), { ...base, going: true, room: true, countUnchecked: true });
  is("cy: no form and no '0 going'; the places are said as not checked", facts(await page("member-cy")), { ...base, countUnchecked: true, placesUnchecked: true });
  const listed = await list("member-cy");
  is("the list: never '0 going' or places left; the count is said as not checked", [listed.includes("0 going"), /places? left/.test(listed), listed.includes("who is going could not be checked")], [false, false, true]);
  redis.pipeline = real;

  part("2. The member's own place (HEXISTS) and the count both unknown");
  onKey(["HLEN", "HEXISTS"], key, odd);
  is("ana: never told she is not going, never offered a form; her place is said as not checked; no way in", facts(await page("member-ana")), { ...base, countUnchecked: true, placeUnchecked: true });
  redis.pipeline = real;

  part("2. Redis could not be reached for the places at all");
  onKey(["HLEN", "HEXISTS"], key, unreachable);
  is("ana: her place is said as not checked; no form", facts(await page("member-ana")), { ...base, countUnchecked: true, placeUnchecked: true });
  redis.pipeline = real;
  is("control again: ana gets the way in", facts(await page("member-ana")), { ...base, going: true, room: true });

  part("2. Taking a place when Redis answers in an unknown shape (rsvp)");
  await real([["HDEL", key, "member-ben"]]);
  onKey(["HEXISTS"], key, odd);
  is("an unknown 'already going?' answer fails, nothing written", [await rsvp(cid, event, "member-dan", club).then((r) => r, () => "threw"), await real([["HEXISTS", key, "member-dan"]])], ["threw", [0]]);
  redis.pipeline = real;
  // Ana already holds one of the two places; somebody else takes the other at the same moment, and the length is unknown.
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    if (commands.some((c) => c[0] === "HSETNX" && c[1] === key)) {
      await real([["HSET", key, "member-eve", "1"]]);
      return commands.map((c, i) => (c[0] === "HLEN" && c[1] === key ? odd() : replies[i]));
    }
    return replies;
  }) as typeof redis.pipeline;
  const taken = await rsvp(cid, event, "member-dan", club).then((r) => r, () => "threw");
  redis.pipeline = real;
  is("an unknown length after writing fails, and the place is given back (never over the cap)", [taken, await real([["HEXISTS", key, "member-dan"]]), await real([["HLEN", key]])], ["threw", [0], [2]]);
  await real([["HDEL", key, "member-eve"]]);
  is("healthy control: the free place is taken", await rsvp(cid, event, "member-dan", club), "added");

  part("2. The creator's push before an event never says a count that was not read");
  const mail = readFileSync("lib/community-event-mail.ts", "utf8");
  is("no '?.going ?? 0' left", mail.includes("?.going ?? 0"), false);
}

async function totalsPart(): Promise<void> {
  const t = { visitors: 10, views: 20, checkouts: 2, sales: 1, cents: 1_000 };
  const data = { totals: { d7: t, d30: t, d90: t, all: t }, currency: "usd", sales: "ok", partial: false } as unknown as StatsData;
  const figures = (name: string, read: StoreFigures["read"]): StoreFigures => ({ sid: name.toLowerCase(), name, handle: name.toLowerCase(), read });
  // Whole readings in one currency (complete, none elsewhere): the shape membersOf now keeps (Claude 1 on #2992).
  const bread = { currency: "usd", paying: 3, trialing: 1, mrr: 2_700, complete: true, elsewhere: 0 };
  const pasta = { currency: "usd", paying: 40, trialing: 2, mrr: 36_000, complete: true, elsewhere: 0 };

  part("3. All your stores: healthy control");
  const healthy = sumStores([figures("Bread", { state: "ok", data, members: bread }), figures("Pasta", { state: "ok", data, members: pasta })]);
  is("43 paying, 3 on trial, $387 a month, no note", memberLines(healthy), { paying: "43", trialing: "3", mrr: "$387", note: null });
  const none = sumStores([figures("Bread", { state: "ok", data, members: null })]);
  is("a store with no memberships counts as none, with no note", [memberLines(none), none.members.unread], [{ paying: "0", trialing: "0", mrr: "$0", note: null }, []]);

  part("3. A store's members read fails (Stripe cannot be reached)");
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_places_totals_only";
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 500 })) as typeof fetch;
  const OWNER = "placestotals@example.com";
  await claimHandle(OWNER, "placestotals", "Places Totals", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPlTot01", true);
  const shop = (await storeForEmail(OWNER))!;
  is("the read is kept as unread, never as no members", await membersOf(keptMembers(shop)), "unread");
  globalThis.fetch = noStripe;
  is("a read that answers is kept as it is", [await membersOf(Promise.resolve(null)), await membersOf(Promise.resolve({ ...bread, atRisk: 0, atRiskMrr: 0, ended30: 0, endedMrr30: 0 } as never))], [null, bread]);

  part("3. One store's members unread");
  const one = sumStores([figures("Bread", { state: "ok", data, members: bread }), figures("Pasta", { state: "ok", data, members: "unread" })]);
  is("Pasta is named as unread", one.members.unread, ["Pasta"]);
  is("the figures say they are at least, and the note names Pasta", memberLines(one), {
    paying: "At least 3",
    trialing: "At least 1",
    mrr: "At least $27",
    note: "Members could not be read just now for Pasta, so the member numbers below leave it out and may be lower than they are.",
  });
  is("its visits and sales are still added", one.counted, 2);

  part("3. Every store's members unread");
  const both = sumStores([figures("Bread", { state: "ok", data, members: "unread" }), figures("Pasta", { state: "ok", data, members: "unread" })]);
  is("never 0 or $0: not known, and the note names both", memberLines(both), {
    paying: "Not known",
    trialing: "Not known",
    mrr: "Not known",
    note: "Members could not be read just now for Bread and Pasta, so the member numbers are not shown.",
  });

  // Claude 1 on #2992 at 722c525e (LEVE, rule 30): a store's own reading can be short (more memberships than one
  // reading takes: complete false) or leave some out of the money (memberships in another currency: elsewhere > 0).
  // Its studio page says so; the totals showed those figures as the whole.
  part("3. A store's members read short, or with memberships in another currency");
  const reading = (over: Record<string, unknown>) => ({ ...bread, atRisk: 0, atRiskMrr: 0, ended30: 0, endedMrr30: 0, complete: true, elsewhere: 0, ...over });
  const shortRead = await membersOf(Promise.resolve(reading({ complete: false }) as never));
  const apartRead = await membersOf(Promise.resolve(reading({ elsewhere: 2 }) as never));
  is("membersOf keeps whether the reading was whole, and how many are in another currency", [shortRead, apartRead], [
    { ...bread, complete: false, elsewhere: 0 },
    { ...bread, complete: true, elsewhere: 2 },
  ]);
  const wholeRead = { ...pasta, complete: true, elsewhere: 0 };
  const short = sumStores([figures("Bread", { state: "ok", data, members: shortRead }), figures("Pasta", { state: "ok", data, members: wholeRead })]);
  is("short reading: every member figure says at least, and the note names Bread", memberLines(short), {
    paying: "At least 43",
    trialing: "At least 3",
    mrr: "At least $387",
    note: "Bread has more memberships than one reading takes, so the oldest are not in the member numbers below and they may be lower than they are.",
  });
  const apart = sumStores([figures("Bread", { state: "ok", data, members: apartRead }), figures("Pasta", { state: "ok", data, members: wholeRead })]);
  is("another currency: members are counted, the monthly money says at least, and the note names Bread", memberLines(apart), {
    paying: "43",
    trialing: "3",
    mrr: "At least $387",
    note: "Some memberships of Bread are in another currency, so they are counted as members but are not in the monthly recurring revenue.",
  });
  const allThree = sumStores([
    figures("Bread", { state: "ok", data, members: shortRead }),
    figures("Pasta", { state: "ok", data, members: { ...pasta, complete: true, elsewhere: 1 } }),
    figures("Rye", { state: "ok", data, members: "unread" }),
  ]);
  is("unread, short and another currency together: each said once, in that order", memberLines(allThree), {
    paying: "At least 43",
    trialing: "At least 3",
    mrr: "At least $387",
    note:
      "Members could not be read just now for Rye, so the member numbers below leave it out and may be lower than they are. " +
      "Bread has more memberships than one reading takes, so the oldest are not in the member numbers below and they may be lower than they are. " +
      "Some memberships of Pasta are in another currency, so they are counted as members but are not in the monthly recurring revenue.",
  });
  const unknownShape = await membersOf(Promise.resolve({ currency: "usd", paying: 3, trialing: 1, mrr: 2_700 } as never));
  is("a reading without the whole/other-currency fields is taken as short (never whole), with no other currency made up", unknownShape !== null && unknownShape !== "unread" && [unknownShape.complete, unknownShape.elsewhere], [false, 0]);
  is("control: whole readings in one currency still show exact figures with no note", memberLines(sumStores([figures("Pasta", { state: "ok", data, members: wholeRead })])), {
    paying: "40",
    trialing: "2",
    mrr: "$360",
    note: null,
  });

  part("3. The page keeps the failure");
  const pageSource = readFileSync("app/studio/totals/page.tsx", "utf8");
  is("members read through membersOf, never .catch(() => null), and drawn from memberLines", [pageSource.includes("keptMembers(store).catch(() => null)"), pageSource.includes("membersOf(keptMembers(store))"), pageSource.includes("memberLines(totals)")], [false, true, true]);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_places_groups_only";
  globalThis.fetch = noStripe;
  await groupPart();
  redis.clear();
  await eventPart();
  await totalsPart();
  done();
}

void main();
