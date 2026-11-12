/**
 * Counters read in their exact shape before what they guard (audit SG2,
 * CX-123 rule 24; the margin rule's ceiling before every cost).
 *
 * Counters were read with Number(...): a reply that was missing, cut
 * short, of another shape or never came read as NaN (never past a ceiling)
 * or as 0/1 (always within it), so the call to Stripe, the email or the
 * write behind it went ahead on a count nobody had. Each is called here as
 * its route calls it, on the in-memory store, with only the counter's own
 * pipeline answered differently:
 *
 *   - lib/card-update.ts openCardUpdate: presses of the card link, before Stripe;
 *   - lib/group-buy.ts askPlace: places taken and links sent, before the email;
 *   - lib/group-buy.ts takePlace: the place being taken, before the product is given;
 *   - lib/free.ts requestCopy and spendClaim: requests an hour and uses of a link,
 *     before the email and before the file.
 *
 * An unknown reply is refused with the answer the code already gives when
 * something failed, and nothing behind the counter happens. A confirmed
 * count within the ceiling still goes through, and one past it is refused as
 * before.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { cardLink, openCardUpdate } from "@/lib/card-update";
import { askPlace, placeNotice, placesTaken, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { addressHash, grantImported, importedFor, importedKey } from "@/lib/imported-purchases";
import { recordEnrollment } from "@/lib/learn";
import { admitOrders, settleAdmitted } from "@/lib/order-admission";
import { requestCopy, spendClaim } from "@/lib/free";
import { POST as freeDownload } from "@/app/api/store/free/download/route";
import { NextRequest } from "next/server";
import { paidPeriod } from "./billing-period-fixture";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

/** Which pipeline is the counter's, and what it answers instead ("throw" for one that never answers). */
let counter: { match: (commands: Command[]) => boolean; reply: unknown } | null = null;
let counterCalls = 0;
/** Every command that reached the store, to see what was written after the counter. */
const seen: Command[] = [];
const pipeline = redis.pipeline.bind(redis);
/**
 * Answers lost on the way back, as a timeout loses them: "after" runs the
 * commands on the store and then throws, so they were done and nobody heard;
 * "before" throws without running them, so they were not done. Each is used
 * once, in the order given.
 */
let lost: { match: (commands: Command[]) => boolean; when: "after" | "before" }[] = [];
/** Something another request does around one pipeline, once: just before it runs, and just after. */
let around: { match: (commands: Command[]) => boolean; before: () => void; after: () => void } | null = null;
redis.pipeline = (async (commands: Command[]) => {
  if (around && around.match(commands)) {
    const { before, after } = around;
    around = null;
    before();
    const replies = await pipeline(commands);
    seen.push(...commands);
    after();
    return replies;
  }
  const loss = lost.findIndex((l) => l.match(commands));
  if (loss >= 0) {
    const [{ when }] = lost.splice(loss, 1);
    if (when === "after") {
      seen.push(...commands);
      await pipeline(commands);
    }
    throw new Error("the answer never came back");
  }
  if (counter && counter.match(commands)) {
    counterCalls++;
    if (counter.reply === "throw") throw new Error("the database did not answer");
    return counter.reply;
  }
  seen.push(...commands);
  return pipeline(commands);
}) as typeof redis.pipeline;

type Mail = { to: string; subject: string; text: string };
const mails: Mail[] = [];
let stripeCalls = 0;
const SUB = "sub_CardGate000001";
const CUSTOMER = "cus_CardGate00001";
const ACCOUNT = "acct_1NumberGatesAAA";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return answer({ id: `email_${mails.length}` });
  }
  if (url.hostname === "api.stripe.com") {
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    if (path === `/subscriptions/${SUB}` && method === "GET") {
      stripeCalls++;
      return answer({ id: SUB, status: "active", customer: CUSTOMER, metadata: { store: "numbergates" }, latest_invoice: null });
    }
    if (path === "/checkout/sessions" && method === "POST") {
      stripeCalls++;
      return answer({ id: `cs_test_${"g".repeat(24)}`, url: "https://checkout.stripe.com/c/setup/test" });
    }
    return answer({ object: "list", data: [], has_more: false });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** What a call answered, or that it threw and with what. */
async function outcome<T>(call: () => Promise<T>): Promise<T | string> {
  try {
    return await call();
  } catch (error) {
    return `threw ${error instanceof Error ? error.name : "something"}`;
  }
}

/** Replies of a SET ... NX then INCR pipeline that are not a confirmed count. */
const SET_INCR_UNKNOWN: [string, unknown][] = [
  ["a SET answered false", [false, 1]],
  ["a count that is null", ["OK", null]],
  ["a count written as text", ["OK", "1"]],
  ["a count of zero after INCR", ["OK", 0]],
  ["a count that is true", ["OK", true]],
  ["a count that is not whole", ["OK", 1.5]],
  ["a reply that is not a list", { x: 1 }],
  ["a reply cut short", ["OK"]],
  ["an empty reply", []],
  ["a counter that never answers", "throw"],
];

/** Replies of a pipeline whose first command is the INCR, `length` commands long. */
const incrFirstUnknown = (length: number): [string, unknown][] => {
  const rest = Array.from({ length: length - 1 }, () => 1);
  return [
    ["a count that is null", [null, ...rest]],
    ["a count written as text", ["1", ...rest]],
    ["a count of zero after INCR", [0, ...rest]],
    ["a count that is true", [true, ...rest]],
    ["a count that is negative", [-1, ...rest]],
    ["a count that is not whole", [1.5, ...rest]],
    ["a reply that is not a list", { x: 1 }],
    ["a reply cut short", length > 1 ? [1] : []],
    ["a reply too long", [1, ...rest, 1]],
    ["a counter that never answers", "throw"],
  ];
};

const key = (command: Command | undefined) => String(command?.[1] ?? "");

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.STRIPE_SECRET_KEY = "sk_test_number_gates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const OWNER = "owner@numbergates.example";
  const made = await claimHandle(OWNER, "numbergates", "Number Gates", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_NumberGates01", subscriptionId: "sub_NumberGates01", active: true, tier: "creator", period: paidPeriod() });
  const course = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  const guide = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  if (!course.ok || !guide.ok) throw new Error("no products");
  await setProductLink(OWNER, course.product.id, "https://example.com/course");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide.pdf");
  const store: Store = (await storeForEmail(OWNER))!;

  part("The card link: presses counted before Stripe is asked (lib/card-update.ts)");
  {
    const token = await cardLink(ACCOUNT, CUSTOMER, SUB);
    const isOpens = (commands: Command[]) => commands[0]?.[0] === "SET" && key(commands[0]).startsWith("nl:card:opens:");
    const open = () => outcome(() => openCardUpdate(store, token, "https://marktmorgen.com"));
    for (const [label, reply] of SET_INCR_UNKNOWN) {
      counter = { match: isOpens, reply };
      const [calls, stripe, from] = [counterCalls, stripeCalls, seen.length];
      const got = await open();
      const wrote = seen.slice(from).filter((c) => key(c).startsWith("nl:card:open:")).length;
      is(`${label}: refused as an error, Stripe never asked, nothing kept`, [got, counterCalls - calls, stripeCalls - stripe, wrote], [{ ok: false, reason: "error" }, 1, 0, 0]);
    }
    counter = { match: isOpens, reply: ["OK", 1] };
    const confirmed = await open();
    is("a confirmed first press opens Stripe's page", [typeof confirmed === "object" && confirmed.ok, stripeCalls > 0], [true, true]);
    counter = { match: isOpens, reply: [null, 21] };
    const stripe = stripeCalls;
    is("a confirmed count past the presses allowed is refused as used, as before", [await open(), stripeCalls - stripe], [{ ok: false, reason: "used" }, 0]);
    counter = null;
  }

  // A purchase for two, paid, that hands out places.
  const product = (await readListing(store, course.product.id))!;
  const BASE = "https://marktmorgen.com/@numbergates";
  const FROM = '"Number Gates" <hello@marktmorgen.com>';
  const paidGroup = async (pi: string) => {
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no purchase for several");
    const id = started.group.id;
    const session = { id: `cs_test_${pi.slice(-1).repeat(24)}`, created: 1_900_000_000, amount_total: 9800, currency: "usd", payment_intent: pi, metadata: { store: "numbergates", product: product.id, group: id, people: "2" }, customer_details: { email: "buyer@numbergates.example" } };
    if ((await settleGroup({ store, session, product, base: BASE, from: FROM })) !== "settled") throw new Error("not settled");
    return id;
  };
  const tokenFor = (address: string) => mails.filter((m) => m.to === address).at(-1)?.text.match(/\?take=([0-9a-f]{64})/)?.[1] ?? "";

  part("Asking for a place: places taken and links sent counted before the email (lib/group-buy.ts askPlace)");
  {
    const id = await paidGroup("pi_NumberGatesA");
    let n = 0;
    const ask = () => outcome(() => askPlace({ store, id, email: `place${(n += 1)}@numbergates.example`, product, base: BASE, from: FROM, ordersLink: async () => null }));
    const isTaken = (commands: Command[]) => commands.length === 3 && commands[0]?.[0] === "HEXISTS" && commands[1]?.[0] === "HLEN" && key(commands[1]).startsWith("nl:grp:");
    const isMail = (commands: Command[]) => commands[0]?.[0] === "SET" && /^nl:grp:.+:mail$/.test(key(commands[0]));
    const after = (from: number) => seen.slice(from).filter((c) => (c[0] === "INCR" && /:mail$/.test(key(c))) || key(c).startsWith("nl:grp:take:")).length;
    for (const [label, reply] of [
      ["a membership answered as text", ["0", 0, null]],
      ["a membership of two", [2, 0, null]],
      ["places taken as text", [0, "1", null]],
      ["places taken that are negative", [0, -1, null]],
      ["places taken that are not whole", [0, 1.5, null]],
      ["places taken that are null", [0, null, null]],
      ["what the address was given as a number", [0, 0, 1]],
      ["what the address was given as a list", [0, 0, []]],
      ["a reply that is not a list", { x: 1 }],
      ["a reply cut short", [0, 0]],
      ["a reply too long", [0, 0, null, null]],
      ["an empty reply", []],
    ] as [string, unknown][]) {
      counter = { match: isTaken, reply };
      const [calls, sent, from] = [counterCalls, mails.length, seen.length];
      const got = await ask();
      is(`places taken, ${label}: refused as unavailable, no email, nothing counted or kept`, [got, counterCalls - calls, mails.length - sent, after(from)], ["unavailable", 1, 0, 0]);
    }
    counter = { match: isTaken, reply: "throw" };
    {
      const [sent, from] = [mails.length, seen.length];
      is("places taken, a read that never answers: thrown to the route, which says unavailable; no email, nothing kept", [await ask(), mails.length - sent, after(from)], ["threw Error", 0, 0]);
    }
    for (const [label, reply] of SET_INCR_UNKNOWN) {
      counter = { match: isMail, reply };
      const [calls, sent, from] = [counterCalls, mails.length, seen.length];
      const got = await ask();
      const kept = seen.slice(from).filter((c) => key(c).startsWith("nl:grp:take:")).length;
      const want = reply === "throw" ? "threw Error" : "unavailable";
      is(`links sent, ${label}: refused, no email, no link kept`, [got, counterCalls - calls, mails.length - sent, kept], [want, 1, 0, 0]);
    }
    counter = { match: isTaken, reply: [0, 2, null] };
    is("places taken confirmed as all of them: full, as before", await ask(), "full");
    counter = { match: isTaken, reply: [1, 2, null] };
    is("an address's own mark with nothing given is not counted against it: a new link", await ask(), "sent");
    counter = { match: isMail, reply: [null, 10_000] };
    is("links sent confirmed past the day's number: slow, as before", await ask(), "slow");
    counter = null;
    const sent = mails.length;
    is("confirmed replies within both: the link is sent", [await ask(), mails.length - sent], ["sent", 1]);
  }

  part("Taking a place: the place counted before the product is given (lib/group-buy.ts takePlace)");
  {
    const id = await paidGroup("pi_NumberGatesB");
    const address = "taker@numbergates.example";
    is("a link to take a place", await askPlace({ store, id, email: address, product, base: BASE, from: FROM, ordersLink: async () => null }), "sent");
    const token = tokenFor(address);
    const starts: string[] = [];
    const take = () => outcome(() => takePlace({ store, token, recordStart: async (email) => void starts.push(email) }));
    const givenTo = async (who: string) => (await importedFor((await storeForEmail(OWNER))!, who)).length;
    const marksOf = () => Number(redis.run(["HLEN", `nl:grp:${id}:m`]));
    const isRead = (commands: Command[]) => commands.length === 2 && commands[0]?.[0] === "HGET" && /^nl:grp:.+:m$/.test(key(commands[0])) && commands[1]?.[0] === "HGET";
    for (const [label, reply] of [
      ["a mark answered as a number", [1, null]],
      ["a mark answered as a list", [[], null]],
      ["what was given as a number", [null, 1]],
      ["what was given as true", [null, true]],
      ["a reply that is not a list", { x: 1 }],
      ["a reply cut short", [null]],
      ["a reply too long", [null, null, null]],
      ["a read that never answers", "throw"],
    ] as [string, unknown][]) {
      counter = { match: isRead, reply };
      const got = await take();
      const want = reply === "throw" ? "threw Error" : "threw UnknownReplyError";
      is(`the address read, ${label}: refused, nothing marked or given`, [got, marksOf(), await givenTo(address), starts.length], [want, 0, 0, 0]);
    }
    const isTake = (commands: Command[]) => commands[0]?.[0] === "HSETNX" && /^nl:grp:.+:m$/.test(key(commands[0])) && commands[1]?.[0] === "HLEN";
    for (const [label, reply] of [
      ["a mark that is null", [null, 1]],
      ["a mark written as text", ["1", 1]],
      ["a mark of two", [2, 1]],
      ["a count that is null", [1, null]],
      ["a count written as text", [1, "1"]],
      ["a count of zero after the mark", [1, 0]],
      ["a count that is true", [1, true]],
      ["a count that is negative", [1, -1]],
      ["a count that is not whole", [1, 1.5]],
      ["a reply that is not a list", { x: 1 }],
      ["a reply cut short", [1]],
      ["an empty reply", []],
      ["a reply too long", [1, 1, 1]],
      ["a counter that never answers", "throw"],
    ] as [string, unknown][]) {
      counter = { match: isTake, reply };
      const [calls, from] = [counterCalls, seen.length];
      const got = await take();
      const others = seen.slice(from).filter((c) => c[0] === "HDEL" && key(c).endsWith(":m") && c[2] !== addressHash(address)).length;
      is(`${label}: refused, nothing given, no place moved`, [got, counterCalls - calls, await givenTo(address), starts.length, marksOf(), others], ["threw UnknownReplyError", 1, 0, 0, 0, 0]);
    }
    counter = null;
    // Both places held by others, really: the hash says so.
    redis.run(["HSET", `nl:grp:${id}:m`, "other-one", JSON.stringify({ e: "one@numbergates.example", at: 1 })]);
    redis.run(["HSET", `nl:grp:${id}:m`, "other-two", JSON.stringify({ e: "two@numbergates.example", at: 1 })]);
    {
      const got = await take();
      is("every place held by somebody else: full, as before, and its own mark taken off", [typeof got === "object" && got.outcome, await givenTo(address), marksOf()], ["full", 0, 2]);
    }
    redis.run(["HDEL", `nl:grp:${id}:m`, "other-two"]);
    {
      const opening = redis.keys().find((k) => k.startsWith(`nl:grp:${id}:t:`));
      is("no open of the link is left holding it", opening, undefined);
    }
    const isOpening = (commands: Command[]) => commands[0]?.[0] === "SET" && /^nl:grp:.+:t:/.test(key(commands[0]));
    for (const [label, reply, want] of [
      ["another open of the same link still going", [null], "threw Error"],
      ["an opening answered in another shape", [1], "threw UnknownReplyError"],
      ["an opening that never answers", "throw", "threw UnknownReplyError"],
    ] as [string, unknown, string][]) {
      counter = { match: isOpening, reply };
      is(`${label}: refused, nothing marked or given`, [await take(), marksOf(), await givenTo(address)], [want, 1, 0]);
    }
    counter = null;
    const got = await take();
    is("the same address, once the count is confirmed: the place is taken and the product given", [typeof got === "object" && got.outcome, await givenTo(address), await placesTaken(id)], ["taken", 1, 2]);
  }

  part("A place whose answer was lost after Redis did it: never a place gone for good (lib/group-buy.ts takePlace)");
  {
    /** The write that puts a place on an address: its mark, its count, or both in one. */
    const marks = (c: Command) => (c[0] === "HSETNX" && /^nl:grp:.+:m$/.test(key(c))) || (c[0] === "INCR" && /^nl:grp:.+:n$/.test(key(c)));
    const counts = (c: Command) => (c[0] === "INCR" && /^nl:grp:.+:n$/.test(key(c))) || (c[0] === "HLEN" && /^nl:grp:.+:m$/.test(key(c)));
    const unmarks = (c: Command) => c[0] === "HDEL" && /^nl:grp:.+:m$/.test(key(c));
    const cases: [string, { match: (commands: Command[]) => boolean; when: "after" | "before" }[]][] = [
      ["the mark's answer lost after it was written", [{ match: (cs) => cs.some(marks), when: "after" }]],
      ["the count's answer lost after it was counted", [{ match: (cs) => cs.some(counts), when: "after" }]],
      ["the count's answer lost, and the mark never taken off", [{ match: (cs) => cs.some(counts), when: "after" }, { match: (cs) => cs.some(unmarks), when: "before" }]],
    ];
    let k = 0;
    for (const [label, losses] of cases) {
      k += 1;
      const id = await paidGroup(`pi_NumberGatesL${k}`);
      const [ana, ben, cy] = ["ana", "ben", "cy"].map((who) => `${who}${k}@numbergates.example`);
      const linkFor = async (address: string) => {
        is(`${label}: a link for ${address.split("@")[0]}`, await askPlace({ store, id, email: address, product, base: BASE, from: FROM, ordersLink: async () => null }), "sent");
        return tokenFor(address);
      };
      const takeAs = async (token: string) => {
        const got = await outcome(() => takePlace({ store, token, recordStart: async () => undefined }));
        return typeof got === "object" ? got.outcome : got;
      };
      const given = async (address: string) => (await importedFor((await storeForEmail(OWNER))!, address)).length;
      const anaToken = await linkFor(ana);
      lost = [...losses];
      const first = await takeAs(anaToken);
      lost = [];
      is(`${label}: the first open is not said as done, and nothing is given on it`, [typeof first === "string" && first.startsWith("threw"), await given(ana)], [true, 0]);
      is(`${label}: opening the same link again takes the place and gives the product`, [await takeAs(anaToken), await given(ana)], ["taken", 1]);
      is(`${label}: and opening it once more is already hers`, [await takeAs(anaToken), await given(ana)], ["already", 1]);
      is(`${label}: the second person of two still gets the second place`, [await takeAs(await linkFor(ben)), await given(ben)], ["taken", 1]);
      const cyAsked = await askPlace({ store, id, email: cy, product, base: BASE, from: FROM, ordersLink: async () => null });
      is(`${label}: a third is told every place is taken, and nothing more is given`, [cyAsked, await given(cy), await placesTaken(id)], ["full", 0, 2]);
    }
  }

  // Review of 5 November 2026: the proofs P1, P3 and P4 as the reviewer wrote them, then what each must give.
  const given = async (address: string) => (await importedFor((await storeForEmail(OWNER))!, address)).length;
  const linkFor = async (id: string, address: string) => {
    const r = await askPlace({ store, id, email: address, product, base: BASE, from: FROM, ordersLink: async () => null });
    if (r !== "sent") throw new Error("ask " + r);
    return tokenFor(address);
  };
  const realStart = async (email: string, productId: string, start: number) => {
    const c = productId === product.id ? product : await readListing(store, productId);
    if (c?.course) await recordEnrollment(store, email, productId, start, "group");
  };
  const importedKeyOf = (address: string) => importedKey(store.statsId!, address);
  const o = (x: unknown) => (typeof x === "object" && x ? (x as { outcome: string }).outcome : x);
  /** Orders the store's checkouts and places hold right now (lib/order-admission.ts), over every hour. */
  const holding = () =>
    redis
      .keys()
      .filter((k) => k.startsWith("nl:orders:open:") && !k.endsWith(":b"))
      .reduce((sum, k) => sum + (redis.run(["HVALS", k]) as string[]).reduce((n, v) => n + Number(v), 0), 0);
  // An order's count is sent as one step with its mark (lib/orders.ts, COUNT_ORDER: its count key, then 1 to count).
  const ordersCounted = (from: number) => seen.slice(from).filter((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:orders-count:v1\n") &&
    String(c[4]).startsWith("nl:orders:n:") && String(c[7]) === "1").length;
  /** The page's notice after an open that threw, for a link that is one. */
  const noticeAfterThrow = (token: string) => placeNotice({ token, tokenValid: true, taken: null, threw: true, status: "" });

  part("P1: finish throws after the grant");
  {
    const id = await paidGroup("pi_ReviewP1");
    const t = await linkFor(id, "p1@numbergates.example");
    const before = holding();
    let fail = true;
    const got = await outcome(() => takePlace({ store, token: t, recordStart: async () => { if (fail) throw new Error("enrollment write lost"); } }));
    is("P1 first open throws (page says unavailable: no place was taken)", got, "threw Error");
    is("P1 but the product was given and the place counted", [await given("p1@numbergates.example"), await placesTaken(id)], [1, 1]);
    is("P1 the page does not say no place was taken: it says to open the link again", noticeAfterThrow(t), "opening");
    is("P1 the order's room is still held while what follows the gift is not done", holding() - before, 1);
    fail = false;
    const starts: string[] = [];
    let from = seen.length;
    const again = await outcome(() => takePlace({ store, token: t, recordStart: async (e, p) => void starts.push(p) }));
    is("P1 reopen: already, and finish redone", [typeof again === "object" && again.outcome, starts.length], ["already", 1]);
    is("P1 reopen: the order counted once, and its room given back once", [ordersCounted(from), holding() - before], [1, 0]);
    from = seen.length;
    const third = await outcome(() => takePlace({ store, token: t, recordStart: async (e, p) => void starts.push(p) }));
    is("P1 opened once more: already, from one read of four commands, nothing redone", [o(third), seen.length - from, starts.length, ordersCounted(from), holding() - before], ["already", 4, 1, 0, 0]);
  }

  part("P2: commands per open");
  {
    const id = await paidGroup("pi_ReviewP2");
    const t = await linkFor(id, "p2@numbergates.example");
    let from = seen.length;
    const first = await takePlace({ store, token: t, recordStart: realStart });
    console.log("P2 taken commands:", seen.length - from, first.outcome, JSON.stringify(seen.slice(from).map((c) => c[0])));
    from = seen.length;
    const second = await takePlace({ store, token: t, recordStart: realStart });
    console.log("P2 already commands:", seen.length - from, second.outcome, JSON.stringify(seen.slice(from).map((c) => c[0])));
    is("P2 a place taken, then opened again: already, in four commands (the token, the purchase, the mark and the gift)", [first.outcome, second.outcome, seen.length - from], ["taken", "already", 4]);
  }

  part("P3: two opens of the same link at once");
  {
    const id = await paidGroup("pi_ReviewP3");
    const t = await linkFor(id, "p3@numbergates.example");
    const [a, b] = await Promise.all([
      outcome(() => takePlace({ store, token: t, recordStart: async () => undefined })),
      outcome(() => takePlace({ store, token: t, recordStart: async () => undefined })),
    ]);
    console.log("P3 outcomes:", o(a), o(b), "given:", await given("p3@numbergates.example"));
    is("P3 one open takes it and the other is refused while it goes; the product given once", [[o(a), o(b)].sort(), await given("p3@numbergates.example"), await placesTaken(id)], [["taken", "threw Error"], 1, 1]);
    is("P3 the refused open is not told no place was taken: it is told to open the link again", noticeAfterThrow(t), "opening");
    is("P3 and opening it again says it is hers", o(await outcome(() => takePlace({ store, token: t, recordStart: async () => undefined }))), "already");
  }

  part("P4: grant refused and the re-read in another shape: mark removed while this purchase gave it");
  {
    const id = await paidGroup("pi_ReviewP4");
    const x = "p4x@numbergates.example";
    const tx = await linkFor(id, x);
    const ty = await linkFor(id, "p4y@numbergates.example");
    const tz = await linkFor(id, "p4z@numbergates.example");
    // The grant lands first (another open of x whose lock had expired), and the re-read answers in another shape.
    const imp = (c: Command) => c[0] === "HGET" && /^nl:imp:buy:/.test(key(c));
    let hget = 0;
    const orig = redis.pipeline;
    let armed = true;
    redis.pipeline = (async (commands: Command[]) => {
      if (armed && commands.length === 1 && imp(commands[0])) {
        hget += 1;
        if (hget === 1) { armed = false; seen.push(...commands); return [1]; }
      }
      if (armed && commands.some((c) => c[0] === "EXPIRE" && /^nl:grp:.+:m$/.test(key(c)))) {
        // simulate the other open of x granting now
        await grantImported(store.statsId!, `group:${id}`, [{ email: x, productId: product.id, items: null }], 1_900_000_100, store.sid);
      }
      return orig(commands);
    }) as typeof redis.pipeline;
    const got = await outcome(() => takePlace({ store, token: tx, recordStart: async () => undefined }));
    redis.pipeline = orig;
    console.log("P4 x:", o(got), "x given:", await given(x), "marks:", await placesTaken(id));
    is("P4 the re-read in another shape: said as not done, and x keeps the mark of the place this purchase gave", [o(got), await given(x), await placesTaken(id)], ["threw UnknownReplyError", 1, 1]);
    const gy = await outcome(() => takePlace({ store, token: ty, recordStart: async () => undefined }));
    const gz = await outcome(() => takePlace({ store, token: tz, recordStart: async () => undefined }));
    console.log("P4 y:", o(gy), "z:", o(gz), "given x,y,z:", await given(x), await given("p4y@numbergates.example"), await given("p4z@numbergates.example"));
    is("P4 never three gifts for two places: y takes the second, z is told every place is taken", [o(gy), o(gz), await given(x), await given("p4y@numbergates.example"), await given("p4z@numbergates.example")], ["taken", "full", 1, 1, 0]);
  }

  part("A record of what an address was given that cannot be read is unknown: never a gift, never a mark taken off");
  {
    for (const [n, raw] of ["{broken", "null", "[]", JSON.stringify({ job: "", at: 1 }), JSON.stringify({ job: "gift:x" })].entries()) {
      const id = await paidGroup(`pi_ReviewU${n}`);
      const u = `u${n}@numbergates.example`;
      const tu = await linkFor(id, u);
      const orig = redis.pipeline;
      let armed = true;
      // The grant refused (a record landed first, as P4's), and that record read back as this.
      redis.pipeline = (async (commands: Command[]) => {
        if (armed && commands.some((c) => c[0] === "EXPIRE" && key(c) === `nl:grp:${id}:m`)) redis.run(["HSET", importedKeyOf(u), product.id, raw]);
        if (armed && commands.length === 1 && commands[0][0] === "HGET" && /^nl:imp:buy:/.test(key(commands[0]))) {
          armed = false;
          return [raw];
        }
        return orig(commands);
      }) as typeof redis.pipeline;
      const got = await outcome(() => takePlace({ store, token: tu, recordStart: async () => undefined }));
      redis.pipeline = orig;
      is(`the grant refused and its record read back as ${raw}: said as not done, the mark kept`, [o(got), await placesTaken(id)], ["threw UnknownReplyError", 1]);
      is(`a record ${raw} when a link is asked for: unavailable, no link sent`, await askPlace({ store, id, email: u, product, base: BASE, from: FROM, ordersLink: async () => null }), "unavailable");
      redis.run(["DEL", importedKeyOf(u)]);
    }
  }

  part("A gift of this purchase granted by another open while this one went: already, its mark kept, this open's room given back");
  {
    const id = await paidGroup("pi_ReviewG");
    const x = "g-x@numbergates.example";
    const tx = await linkFor(id, x);
    const before = holding();
    const orig = redis.pipeline;
    let armed = true;
    redis.pipeline = (async (commands: Command[]) => {
      if (armed && commands.some((c) => c[0] === "EXPIRE" && /^nl:grp:.+:m$/.test(key(c)))) {
        armed = false;
        await grantImported(store.statsId!, `group:${id}`, [{ email: x, productId: product.id, items: null }], 1_900_000_100, store.sid);
      }
      return orig(commands);
    }) as typeof redis.pipeline;
    const got = await outcome(() => takePlace({ store, token: tx, recordStart: async () => undefined }));
    redis.pipeline = orig;
    is("already, given once, the mark kept, and the room this open was admitted with given back", [o(got), await given(x), await placesTaken(id), holding() - before], ["already", 1, 1, 0]);
  }

  part("An address given the product another way: its pending mark comes off and no place is used");
  {
    const id = await paidGroup("pi_ReviewH");
    const h = "h-other@numbergates.example";
    const th = await linkFor(id, h);
    redis.run(["HSET", `nl:grp:${id}:m`, addressHash(h), JSON.stringify({ e: h, at: 1 })]);
    await grantImported(store.statsId!, "api:test-gift", [{ email: h, productId: product.id, items: null }], 1_900_000_100, store.sid);
    is("has, and the half-way mark taken off", [o(await outcome(() => takePlace({ store, token: th, recordStart: async () => undefined }))), await placesTaken(id)], ["has", 0]);
  }

  part("A gift of this purchase whose mark went missing: the mark is written back, so it counts among the places");
  {
    const id = await paidGroup("pi_ReviewW");
    const w = "w-mark@numbergates.example";
    const tw = await linkFor(id, w);
    is("taken", o(await outcome(() => takePlace({ store, token: tw, recordStart: async () => undefined }))), "taken");
    redis.run(["HDEL", `nl:grp:${id}:m`, addressHash(w)]);
    is("opened again: already, and the place counted again", [o(await outcome(() => takePlace({ store, token: tw, recordStart: async () => undefined }))), await placesTaken(id)], ["already", 1]);
  }

  part("The open's hold on its link: taken off only while it is still this open's");
  {
    const id = await paidGroup("pi_ReviewL");
    const l = "l-lock@numbergates.example";
    const tl = await linkFor(id, l);
    const opening = `nl:grp:${id}:t:${addressHash(l)}`;
    // This open outlives its 30 seconds: its hold ends and another open of the link takes it.
    around = { match: (cs) => cs.some((c) => c[0] === "HSETNX" && key(c) === `nl:grp:${id}:m`), before: () => void redis.run(["SET", opening, "another-open", "EX", 30]), after: () => undefined };
    is("the place taken", o(await outcome(() => takePlace({ store, token: tl, recordStart: async () => undefined }))), "taken");
    is("the other open's hold is left where it is", redis.run(["GET", opening]), "another-open");
    redis.run(["DEL", opening]);
  }

  part("An open that outlives its hold: the order's room given back once, never twice (Claude 5's review of #2654)");
  {
    const id = await paidGroup("pi_ReviewD");
    const d = "d-double@numbergates.example";
    const td = await linkFor(id, d);
    const settles = (from: number) => seen.slice(from).filter((c) => c[0] === "EVAL" && key(c).startsWith("-- marktmorgen:order-admission-settle:")).length;
    // Another checkout of the store holds its own order's room in the same hour.
    const other = await admitOrders(store, 1);
    is("another checkout holds its order's room", other.ok, true);
    const before = holding();
    const from = seen.length;
    let second: unknown = null;
    const starts: string[] = [];
    // Open A is still in what follows the gift when its 30 seconds end; open B of the same link comes in then.
    const first = await outcome(() =>
      takePlace({
        store,
        token: td,
        recordStart: async (email) => {
          starts.push(email);
          if (second !== null) return;
          second = "running";
          advance(31_000);
          second = await outcome(() => takePlace({ store, token: td, recordStart: async (e) => void starts.push(e) }));
        },
      }),
    );
    is("A takes the place and B finds it already hers", [o(first), o(second)], ["taken", "already"]);
    is("the place's room is given back once", settles(from), 1);
    is("the other checkout's room is still held: every room held before is held after", [before >= 1, holding()], [true, before]);
    is("the product given once and one place counted", [await given(d), await placesTaken(id)], [1, 1]);
    if (other.ok && other.hour !== null) await settleAdmitted(store, other.hour);
  }

  part("The page's notice after the link was opened (lib/group-buy.ts placeNotice)");
  {
    const t = "a".repeat(64);
    const g = { id: "grp_x", s: "s", p: "p", people: 2, at: 1 };
    is("an open that threw, with a link that is one: open it again", placeNotice({ token: t, tokenValid: true, taken: null, threw: true, status: "" }), "opening");
    is("a link that is not one: expired", placeNotice({ token: "nope", tokenValid: false, taken: null, threw: false, status: "" }), "expired");
    is("a link that leads nowhere: expired", placeNotice({ token: t, tokenValid: true, taken: { outcome: "gone" }, threw: false, status: "" }), "expired");
    is("every place taken: full", placeNotice({ token: t, tokenValid: true, taken: { outcome: "full", email: "a@b.example", group: g }, threw: false, status: "" }), "full");
    is("the store resting: resting", placeNotice({ token: t, tokenValid: true, taken: { outcome: "resting", email: "a@b.example", group: g }, threw: false, status: "" }), "resting");
    is("no link: the status the form sent", placeNotice({ token: "", tokenValid: false, taken: null, threw: false, status: "sent" }), "sent");
    is("the opening notice is never read from the address bar", placeNotice({ token: "", tokenValid: false, taken: null, threw: false, status: "opening" }), null);
  }

  part("Two pressing for the last place: one gets it, and nobody is told it is taken while it is free");
  {
    const id = await paidGroup("pi_NumberGatesT");
    const members = `nl:grp:${id}:m`;
    const linkFor = async (address: string) => {
      await askPlace({ store, id, email: address, product, base: BASE, from: FROM, ordersLink: async () => null });
      return tokenFor(address);
    };
    const takeAs = async (token: string) => {
      const got = await outcome(() => takePlace({ store, token, recordStart: async () => undefined }));
      return typeof got === "object" ? got.outcome : got;
    };
    const given = async (address: string) => (await importedFor((await storeForEmail(OWNER))!, address)).length;
    is("the first of two places", await takeAs(await linkFor("first-t@numbergates.example")), "taken");
    const isMarking = (commands: Command[]) => commands[0]?.[0] === "HSETNX" && key(commands[0]) === members;
    const rival = JSON.stringify({ e: "rival-t@numbergates.example", at: 1 });
    const lastToken = await linkFor("last-t@numbergates.example");
    // A rival's mark lands just before this one and stays: the rival has the last place.
    around = { match: isMarking, before: () => void redis.run(["HSET", members, "rival-t", rival]), after: () => undefined };
    is("a rival marked first and keeps it: every place is taken, nothing given", [await takeAs(lastToken), await given("last-t@numbergates.example"), Number(redis.run(["HLEN", members]))], ["full", 0, 2]);
    redis.run(["HDEL", members, "rival-t"]);
    // A rival's mark lands just before this one and comes off just after: both saw three, both come off.
    around = { match: isMarking, before: () => void redis.run(["HSET", members, "rival-t", rival]), after: () => void redis.run(["HDEL", members, "rival-t"]) };
    is("both came off and a place is free: not said full, said as not done", [await takeAs(lastToken), await given("last-t@numbergates.example"), Number(redis.run(["HLEN", members]))], ["threw Error", 0, 1]);
    is("and the same link then takes it", [await takeAs(lastToken), await given("last-t@numbergates.example"), await placesTaken(id)], ["taken", 1, 2]);
  }

  part("A purchase's emails of the day: the day always on the count, even when the answer is lost (lib/group-buy.ts askPlace)");
  {
    const id = await paidGroup("pi_NumberGatesM");
    const mailOf = `nl:grp:${id}:mail`;
    lost = [
      { match: (cs) => cs.some((c) => c[0] === "INCR" && key(c) === mailOf), when: "after" },
      { match: (cs) => cs.some((c) => c[0] === "EXPIRE" && key(c) === mailOf), when: "before" },
    ];
    const got = await outcome(() => askPlace({ store, id, email: "lost-mail@numbergates.example", product, base: BASE, from: FROM, ordersLink: async () => null }));
    lost = [];
    const ttl = Number(redis.run(["TTL", mailOf]));
    is("the first count's answer lost and its repair never done: not sent, and the count still ends within the day", [got === "sent", ttl > 0 && ttl <= 86_400], [false, true]);
    // A day of asking that a lost answer could otherwise have frozen: the count ends, and asking works again.
    await redis.pipeline([["INCRBY", mailOf, 10_000]]);
    is("past the day's number, slow, as before", await askPlace({ store, id, email: "after-day@numbergates.example", product, base: BASE, from: FROM, ordersLink: async () => null }), "slow");
    advance(86_401_000);
    is("a day later the count is gone and the link is sent again", await askPlace({ store, id, email: "after-day@numbergates.example", product, base: BASE, from: FROM, ordersLink: async () => null }), "sent");
  }

  part("A free copy: requests an hour counted before the email (lib/free.ts requestCopy)");
  const free = (await readListing(store, guide.product.id))!;
  let n = 0;
  const ask = () => {
    n += 1;
    return outcome(() => requestCopy({ store, product: free, email: `reader${n}@numbergates.example`, consent: false, ip: `192.0.2.${n}`, origin: "https://marktmorgen.com" }));
  };
  for (const [which, prefix] of [["per connection", "nl:rl:free:ip:"], ["per address", "nl:rl:free:addr:"]] as const) {
    const isRate = (commands: Command[]) => commands[0]?.[0] === "SET" && key(commands[0]).startsWith(prefix);
    for (const [label, reply] of SET_INCR_UNKNOWN) {
      counter = { match: isRate, reply };
      const [calls, sent, from] = [counterCalls, mails.length, seen.length];
      const got = await ask();
      const kept = seen.slice(from).filter((c) => key(c).startsWith("nl:free:claim:")).length;
      const want = reply === "throw" ? "threw Error" : "error";
      is(`${which}, ${label}: refused, no email, no link kept`, [got, counterCalls - calls, mails.length - sent, kept], [want, 1, 0, 0]);
    }
    counter = { match: isRate, reply: [null, 10_000] };
    is(`${which}, a confirmed count past the hour's number: limited, as before`, await ask(), "limited");
    counter = { match: isRate, reply: ["OK", 1] };
    const sent = mails.length;
    is(`${which}, a confirmed first request: the link is sent`, [await ask(), mails.length - sent], ["sent", 1]);
  }
  counter = null;

  part("A free copy's link: uses counted before the file (lib/free.ts spendClaim)");
  {
    const claimToken = mails.at(-1)?.text.match(/free\?token=([0-9a-f]{64})/)?.[1] ?? "";
    is("a link to use", claimToken.length, 64);
    const isUses = (commands: Command[]) => commands[0]?.[0] === "INCR" && key(commands[0]).startsWith("nl:free:uses:");
    for (const [label, reply] of incrFirstUnknown(2)) {
      counter = { match: isUses, reply };
      const calls = counterCalls;
      const got = await outcome(() => spendClaim(claimToken));
      const want = reply === "throw" ? "threw Error" : "threw UnknownReplyError";
      is(`${label}: no claim handed out`, [got, counterCalls - calls], [want, 1]);
    }
    // The route the link's button posts to: an unknown count is said as a moment's trouble, never a bare 500 (Claude 5's review of #2654).
    for (const [label, reply] of [["a count cut short", [1]], ["a count that never answers", "throw"]] as [string, unknown][]) {
      counter = { match: isUses, reply };
      const form = new FormData();
      form.set("token", claimToken);
      const response = await outcome(() => freeDownload(new NextRequest("https://marktmorgen.com/api/store/free/download", { method: "POST", body: form })));
      const answer = response instanceof Response ? [response.status, (await response.text()).length > 0, response.headers.get("location")] : response;
      is(`the download route, ${label}: unavailable, with words, and no file`, answer, [503, true, null]);
    }
    counter = { match: isUses, reply: [11, 1] };
    is("a confirmed count past the uses allowed: spent, as before", await spendClaim(claimToken), { ok: false, reason: "spent" });
    counter = { match: isUses, reply: [1, 1] };
    const used = await spendClaim(claimToken);
    is("a confirmed first use: the claim is handed out", used.ok, true);
    counter = null;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
