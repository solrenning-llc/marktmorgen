/**
 * The call packages a person bought are in their copy without Stripe (#5125, the Stripe-read copiers row; coordinator
 * b3f6's pattern, 22 November 2026): a package's checkout is put in its buyer's index, under the SHA-256 of their address
 * in lower case, in the same write as its booking link's token. A package with a last day goes in a set that runs out,
 * never before the latest package in it; one with no last day goes in a set kept for good, like the package. The copy
 * reads that index and each package, never the store's current Stripe account, and never by the address's casing.
 * Checked against the stand-in Redis and a stand-in Stripe; nothing real is reached.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, clearStripeAccount, ensureStatsId, setCallPackage, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { buyerField, buyerPackagesKey, packagesBoughtBy, recordPackage } from "@/lib/call-packages";
import { COPIERS } from "@/lib/person-copy";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { CallSetup } from "@/lib/call-setup";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "owner@pkgindex.example";
const HANDLE = "pkgindex";
const ADA = "ada@pkgindex.example";
const BOB = "bob@pkgindex.example";
let stripeAsked = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "e" }));
  stripeAsked += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (method === "POST" && path === "/coupons") return new Response(JSON.stringify({ id: "co_Session1" }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const weekly = {
  kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;
const checkoutId = (n: number) => `cs_test_pkgindex${String(n).padStart(16, "0")}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const ttl = (key: string) => Number(redis.run(["TTL", key]));

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_package_person_index_only";
  process.env.RESEND_API_KEY = "re_test_package_person_index_only";
  await claimHandle(OWNER, HANDLE, "Package Index", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPkgIndex01", true);
  await setSubscription(OWNER, { customerId: "cus_PkgIndex001", subscriptionId: "sub_PkgIndex001", active: true, period: paidPeriod() });
  const call = await addProduct(OWNER, "Coaching Call", "", "120", null);
  if (!call.ok) throw new Error("no product");
  await setProductCall(OWNER, call.product.id, weekly);
  const store = async () => (await storeForEmail(OWNER))!;
  const sid = (await store()).statsId!;
  // A package bought: recorded by the real path (recordPackage, then finishPackage), as the thanks page does.
  const buy = async (n: number, typed: string, days: number) => {
    if (!(await setCallPackage(OWNER, call.product.id, { sessions: 3, priceCents: 30000, days })).ok) throw new Error("no package offered");
    const shop = await store();
    const listing = (await readListing(shop, call.product.id))! as Listing;
    const session = { id: checkoutId(n), status: "complete", payment_status: "paid", created: nowSeconds(), amount_total: 30000, currency: "usd", metadata: { store: HANDLE, product: listing.id, kind: "package", sessions: "3", days: String(days) }, customer_details: { email: typed } };
    const bought = await recordPackage({ store: shop, session: session as never, product: listing, base: `https://marktmorgen.com/@${HANDLE}`, from: "hello@marktmorgen.com" });
    if (!bought) throw new Error("not recorded");
    return checkoutId(n);
  };
  const thirty = await buy(1, "Ada@PkgIndex.example", 30);
  const forever = await buy(2, ADA, 0);
  await buy(3, BOB, 30);

  const scope = async (email: string) => ({ store: await store(), statsId: sid, email }) as unknown as ErasureScope;
  const bought = async (email: string) => {
    stripeAsked = 0;
    const rows = (await COPIERS["lib/call-packages.ts"](await scope(email))) as { sessions: number; bookBy: string | null }[];
    return { rows: rows.map((r) => `${r.sessions}:${r.bookBy ? "dated" : "no last day"}`).sort(), stripe: stripeAsked };
  };

  part("A person's copy holds every call package they bought, and only theirs, without Stripe");
  {
    const ada = await bought(ADA);
    is("Ada's two: the one typed in another casing (30 days), and the one with no last day", ada.rows, ["3:dated", "3:no last day"]);
    is("Stripe is not asked", ada.stripe, 0);
    is("Bob's one, none of Ada's", (await bought(BOB)).rows, ["3:dated"]);
    is("a person who bought none: none", (await bought("nobody@pkgindex.example")).rows, []);
  }

  part("The creator disconnects Stripe, or connects another account: the copy still holds them");
  {
    await clearStripeAccount(OWNER);
    is("no account: Ada's two", (await bought(ADA)).rows, ["3:dated", "3:no last day"]);
    await setStripeAccount(OWNER, "acct_1TestPkgIndex02", true);
    is("another account: Ada's two", (await bought(ADA)).rows, ["3:dated", "3:no last day"]);
  }

  part("The index never runs out before a package it leads to");
  {
    const dated = buyerPackagesKey(sid, buyerField(ADA), false);
    const lasting = buyerPackagesKey(sid, buyerField(ADA), true);
    is("the package with no last day is in the set kept for good, with no expiry, like the package", [redis.run(["SMEMBERS", lasting]), ttl(lasting), ttl(`nl:pkg:${forever}`)], [[forever], -1, -1]);
    is("the dated package's set runs out with it", ttl(dated), ttl(`nl:pkg:${thirty}`));
    const longer = await buy(4, ADA, 90);
    is("a later package with a later last day carries the set to its own expiry (GT)", ttl(dated), ttl(`nl:pkg:${longer}`));
    const shorter = await buy(5, ADA, 60);
    is("a package with an earlier last day never shortens it", [ttl(dated) >= ttl(`nl:pkg:${longer}`), ttl(dated) > ttl(`nl:pkg:${shorter}`)], [true, true]);
    is("all four of Ada's are in her copy", (await bought(ADA)).rows.length, 4);
    is("and the set holds the three dated ones", (redis.run(["SMEMBERS", dated]) as string[]).sort(), [thirty, longer, shorter].sort());
  }

  part("Read exactly: unknown is never 'no package bought'");
  {
    const real = redis.pipeline.bind(redis);
    const dated = buyerPackagesKey(sid, buyerField(ADA), false);
    const bent = async (reply: unknown, key = dated) => {
      redis.pipeline = (async (commands: unknown[][]) => {
        const replies = (await real(commands as never)) as unknown[];
        return commands.map((c, i) => (c[0] === "SMEMBERS" && c[1] === key ? reply : replies[i]));
      }) as typeof redis.pipeline;
      try {
        return await packagesBoughtBy(sid, ADA).then((ids) => `ids:${ids.length}`, (error) => (error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`));
      } finally {
        redis.pipeline = real;
      }
    };
    for (const [what, reply] of [["no reply", undefined], ["a number", 3], ["text", thirty], ["a list with a number", [thirty, 7]], ["a list with something not a checkout id", ["not-a-checkout"]]] as const) {
      is(`the dated set as ${what}: unknown`, await bent(reply), "unknown");
      is(`the set kept for good as ${what}: unknown`, await bent(reply, buyerPackagesKey(sid, buyerField(ADA), true)), "unknown");
    }
    redis.pipeline = (async () => [[]]) as typeof redis.pipeline;
    is("one reply for two reads: unknown", await packagesBoughtBy(sid, ADA).then(() => "read", (error) => (error instanceof UnknownReplyError ? "unknown" : "other")), "unknown");
    redis.pipeline = real;
    is("the dated set empty: only the one kept for good", await bent([]), "ids:1");
    is("a person with neither set: none", (await packagesBoughtBy(sid, "nobody@pkgindex.example")).length, 0);
  }

  part("The index is written with the token, in one write");
  {
    const source = readFileSync("lib/call-packages.ts", "utf8");
    is("finishPackage writes the store's list, the token and the buyer's index in one orderWrite", source.includes('const [, set] = await orderWrite(store, [["SADD", packagesKey(bought.s), checkout], ["SET", tokenKey(bought.token), checkout, "NX", ...kept], ...indexCommands(bought, checkout, kept)]);'), true);
    is("a dated package: SADD, EXPIRE NX, EXPIRE GT at its own expiry", source.includes('return [["SADD", key, checkout], ["EXPIRE", key, kept[1], "NX"], ["EXPIRE", key, kept[1], "GT"]];'), true);
    is("the index is named under the store's set of packages, so a closing store deletes it with them", source.includes("`nl:pkg:s:${statsId}:${lasting ? \"byk\" : \"by\"}:${field}`"), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
