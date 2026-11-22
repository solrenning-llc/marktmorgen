/**
 * A person's copy reads only that person's call packages (issue #5125, row (1) call-packages): the copier used to read
 * the store's whole set of packages ever sold (SMEMBERS of nl:pkg:s:<store>, which never expires) and GET every one of
 * them to keep the person's, so one person's copy cost grew with every package the store had sold. It now reads the
 * package record of each of the person's own paid checkouts in the store (the same Stripe read the copy already makes
 * for shipments), so it is bounded by what that person bought. Synthetic store, Stripe and email.
 */
import { addProduct, claimHandle, ensureStatsId, setCallPackage, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { recordPackage } from "@/lib/call-packages";
import { admitOrders } from "@/lib/order-admission";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DANA = "dana@example.com";
const sessionId = (n: number) => `cs_test_${String(n).padStart(24, "p")}`;
type Listed = { id: string; status: string; payment_status: string; created: number; amount_total: number; currency: string; metadata: Record<string, string>; customer_details: { email: string } };
const listed: Listed[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "e" }));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const email = url.searchParams.get("customer_details[email]");
    const data = listed.filter((s) => s.customer_details.email === email);
    return new Response(JSON.stringify({ object: "list", has_more: false, data }));
  }
  if (path === "/coupons") return new Response(JSON.stringify({ id: "co_Session1" }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

const weekly = {
  kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_packages_only";
  process.env.RESEND_API_KEY = "re_test_packages_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const call = await addProduct("owner@example.com", "Coaching Call", "", "120", null);
  if (!call.ok) throw new Error("no product");
  await setProductCall("owner@example.com", call.product.id, weekly);
  await setCallPackage("owner@example.com", call.product.id, { sessions: 5, priceCents: 50000, days: 90 });
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, call.product.id))!;
  is("eight orders admitted", (await admitOrders(store, 8)).ok, true);

  // Six packages bought by other people, two by Dana, each through the real write (recordPackage).
  const buyers = ["ann@example.com", "bo@example.com", "cy@example.com", "ed@example.com", "fay@example.com", "gus@example.com", DANA, DANA];
  for (let i = 0; i < buyers.length; i += 1) {
    const session: Listed = {
      id: sessionId(i), status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000), amount_total: 50000, currency: "usd",
      metadata: { store: "harbor", product: product.id, kind: "package", sessions: "5", days: "90" }, customer_details: { email: buyers[i] },
    };
    listed.push(session);
    const recorded = await recordPackage({ store, session: session as never, product, base: "https://marktmorgen.com/@harbor", from: '"Harbor Kitchen" <hello@marktmorgen.com>' });
    if (!recorded) throw new Error(`package ${i} not recorded`);
  }
  // Dana also paid for something that is not a package: the copy never reads a package record for it.
  listed.push({ id: sessionId(99), status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000), amount_total: 1200, currency: "usd", metadata: { store: "harbor", product: product.id }, customer_details: { email: DANA } });
  is("the store's set lists all eight packages", (redis.run(["SMEMBERS", `nl:pkg:s:${store.statsId}`]) as string[]).length, 8);

  part("Dana's copy reads only Dana's packages");
  const scope = { store, statsId: store.statsId, listId: store.listId ?? null, email: DANA } as unknown as ErasureScope;
  const run = redis.run.bind(redis);
  const reads: string[] = [];
  redis.run = (c: (string | number)[]) => {
    const name = String(c[0]).toUpperCase();
    if (name === "SMEMBERS" || name === "GET" || name === "MGET") reads.push(`${name} ${String(c[1])}`);
    return run(c);
  };
  let copied: unknown[];
  try {
    copied = await COPIERS["lib/call-packages.ts"](scope);
  } finally {
    redis.run = run;
  }
  is("both of Dana's packages are in the copy", copied.length, 2);
  is("the store's whole set of packages is never read", reads.filter((r) => r.startsWith(`SMEMBERS nl:pkg:s:`)).length, 0);
  is("a package record is read only for Dana's two package checkouts", reads.filter((r) => /^GET nl:pkg:cs_/.test(r)).length, 2);
  is("nobody else's package is read", reads.some((r) => [0, 1, 2, 3, 4, 5].some((i) => r.endsWith(sessionId(i)))), false);

  part("A person with no package checkouts reads no package record");
  const none = { ...scope, email: "nobody@example.com" } as unknown as ErasureScope;
  const before = reads.length;
  redis.run = (c: (string | number)[]) => {
    const name = String(c[0]).toUpperCase();
    if (name === "SMEMBERS" || name === "GET" || name === "MGET") reads.push(`${name} ${String(c[1])}`);
    return run(c);
  };
  try {
    is("nothing copied", (await COPIERS["lib/call-packages.ts"](none)).length, 0);
  } finally {
    redis.run = run;
  }
  is("and no package read", reads.slice(before).filter((r) => r.includes("nl:pkg:")).length, 0);
  done();
}

void main();
