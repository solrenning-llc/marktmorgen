/**
 * A store in its closing day whose closing state was lost is held, never taken as having its members' renewals
 * stopped (Claude 7's hunt, MÉDIO money). closeOne used to rebuild a missing or foreign state as
 * `{ of, renewals: now }`, so closingDay skipped stopRenewals: the store closed while its members' subscriptions
 * kept renewing on the creator's account. The state can go while the store is in the final line when two runs
 * overlap: one puts it in FINAL_INDEX, the other sees a plan again and deletes the state.
 *
 * Now a lost state fails closed: the renewals are stopped (stopRenewals skips what is ended), and the day, which is
 * not known any more, is never guessed as today (that would give members back less): the store is held.
 * Synthetic store; Stripe and email through the journey's stand-ins; in-memory Redis.
 */
import { createHash } from "node:crypto";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { closeOne, type Hands } from "@/lib/plan-closing";
import { claimHandle, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { type Sent, type StripeWorld, standIns } from "./closing-journey";

const sent: Sent[] = [];
const stripe: StripeWorld = { sessions: [], memberships: [], posted: [] };
globalThis.fetch = standIns(stripe, sent, null);
const DAY = 86_400_000;
/** The closing state's key, as lib/plan-closing.ts names it (stateKey). */
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
const hands: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };

async function closingStore(owner: string, handle: string, account: string, member: string): Promise<{ key: string; ended: number }> {
  await claimHandle(owner, handle, "Lost State", "");
  await setStripeAccount(owner, account, true);
  const ended = Date.UTC(2026, 10, 2, 12, 0, 0);
  const realNow = Date.now;
  Date.now = () => ended;
  try {
    await setSubscription(owner, { active: false });
  } finally {
    Date.now = realNow;
  }
  const store = (await storeForEmail(owner))!;
  stripe.memberships.push({ id: member, account, status: "active", cancel_at_period_end: false, metadata: { store: store.handle } });
  const key = storeRef(store);
  // Its closing day has begun: it is in the final line.
  await redis.pipeline([["ZADD", FINAL_INDEX, ended, key]]);
  return { key, ended };
}

const deleted = (account: string, member: string) => stripe.posted.some((p) => p.body === "DELETE" && p.account === account && p.path === `/subscriptions/${member}`);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_closing_final_state_lost_only";
  process.env.RESEND_API_KEY = "re_test_closing_final_state_lost_only";
  process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";

  part("A store in its final line whose closing state was lost (the overlap of two runs)");
  const lost = await closingStore("lost-state@example.com", "loststate", "acct_1LostStateShop", "sub_1LostStateMember");
  const result = await closeOne(lost.key, lost.ended + 31 * DAY, hands, Number.POSITIVE_INFINITY);
  is("its member's renewal is stopped on its own account, never taken as stopped", deleted("acct_1LostStateShop", "sub_1LostStateMember"), true);
  is("it is held: its day is not known, so nothing is given back on a guessed day", result.state, "held");
  const [raw] = await redis.pipeline([["GET", stateKey(lost.key)]]);
  const state = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
  is("no step is written down as done on a guess", [state.refunds, state.removed], [undefined, undefined]);

  part("Control: a store whose state is there and whose renewals were stopped is not asked again");
  const kept = await closingStore("kept-state@example.com", "keptstate", "acct_1KeptStateShop", "sub_1KeptStateMember");
  await redis.pipeline([["SET", stateKey(kept.key), JSON.stringify({ of: kept.ended, day: kept.ended + 30 * DAY, renewals: kept.ended + 30 * DAY })]]);
  const normal = await closeOne(kept.key, kept.ended + 31 * DAY, hands, Number.POSITIVE_INFINITY);
  is("its renewals are not stopped again (the state says they were)", deleted("acct_1KeptStateShop", "sub_1KeptStateMember"), false);
  is("and it is not held for a lost state", normal.note === undefined || !/state/.test(normal.note), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
