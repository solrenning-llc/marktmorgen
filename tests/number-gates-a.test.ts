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
import { askPlace, placesTaken, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor } from "@/lib/imported-purchases";
import { requestCopy, spendClaim } from "@/lib/free";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

/** Which pipeline is the counter's, and what it answers instead ("throw" for one that never answers). */
let counter: { match: (commands: Command[]) => boolean; reply: unknown } | null = null;
let counterCalls = 0;
/** Every command that reached the store, to see what was written after the counter. */
const seen: Command[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
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
    const isTaken = (commands: Command[]) => commands.length === 2 && commands[0]?.[0] === "HEXISTS" && commands[1]?.[0] === "GET" && key(commands[1]).startsWith("nl:grp:");
    const isMail = (commands: Command[]) => commands[0]?.[0] === "INCR" && /^nl:grp:.+:mail$/.test(key(commands[0]));
    const after = (from: number) => seen.slice(from).filter((c) => (c[0] === "INCR" && /:mail$/.test(key(c))) || key(c).startsWith("nl:grp:take:")).length;
    for (const [label, reply] of [
      ["a membership answered as text", ["0", null]],
      ["a membership of two", [2, null]],
      ["places taken as a number", [0, 1]],
      ["places taken as words", [0, "two"]],
      ["places taken as an empty text", [0, ""]],
      ["places taken that are negative", [0, "-1"]],
      ["a reply that is not a list", { x: 1 }],
      ["a reply cut short", [0]],
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
    for (const [label, reply] of incrFirstUnknown(1)) {
      counter = { match: isMail, reply };
      const [calls, sent, from] = [counterCalls, mails.length, seen.length];
      const got = await ask();
      const kept = seen.slice(from).filter((c) => key(c).startsWith("nl:grp:take:")).length;
      const want = reply === "throw" ? "threw Error" : "unavailable";
      is(`links sent, ${label}: refused, no email, no link kept`, [got, counterCalls - calls, mails.length - sent, kept], [want, 1, 0, 0]);
    }
    counter = { match: isTaken, reply: [0, "2"] };
    is("places taken confirmed as all of them: full, as before", await ask(), "full");
    counter = { match: isMail, reply: [10_000] };
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
    const isTake = (commands: Command[]) => commands[0]?.[0] === "INCR" && /^nl:grp:.+:n$/.test(key(commands[0]));
    for (const [label, reply] of incrFirstUnknown(1)) {
      counter = { match: isTake, reply };
      const [calls, from] = [counterCalls, seen.length];
      const got = await take();
      const decr = seen.slice(from).filter((c) => c[0] === "DECR").length;
      is(`${label}: refused, nothing given, no place handed back`, [got, counterCalls - calls, (await importedFor((await storeForEmail(OWNER))!, address)).length, starts.length, decr], ["threw UnknownReplyError", 1, 0, 0, 0]);
    }
    counter = { match: isTake, reply: [3] };
    {
      const from = seen.length;
      const got = await take();
      is("a confirmed count past the places paid for: full, as before, and its own place handed back", [typeof got === "object" && got.outcome, (await importedFor((await storeForEmail(OWNER))!, address)).length, seen.slice(from).filter((c) => c[0] === "DECR").length], ["full", 0, 1]);
    }
    counter = null;
    // The counter the check above handed back without having counted.
    await redis.pipeline([["SET", `nl:grp:${id}:n`, "0"]]);
    const got = await take();
    is("the same address, once the count is confirmed: the place is taken and the product given", [typeof got === "object" && got.outcome, (await importedFor((await storeForEmail(OWNER))!, address)).length, await placesTaken(id)], ["taken", 1, 1]);
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
