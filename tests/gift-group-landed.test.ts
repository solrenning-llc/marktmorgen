/**
 * Gifts and purchases for several when a write LANDED but its reply came back in another shape (#2872 reviews:
 * Claude 4 M1 and L1, Claude 4 focal rule-30 LEVE, Claude 1 N1), synthetic only: the in-memory Redis double and an
 * email stand-in; no Stripe, no real email. Each part beside its healthy control:
 *
 * A/B. M1: the last write (the gift marked given, the purchase marked paid) lands with an unknown reply. The run
 *      throws (rule 24), and the next run must still send the emails that come after that write (the friend's, the
 *      payer's receipt, the receipt with the link that hands out the places), once, never "already" with nothing sent.
 * C.   L1: the places counter (on the main, the HLEN of the marks) answers in an unknown shape. Two places paid for: two people hold the product,
 *      the link page does not say "full" to the second, and never a place more than paid.
 * D.   Rule 30: an address holding a leftover record of a place without the product is never emailed "You already
 *      took your place"; on a full purchase it is told "full", as takePlace says once its mark is given back.
 * E.   N1: the grant of a place answers in another shape. Not landed: the place is given back and the link works
 *      again; landed: the place is taken. Two places paid for: two people hold the product.
 * F.   N2 (Claude 1 on #2872): a give-back's two commands run one at a time, and a second taker past the places paid
 *      for runs its whole take between them. No reply is altered. Two places paid for: the count
 *      stays at two, a later address is told full, and only two people hold the product.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { startGift } from "@/lib/gifts";
import { askPlace, placesTaken, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { confirmPurchase } from "@/lib/purchase-email";
import { importedFor } from "@/lib/imported-purchases";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const UNKNOWN = { unexpected: true };
/**
 * Every pipeline runs as usual, except that a command `match` picks is answered in an unknown shape: run (the write
 * lands) when `lands`, otherwise not run at all.
 */
function unknownFor(match: (c: Command) => boolean, lands: boolean): void {
  redis.pipeline = (async (commands: Command[]) => {
    const picked = commands.map(match);
    const ran = await real(commands.filter((_, i) => lands || !picked[i]));
    let k = 0;
    return commands.map((_, i) => {
      const reply = lands || !picked[i] ? ran[k++] : undefined;
      return picked[i] ? UNKNOWN : reply;
    });
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = real;
};
/** What a call came to: its answer, or "threw" when it refused by throwing. */
const outcome = <T>(p: Promise<T>): Promise<T | "threw"> => p.then((v) => v, () => "threw" as const);

const sent: { to: string | string[]; subject: string; text: string }[] = [];
const to = (address: string) => sent.filter((e) => [e.to].flat().includes(address)).length;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_group_landed_only";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  const OWNER = "giftgrouplanded@example.com";
  await claimHandle(OWNER, "giftlanded", "Gift Landed", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGiftLand01", true);
  await setSubscription(OWNER, { customerId: "cus_GiftLanded001", subscriptionId: "sub_GiftLanded001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Glaze Guide", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  let n = 0;
  const paidSession = (meta: Record<string, string>, people = 1) => {
    n += 1;
    return {
      id: "cs_test_" + String(n).padStart(24, "l"),
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      created: Math.floor(Date.now() / 1000),
      amount_total: 4900 * people,
      currency: "usd",
      payment_intent: `pi_GiftLanded${String(n).padStart(6, "0")}`,
      metadata: { store: "giftlanded", product: product.id, ...meta },
      customer_details: { email: "payer@example.com" },
    };
  };
  const base = "https://marktmorgen.com/@giftlanded";
  const from = '"Gift Landed" <hello@marktmorgen.com>';
  const confirm = (session: ReturnType<typeof paidSession>) => outcome(confirmPurchase(store, session.id, session as never));
  const owns = async (email: string) => (await importedFor({ ...store, pastBuyers: true }, email)).map((p) => p.productId);

  part("A. Control: a gift paid and confirmed tells the friend and the payer once");
  const ga = await startGift(store, product, { to: "friend-ok@example.com", from: "Ana", message: "" });
  if (!ga.ok) throw new Error("no gift");
  const gaSession = paidSession({ gift: ga.gift.id });
  sent.length = 0;
  is("runs: sent, then already", [await confirm(gaSession), await confirm(gaSession)], ["sent", "already"]);
  is("the friend is emailed once, the payer gets one receipt", [to("friend-ok@example.com"), to("payer@example.com")], [1, 1]);

  part("A. M1 gift: the record marked given LANDS, its reply in another shape");
  const g = await startGift(store, product, { to: "friend-landed@example.com", from: "Ana", message: "" });
  if (!g.ok) throw new Error("no gift");
  const gs = paidSession({ gift: g.gift.id });
  sent.length = 0;
  unknownFor((c) => c[0] === "SET" && c[1] === `nl:gift:${g.gift.id}`, true);
  const a1 = await confirm(gs);
  restore();
  const a2 = await confirm(gs);
  const a3 = await confirm(gs);
  is("runs: threw (rule 24), then sent, then already", [a1, a2, a3], ["threw", "sent", "already"]);
  is("the friend holds the gift", await owns("friend-landed@example.com"), [product.id]);
  is("the friend is emailed about the gift once", to("friend-landed@example.com"), 1);
  is("the payer gets the gift receipt once", to("payer@example.com"), 1);

  part("B. Control: a purchase for several paid and confirmed sends the payer the receipt with the places link once");
  const pa = await startGroup(store, product, "3");
  if (!pa.ok) throw new Error("no group");
  const paSession = paidSession({ group: pa.group.id, people: "3" }, 3);
  sent.length = 0;
  is("runs: sent, then already", [await confirm(paSession), await confirm(paSession)], ["sent", "already"]);
  is("one receipt, with the link", [to("payer@example.com"), sent.filter((e) => e.text.includes(`/group/${pa.group.id}`)).length], [1, 1]);

  part("B. M1 group: the record marked paid LANDS, its reply in another shape");
  const p = await startGroup(store, product, "3");
  if (!p.ok) throw new Error("no group");
  const ps = paidSession({ group: p.group.id, people: "3" }, 3);
  sent.length = 0;
  unknownFor((c) => c[0] === "SET" && c[1] === `nl:grp:${p.group.id}`, true);
  const b1 = await confirm(ps);
  restore();
  const b2 = await confirm(ps);
  const b3 = await confirm(ps);
  is("runs: threw, then sent, then already", [b1, b2, b3], ["threw", "sent", "already"]);
  is("the payer gets the receipt with the link that hands out the places once", [to("payer@example.com"), sent.filter((e) => e.text.includes(`/group/${p.group.id}`)).length], [1, 1]);

  /** A purchase for `people`, paid and settled, and a link maker for its places. */
  const paidGroup = async (people: number) => {
    const started = await startGroup(store, product, String(people));
    if (!started.ok) throw new Error("no group");
    if ((await settleGroup({ store, product, base, from, session: paidSession({ group: started.group.id, people: String(people) }, people) })) !== "settled") throw new Error("not settled");
    store = (await storeForEmail(OWNER))!;
    const id = started.group.id;
    const link = async (email: string) => {
      const t = Buffer.from((id.slice(-6) + email).padEnd(32, "x").slice(0, 32)).toString("hex");
      await real([["SET", `nl:grp:take:${t}`, JSON.stringify({ g: id, e: email }), "EX", 3600]]);
      return t;
    };
    return { id, link };
  };
  const take = async (token: string) => {
    const r = await outcome(takePlace({ store, token, recordStart: async () => {} }));
    return r === "threw" ? r : r.outcome;
  };
  const ask = (id: string, email: string) => askPlace({ store, id, email, product, base, from, ordersLink: async () => null });
  // Rule 23: the main counts places by their marks (the HLEN of the marks right after a mark's HSETNX), no longer by an
  // INCR of ":n"; the unknown answer is put on that HLEN. Expectations unchanged.
  const isCount = (id: string) => (c: Command) => c[0] === "HLEN" && c[1] === `nl:grp:${id}:m`;

  part("C. Control: a purchase for 2, three people: two hold it, the third is told full");
  const c0 = await paidGroup(2);
  is("taken, taken, full", [await take(await c0.link("al@example.com")), await take(await c0.link("bo@example.com")), await take(await c0.link("ce@example.com"))], ["taken", "taken", "full"]);
  is("two places counted, the third holds nothing", [await placesTaken(c0.id), await owns("ce@example.com")], [2, []]);
  is("the link page tells a fourth address it is full", await ask(c0.id, "di@example.com"), "full");

  part("C. Control: the INCR answered in another shape and NOT landed");
  const c1 = await paidGroup(2);
  unknownFor(isCount(c1.id), false);
  const c1First = await take(await c1.link("fa@example.com"));
  restore();
  is("threw, then taken, taken, full: never a place more than paid", [c1First, await take(await c1.link("fa@example.com")), await take(await c1.link("ga@example.com")), await take(await c1.link("ha@example.com"))], ["threw", "taken", "taken", "full"]);
  is("two hold the product, the third nothing", [await owns("fa@example.com"), await owns("ga@example.com"), await owns("ha@example.com")], [[product.id], [product.id], []]);

  part("C. L1: a purchase for 2, the first place's INCR LANDS with its reply in another shape");
  const c2 = await paidGroup(2);
  unknownFor(isCount(c2.id), true);
  const ivy1 = await take(await c2.link("ivy@example.com"));
  restore();
  const ivy2 = await take(await c2.link("ivy@example.com"));
  sent.length = 0;
  const joAsk = await ask(c2.id, "jo@example.com");
  is("the link page sends jo a link, never 'full' with one paid place free", [joAsk, sent.map((e) => e.subject)], ["sent", ["Take your place in Glaze Guide"]]);
  const jo = await take(await c2.link("jo@example.com"));
  const kim = await take(await c2.link("kim@example.com"));
  is("ivy threw then taken, jo taken, kim full", [ivy1, ivy2, jo, kim], ["threw", "taken", "taken", "full"]);
  is("two places paid for: ivy and jo both hold the product, kim nothing", [await owns("ivy@example.com"), await owns("jo@example.com"), await owns("kim@example.com")], [[product.id], [product.id], []]);
  is("two places counted", await placesTaken(c2.id), 2);

  part("D. Control: an address that took its place is told it already did");
  const d0 = await paidGroup(3);
  const took = await take(await d0.link("rae@example.com"));
  sent.length = 0;
  const tookAsk = await ask(d0.id, "rae@example.com");
  is("taken, then 'Your place'", [took, tookAsk, sent.map((e) => e.subject)], ["taken", "sent", ["Your place in Glaze Guide"]]);

  part("D. Rule 30: full, the give-back script fails every time, then that address asks on the link page");
  const d1 = await paidGroup(2);
  is("two places, taken", [await take(await d1.link("kai@example.com")), await take(await d1.link("lu@example.com"))], ["taken", "taken"]);
  // Rule 23: on the main a place is given back by an HDEL of the address's mark (no script, no DECR).
  const isDrop = (c: Command) => c[0] === "HDEL" && c[1] === `nl:grp:${d1.id}:m`;
  redis.pipeline = (async (commands: Command[]) => {
    if (!commands.some(isDrop)) return real(commands);
    await real(commands.filter((c) => !isDrop(c)));
    throw new Error("Redis error: ERR script failed");
  }) as typeof redis.pipeline;
  const maxLink = await d1.link("max@example.com");
  const maxFirst = await take(maxLink);
  const maxSecond = await take(maxLink);
  restore();
  // Rule 23: on the main a give-back whose every HDEL fails is said as not done (it throws: the page says "We could
  // not finish opening your place", lib/group-buy.ts placeNotice "opening"), not "full" then "pending", which the
  // main does not have; the leftover mark is max's own and is picked up and given back once the HDEL works: "full".
  is("max: not done twice while the give-back fails, then full; nothing handed over", [maxFirst, maxSecond, await take(maxLink), await owns("max@example.com")], ["threw", "threw", "full", []]);
  sent.length = 0;
  const maxAsk = await ask(d1.id, "max@example.com");
  is("never emailed 'You already took your place' while holding nothing", sent.filter((e) => /already took your place/.test(e.text)).length, 0);
  is("told the purchase is full, as takePlace says", maxAsk, "full");

  part("E. N1: a purchase for 2, the first place's grant answers in another shape and did NOT land");
  const e1 = await paidGroup(2);
  const isGrant = (id: string) => (c: Command) => c[0] === "EVAL" && JSON.stringify(c).includes(`group:${id}`);
  unknownFor(isGrant(e1.id), false);
  const cy1 = await take(await e1.link("cy@example.com"));
  restore();
  const cy2 = await take(await e1.link("cy@example.com"));
  const cy3 = await take(await e1.link("cy@example.com"));
  const dee = await take(await e1.link("dee@example.com"));
  const eli = await take(await e1.link("eli@example.com"));
  is("cy threw, then taken, then already; dee taken; eli full", [cy1, cy2, cy3, dee, eli], ["threw", "taken", "already", "taken", "full"]);
  is("two places paid for: cy and dee hold the product, eli nothing", [await owns("cy@example.com"), await owns("dee@example.com"), await owns("eli@example.com")], [[product.id], [product.id], []]);
  is("two places counted", await placesTaken(e1.id), 2);

  part("E. N1: the grant LANDS with its reply in another shape");
  const e2 = await paidGroup(2);
  unknownFor(isGrant(e2.id), true);
  const fy1 = await take(await e2.link("fy@example.com"));
  restore();
  const fy2 = await take(await e2.link("fy@example.com"));
  const gus = await take(await e2.link("gus@example.com"));
  const hal = await take(await e2.link("hal@example.com"));
  is("fy taken (its grant is on the address), then already; gus taken; hal full", [fy1, fy2, gus, hal], ["taken", "already", "taken", "full"]);
  is("fy and gus hold the product, hal nothing; two counted", [await owns("fy@example.com"), await owns("gus@example.com"), await owns("hal@example.com"), await placesTaken(e2.id)], [[product.id], [product.id], [], 2]);

  part("F. N2: a give-back's two commands with a second taker's whole take (and its heal) run between them");
  const f1 = await paidGroup(2);
  is("al and bo take the two places", [await take(await f1.link("al2@example.com")), await take(await f1.link("bo2@example.com"))], ["taken", "taken"]);
  const diToken = await f1.link("di2@example.com");
  // Rule 23: on the main the give-back past the places paid for is the HDEL of the mark and the HLEN of the marks
  // after it (no script, no DECR); the second taker's whole take runs between those two commands. Expectations unchanged.
  const isGiveBack = (commands: Command[]) =>
    commands.length === 2 &&
    commands.some((c) => c[0] === "HDEL" && c[1] === `nl:grp:${f1.id}:m`) &&
    commands.some((c) => c[0] === "HLEN" && c[1] === `nl:grp:${f1.id}:m`);
  let between: string | null = null;
  redis.pipeline = (async (commands: Command[]) => {
    if (between !== null || !isGiveBack(commands)) return real(commands);
    between = "running";
    const first = await real([commands[0]]);
    restore();
    between = await take(diToken);
    const second = await real([commands[1]]);
    return [...first, ...second];
  }) as typeof redis.pipeline;
  const ce = await take(await f1.link("ce2@example.com"));
  restore();
  is("ce and di are told full", [ce, between], ["full", "full"]);
  is("two places still counted for al and bo", await placesTaken(f1.id), 2);
  is("a fifth address later is told full: never a place more than paid", await take(await f1.link("fy2@example.com")), "full");
  const holders = (await Promise.all(["al2", "bo2", "ce2", "di2", "fy2"].map((x) => owns(`${x}@example.com`)))).filter((o) => o.length).length;
  is("only two people hold the product", holders, 2);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
