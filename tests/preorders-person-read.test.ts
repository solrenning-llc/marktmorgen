/**
 * A person's copy of their pre-orders reads only their own, and never Stripe (#5125; coordinator b3f6, 8dc1 and 66f4,
 * 22 November 2026, after Claude 2's MEDIUM on #5137: a copy read through the store's current Stripe account lost the
 * pre-orders paid on an account the creator had disconnected or replaced). recordPreorder writes each entry and its
 * line in the buyer's index beside the product's hash in one script; every write of the product's hash gives the index
 * its expiry again; the copy reads the store's list of products with pre-orders, the person's line of each index and
 * one HGET for each entry, never a product's whole hash. Checked against the stand-in Redis; nothing real is reached.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { addProduct, claimHandle, clearStripeAccount, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { setSoon } from "@/lib/waitlist";
import { COPIERS } from "@/lib/person-copy";
import { PREORDER_COPY_PRODUCTS_MOST, PREORDER_INDEX_COMMANDS, PREORDER_RECORD, confirmPreorder, entriesKey, preordersOf, productsKey, whoField, whoKey } from "@/lib/preorders";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY ??= "sk_test_preorders_person_read_only";
// Stripe is never asked by the copy: any request to it while the copy runs fails this test.
let stripeAsked = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com") stripeAsked += 1;
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "preorders-person@example.com";
const HANDLE = "prepersonread";
const ADA = "ada@example.com";
const BOB = "bob@example.com";
const NOW = Math.floor(Date.now() / 1000);
const checkout = (n: string) => `cs_test_${n.padEnd(24, "0")}`;
const deps = { base: "https://marktmorgen.com/@prepersonread", from: '"Pre" <hello@marktmorgen.com>', ordersLink: async () => null, recordStart: async () => {} };

async function main() {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Pre person read", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1PreorderPerson", true);
  await setSubscription(OWNER, { customerId: "cus_PreOwner0001", subscriptionId: "sub_PreOwner0001", active: true, period: paidPeriod() });
  const product = async (title: string) => {
    const made = await addProduct(OWNER, title, "", "25", null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, "https://example.com/thing");
    // Coming soon: a paid pre-order is written down and receipted, and nothing is handed over or asked of Stripe yet.
    await setSoon((await storeForEmail(OWNER))!, made.product.id, true);
    return made.product.id;
  };
  const A = await product("Course A");
  const B = await product("Course B");
  const store = async () => (await storeForEmail(OWNER))!;
  const sid = (await store()).statsId!;
  // Each pre-order made by the real path: a paid pre-order checkout confirmed (recordPreorder), its product coming soon.
  const preorder = async (id: string, email: string, pid: string) => {
    const shop = await store();
    const listing = (await readListing(shop, pid)) as Listing;
    const session = { id, created: NOW - 600, status: "complete", payment_status: "paid", amount_total: 2500, currency: "usd", payment_intent: `pi_${id.slice(8, 30)}`, metadata: { store: HANDLE, product: pid, preorder: "yes" }, customer_details: { email } };
    return confirmPreorder(shop, session as never, listing, deps);
  };
  await preorder(checkout("ada1"), ADA, A);
  // Ada typed another casing on her second: her index is by the address in lower case, so it is found all the same.
  await preorder(checkout("ada2"), "ADA@Example.com", B);
  await preorder(checkout("bob1"), BOB, A);
  for (let i = 0; i < 20; i += 1) await preorder(checkout(`other${i}`), `other${i}@example.com`, A);

  const scope = async (email: string) => ({ store: await store(), statsId: sid, email, productIds: [A] }) as unknown as ErasureScope;
  const real = redis.pipeline.bind(redis);
  const watched = async <T>(run: () => Promise<T>) => {
    const sent: unknown[][] = [];
    redis.pipeline = (async (commands: unknown[][]) => {
      sent.push(...commands);
      return real(commands as never);
    }) as typeof redis.pipeline;
    stripeAsked = 0;
    try {
      return { out: await run(), sent, stripe: stripeAsked };
    } finally {
      redis.pipeline = real;
    }
  };

  part("A person's copy holds every pre-order of theirs, reads only theirs, and never asks Stripe");
  {
    const adaScope = await scope(ADA);
    const { out, sent, stripe } = await watched(() => COPIERS["lib/preorders.ts"](adaScope));
    const rows = out as { checkout: string; product: string }[];
    is("Ada's two, the one typed in another casing and the one of a product not in the scope's list included", rows.map((p) => [p.checkout, p.product]).sort(), [[checkout("ada1"), A], [checkout("ada2"), B]].sort());
    is("Stripe is not asked", stripe, 0);
    is("no product's whole hash of pre-orders is read", sent.some((c) => ["HGETALL", "HVALS", "HKEYS", "HSCAN"].includes(String(c[0])) && String(c[1]).startsWith(`nl:pre:${sid}:`)), false);
    is("the reads: the store's list, her line of each product's index, one HGET for each of her pre-orders", sent.map((c) => [c[0], c[1], c[2]]).sort(), [
      ["HGET", entriesKey(sid, A), checkout("ada1")], ["HGET", entriesKey(sid, B), checkout("ada2")],
      ["HGET", whoKey(sid, A), whoField(ADA)], ["HGET", whoKey(sid, B), whoField(ADA)],
      ["SMEMBERS", productsKey(sid), undefined],
    ].sort());
    is("Bob's one", ((await COPIERS["lib/preorders.ts"](await scope(BOB))) as { checkout: string }[]).map((p) => p.checkout), [checkout("bob1")]);
    is("a person with no pre-order: nothing", await COPIERS["lib/preorders.ts"](await scope("nobody@example.com")), []);
    // Claude 6 hsz3's LEVE on #5137 @62aea1f652: the address check on each entry is the last guard. An index line that
    // names another buyer's checkout (a later backfill, a change in whoField, anything but PREORDER_RECORD) never hands
    // that buyer's pre-order to this person.
    const adaLine = redis.run(["HGET", whoKey(sid, A), whoField(ADA)]);
    redis.run(["HSET", whoKey(sid, A), whoField(ADA), `${String(adaLine)}\n${checkout("bob1")}`]);
    const misfiled = ((await COPIERS["lib/preorders.ts"](await scope(ADA))) as { checkout: string }[]).map((p) => p.checkout).sort();
    redis.run(["HSET", whoKey(sid, A), whoField(ADA), String(adaLine)]);
    is("a line naming Bob's checkout in Ada's place: Ada's copy still holds only hers, never Bob's", misfiled, [checkout("ada1"), checkout("ada2")]);
  }

  part("The creator disconnects Stripe, or connects another account: the copy still holds them (Claude 2 on #5137)");
  {
    await clearStripeAccount(OWNER);
    is("no account: Ada's two still in her copy", ((await preordersOf(await store(), ADA)) as { checkout: string }[]).map((p) => p.checkout).sort(), [checkout("ada1"), checkout("ada2")]);
    await setStripeAccount(OWNER, "acct_1PreorderOther", true);
    is("another account: still both", ((await preordersOf(await store(), ADA)) as { checkout: string }[]).map((p) => p.checkout).sort(), [checkout("ada1"), checkout("ada2")]);
  }

  part("The index runs out with its entries, never before: every write of a product's hash gives both their expiry");
  {
    // Two days later, another buyer's pre-order of A renews A's hash; Ada's line beside it is renewed with it.
    redis.advance(2 * 86_400_000);
    const before = [redis.run(["TTL", entriesKey(sid, A)]), redis.run(["TTL", whoKey(sid, A)]), redis.run(["TTL", productsKey(sid)])];
    await preorder(checkout("late1"), "late@example.com", A);
    const after = [redis.run(["TTL", entriesKey(sid, A)]), redis.run(["TTL", whoKey(sid, A)]), redis.run(["TTL", productsKey(sid)])];
    is("renewed, all three", after.every((t, i) => Number(t) > Number(before[i])), true);
    is("the index and the entries run out together", after[0], after[1]);
    is("the store's list never before a product in it", Number(after[2]) >= Number(after[0]), true);
    is("B's untouched, still both together", redis.run(["TTL", entriesKey(sid, B)]), redis.run(["TTL", whoKey(sid, B)]));
  }

  part("Read exactly: unknown is never 'no pre-order', and a store past one request's products fails rather than be cut");
  {
    const shop = await store();
    const bent = async (command: string, key: string, reply: unknown) => {
      redis.pipeline = (async (commands: unknown[][]) => {
        const replies = (await real(commands as never)) as unknown[];
        return commands.map((c, i) => (c[0] === command && c[1] === key ? reply : replies[i]));
      }) as typeof redis.pipeline;
      try {
        return await preordersOf(shop, ADA).then((rows) => `rows:${rows.length}`, (error) => (error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`));
      } finally {
        redis.pipeline = real;
      }
    };
    for (const [what, reply] of [["no reply", undefined], ["a number", 3], ["text", "x"], ["a list with a number", [A, 7]], ["a product id with a colon", ["a:b"]]] as const) {
      is(`the store's list as ${what}: unknown`, await bent("SMEMBERS", productsKey(sid), reply), "unknown");
    }
    for (const [what, reply] of [["no reply", undefined], ["a number", 3], ["a list", [checkout("ada1")]], ["an empty text", ""], ["a line that is not a checkout", "not-a-checkout"]] as const) {
      is(`her line as ${what}: unknown`, await bent("HGET", whoKey(sid, A), reply), "unknown");
    }
    for (const [what, reply] of [["no reply", undefined], ["a number", 3], ["a list", ["x"]], ["text that is not a pre-order", "not json"]] as const) {
      is(`her entry as ${what}: unknown`, await bent("HGET", entriesKey(sid, A), reply), "unknown");
    }
    is("no line in a product's index: none there", await bent("HGET", whoKey(sid, A), null), "rows:1");
    is("an entry gone: none", await bent("HGET", entriesKey(sid, A), null), "rows:1");
    const many = Array.from({ length: PREORDER_COPY_PRODUCTS_MOST + 1 }, (_, i) => `prod${String(i).padStart(9, "0")}`);
    is("more products than one copy request reads: unknown, never a copy cut short", await bent("SMEMBERS", productsKey(sid), many), "unknown");
  }

  part("A pre-order is made only by recordPreorder's one script, with its line; every EXPIRE of a product's hash renews the index");
  {
    const source = readFileSync("lib/preorders.ts", "utf8");
    is("no HSETNX of an entry outside the script", /\["HSETNX", entriesKey\(/.test(source), false);
    const script = source.slice(source.indexOf("export const PREORDER_RECORD = `"), source.indexOf("`;", source.indexOf("export const PREORDER_RECORD = `")));
    is("the script makes the entry and, only when new, its line and the product in the list, then the three expiries", ['redis.call("HSETNX", KEYS[1]', 'if made == 1 then', 'redis.call("HSET", KEYS[2], ARGV[1], list)', 'redis.call("SADD", KEYS[3], ARGV[4])', 'redis.call("EXPIRE", KEYS[1], ARGV[5])', 'redis.call("EXPIRE", KEYS[2], ARGV[5])', 'redis.call("EXPIRE", KEYS[3], ARGV[5])'].every((part) => script.includes(part)), true);
    is("its priced commands: the EVAL and its eight calls for the entry's three, and keep's two more at each of two later writes", [(PREORDER_RECORD.match(/redis\.call\(/g) ?? []).length, PREORDER_INDEX_COMMANDS], [8, 1 + 8 - 3 + 2 * 2]);
    is("the script is recordPreorder's, with the three keys in that order", /\["EVAL", PREORDER_RECORD, 3, entriesKey\(sid, read\.productId\), whoKey\(sid, read\.productId\), productsKey\(sid\)/.test(source), true);
    // Every EXPIRE of a product's hash is keep's, and keep gives the index and the list theirs in the same breath.
    const expires = [...source.matchAll(/\["EXPIRE", entriesKey\(/g)].length;
    is("one EXPIRE of a product's hash in the code, keep's", expires, 1);
    is("keep gives the hash, the index and the list their expiry together", /const keep = [^;]*\["EXPIRE", entriesKey\(sid, product\), KEPT_SECONDS\],\s*\["EXPIRE", whoKey\(sid, product\), KEPT_SECONDS\],\s*\["EXPIRE", productsKey\(sid\), KEPT_SECONDS\],/.test(source), true);
    const writes = [...source.matchAll(/\["HSET", entriesKey\(([^,]+), ([^,)]+)\), [^\]]*\], \.\.\.keep\(\1, \2\)/g)].length;
    const allWrites = [...source.matchAll(/\["HSET", entriesKey\(/g)].length;
    is("every HSET of an entry is sent with keep for the same product", writes > 0 && writes === allWrites, true);
    // No other file writes a pre-order's keys.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(path);
      }
    };
    for (const dir of ["lib", "app", "scripts"]) walk(dir);
    const elsewhere = files.filter((path) => path !== join("lib", "preorders.ts") && /nl:pre:/.test(readFileSync(path, "utf8")));
    is("the other files that name nl:pre: are the families' list, the gifts' comment and the dispute review's read", elsewhere.sort(), [join("lib", "data-families.ts"), join("lib", "dispute-preorder-review.ts"), join("lib", "gifts.ts")]);
    is("the dispute review only reads a pre-order (HGET and PTTL in its script)", /redis\.call\("HGET"/.test(readFileSync(join("lib", "dispute-preorder-review.ts"), "utf8")) && !/redis\.call\("H(SET|SETNX|DEL|MSET)"/.test(readFileSync(join("lib", "dispute-preorder-review.ts"), "utf8")), true);
    // The erasure keeps pre-orders on purpose (lib/person-data.ts): no eraser touches them, so their index stays with them.
    is("no eraser for lib/preorders.ts: kept on purpose, the index with it", /module: "lib\/preorders\.ts"/.test(readFileSync(join("lib", "person-erasure.ts"), "utf8")), false);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
