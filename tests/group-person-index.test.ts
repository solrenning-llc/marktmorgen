/**
 * The purchases for several a person paid are in their copy without Stripe (#5125, the Stripe-read copiers row): a
 * purchase paid (or given back before it settled) names its buyer, as the SHA-256 of their address in lower case, and
 * is put in their index in the same pipeline as every write of it, with the same expiry. The copy reads that index and
 * each purchase, never the store's current Stripe account, and never by the address's casing. Stand-ins only.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, clearStripeAccount, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { buyerField, buyerGroupsKey, groupsBoughtBy, settleGroup, startGroup } from "@/lib/group-buy";
import { COPIERS } from "@/lib/person-copy";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
const OWNER = "owner@groupindex.example";
const HANDLE = "groupindex";
const ADA = "ada@groupindex.example";
const BOB = "bob@groupindex.example";
const refunded = new Set<string>();
let stripeAsked = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  stripeAsked += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  if (path.startsWith("/payment_intents/")) {
    const pi = decodeURIComponent(path.slice("/payment_intents/".length));
    const charge = { id: `ch_${pi.slice(3)}`, object: "charge", payment_intent: pi, refunded: refunded.has(pi), disputed: false, amount: 7500, amount_refunded: refunded.has(pi) ? 7500 : 0 };
    return answer({ id: pi, object: "payment_intent", status: "succeeded", latest_charge: charge });
  }
  if (path === "/refunds" || path === "/events") return answer({ object: "list", data: [], has_more: false });
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
  process.env.STRIPE_SECRET_KEY = "sk_test_group_person_index_only";
  process.env.RESEND_API_KEY = "re_test_group_person_index_only";
  await claimHandle(OWNER, HANDLE, "Group Index", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGroupIndx1", true);
  await setSubscription(OWNER, { customerId: "cus_GroupIndx001", subscriptionId: "sub_GroupIndx001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  const store = async () => (await storeForEmail(OWNER))!;
  const sid = (await store()).statsId!;
  const product = (await readListing(await store(), made.product.id))! as Listing;
  // A purchase for several: started before its checkout, then settled by the real path (settleGroup).
  const buy = async (n: number, typed: string, people: number, refundFirst = false) => {
    const shop = await store();
    const started = await startGroup(shop, product, people);
    if (!started.ok) throw new Error(`no purchase for several: ${JSON.stringify(started)}`);
    const pi = `pi_groupindex${String(n).padStart(8, "0")}`;
    if (refundFirst) refunded.add(pi);
    const outcome = await quiet(() => settleGroup({
      store: shop,
      session: { id: `cs_test_groupindex${String(n).padStart(8, "0")}`, created: NOW - 600, amount_total: 7500, currency: "usd", payment_intent: pi, metadata: { store: HANDLE, product: product.id, group: started.group.id }, customer_details: { email: typed } } as never,
      product,
      base: "https://marktmorgen.com/@groupindex",
      from: '"Group Index" <hello@marktmorgen.com>',
    }));
    return { id: started.group.id, outcome };
  };
  const one = await buy(1, "Ada@GroupIndex.example", 3);
  const two = await buy(2, ADA, 4, true);
  const three = await buy(3, BOB, 5);
  is("the purchases went through the real path: settled, given back before it settled, settled", [one.outcome, two.outcome, three.outcome], ["settled", "already", "settled"]);

  const scope = async (email: string) => ({ store: await store(), statsId: sid, email, productIds: [product.id] }) as unknown as ErasureScope;
  const bought = async (email: string) => {
    stripeAsked = 0;
    const rows = (await COPIERS["lib/group-buy.ts"](await scope(email))) as { youBought?: boolean; places: number }[];
    return { places: rows.filter((r) => r.youBought).map((r) => r.places).sort(), stripe: stripeAsked };
  };

  part("A person's copy holds every purchase for several they paid, and only theirs, without Stripe");
  {
    const ada = await bought(ADA);
    is("Ada's two: the one typed in another casing, and the one given back before it settled", ada.places, [3, 4]);
    is("Stripe is not asked", ada.stripe, 0);
    is("Bob's one", (await bought(BOB)).places, [5]);
    is("a person who paid none: none", (await bought("nobody@groupindex.example")).places, []);
  }

  part("The creator disconnects Stripe, or connects another account: the copy still holds them");
  {
    await clearStripeAccount(OWNER);
    is("no account: Ada's two", (await bought(ADA)).places, [3, 4]);
    await setStripeAccount(OWNER, "acct_1TestGroupIndx2", true);
    is("another account: Ada's two", (await bought(ADA)).places, [3, 4]);
  }

  part("The index runs out with the purchases it leads to");
  {
    const index = buyerGroupsKey(sid, buyerField(ADA));
    is("Ada's index and her latest purchase's record have the same expiry", redis.run(["TTL", index]), redis.run(["TTL", `nl:grp:${two.id}`]));
  }

  part("Read exactly: unknown is never 'none paid'");
  {
    const real = redis.pipeline.bind(redis);
    const index = buyerGroupsKey(sid, buyerField(ADA));
    const bent = async (reply: unknown) => {
      redis.pipeline = (async (commands: unknown[][]) => {
        const replies = (await real(commands as never)) as unknown[];
        return commands.map((c, i) => (c[0] === "SMEMBERS" && c[1] === index ? reply : replies[i]));
      }) as typeof redis.pipeline;
      try {
        return await groupsBoughtBy(sid, ADA).then((ids) => `ids:${ids.length}`, (error) => (error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`));
      } finally {
        redis.pipeline = real;
      }
    };
    for (const [what, reply] of [["no reply", undefined], ["a number", 3], ["text", "grp_x"], ["a list with a number", [one.id, 7]], ["a list with something not a purchase id", ["not-a-group"]]] as const) {
      is(`the index as ${what}: unknown`, await bent(reply), "unknown");
    }
    is("an empty index: none", await bent([]), "ids:0");
  }

  part("Every write of a purchase's record goes through saveGroup");
  {
    const source = readFileSync("lib/group-buy.ts", "utf8");
    is("one SET of a purchase's record in the code, saveGroup's", [...source.matchAll(/\["SET", groupKey\(/g)].length, 1);
    const save = source.slice(source.indexOf("async function saveGroup("), source.indexOf("\n}\n", source.indexOf("async function saveGroup(")));
    is("saveGroup writes the record and, for a paid purchase, the index and its expiry, in one pipeline", ['["SET", groupKey(group.id), JSON.stringify(group), "EX", seconds]', '["SADD", index, group.id]', '["EXPIRE", index, seconds]'].every((part) => save.includes(part)), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
