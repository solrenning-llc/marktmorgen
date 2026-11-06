/**
 * Independent review proof for #2967.
 *
 * The product catches thrown reads, but the Redis client may also return an
 * incomplete pipeline envelope. That reply is unknown, not confirmed
 * absence. The affiliate hub must not turn it into "nothing is listed" or
 * omit an announced product-specific cut.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import AffiliateHubPage from "@/app/affiliate/page";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { joinAsBuyer } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

const NOTHING = "Nothing is listed for this address any more";
const UNREAD = "could not be read just now";
const sessions = new Map<string, Record<string, unknown>>();

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const match = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  const found = match ? sessions.get(match[1]) : undefined;
  return Response.json(found ?? { error: { message: "No such checkout.session" } }, { status: found ? 200 : 404 });
}) as typeof fetch;

async function incomplete<T>(matches: (commands: Commands) => boolean, work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => (matches(commands) ? [] : original.call(redis, commands))) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_review_2967";
  process.env.STRIPE_SECRET_KEY = "sk_test_review_2967";

  const creator = "one@example.com";
  const affiliateEmail = "dana@example.com";
  if (!(await claimHandle(creator, "harbor", "Harbor Kitchen", "")).ok) throw new Error("store setup failed");
  await ensureStoreId(creator);
  await ensureStatsId(creator);
  await setStripeAccount(creator, "acct_1TestHarbor0001", true);
  await setAffiliateSetting(creator, { ...NO_AFFILIATES, enabled: true, buyers: true, rates: {} });

  // Put the product outside catalog.head so cutFor must read its listing.
  for (let index = 0; index < 25; index += 1) await addProduct(creator, `Filler ${index}`, "", "5");
  const made = await addProduct(creator, "Review Course", "", "40");
  if (!made.ok) throw new Error("product setup failed");
  const productId = made.product.id;
  const store = (await storeForEmail(creator))!;

  const sessionId = "cs_test_hubharbor0001";
  sessions.set(sessionId, {
    id: sessionId,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 2700,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    customer_details: { email: affiliateEmail },
    metadata: { store: store.handle, product: "p8w2m4q9zz" },
  });
  if (!(await joinAsBuyer(store, sessionId)).ok) throw new Error("affiliate setup failed");
  const token = "a".repeat(64);
  const linkKey = `nl:affhub:link:${createHash("sha256").update(`nimbus-affhub-link:${token}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", linkKey, affiliateEmail, "EX", 86_400]]);
  const page = async () => renderToStaticMarkup(await AffiliateHubPage({ searchParams: Promise.resolve({ token }) }));

  part("Healthy control");
  const healthy = await page();
  is("the program is listed", healthy.includes('data-hub-store="harbor"'), true);

  part("Incomplete promoted-store envelope is unknown");
  const promoted = await incomplete((commands) => commands.some((command) => command[0] === "SUNION"), page);
  is("never says nothing is listed", promoted.includes(NOTHING), false);
  is("says the programs could not be read", promoted.includes(UNREAD), true);

  part("Incomplete store envelope is unknown");
  const storeRead = await incomplete(
    (commands) => commands.some((command) => command[0] === "GET" && command[1] === `nl:store:id:${store.sid}`),
    page,
  );
  is("never says nothing is listed", storeRead.includes(NOTHING), false);
  is("says the program could not be read", storeRead.includes(UNREAD), true);

  part("Incomplete affiliate envelope is unknown");
  const affiliateRead = await incomplete(
    (commands) => commands.some((command) => command[0] === "HGET" && command[1] === `nl:aff:${store.statsId}:emails`),
    page,
  );
  is("never says nothing is listed", affiliateRead.includes(NOTHING), false);
  is("says the program could not be read", affiliateRead.includes(UNREAD), true);

  part("Incomplete product-listing envelope keeps the cut visible");
  const from = Math.floor(Date.now() / 1000) + 14 * 86_400;
  await setAffiliateSetting(creator, {
    ...NO_AFFILIATES,
    enabled: true,
    buyers: true,
    rates: { [productId]: 40 },
    pending: { ...NO_AFFILIATES, rates: { [productId]: 0 }, from },
  } as typeof NO_AFFILIATES);
  const listingRead = await incomplete(
    (commands) => commands.some((command) => command[0] === "GET" && String(command[1]).startsWith("nl:catalog:") && String(command[1]).includes(":l:")),
    page,
  );
  is("the announced cut remains visible", listingRead.includes("data-hub-cut"), true);
  is("the unread product change is disclosed", listingRead.includes(UNREAD), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
