/**
 * The gifts a person bought are in their copy without Stripe (#5125, the Stripe-read copiers row; coordinator b3f6's
 * pattern for pre-orders, 22 November 2026): a gift handed over (or given back before it was) names its buyer, as the
 * SHA-256 of their address in lower case, and is put in their index in the same pipeline as every write of it, with
 * the same expiry, so the index never runs out before the gift. The copy reads that index and each gift, never the
 * store's current Stripe account, which the creator may disconnect or replace, and never by the address's casing.
 * Checked against the stand-in Redis and a stand-in Stripe; nothing real is reached.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, clearStripeAccount, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { buyerField, buyerGiftsKey, deliverGift, giftsBoughtBy, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { COPIERS } from "@/lib/person-copy";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
const OWNER = "owner@giftindex.example";
const HANDLE = "giftindex";
const ADA = "ada@giftindex.example";
const BOB = "bob@giftindex.example";
/** The payments Stripe says were refunded in full. */
const refunded = new Set<string>();
let stripeAsked = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  stripeAsked += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  const charge = (pi: string) => ({ object: "charge", refunded: refunded.has(pi), amount: 2500, amount_refunded: refunded.has(pi) ? 2500 : 0 });
  if (path === "/refunds") {
    const data = [...refunded].map((pi, i) => ({ id: `re_giftindex${String(i).padStart(4, "0")}`, object: "refund", created: NOW, status: "succeeded", payment_intent: pi, charge: charge(pi) }));
    return answer({ object: "list", data, has_more: false });
  }
  if (path === "/events") return answer({ object: "list", data: [], has_more: false });
  if (path.startsWith("/payment_intents/")) {
    const pi = decodeURIComponent(path.slice("/payment_intents/".length));
    return answer({ id: pi, object: "payment_intent", status: "succeeded", latest_charge: charge(pi) });
  }
  return answer({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const errors = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = errors;
  }
};

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_person_index_only";
  process.env.RESEND_API_KEY = "re_test_gift_person_index_only";
  await claimHandle(OWNER, HANDLE, "Gift Index", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGiftIndex1", true);
  await setSubscription(OWNER, { customerId: "cus_GiftIndex001", subscriptionId: "sub_GiftIndex001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  const store = async () => (await storeForEmail(OWNER))!;
  const sid = (await store()).statsId!;
  const product = (await readListing(await store(), made.product.id))! as Listing;
  // A gift bought: started before its checkout, then confirmed by the real path (deliverGift).
  const buy = async (n: number, typed: string, refundFirst = false) => {
    const shop = await store();
    const started = await startGift(shop, product, { to: `friend${n}@giftindex.example`, from: "Ana", message: `Note ${n}` });
    if (!started.ok) throw new Error("no gift");
    const pi = `pi_giftindex${String(n).padStart(8, "0")}`;
    if (refundFirst) refunded.add(pi);
    const outcome = await quiet(() => deliverGift({
      store: shop,
      session: { id: `cs_test_giftindex${String(n).padStart(8, "0")}`, created: NOW - 600, amount_total: 2500, currency: "usd", payment_intent: pi, metadata: { store: HANDLE, product: product.id, gift: started.gift.id }, customer_details: { email: typed } } as never,
      product,
      base: "https://marktmorgen.com/@giftindex",
      from: '"Gift Index" <hello@marktmorgen.com>',
      recordStart: async () => {},
      ordersLink: async () => null,
    }));
    return { id: started.gift.id, outcome, pi };
  };
  const one = await buy(1, "Ada@GiftIndex.example");
  const two = await buy(2, ADA, true);
  const three = await buy(3, BOB);
  is("the gifts went through the real path: given, given back before it was, given", [one.outcome, two.outcome, three.outcome], ["given", "already", "given"]);

  const scope = async (email: string) => ({ store: await store(), statsId: sid, email, productIds: [product.id] }) as unknown as ErasureScope;
  const bought = async (email: string) => {
    stripeAsked = 0;
    const rows = (await COPIERS["lib/gifts.ts"](await scope(email))) as { youBought?: boolean; message: string; refunded?: string }[];
    return { rows: rows.filter((r) => r.youBought).map((r) => [r.message, Boolean(r.refunded)]).sort(), stripe: stripeAsked };
  };

  part("A person's copy holds every gift they bought, and only theirs, without Stripe");
  {
    const ada = await bought(ADA);
    is("Ada's two: the one typed in another casing, and the one given back before it was handed over", ada.rows, [["Note 1", false], ["Note 2", true]]);
    is("Stripe is not asked", ada.stripe, 0);
    is("Bob's one, none of Ada's", (await bought(BOB)).rows, [["Note 3", false]]);
    is("a person who bought none: none", (await bought("nobody@giftindex.example")).rows, []);
  }

  part("The creator disconnects Stripe, or connects another account: the copy still holds them");
  {
    await clearStripeAccount(OWNER);
    is("no account: Ada's two", (await bought(ADA)).rows, [["Note 1", false], ["Note 2", true]]);
    await setStripeAccount(OWNER, "acct_1TestGiftIndex2", true);
    is("another account: Ada's two", (await bought(ADA)).rows, [["Note 1", false], ["Note 2", true]]);
    await setStripeAccount(OWNER, "acct_1TestGiftIndex1", true);
  }

  part("The index runs out with the gifts it leads to, never before");
  {
    const index = buyerGiftsKey(sid, buyerField(ADA));
    is("Ada's index and her latest gift's record have the same expiry", redis.run(["TTL", index]), redis.run(["TTL", `nl:gift:${two.id}`]));
    // Days later, a full refund of her first gift is taken back by the refund pass: its write gives the index its expiry again.
    redis.advance(3 * 86_400_000);
    refunded.add(one.pi);
    const shop = await store();
    await quiet(() => revokeRefundedGifts(shop, Date.now() + 60_000, async () => {}));
    is("the refund pass's write renewed the index with the gift", redis.run(["TTL", index]), redis.run(["TTL", `nl:gift:${one.id}`]));
    is("and the copy says it was refunded", (await bought(ADA)).rows, [["Note 1", true], ["Note 2", true]]);
  }

  part("Read exactly: unknown is never 'no gift bought'");
  {
    const real = redis.pipeline.bind(redis);
    const index = buyerGiftsKey(sid, buyerField(ADA));
    const bent = async (reply: unknown) => {
      redis.pipeline = (async (commands: unknown[][]) => {
        const replies = (await real(commands as never)) as unknown[];
        return commands.map((c, i) => (c[0] === "SMEMBERS" && c[1] === index ? reply : replies[i]));
      }) as typeof redis.pipeline;
      try {
        return await giftsBoughtBy(sid, ADA).then((ids) => `ids:${ids.length}`, (error) => (error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`));
      } finally {
        redis.pipeline = real;
      }
    };
    for (const [what, reply] of [["no reply", undefined], ["a number", 3], ["text", "gft_x"], ["a list with a number", [one.id, 7]], ["a list with something not a gift id", ["not-a-gift"]]] as const) {
      is(`the index as ${what}: unknown`, await bent(reply), "unknown");
    }
    is("an empty index: none", await bent([]), "ids:0");
  }

  part("Every write of a gift goes through saveGift, and only a handed-over gift (with its buyer) is in an index");
  {
    const source = readFileSync("lib/gifts.ts", "utf8");
    is("one SET of a gift's record in the code, saveGift's", [...source.matchAll(/\["SET", giftKey\(/g)].length, 1);
    const save = source.slice(source.indexOf("async function saveGift("), source.indexOf("\n}\n", source.indexOf("async function saveGift(")));
    is("saveGift writes the record and, for a gift that names its buyer, the index and its expiry, in one pipeline", ['["SET", giftKey(gift.id), JSON.stringify(gift), "EX", seconds]', '["SADD", index, gift.id]', '["EXPIRE", index, seconds]'].every((part) => save.includes(part)), true);
    const pending = [...source.matchAll(/saveGift\(([^)]*), GIFT_PENDING_SECONDS\)/g)].map((m) => m[1]);
    is("the one short-lived write is the new gift's, before anyone paid (no buyer, no index)", pending, ["gift"]);
    is("every other write keeps a gift as long as a given one", [...source.matchAll(/saveGift\([^;]*?, (GIFT_\w+)\)\)/g)].every((m) => ["GIFT_KEPT_SECONDS", "GIFT_PENDING_SECONDS"].includes(m[1])), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
