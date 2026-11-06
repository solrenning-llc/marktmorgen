/**
 * CX-123 rule 24, lot L10b: "where did you hear about us?" (lib/heard.ts) counts one answer an order, guarded by a
 * SET NX mark. A reply to that SET in any shape but "OK" or nil is read back: our own value means the answer is counted
 * once; another value is an answer already counted; nothing readable is not counted now (the buyer may tap again).
 * Stripe is played by a stand-in for `fetch`.
 */
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { recordHeard } from "@/lib/heard";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, getOf, setNx } from "./l10b-replies";

process.env.STRIPE_SECRET_KEY = "sk_test_l10b_heard_only_a_stand_in";
const OWNER = "l10b-heard@example.com";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  return new Response(
    JSON.stringify({ id, status: "complete", payment_status: "paid", amount_total: 4900, currency: "usd", created: Math.floor(Date.now() / 1000) - 60, metadata: { store: "lheard", product: "prod000001" } }),
  );
}) as typeof fetch;

let n = 0;
const order = () => `cs_test_lheard${String((n += 1)).padStart(8, "0")}`;
const DONE = "nl:heard:done:";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "lheard", "Heard Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLheard001", true);
  const store = (await storeForEmail(OWNER))!;

  part("An answer counted once, and a mark held by another count is never taken for ours");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const s = order();
    const first = await recordHeard(store, s, "friend");
    answer(setNx(DONE), reply);
    const second = await recordHeard(store, s, "friend");
    is(`the same order again, the mark answered with ${shape}: already counted`, [first, second], ["counted", "already"]);
  }

  part("The mark written and its answer lost: our own value read back, counted once");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const s = order();
    answer(setNx(DONE), reply);
    is(`answered with ${shape}, the write landed: counted`, await recordHeard(store, s, "podcast"), "counted");
    is(`and the same order again is already counted (${shape})`, await recordHeard(store, s, "podcast"), "already");
  }

  part("Nothing readable: not counted now");
  for (const [shape, reply] of UNREADABLE) {
    clearAnswers();
    const s = order();
    answer(setNx(DONE), () => ["QUEUED"], { run: false });
    answer(getOf(DONE), reply);
    is(`the mark unknown and its read-back ${shape}: not counted`, await recordHeard(store, s, "friend").catch(() => "threw"), "unavailable");
  }
  clearAnswers();
  answer(setNx(DONE), THROWS, { run: false });
  answer(getOf(DONE), THROWS);
  is("the database not answering at all: not counted", await recordHeard(store, order(), "friend").catch(() => "threw"), "unavailable");

  part("Claude 3 on #2723: a mark of this run's that could not be read back is let go, so the buyer's next try counts");
  for (const [shape, reply] of UNREADABLE) {
    clearAnswers();
    const s = order();
    answer(setNx(DONE), () => ["QUEUED"], { run: true });
    answer(getOf(DONE), reply);
    const first = await recordHeard(store, s, "friend").catch(() => "threw");
    clearAnswers();
    is(`the mark written, its answer lost and its read-back ${shape}: unavailable now, counted on the next try`, [first, await recordHeard(store, s, "friend")], ["unavailable", "counted"]);
  }
  clearAnswers();
  done();
}

void main();
