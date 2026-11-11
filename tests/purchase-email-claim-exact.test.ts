/**
 * An order's confirmation email is claimed with an exact mark (lib/purchase-email.ts; CX-123 rule 24,
 * lib/claim-mark.ts). Found by Claude 3 (cloud D)'s audit of main (11 November 2026): confirmOffer, confirmPurchase,
 * confirmRequest and confirmPreorderOnce took their "sending" mark with SET NX and read any answer but nil as theirs,
 * then let it go with a plain DEL. When another run took the mark first and this run's answer was lost, this run sent
 * the same confirmation again (behind Resend's idempotency key the email may be dropped, but the SES path has none,
 * and the order is counted again), and its DEL could delete the other run's mark. Now each is taken with claimMark:
 * an answer that proves nothing is read back; somebody else's is "already"; one still unknown is "failed", with
 * nothing sent and no mark let go but this run's own. Synthetic only.
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmOffer, confirmationKey } from "@/lib/purchase-email";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let emails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails += 1;
    return new Response(JSON.stringify({ id: `email_${emails}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

// "crossed": another run takes the mark just before this run's SET NX, whose answer is then lost.
// "gone": the same, and this run's read back of the mark is lost too.
let mode: "ok" | "crossed" | "gone" = "ok";
const run = redis.pipeline.bind(redis);
redis.pipeline = async (commands) => {
  const claim = commands.find((c) => c[0] === "SET" && c.includes("NX") && String(c[1]).startsWith("nl:confirm:"));
  if (mode !== "ok" && claim) {
    await run([["SET", String(claim[1]), "sending", "EX", 600]]);
    await run(commands);
    return [];
  }
  if (mode === "gone" && commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:confirm:")) && (await run([["GET", String(commands[0][1])]]))[0] !== null) return [];
  return run(commands);
};

async function main() {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_cart_offers_only";
  const owner = "claimconfirm@example.com";
  await claimHandle(owner, "claimconfirm", "Claim Confirm", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestClaimConf1", true);
  await setSubscription(owner, { customerId: "cus_claimconfirm1", subscriptionId: "sub_claimconfirm1", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Bread guide", "", "19", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner)) as Store;
  const product = (await readListing(store, made.product.id)) as Listing;
  const offer = (n: number) => ({ reference: `pi_claimconfirm${String(n).padStart(6, "0")}`, parent: "cs_test_claimconfirm000001", product, email: "buyer@example.com", amountCents: 1900, currency: "usd" });

  is("a healthy offer confirmation is sent once", [await confirmOffer(store, offer(1)), emails], ["sent", 1]);

  mode = "crossed";
  const crossed = await confirmOffer(store, offer(2));
  mode = "ok";
  is("another run holds the mark and this run's answer was lost: nothing sent again", [crossed, emails], ["already", 1]);
  is("and the other run's mark is left as it was", (await run([["GET", confirmationKey(offer(2).reference)]]))[0], "sending");

  mode = "gone";
  const gone = await confirmOffer(store, offer(3));
  mode = "ok";
  is("a mark that cannot be read back sends nothing and is not done", [gone === "sent", emails], [false, 1]);
  is("and the other run's mark is never deleted", (await run([["GET", confirmationKey(offer(3).reference)]]))[0], "sending");
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
