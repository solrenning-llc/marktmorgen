/**
 * The checkout sweep and the reviews' refund pass's turn (lib/checkout-sweep.ts, lib/review-proof.ts; Claude 1 2as on
 * #5100): a store with reviews is swept every run whatever its turn says (its revocations, reminders and
 * confirmations keep their five minutes), the pass itself runs only on a free turn, taking it once with one SET NX EX,
 * and a held turn sends no SET NX and no read of Stripe's refunds. Synthetic store, review and Stripe stand-in; the
 * Redis stand-in's pipeline watched.
 */
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { saveReview } from "@/lib/reviews";
import { REVIEW_REFUND_PASS_EVERY_SECONDS } from "@/lib/review-proof";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { installSesMailFixture } from "./ses-mail-fixture";
import { ROOM } from "./data-room";

process.env.STRIPE_SECRET_KEY = "sk_test_turn_sweep_only_a_stand_in";
process.env.RESEND_API_KEY = "re_test_turn_sweep_only_a_stand_in";
const refundReads: string[] = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/refunds") refundReads.push(url.search);
    if (url.pathname === "/v1/account") return new Response(JSON.stringify({ id: "acct_1TestTurnSwp1", country: "US" }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

const OWNER = "turn-sweep@example.com";
type Batch = (string | number)[][];
const sent: Batch = [];
const healthy = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Batch) => {
  sent.push(...batch);
  return healthy(batch);
}) as typeof redis.pipeline;
const turnTakes = (statsId: string) => sent.filter((c) => c[0] === "SET" && c[1] === `nl:rev:refunds:next:${statsId}` && c.includes("NX")).length;

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  // A store the sweep reaches only for its reviews: a connected account and one review, with nothing listed, no list,
  // no pixels, no keys and no sale listeners, so that worthAsking (lib/checkout-sweep.ts) is false and the store is
  // counted by `reviewed` alone. With a paid listing the store would be swept anyway, and the gate under test would be
  // invisible to the count.
  await claimHandle(OWNER, "turnsweep", "Turn Sweep", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestTurnSwp1", true);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const saved = await saveReview(statsId, { productId: "turnsweepguide1", email: "buyer@example.com", reference: "cs_test_turnsweep000000000", pi: "pi_turnsweep0000001", rating: 5, text: "Clear and kind.", name: "Buyer", paidAt: Math.floor(Date.now() / 1000) - 86_400 }, ROOM);
  if (saved.state !== "created") throw new Error(`review not saved: ${saved.state}`);
  const turn = `nl:rev:refunds:next:${statsId}`;

  part("A held turn: the store is still swept, and the pass neither takes the turn nor reads Stripe");
  await healthy([["SET", turn, "1", "EX", REVIEW_REFUND_PASS_EVERY_SECONDS]]);
  sent.length = 0;
  refundReads.length = 0;
  const held = await sweepCheckouts(Date.now() + 20_000);
  is("the store with reviews is swept (its revocations, reminders and confirmations run)", held.stores, 1);
  is("no SET NX on the held turn", turnTakes(statsId), 0);
  is("and no read of Stripe's refunds", refundReads.length, 0);

  part("A free turn: the pass takes it once and reads the refunds; the next run finds it held");
  await healthy([["DEL", turn]]);
  sent.length = 0;
  refundReads.length = 0;
  const free = await sweepCheckouts(Date.now() + 20_000);
  is("the store is swept", free.stores, 1);
  is("the turn is taken once, with SET NX", turnTakes(statsId), 1);
  is("and Stripe's refunds are read once", refundReads.length, 1);
  const ttl = Number((await healthy([["TTL", turn]]))[0]);
  is("the turn is held for the pass's wait", ttl > 0 && ttl <= REVIEW_REFUND_PASS_EVERY_SECONDS, true);
  sent.length = 0;
  refundReads.length = 0;
  const again = await sweepCheckouts(Date.now() + 20_000);
  is("the run after: the store swept, the turn held, no take and no read", [again.stores, turnTakes(statsId), refundReads.length], [1, 0, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
