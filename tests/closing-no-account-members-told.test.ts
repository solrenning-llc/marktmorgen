/**
 * The closing day of a store with no Stripe account connected (its creator disconnected during the closing window):
 * lib/closing-refunds.ts giveBackUnused answers "unavailable", and lib/plan-closing.ts read that as nothing left to
 * settle, wrote its refunds as done, removed the store and deleted its members' paid periods. A member who paid for
 * time past the day was then neither given it back nor told, and the record of what was owed was gone. Now each such
 * member is settled as not made automatically (r "over", final) and told so with the creator's contact, the same
 * notice as a refund past the closing's limit, before the closing goes on. Found by Claude 2 (nuvem A). Synthetic.
 */
import { createHash } from "node:crypto";
import { closeOne, type Hands } from "@/lib/plan-closing";
import { FINAL_INDEX, paidKey, paidPeriods } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
const emails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string } | { to: string | string[]; text: string }[];
    for (const one of Array.isArray(body) ? body : [body]) emails.push({ to: [one.to].flat()[0], text: one.text });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e_${i}` })) } : { id: "e_1" }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "search_result", data: [], has_more: false, next_page: null }), { status: 200 });
}) as typeof fetch;

const hands: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.COMPANY_POSTAL_ADDRESS = "Solrenning LLC, 1 Synthetic Way, Dover, DE 19901";
  const now = Date.now();
  const day = now - DAY;
  const endedAt = now - 40 * DAY;
  await claimHandle("closing-no-account@example.test", "noaccount", "No Account Shop", "");
  const shop = (await storeForEmail("closing-no-account@example.test"))!;
  const key = storeRef(shop);
  is("control: the store has no Stripe account connected", shop.stripeAccountId ?? null, null);
  const folder = await storeFolder(key);
  const s = Math.floor(day / 1000);
  await redis.pipeline([
    ["ZADD", FINAL_INDEX, String(endedAt), key],
    ["SET", stateKey(key), JSON.stringify({ of: endedAt, day, renewals: now - 3_600_000, hold: endedAt, holdFrom: endedAt, week: day - 7 * DAY, buyersDone: day - 8 * DAY })],
    ["HSET", paidKey(folder), "sub_NoAccountMember1", JSON.stringify({ inv: "in_NoAccountMember1", pi: "pi_NoAccountMember1", amt: 3000, tot: 3000, cur: "usd", ps: s - 15 * 86_400, pe: s + 15 * 86_400, e: "member@example.com" })],
  ]);

  part("The closing day with no account to refund from");
  const first = await closeOne(key, now, hands);
  is("the closing is not finished while the member is neither refunded nor told", first.state === "removed" && emails.every((e) => e.to !== "member@example.com"), false);
  is("the member is told their refund was not made automatically", emails.some((e) => e.to === "member@example.com"), true);
  const rows = await paidPeriods(shop).catch(() => new Map());
  const row = [...rows.values()][0] ?? null;
  is("their paid period is settled as not made, final, and told (or kept until it is)", row === null ? "deleted" : `${row.r}:${row.f}:${row.m}`, emails.some((e) => e.to === "member@example.com") ? (first.state === "removed" ? "deleted" : "over:1:1") : "over:1:undefined");
  done();
}

void main();
