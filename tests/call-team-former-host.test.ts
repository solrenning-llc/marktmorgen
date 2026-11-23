/**
 * A team booking's host taken off the team (Claude 2 on #3336, MEDIUM,
 * privacy; synthetic only).
 *
 * A team booking keeps the hosts it was held with (lib/calls.ts, bookingTeam
 * and teamForMove, from the team as it was saved), so its time and claim are
 * never taken away. Its emails are another matter: the "New booking" email
 * carries the buyer's address, their answers before paying and the meeting
 * link, and the "Moved:" email the buyer's address and the link. Sent from
 * the saved setup, they reached a host taken off the store's team between
 * the checkout and the confirmation, or after it.
 *
 * Expected: who is still on the team is read when the emails go
 * (possibleHosts). A former host is sent nothing; the store's owner is sent
 * the creator's side instead. A team record that cannot be read in its exact
 * shape is unknown (rule 24): only the owner is told, never the saved list.
 *
 * Against the real code with an in-memory Redis and stand-ins for Stripe and
 * the sender.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, confirmBooking, holdAndCheckout, isConfirmed, moveBooking } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { writeTeam } from "@/lib/team-booking";
import { putMember, removeMember } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const NY = "America/New_York";
const OWNER = "former-host-owner@example.com";
const HOST = "former-host-left@example.com";
const STAYS = "former-host-stays@example.com";
const BUYER = "former-host-buyer@example.com";

/** Every email handed to the sender: who it went to and its subject. */
const sent: { to: string[]; subject: string; text: string }[] = [];
let sessions = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    sent.push({ to: (Array.isArray(body.to) ? body.to : [body.to]).map((t) => t.toLowerCase()), subject: body.subject, text: body.text });
    return answer({ id: `e${sent.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_formerhost${String(sessions).padStart(8, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);

/** Runs work with every GET of `key` answered by `reply`. */
async function withGet<T>(key: string, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await original(commands);
    return commands.map((c, at) => (c[0] === "GET" && c[1] === key ? reply : replies[at]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: NY,
  weekly: WEEKDAYS,
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/private-room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

function host(email: string): TeamHost {
  return { email, tz: NY, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 8 };
}

async function teamStore(mode: "round_robin" | "collective", hosts: string[]): Promise<{ store: Store; call: CallListing }> {
  await claimHandle(OWNER, "former-host", "Former Host Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestFormerHost1", true);
  await setSubscription(OWNER, { customerId: "cus_FormerHost0001", subscriptionId: "sub_FormerHost0001", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, weekly);
  const store = (await storeForEmail(OWNER)) as Store;
  for (const email of hosts) if (email !== OWNER) await putMember(store, email, "support");
  const call = (await readListing(store, made.product.id)) as CallListing;
  await writeTeam(store, call.id, { mode, hosts: hosts.map(host), createdAt: "2026-10-06T00:00:00.000Z" });
  return { store: (await storeForEmail(OWNER)) as Store, call };
}

async function hold(store: Store, call: CallListing, start: number): Promise<string> {
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error(`no hold: ${held.reason}`);
  return held.session;
}

const booked = (store: Store, call: CallListing, session: string, start: number) => ({
  store, product: call, session, start, end: start + HOUR, buyerEmail: BUYER, buyerTz: NY, cancel: null, amountCents: 12000, currency: "usd", origin: "https://marktmorgen.com",
  answers: [{ label: "What do you want to cover?", value: "My private plans" }],
});

/** Who was sent the creator's side of what was sent since `from`, by subject start. */
const creatorSide = (from: number, subject: string) => sent.slice(from).filter((m) => m.subject.startsWith(subject)).flatMap((m) => m.to).filter((to) => to !== BUYER);
const reached = (from: number, who: string) => sent.slice(from).some((m) => m.to.includes(who));

async function main(): Promise<void> {
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_former_host_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  part("Control: a host still on the team is sent the new booking");
  redis.clear();
  let shop = await teamStore("round_robin", [HOST]);
  let at = sent.length;
  const S0 = weekdayAt(9, 600);
  const s0 = await hold(shop.store, shop.call, S0);
  await confirmBooking(booked(shop.store, shop.call, s0, S0));
  is("(setup) confirmed", await isConfirmed(s0), true);
  is("the host gets the New booking email", creatorSide(at, "New booking"), [HOST]);

  part("A: the host is taken off the team between the checkout and the confirmation");
  redis.clear();
  shop = await teamStore("round_robin", [HOST]);
  const S1 = weekdayAt(10, 600);
  const s1 = await hold(shop.store, shop.call, S1);
  is("(setup) taken off the team", await removeMember(shop.store, HOST), true);
  at = sent.length;
  await confirmBooking(booked((await storeForEmail(OWNER)) as Store, shop.call, s1, S1));
  is("(setup) the booking is still confirmed: a paid booking is kept", await isConfirmed(s1), true);
  is("the former host is sent nothing: no buyer address, answers or meeting link", reached(at, HOST), false);
  is("the owner gets the New booking email instead", creatorSide(at, "New booking"), [OWNER]);
  is("the email does not name the former host", sent.slice(at).some((m) => m.text.includes(HOST)), false);

  part("B: the host is taken off the team after the confirmation, then the buyer moves");
  redis.clear();
  shop = await teamStore("round_robin", [HOST]);
  const S2 = weekdayAt(11, 600);
  const s2 = await hold(shop.store, shop.call, S2);
  await confirmBooking(booked(shop.store, shop.call, s2, S2));
  is("(setup) confirmed with the host", await isConfirmed(s2), true);
  is("(setup) taken off the team", await removeMember(shop.store, HOST), true);
  at = sent.length;
  const moved = await moveBooking({ store: (await storeForEmail(OWNER)) as Store, product: shop.call, session: s2, booked: { start: S2, end: S2 + HOUR, email: BUYER, buyerTz: NY }, start: S2 + 2 * HOUR, origin: "https://marktmorgen.com" });
  is("(setup) the move is made: a booking keeps its hosts' time", moved.ok, true);
  is("the former host is not sent the Moved email", reached(at, HOST), false);
  is("the owner gets the Moved email instead", creatorSide(at, "Moved:"), [OWNER]);

  part("C: a collective call, one host stays and one leaves");
  redis.clear();
  shop = await teamStore("collective", [HOST, STAYS]);
  const S3 = weekdayAt(12, 600);
  const s3 = await hold(shop.store, shop.call, S3);
  is("(setup) one host taken off the team", await removeMember(shop.store, HOST), true);
  at = sent.length;
  await confirmBooking(booked((await storeForEmail(OWNER)) as Store, shop.call, s3, S3));
  is("the former host is sent nothing", reached(at, HOST), false);
  is("the host still on the team gets it", creatorSide(at, "New booking"), [STAYS]);
  const named = sent.slice(at).filter((m) => m.subject.startsWith("New booking")).map((m) => m.text.split("\n").find((l) => l.startsWith("Host")));
  is("its host line names only who is still on the team", named, [`Host: ${STAYS}`]);

  part("Rule 24: the store's team in an unknown shape at the confirmation");
  for (const [label, reply] of [["a number", 42], ["text that is not JSON", "not json"], ["JSON without members", JSON.stringify({ invites: [] })]] as [string, unknown][]) {
    redis.clear();
    shop = await teamStore("round_robin", [HOST]);
    const S = weekdayAt(13, 600);
    const s = await hold(shop.store, shop.call, S);
    at = sent.length;
    await withGet(`nl:team:${shop.store.sid}`, reply, () => confirmBooking(booked(shop.store, shop.call, s, S)));
    is(`team read as ${label}: the saved host is not sent it`, reached(at, HOST), false);
    is(`team read as ${label}: only the owner is told`, creatorSide(at, "New booking"), [OWNER]);
  }

  part("Rule 24: the store's team in an unknown shape at a move");
  redis.clear();
  shop = await teamStore("round_robin", [HOST]);
  const S5 = weekdayAt(14, 600);
  const s5 = await hold(shop.store, shop.call, S5);
  await confirmBooking(booked(shop.store, shop.call, s5, S5));
  at = sent.length;
  const unknownMove = await withGet(`nl:team:${shop.store.sid}`, 42, () =>
    moveBooking({ store: shop.store, product: shop.call, session: s5, booked: { start: S5, end: S5 + HOUR, email: BUYER, buyerTz: NY }, start: S5 + 2 * HOUR, origin: "https://marktmorgen.com" }),
  );
  is("(setup) the move is made", unknownMove.ok, true);
  is("the saved host is not sent the Moved email", reached(at, HOST), false);
  is("only the owner is told", creatorSide(at, "Moved:"), [OWNER]);

  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
