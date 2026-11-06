/**
 * Sweep A3 proof (CX-123 rules 24 and 30), synthetic only: the in-memory Redis double, no Stripe or email reached.
 *
 * lib/gifts.ts startGift, line 141, and lib/group-buy.ts startGroup, line 177 (the same pattern, rule 30): the SET
 * that writes the gift or the purchase for several down before its checkout opens is not read at all. An answer in
 * an unknown shape (here: a reply with no result, the write not landed) still returns { ok: true }, so
 * app/api/store/checkout opens the Stripe checkout and the buyer pays. When the paid checkout is confirmed,
 * readGift / readGroup find nothing and deliverGift / settleGroup answer "skip" (lib/purchase-email.ts
 * confirmGift / confirmGroup then return "skip" and set no mark): the payment is taken and nothing is handed over,
 * nobody is emailed, and no later run can find the record that was never written.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, readGift, startGift } from "@/lib/gifts";
import { readGroup, settleGroup, startGroup } from "@/lib/group-buy";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** A SET of a key with this prefix is not run and answered with no result: its write is unknown (and did not land). */
function unknownSet(prefix: string): void {
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith(prefix)) return [undefined];
    return real(commands);
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = real;
};
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_stand_in" }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_sweep_a3_only";
  process.env.RESEND_API_KEY = "re_test_sweep_a3_only";
  const OWNER = "sweepa3gift@example.com";
  await claimHandle(OWNER, "sweepgift", "Sweep Gift", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSweepGift01", true);
  await setSubscription(OWNER, { customerId: "cus_SweepGift0001", subscriptionId: "sub_SweepGift0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Glaze Guide", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const paidSession = (meta: Record<string, string>) => ({
    id: "cs_test_" + "g".repeat(24),
    created: Math.floor(Date.now() / 1000),
    amount_total: 4900,
    currency: "usd",
    payment_intent: "pi_SweepGift00001",
    metadata: { store: "sweepgift", product: product.id, ...meta },
    customer_details: { email: "payer@example.com" },
  });
  const deps = { store, product, base: "https://marktmorgen.com/@sweepgift", from: '"Sweep Gift" <hello@marktmorgen.com>' };

  part("Gift: healthy control");
  const okGift = await startGift(store, product, { to: "friend@example.com", from: "Ana", message: "" });
  if (!okGift.ok) throw new Error("no gift");
  is("written down, then handed over once paid", [Boolean(await readGift(okGift.gift.id)), await deliverGift({ ...deps, session: paidSession({ gift: okGift.gift.id }), recordStart: async () => {}, ordersLink: async () => null })], [true, "given"]);

  part("Gift: DEFECT, the SET that writes it down answers in an unknown shape");
  unknownSet("nl:gift:gft_");
  const lost = await startGift(store, product, { to: "friend2@example.com", from: "Ana", message: "" });
  restore();
  if (!lost.ok) throw new Error("startGift refused");
  is("DEFECT: startGift still says ok, so the checkout opens and the buyer pays", lost.ok, true);
  is("DEFECT: the paid gift has no record", await readGift(lost.gift.id), null);
  is("DEFECT: the paid checkout hands nothing over (skip)", await deliverGift({ ...deps, session: paidSession({ gift: lost.gift.id }), recordStart: async () => {}, ordersLink: async () => null }), "skip");

  part("Purchase for several: healthy control");
  const okGroup = await startGroup(store, product, "3");
  if (!okGroup.ok) throw new Error("no group");
  is("written down, then settled once paid", [Boolean(await readGroup(okGroup.group.id)), await settleGroup({ ...deps, session: paidSession({ group: okGroup.group.id, people: "3" }) })], [true, "settled"]);

  part("Purchase for several: DEFECT (rule 30 sibling), the same unread SET");
  unknownSet("nl:grp:grp_");
  const lostGroup = await startGroup(store, product, "3");
  restore();
  if (!lostGroup.ok) throw new Error("startGroup refused");
  is("DEFECT: startGroup still says ok, so the checkout for 3 places opens and is paid", lostGroup.ok, true);
  is("DEFECT: the paid purchase has no record", await readGroup(lostGroup.group.id), null);
  is("DEFECT: settling the paid checkout hands nothing over (skip)", await settleGroup({ ...deps, session: paidSession({ group: lostGroup.group.id, people: "3" }) }), "skip");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
