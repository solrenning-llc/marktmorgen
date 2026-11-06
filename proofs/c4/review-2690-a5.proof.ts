/**
 * Focal return on #2690 at 8d7fd12e: A5 (LOW) is still open.
 * openMove takes the open mark ("opening", 24h + 60s), then, when Stripe shows the membership live, calls noteKept
 * OUTSIDE any try (lib/move-members.ts:402). If that Redis write throws, release() never runs: the mark stays
 * "opening" for a day and every later press reads "refused" ("Try again in a few minutes") although Stripe shows
 * the member moved. A safe design says "done" (or at least lets the mark go). Nothing is charged twice either way.
 */
import { TEST_CONSENT } from "~t/digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMembers, openMove, readInvite } from "@/lib/move-members";
import { store as redis } from "~t/redis-stub";
import { done, is, part } from "~t/check";
import { paidPeriod } from "~t/billing-period-fixture";

const OWNER = "proof-a5@example.com";
let productId = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (method === "GET" && path === "/customers") return new Response(JSON.stringify({ object: "list", data: [{ id: "cus_EvPaid01" }], has_more: false }));
  if (method === "GET" && path === "/subscriptions") {
    return new Response(JSON.stringify({ object: "list", data: [{ id: "sub_EvPaid01", status: "active", metadata: { product: productId, moved: "yes" } }], has_more: false }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_proof_only";
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_proof";
  redis.clear();
  const nowS = Math.floor(Date.now() / 1000);
  const made = await claimHandle(OWNER, "proofa5", "Proof Store", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestProofA51", true);
  await setSubscription(OWNER, { customerId: "cus_PrfA501x", subscriptionId: "sub_PrfA501x", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Club", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  productId = club.product.id;
  await setProductLink(OWNER, productId, "https://example.com/club");
  let store = (await storeForEmail(OWNER))!;
  const [evF] = await inviteMembers(store, "job_a5", [{ email: "ev@example.com", productId, option: "", renews: nowS + 20 * 86_400 }]);
  store = (await storeForEmail(OWNER))!;
  const ev = (await readInvite(store.statsId!, evF!))!;
  const markKey = `nl:mv:open:${store.statsId}:${evF}`;

  part("A5: Stripe shows Ev's membership live; the write that notes it kept fails once");
  const real = redis.pipeline.bind(redis);
  let failed = false;
  (redis as unknown as { pipeline: typeof real }).pipeline = (commands) => {
    if (!failed && commands.some((c) => c[0] === "HSET" && c[1] === `nl:mv:${store.statsId}`)) {
      failed = true;
      return Promise.reject(new Error("redis: connection reset"));
    }
    return real(commands);
  };
  let first = "returned";
  try {
    const r = await openMove(store, productId, ev.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
    first = r.ok ? "opened" : r.reason;
  } catch {
    first = "threw";
  }
  (redis as unknown as { pipeline: typeof real }).pipeline = real;
  console.log(`  first press: ${first}; the HSET was failed: ${failed}`);
  const mark = redis.run(["GET", markKey]);
  const ttl = Number(redis.run(["TTL", markKey]));
  console.log(`  open mark after it: ${JSON.stringify(mark)}, lives ${ttl}s`);
  is("the open mark is not left behind for a day after the press ended (EXPECTED TO FAIL)", mark, null);
  const second = await openMove(store, productId, ev.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("the next press says the membership was moved, not 'try again in a few minutes' (EXPECTED TO FAIL)", second.ok ? "opened" : second.reason, "done");
  done();
}
void main();
