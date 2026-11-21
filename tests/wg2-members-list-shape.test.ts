/**
 * CX-123 rule 24 on lib/membership-numbers.ts (Claude 4, C4-20261106-2890-HOLD-175, LEVE+): a page of the creator's
 * subscriptions that Stripe answers without its list (`data`) or without saying whether more follow (`has_more`) is
 * unknown, never "no members": the numbers are not computed from it and nothing is kept in the cache, so the studio
 * never shows 0 members and a recurring revenue of 0 for minutes afterwards.
 */
import { membershipCacheKey, membershipNumbers } from "@/lib/membership-numbers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_members_only_a_stand_in";
let page: unknown = { object: "list", data: [], has_more: false };
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const body = url.pathname.endsWith("/subscriptions") ? page : { object: "list", data: [], has_more: false };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const store = { handle: "club", statsId: "st_club000001", sid: "sid_club0001", stripeAccountId: "acct_1TestClub0001", currency: "usd", listId: "", products: [], previousHandles: [] } as never;

async function attempt(answer: unknown): Promise<{ result: string; cached: boolean }> {
  redis.clear();
  page = answer;
  let result: string;
  try {
    const numbers = await membershipNumbers(store, true, Date.UTC(2026, 10, 6) );
    result = numbers === null ? "null" : `members ${numbers.paying}`;
  } catch (error) {
    // Only an unknown page counts; anything else that throws is a broken fixture, not the proof.
    result = /subscriptions/.test(String(error)) ? "threw" : `broke: ${String(error)}`;
  }
  const cached = (await redis.pipeline([["GET", membershipCacheKey("st_club000001")]]))[0] !== null;
  return { result, cached };
}

async function main(): Promise<void> {
  part("A page that does not read is unknown, never 0 members, and is never kept");
  for (const [label, answer] of [
    ["no list at all, nothing more said", { object: "list", has_more: false }],
    ["a list that is not one", { object: "list", data: "none", has_more: false }],
    ["more not said", { object: "list", data: [] }],
  ] as [string, unknown][]) {
    is(label, await attempt(answer), { result: "threw", cached: false });
  }
  part("Control");
  is("an empty list that says so: 0 members, kept", await attempt({ object: "list", data: [], has_more: false }), { result: "members 0", cached: true });
  done();
}

main();
