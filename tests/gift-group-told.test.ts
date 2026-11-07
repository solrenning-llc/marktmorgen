/**
 * Claude 1's focal return and second money review of #2872 (head f79249b4), its findings turned into checks, synthetic
 * only: the in-memory Redis double and an email stand-in; no Stripe, no real email, no network.
 *
 * A. M1, gift (lib/gifts.ts): the last write marking the gift given lands, its reply in another shape. The first run
 *    throws; a later run must still tell the friend and send the payer's receipt, once, and count the order.
 * B. M1, purchase for several (lib/group-buy.ts settleGroup): the same on the record marked paid; the payer must get
 *    the receipt with the link that hands out the places, once.
 * C. L1 (takePlace): the place counter's write lands, its reply in another shape. Two places paid for are two people
 *    holding the product, never one.
 * D. Rule 30 (askPlace): a record of a place left over without the product (the give-back failed every time) is not a
 *    place: on a full purchase that address is told "full", never sent "Your place".
 * E. N1 (takePlace): the grant of a place answers in another shape and did not land. The place is given back, so the
 *    same link takes it on a later try and two places paid for are two people holding the product.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { startGift } from "@/lib/gifts";
import { askPlace, placesTaken, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor } from "@/lib/imported-purchases";
import { confirmPurchase } from "@/lib/purchase-email";
import { storeOrdersThisMonth } from "@/lib/orders";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const UNKNOWN = { unexpected: true };
/**
 * The first command `match` picks (only the first: a run that asks again is answered as usual) is answered in an
 * unknown shape: run (the write lands) when `lands`, otherwise not run at all.
 */
function unknownOnce(match: (c: Command) => boolean, lands: boolean): void {
  let used = false;
  redis.pipeline = (async (commands: Command[]) => {
    const picked = commands.map((c) => !used && match(c));
    if (picked.some(Boolean)) used = true;
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
/** What a call came to: its answer (a place's outcome), or "threw" when it refused by throwing. */
const outcome = <T>(p: Promise<T>): Promise<string> =>
  p.then((v) => (v && typeof v === "object" && "outcome" in v ? String((v as { outcome: unknown }).outcome) : String(v)), () => "threw");

const emails: { to: string[]; subject: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as { to: string[]; subject: string });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;
const to = (address: string) => emails.filter((e) => e.to.includes(address)).length;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_group_told_only";
  process.env.RESEND_API_KEY = "re_test_groups_only"; // a synthetic credential the Resend fallback fixture knows (tests/resend-fixture-credentials.ts)
  const OWNER = "giftgrouptold@example.com";
  await claimHandle(OWNER, "gifttold", "Gift Told", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGiftTold1", true);
  await setSubscription(OWNER, { customerId: "cus_GiftTold00001", subscriptionId: "sub_GiftTold00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Glaze Guide", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const base = "https://marktmorgen.com/@gifttold";
  const from = '"Gift Told" <hello@marktmorgen.com>';
  let n = 0;
  const paidSession = (meta: Record<string, string>, payer: string, people = 1) => {
    n += 1;
    return {
      id: "cs_test_" + String(n).padStart(24, "t"),
      object: "checkout.session",
      created: Math.floor(Date.now() / 1000),
      status: "complete",
      payment_status: "paid",
      amount_total: 4900 * people,
      currency: "usd",
      payment_intent: `pi_GiftTold${String(n).padStart(6, "0")}`,
      metadata: { store: "gifttold", product: product.id, ...meta },
      customer_details: { email: payer },
    };
  };
  const owns = async (email: string) => (await importedFor({ ...store, pastBuyers: true }, email)).map((p) => p.productId);

  part("A. M1, gift: the SET marking the gift given lands, its reply in another shape (confirmPurchase)");
  const gift = await startGift(store, product, { to: "friend@example.com", from: "Ana", message: "" });
  if (!gift.ok) throw new Error("no gift");
  const gs = paidSession({ gift: gift.gift.id }, "payer@example.com");
  const ordersBefore = await storeOrdersThisMonth(store);
  unknownOnce((c) => c[0] === "SET" && c[1] === `nl:gift:${gift.gift.id}`, true);
  const a1 = await outcome(confirmPurchase(store, gs.id, gs as never));
  restore();
  const a2 = await outcome(confirmPurchase(store, gs.id, gs as never));
  const a3 = await outcome(confirmPurchase(store, gs.id, gs as never));
  is("the first run throws, a later one tells, the next is 'already'", [a1, a2, a3], ["threw", "sent", "already"]);
  is("the friend holds the gift", await owns("friend@example.com"), [product.id]);
  is("the friend is emailed about the gift once", to("friend@example.com"), 1);
  is("the payer gets the gift receipt once", to("payer@example.com"), 1);
  is("the order is counted once", (await storeOrdersThisMonth(store)) - ordersBefore, 1);

  part("A. M1, gift: healthy control, the gift told once and never again");
  const okGift = await startGift(store, product, { to: "friend2@example.com", from: "Ana", message: "" });
  if (!okGift.ok) throw new Error("no gift");
  const okGs = paidSession({ gift: okGift.gift.id }, "payer2@example.com");
  is("sent, then already", [await outcome(confirmPurchase(store, okGs.id, okGs as never)), await outcome(confirmPurchase(store, okGs.id, okGs as never))], ["sent", "already"]);
  is("one email to the friend, one receipt to the payer", [to("friend2@example.com"), to("payer2@example.com")], [1, 1]);

  part("B. M1, purchase for several: the SET marking it paid lands, its reply in another shape (confirmPurchase)");
  const group = await startGroup(store, product, "2");
  if (!group.ok) throw new Error("no group");
  const grs = paidSession({ group: group.group.id, people: "2" }, "groupbuyer@example.com", 2);
  unknownOnce((c) => c[0] === "SET" && c[1] === `nl:grp:${group.group.id}`, true);
  const b1 = await outcome(confirmPurchase(store, grs.id, grs as never));
  restore();
  const b2 = await outcome(confirmPurchase(store, grs.id, grs as never));
  const b3 = await outcome(confirmPurchase(store, grs.id, grs as never));
  is("the first run throws, a later one sends, the next is 'already'", [b1, b2, b3], ["threw", "sent", "already"]);
  is("the payer gets the receipt with the places link once", to("groupbuyer@example.com"), 1);

  /** A purchase for `people`, paid and settled, and a link maker for its places. */
  const paidGroup = async (people: number) => {
    const started = await startGroup(store, product, String(people));
    if (!started.ok) throw new Error("no group");
    const session = paidSession({ group: started.group.id, people: String(people) }, "payer@example.com", people);
    if ((await settleGroup({ store, product, base, from, session })) !== "settled") throw new Error("not settled");
    store = (await storeForEmail(OWNER))!;
    const id = started.group.id;
    const link = async (email: string) => {
      const t = Buffer.from((id.slice(-6) + email).padEnd(32, "x").slice(0, 32)).toString("hex");
      await real([["SET", `nl:grp:take:${t}`, JSON.stringify({ g: id, e: email }), "EX", 3600]]);
      return t;
    };
    return { id, link };
  };
  const take = (token: string) => outcome(takePlace({ store, token, recordStart: async () => {} }));
  /** The place counter's write, as a plain INCR or inside a script that counts a run's own hold. */
  const isCount = (id: string) => (c: Command) => (c[0] === "INCR" && c[1] === `nl:grp:${id}:n`) || (c[0] === "EVAL" && c.includes(`nl:grp:${id}:n`));

  part("C. L1: a group of 2, the first place's counter write lands, its reply in another shape");
  const c = await paidGroup(2);
  const ivy = await c.link("ivy@example.com");
  unknownOnce(isCount(c.id), true);
  const ivy1 = await take(ivy);
  restore();
  const ivy2 = await take(ivy);
  const jo = await take(await c.link("jo@example.com"));
  const kim = await take(await c.link("kim@example.com"));
  is("ivy ends with her place, jo takes the second, kim is told full", [[ivy1, ivy2].includes("taken"), jo, kim], [true, "taken", "full"]);
  is("two places paid for: ivy and jo both hold the product", [await owns("ivy@example.com"), await owns("jo@example.com")], [[product.id], [product.id]]);
  is("two places counted", await placesTaken(c.id), 2);

  part("D. Rule 30: full group, the give-back script fails on both tries, then that address asks for a link");
  const d = await paidGroup(2);
  is("two places, taken", [await take(await d.link("al@example.com")), await take(await d.link("bea@example.com"))], ["taken", "taken"]);
  const bobLink = await d.link("bob@example.com");
  const isDropOf = (cmd: Command) => cmd[0] === "EVAL" && cmd[3] === `nl:grp:${d.id}:m` && String(cmd[1]).includes("hdel-own");
  redis.pipeline = (async (commands: Command[]) => {
    if (!commands.some(isDropOf)) return real(commands);
    await real(commands.filter((cmd) => !isDropOf(cmd)));
    throw new Error("Redis error: ERR script failed");
  }) as typeof redis.pipeline;
  const bobTake = await take(bobLink);
  restore();
  const sentBefore = emails.length;
  const bobAsk = await askPlace({ store, id: d.id, email: "bob@example.com", product, base, from, ordersLink: async () => null });
  is("bob is told full on taking, and full on asking", [bobTake, bobAsk], ["full", "full"]);
  is("bob holds nothing and no email went to him", [await owns("bob@example.com"), emails.length - sentBefore], [[], 0]);

  part("D. Healthy control: an address that holds its place is sent the way in again");
  is("al asks and is sent the way in", await askPlace({ store, id: d.id, email: "al@example.com", product, base, from, ordersLink: async () => null }), "sent");

  part("E. N1: the place's grant answers in another shape and did not land");
  const e = await paidGroup(2);
  const cy = await e.link("cy@example.com");
  unknownOnce((cmd) => cmd[0] === "EVAL" && JSON.stringify(cmd).includes(`group:${e.id}`), false);
  const cy1 = await take(cy);
  restore();
  const cy2 = await take(cy);
  const dee = await take(await e.link("dee@example.com"));
  const eli = await take(await e.link("eli@example.com"));
  is("cy's first try refuses, the next takes the place; dee takes the second; eli is told full", [cy1, cy2, dee, eli], ["threw", "taken", "taken", "full"]);
  is("two places paid for: cy and dee both hold the product", [await owns("cy@example.com"), await owns("dee@example.com")], [[product.id], [product.id]]);
  is("two places counted", await placesTaken(e.id), 2);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
