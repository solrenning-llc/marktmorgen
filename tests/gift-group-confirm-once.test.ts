/**
 * A gift or a purchase for several confirmed in full, whose caller's "sent" mark (lib/purchase-email.ts,
 * confirmGift/confirmGroup) did not land (Claude 3, CX-116 on #2872, LOW 1). Synthetic only: the in-memory Redis
 * double and an email stand-in; no Stripe, no real email.
 *
 * Once the giving/settling mark has run out (300 s) and within the day, a later run takes the re-tell path made for
 * #2872 review M1 and answers "sent" again. The room the checkout was admitted with (lib/order-admission.ts) is given
 * back once per checkout, never a second time: a second give-back would free another checkout's room in that hour, and
 * the store could admit one order past its plan's figure. Beside each, the M1 case itself: the first run threw before
 * giving anything back, so the run after it gives the room back, once.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { startGift } from "@/lib/gifts";
import { startGroup } from "@/lib/group-buy";
import { confirmPurchase } from "@/lib/purchase-email";
import { ADMITTED_FIELD, admitOrders } from "@/lib/order-admission";
import { paidPeriod } from "./billing-period-fixture";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
globalThis.fetch = (async (input: string | URL | Request) =>
  new URL(String(input)).hostname === "api.resend.com"
    ? new Response(JSON.stringify({ id: "email_1" }), { status: 200 })
    : new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;
const outcome = <T>(p: Promise<T>): Promise<T | "threw"> => p.then((v) => v, () => "threw" as const);
/** Every pipeline runs as usual, except that a lone command `match` picks is answered in an unknown shape, landed or not. */
function unknownFor(match: (c: Command) => boolean, lands: boolean): void {
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length !== 1 || !match(commands[0])) return real(commands);
    if (lands) await real(commands);
    return [{ unexpected: true }];
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = real;
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_group_confirm_once";
  process.env.RESEND_API_KEY = "re_test_gift_group_confirm_once";
  const OWNER = "giftconfirmonce@example.com";
  await claimHandle(OWNER, "giftonce", "Gift Once", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGiftOnce01", true);
  await setSubscription(OWNER, { customerId: "cus_GiftOnce00001", subscriptionId: "sub_GiftOnce00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Glaze Guide", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const folder = await storeFolder(OWNER);
  const held = async (hour: number) => Number((await real([["HGET", `nl:orders:open:${folder}`, String(hour)]]))[0] ?? 0);
  let n = 0;
  const session = (meta: Record<string, string>, hour: number, people = 1) => {
    n += 1;
    return {
      id: "cs_test_" + String(n).padStart(24, "o"),
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      created: Math.floor(Date.now() / 1000),
      amount_total: 4900 * people,
      currency: "usd",
      payment_intent: `pi_GiftOnce${String(n).padStart(6, "0")}`,
      metadata: { store: "giftonce", product: product.id, [ADMITTED_FIELD]: String(hour), ...meta },
      customer_details: { email: "payer@example.com" },
    };
  };
  /** Two checkouts admitted in the same hour, this one a gift or a purchase for several. */
  const twoAdmitted = async (kind: "gift" | "group") => {
    const a = await admitOrders(store, 1);
    const b = await admitOrders(store, 1);
    if (!a.ok || !b.ok || a.hour === null || a.hour !== b.hour) throw new Error(`no admission ${JSON.stringify([a, b])}`);
    let meta: Record<string, string>;
    if (kind === "gift") {
      const g = await startGift(store, product, { to: `friend-${n}@example.com`, from: "Ana", message: "" });
      if (!g.ok) throw new Error("no gift");
      meta = { gift: g.gift.id };
    } else {
      const g = await startGroup(store, product, "2");
      if (!g.ok) throw new Error("no group");
      meta = { group: g.group.id, people: "2" };
    }
    const s = session(meta, a.hour, kind === "group" ? 2 : 1);
    return { s, hour: a.hour, before: await held(a.hour), record: kind === "gift" ? `nl:gift:${meta.gift}` : `nl:grp:${meta.group}` };
  };

  for (const kind of ["gift", "group"] as const) {
    part(`${kind}: confirmed in full, its "sent" mark write did not land, and a run comes after the 300 s mark`);
    const one = await twoAdmitted(kind);
    unknownFor((c) => c[0] === "SET" && c[1] === `nl:confirm:${one.s.id}`, false);
    const first = await outcome(confirmPurchase(store, one.s.id, one.s as never));
    restore();
    const afterFirst = await held(one.hour);
    advance(301_000);
    const second = await outcome(confirmPurchase(store, one.s.id, one.s as never));
    const afterSecond = await held(one.hour);
    is("the first run confirms and gives its own room back once", [first, afterFirst], ["sent", one.before - 1]);
    is("the run after it never gives back another checkout's room", afterSecond, one.before - 1);

    part(`${kind}: M1, the record's last write lands with its reply in another shape, so the first run throws`);
    const m1 = await twoAdmitted(kind);
    unknownFor((c) => c[0] === "SET" && c[1] === m1.record, true);
    const m1First = await outcome(confirmPurchase(store, m1.s.id, m1.s as never));
    restore();
    const m1AfterFirst = await held(m1.hour);
    const m1Second = await outcome(confirmPurchase(store, m1.s.id, m1.s as never));
    const m1Third = await outcome(confirmPurchase(store, m1.s.id, m1.s as never));
    is("threw, then sent, then already", [m1First, m1Second, m1Third], ["threw", "sent", "already"]);
    is("the room is held through the throw, then given back once", [m1AfterFirst, await held(m1.hour)], [m1.before, m1.before - 1]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
