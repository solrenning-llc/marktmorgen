/**
 * A person's copy of their pre-orders reads only their own (#5125, coordinator 6e01, 22 November 2026): the copier
 * takes the person's own paid checkouts from the store's Stripe account (lib/person-copy.ts checkoutsOf), keeps those
 * that are pre-orders, and reads each one's entry by its checkout, never every product's whole hash of pre-orders.
 * That is complete because a pre-order is only ever made from such a checkout (lib/preorders.ts recordPreorder, from
 * readSession); the last part holds that path to the code, so a new way to make a pre-order fails this test before
 * it can leave a person's copy short. Checked against the stand-in Redis and a stand-in Stripe; nothing real is reached.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { COPIERS } from "@/lib/person-copy";
import { preordersOf } from "@/lib/preorders";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_preorders_person_read_only";

const OWNER = "preorders-person@example.com";
const HANDLE = "prepersonread";
const ACCOUNT = "acct_1PreorderPerson";
const ADA = "ada@example.com";
const BOB = "bob@example.com";
const PRODUCT_A = "preprodaaaaaa";
const PRODUCT_B = "preprodbbbbbb";
const checkout = (n: string) => `cs_test_${n.padEnd(24, "0")}`;
/**
 * Ada bought two pre-orders (one of a product the store no longer lists), Bob one, and Ada one plain sale. Stripe's
 * filter on the address is taken as exact, which is what the copy asks it for (as typed, and trimmed and lower-cased);
 * whether Stripe also matches another casing is a #5125 row of its own, for every copier that reads checkoutsOf.
 */
const SESSIONS: Record<string, { email: string; meta: Record<string, string> }> = {
  [checkout("ada1")]: { email: ADA, meta: { store: HANDLE, preorder: "yes", product: PRODUCT_A } },
  [checkout("ada2")]: { email: ADA, meta: { store: HANDLE, preorder: "yes", product: PRODUCT_B } },
  [checkout("adasale")]: { email: ADA, meta: { store: HANDLE, product: PRODUCT_A } },
  [checkout("bob1")]: { email: BOB, meta: { store: HANDLE, preorder: "yes", product: PRODUCT_A } },
};
const entry = (to: string) => JSON.stringify({ to, at: 1_790_000_000, pi: "", ship: false });

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com" || url.pathname !== "/v1/checkout/sessions") return json({ error: { message: "no stand-in" } }, 404);
  // Stripe's own filter, as the stand-in takes it: the address exactly as asked.
  const asked = url.searchParams.get("customer_details[email]") ?? "";
  const data = Object.entries(SESSIONS)
    .filter(([, s]) => s.email === asked)
    .map(([id, s]) => ({ id, status: "complete", payment_status: "paid", payment_intent: null, metadata: s.meta, customer_details: { email: s.email } }));
  return json({ object: "list", data, has_more: false });
}) as typeof fetch;

async function main() {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Pre person read", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const store = (await storeForEmail(OWNER))!;
  const sid = store.statsId!;
  const key = (product: string) => `nl:pre:${sid}:${product}`;
  await redis.pipeline([
    ["HSET", key(PRODUCT_A), checkout("ada1"), entry(" ADA@example.com"), checkout("bob1"), entry(BOB)],
    ["HSET", key(PRODUCT_B), checkout("ada2"), entry(ADA)],
  ]);
  // Other buyers' pre-orders of the same product: a person's copy never reads them.
  for (let i = 0; i < 200; i += 1) await redis.pipeline([["HSET", key(PRODUCT_A), checkout(`other${i}`), entry(`other${i}@example.com`)]]);
  // The scope lists only the product the store still has, as an erasure scope would.
  const scope = (email: string) => ({ store, statsId: sid, email, productIds: [PRODUCT_A] }) as unknown as ErasureScope;
  const real = redis.pipeline.bind(redis);
  const watched = async <T>(run: () => Promise<T>) => {
    const sent: unknown[][] = [];
    redis.pipeline = (async (commands: unknown[][]) => {
      sent.push(...commands);
      return real(commands as never);
    }) as typeof redis.pipeline;
    try {
      return { out: await run(), sent };
    } finally {
      redis.pipeline = real;
    }
  };

  part("A person's copy holds every pre-order of theirs, and reads only theirs");
  {
    const { out, sent } = await watched(() => COPIERS["lib/preorders.ts"](scope(ADA)));
    is("Ada's two pre-orders, the one of a product the store no longer lists included", (out as { checkout: string; product: string }[]).map((p) => [p.checkout, p.product]).sort(), [[checkout("ada1"), PRODUCT_A], [checkout("ada2"), PRODUCT_B]]);
    is("no product's whole hash of pre-orders is read", sent.some((c) => (c[0] === "HGETALL" || c[0] === "HVALS" || c[0] === "HKEYS" || c[0] === "HSCAN") && String(c[1]).startsWith(`nl:pre:${sid}:`)), false);
    is("one HGET for each of her pre-order checkouts, and nothing for her plain sale", sent.filter((c) => c[0] === "HGET").map((c) => [c[1], c[2]]).sort(), [[key(PRODUCT_A), checkout("ada1")], [key(PRODUCT_B), checkout("ada2")]]);
    is("Bob's one", ((await COPIERS["lib/preorders.ts"](scope(BOB))) as { checkout: string }[]).map((p) => p.checkout), [checkout("bob1")]);
    is("a person with no pre-order: nothing", await COPIERS["lib/preorders.ts"](scope("nobody@example.com")), []);
  }

  part("An entry is read exactly: unknown is never 'no pre-order', and a missing entry is none");
  {
    const ada = [{ id: checkout("ada1"), meta: SESSIONS[checkout("ada1")].meta }];
    const bent = async (reply: unknown) => {
      redis.pipeline = (async (commands: unknown[][]) => {
        const replies = (await real(commands as never)) as unknown[];
        return commands.map((c, i) => (c[0] === "HGET" && c[1] === key(PRODUCT_A) ? reply : replies[i]));
      }) as typeof redis.pipeline;
      try {
        return await preordersOf(store, ada, ADA).then((rows) => `rows:${rows.length}`, (error) => (error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`));
      } finally {
        redis.pipeline = real;
      }
    };
    for (const [what, reply] of [["no reply", undefined], ["a number", 3], ["a list", [entry(ADA)]], ["text that is not a pre-order", "not json"], ["a pre-order with no buyer", JSON.stringify({ at: 1, pi: "" })]] as const) {
      is(`${what}: the copy is not made`, await bent(reply), "unknown");
    }
    is("an entry Redis says is not there: none", await bent(null), "rows:0");
    is("a checkout that is not a pre-order is never read", await watched(() => preordersOf(store, [{ id: checkout("adasale"), meta: SESSIONS[checkout("adasale")].meta }], ADA)).then((r) => [r.out, r.sent.length]), [[], 0]);
  }

  part("A pre-order is made only from the person's own paid checkout of the store (the copy's completeness rests on it)");
  {
    const source = readFileSync("lib/preorders.ts", "utf8");
    // The only write that makes an entry: HSETNX on a product's pre-orders, inside recordPreorder.
    const makes = [...source.matchAll(/\["HSETNX", entriesKey\(/g)].map((m) => m.index ?? 0);
    const record = source.indexOf("async function recordPreorder(");
    const recordEnd = source.indexOf("\n}\n", record);
    is("one HSETNX makes an entry, and it is recordPreorder's", makes.length === 1 && makes[0] > record && makes[0] < recordEnd, true);
    // Every other write of an entry is an HSET of one already read (given, revoked), never a new one.
    const sets = [...source.matchAll(/\["HSET", entriesKey\([^\]]*JSON\.stringify\(\{ \.\.\.(\w+)/g)].map((m) => m[1]);
    is("every HSET of an entry writes over one read before it", sets.length > 0 && sets.every((name) => ["entry", "current"].includes(name)), true);
    // recordPreorder is called only with what readSession read from a paid checkout session of the store.
    const calls = [...source.matchAll(/recordPreorder\(store, \{ \.\.\.(\w+), pi: \1\.pi \}\)/g)].map((m) => m[1]);
    is("recordPreorder's callers pass only readSession's result", calls.length >= 1 && calls.length === source.split("recordPreorder(store,").length - 1 && calls.every((name) => name === "read") && [...source.matchAll(/const read = readSession\(store, session\);/g)].length === calls.length, true);
    const reader = source.slice(source.indexOf("function readSession("), source.indexOf("function readSession(") + 1200);
    is("readSession takes only a settled pre-order checkout of one of the store's handles", ['meta.preorder !== "yes"', "saleHandles(store)", "isSettled(session)", "customer_details?.email"].every((part) => reader.includes(part)), true);
    // No other file writes a pre-order's entry key (nl:pre:<store>:<product>).
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
    const review = readFileSync(join("lib", "dispute-preorder-review.ts"), "utf8");
    is("the dispute review only reads a pre-order (HGET and PTTL in its script)", /redis\.call\("HGET"/.test(review) && !/redis\.call\("H(SET|SETNX|DEL|MSET)"/.test(review), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
