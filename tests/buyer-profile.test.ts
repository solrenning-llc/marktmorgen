/**
 * A buyer's page in the studio (lib/buyer-profile.ts, added 11 October
 * 2026). Checked:
 *
 *   - only this store's sales are on it, each payment counted once: a
 *     checkout, a one-click extra after it, a membership's first invoice
 *     folded into its sale and a later one shown as a payment of its own;
 *   - what was given back is taken off, whole or in part, and money in
 *     another currency is kept apart;
 *   - where they first found the store, and where the latest sale came from;
 *   - the membership's state, the course's progress, the list's record;
 *   - notes are kept under a key that is not the address, one field each,
 *     at most MAX_PERSON_NOTES, and all of a store's go when it is deleted;
 *   - a search's token opens the page on the store it was made on only, and
 *     a sale opens its buyer only when it is this store's.
 */
import {
  MAX_PERSON_NOTES,
  addPersonNote,
  addressForSale,
  addressForToken,
  buyerProfile,
  findToken,
  forgetPersonNotes,
  personKey,
  readAddress,
  readPersonNotes,
  removePersonNote,
} from "@/lib/buyer-profile";
import { leadsKey } from "@/lib/contacts";
import { markLesson, touchStudent } from "@/lib/learn";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const NOW = Math.floor(Date.parse("2026-10-11T12:00:00Z") / 1000);
const DAY = 86_400;
const STATS = "a".repeat(32);
const COURSE = "c".repeat(32);

const charge = (id: string, amount: number, refunded = 0, created = NOW, extra: Record<string, unknown> = {}) => ({
  id,
  object: "charge",
  status: "succeeded",
  paid: true,
  amount,
  amount_refunded: refunded,
  currency: "usd",
  created,
  ...extra,
});

const sessions = [
  // A course, paid once, with a channel written on it; its customer took an extra.
  {
    id: "cs_test_course000000001",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: NOW - 30 * DAY,
    amount_total: 2900,
    currency: "usd",
    customer: "cus_course0001",
    customer_details: { email: "Buyer@Example.com", name: "Ada Baker" },
    payment_intent: { id: "pi_course000000001", latest_charge: charge("ch_course01", 2900, 0, NOW - 30 * DAY) },
    metadata: { store: "bakery", product: "course1", title: "Bread School", channel: "instagram", channel_first: "tiktok", channel_campaign: "october-reel" },
  },
  // A membership: its first invoice is the sale, a later one a payment of its own.
  {
    id: "cs_test_club0000000001",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    created: NOW - 40 * DAY,
    amount_total: 1500,
    currency: "usd",
    customer: "cus_club000001",
    customer_details: { email: "buyer@example.com" },
    payment_intent: null,
    subscription: { id: "sub_club1", status: "active", start_date: NOW - 40 * DAY, cancel_at_period_end: false },
    metadata: { store: "bakery", product: "club1", title: "Bakers' Club", channel: "youtube" },
  },
  // Refunded in full, sold before channels were written down.
  {
    id: "cs_test_old00000000001",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: NOW - 60 * DAY,
    amount_total: 1000,
    currency: "usd",
    customer: null,
    customer_details: { email: "buyer@example.com" },
    payment_intent: { id: "pi_old0000000000001", latest_charge: charge("ch_old0001", 1000, 1000, NOW - 60 * DAY) },
    metadata: { store: "bakery", product: "gone1", title: "Old Recipes" },
  },
  // Paid in euros: kept apart from the dollars.
  {
    id: "cs_test_euro0000000001",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: NOW - 5 * DAY,
    amount_total: 800,
    currency: "eur",
    customer: null,
    customer_details: { email: "buyer@example.com" },
    payment_intent: { id: "pi_euro000000000001", latest_charge: { ...charge("ch_euro0001", 800, 0, NOW - 5 * DAY), currency: "eur" } },
    metadata: { store: "bakery", product: "course1", title: "Bread School" },
  },
  // A one-off sale whose payment came back as an id only: counted at what the checkout took.
  {
    id: "cs_test_plain000000001",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: NOW - 20 * DAY,
    amount_total: 700,
    currency: "usd",
    customer: null,
    customer_details: { email: "buyer@example.com" },
    payment_intent: "pi_plain00000000001",
    metadata: { store: "bakery", product: "list1", title: "Pantry List", channel: "direct" },
  },
  // Another store's sale on the same Stripe account: never on this page.
  {
    id: "cs_test_other000000001",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: NOW - 2 * DAY,
    amount_total: 9900,
    currency: "usd",
    customer: null,
    customer_details: { email: "buyer@example.com" },
    payment_intent: { id: "pi_other00000000001", latest_charge: charge("ch_other001", 9900) },
    metadata: { store: "somebody-else", product: "x", title: "Not ours" },
  },
  // Opened and never paid: not a sale.
  {
    id: "cs_test_unpaid00000001",
    mode: "payment",
    status: "complete",
    payment_status: "unpaid",
    created: NOW - 1 * DAY,
    amount_total: 500,
    currency: "usd",
    customer: null,
    customer_details: { email: "buyer@example.com" },
    payment_intent: null,
    metadata: { store: "bakery", product: "course1", title: "Bread School" },
  },
];

const charges: Record<string, unknown[]> = {
  cus_course0001: [
    // The checkout's own payment, listed again under its customer: counted once.
    charge("ch_course01", 2900, 0, NOW - 30 * DAY, { payment_intent: { id: "pi_course000000001", metadata: {} } }),
    charge("ch_extra001", 900, 0, NOW - 30 * DAY + 120, { payment_intent: { id: "pi_extra0000000001", metadata: { kind: "upsell", store: "bakery", title: "Starter Kit", product: "kit1" } } }),
    // A failed one-click payment: not money.
    { ...charge("ch_failed01", 900, 0, NOW - 29 * DAY), status: "failed", paid: false, payment_intent: { id: "pi_failed000000001", metadata: { kind: "upsell", store: "bakery" } } },
  ],
  cus_club000001: [
    charge("ch_clubfirst", 1500, 0, NOW - 40 * DAY + 30, { payment_intent: { id: "pi_clubfirst000001", metadata: {} } }),
    charge("ch_clubnext1", 1500, 500, NOW - 10 * DAY, { payment_intent: { id: "pi_clubnext0000001", metadata: {} } }),
  ],
};

let stripeDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  if (stripeDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  if (url.pathname === "/v1/checkout/sessions") {
    const email = (url.searchParams.get("customer_details[email]") ?? "").toLowerCase();
    return new Response(JSON.stringify({ data: sessions.filter((s) => s.customer_details.email.toLowerCase() === email), has_more: false }));
  }
  const one = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_\w+)$/)?.[1];
  if (one) {
    const found = sessions.find((s) => s.id === one);
    return found ? new Response(JSON.stringify(found)) : new Response(JSON.stringify({ error: { message: "No such session" } }), { status: 404 });
  }
  if (url.pathname === "/v1/charges") {
    return new Response(JSON.stringify({ data: charges[url.searchParams.get("customer") ?? ""] ?? [], has_more: false }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const products = [
  { id: "course1", title: "Bread School", course: { id: COURSE, lessons: 4 }, options: [] },
  { id: "club1", title: "Bakers' Club", course: null, options: [] },
];

function shop(): Store {
  return {
    sid: "sidbake00001",
    handle: "bakery",
    name: "Oven Notes",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    listId: "list0001",
    callsId: null,
    currency: "usd",
    language: "en",
    stripeAccountId: "acct_test_profile1",
    pastBuyers: false,
    catalog: { id: null, head: [], items: products.map((p) => ({ id: p.id, kind: 0, options: [] })), inline: products },
  } as unknown as Store;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_profile_only_a_stand_in";
  const store = shop();
  await redis.pipeline([
    ["HSET", leadsKey("list0001"), "buyer@example.com", JSON.stringify({ agreed: true, agreedAt: "2026-09-01T10:00:00.000Z", firstAt: "2026-09-01T10:00:00.000Z", lastAt: "2026-09-11T10:00:00.000Z", titles: [], ids: [], source: "buyer", unsub: false, unsubAt: "", t: "", name: "", tags: ["vip"], importedAt: "" })],
  ]);
  await touchStudent(COURSE, "buyer@example.com", NOW - 30 * DAY, ROOM);
  await markLesson(COURSE, "buyer@example.com", "lesson000001", true, ROOM);
  await markLesson(COURSE, "buyer@example.com", "lesson000002", true, ROOM);

  part("What they paid");
  const profile = await buyerProfile(store, "  BUYER@example.com ");
  is("the address, as one", profile.email, "buyer@example.com");
  is("the name Stripe has", profile.name, "Ada Baker");
  is(
    "this store's sales and payments only, newest first",
    profile.orders.map((o) => [o.kind, o.title, o.cents, o.refunded]),
    [
      ["sale", "Bread School", 800, 0],
      ["renewal", "Bakers' Club", 1500, 500],
      ["sale", "Pantry List", 700, 0],
      ["added", "Starter Kit", 900, 0],
      ["sale", "Bread School", 2900, 0],
      ["sale", "Bakers' Club", 1500, 0],
      ["sale", "Old Recipes", 1000, 1000],
    ],
  );
  is("paid in dollars, each payment once", profile.paid, 2900 + 900 + 1500 + 1500 + 1000 + 700);
  is("and given back", profile.refunded, 500 + 1000);
  is("euros kept apart", profile.otherCurrencies, { eur: 800 });
  is("purchases and later payments", [profile.purchases, profile.renewals], [6, 1]);

  part("Where they came from");
  is("first and latest purchase", [profile.firstAt, profile.lastAt], [NOW - 60 * DAY, NOW - 5 * DAY]);
  is("a channel is known for some of their sales", profile.channelKnown, true);
  is("the course sale's channel and campaign", profile.orders.find((o) => o.reference === "cs_test_course000000001")?.channel, "instagram");
  is("where they found the store, from the earliest sale that says, not the older one that does not", profile.firstChannel, "youtube");
  is("the latest purchase that says: direct, which is not the same as not recorded", [profile.lastChannel, profile.orders.find((o) => o.title === "Pantry List")?.recorded, profile.orders.find((o) => o.title === "Old Recipes")?.recorded], ["", true, false]);

  part("Membership, course, list");
  is("the membership, paying", profile.memberships.map((m) => [m.title, m.status]), [["Bakers' Club", "active"]]);
  is("the course, two of four lessons", profile.courses.map((c) => [c.title, c.done, c.lessons, c.lastSeen > 0]), [["Bread School", 2, 4, true]]);
  is("on the list, agreed, with its labels", [profile.contact?.agreed, profile.contact?.tags], [true, ["vip"]]);
  is("Stripe was read in full", [profile.partial, profile.stripeError], [false, false]);

  part("Notes");
  const person = personKey(STATS, "Buyer@Example.com");
  is("the key is the same whatever the capitals, and is not the address", [person === profile.person, person.includes("buyer")], [true, false]);
  is("empty words are not a note", await addPersonNote(STATS, person, "owner@example.com", "   ", ROOM), null);
  const one = await addPersonNote(STATS, person, "Owner@Example.com", "Asked about the advanced course.\n\n\n\nPrefers email.", ROOM, NOW * 1000);
  is("a note, with who wrote it and its line breaks kept", one?.map((n) => [n.by, n.text]), [["owner@example.com", "Asked about the advanced course.\n\nPrefers email."]]);
  for (let i = 0; i < MAX_PERSON_NOTES + 3; i += 1) await addPersonNote(STATS, person, "owner@example.com", `note ${i}`, ROOM, (NOW + i + 1) * 1000);
  const many = await readPersonNotes(STATS, person);
  is("at most MAX_PERSON_NOTES, the newest kept", [many.length, many[0].text], [MAX_PERSON_NOTES, `note ${MAX_PERSON_NOTES + 2}`]);
  is("one taken away", (await removePersonNote(STATS, person, many[0].id, ROOM)).length, MAX_PERSON_NOTES - 1);
  const keys = [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((k) => k.startsWith("nl:person:"));
  is("no key holds the address", keys.some((k) => k.includes("buyer")), false);
  await forgetPersonNotes(STATS);
  const left = [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((k) => k.startsWith(`nl:person:${STATS}`)).length;
  is("a deleted store's notes all go", [left, (await readPersonNotes(STATS, person)).length], [0, 0]);

  part("Opening a buyer's page");
  is("an address is read as one; anything else is not", [readAddress(" Buyer@Example.com "), readAddress("nope"), readAddress(42)], ["buyer@example.com", "", ""]);
  const token = (await findToken(store, "buyer@example.com")) ?? "";
  is("a search's token opens it on its own store", await addressForToken(store, token), "buyer@example.com");
  is("and on no other", await addressForToken({ sid: "sidother0001" }, token), null);
  is("a made-up token opens nothing", await addressForToken(store, "0".repeat(48)), null);
  is("a sale of this store opens its buyer", await addressForSale(store, "cs_test_course000000001"), "buyer@example.com");
  is("another store's sale opens nobody", await addressForSale(store, "cs_test_other000000001"), null);
  is("something that is not a sale's reference is not looked up", await addressForSale(store, "../../v1/customers"), null);

  part("Free days given to a paying member (641 [WG1]; review of #2912, M1, fixed by Claude 4 on Claude 5's behalf)");
  // Free days are Stripe's trial_end: it answers "trialing", and the membership's own record says they were given to a paid one.
  const club = sessions.find((s) => s.id === "cs_test_club0000000001")!;
  const paid = club.subscription;
  const freeEnd = NOW + 27 * DAY;
  club.subscription = { ...paid, status: "trialing", trial_end: freeEnd, metadata: { store: "bakery", product: "club1", mm_free_days_until: String(freeEnd), mm_trial_end_before: "0" } } as typeof paid;
  is("a member who paid and was given free days is shown paying, never 'in a free trial'", (await buyerProfile(store, "buyer@example.com")).memberships.map((m) => m.status), ["active"]);
  club.subscription = { ...paid, status: "trialing", trial_end: freeEnd } as typeof paid;
  is("control: a real free trial is still shown as one", (await buyerProfile(store, "buyer@example.com")).memberships.map((m) => m.status), ["trialing"]);
  club.subscription = paid;

  part("When Stripe cannot be read");
  stripeDown = true;
  const down = await buyerProfile(store, "buyer@example.com");
  is("the page says so, and the rest is still there", [down.stripeError, down.orders.length, down.contact?.agreed, down.courses.length], [true, 0, true, 0]);
  stripeDown = false;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
