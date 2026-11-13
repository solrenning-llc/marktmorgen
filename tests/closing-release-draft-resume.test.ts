/**
 * #4394: a held member is let go again (releaseHolds, lib/closing-holds.ts), but putting a draft its hold kept back
 * on auto_advance fails. The member's store_hold is already gone, so the next run must still find the draft written
 * down (d:<subscription>) and try it again, with the same idempotency key the first try used, without letting the
 * subscription go a second time. The draft's note goes only once every draft went back; a failure keeps the release
 * not done, so releaseRestarted never forgets the store's held state while a draft is still a draft.
 *
 * Stripe is a stand-in for fetch; synthetic store, in-memory Redis.
 */
import { HELD_INDEX, releaseHolds, workKey } from "@/lib/closing-holds";
import { claimHandle, ensureStatsId, setStripeAccount, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_closing_release_stand_in";
const ENDED = Date.parse("2026-10-01T00:00:00Z");
const SUB = "sub_ReleaseDraft01";
const DRAFT = "in_HeldDraft0001";
let held = true;
let draftFails = 0;
const posts: { path: string; key: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === "GET" && path === "/subscriptions/search") {
    return answer({ object: "search_result", data: [{
      id: SUB, object: "subscription", status: "active", customer: { id: "cus_Member000001", email: "member@example.com" },
      metadata: { store: "releasing", ...(held ? { store_hold: String(ENDED) } : {}) },
      ...(held ? { pause_collection: { behavior: "void" } } : {}),
    }], has_more: false, next_page: null });
  }
  if (method === "POST" && path === `/subscriptions/${SUB}`) {
    posts.push({ path, key });
    held = false;
    return answer({ id: SUB, object: "subscription", status: "active", metadata: { store: "releasing" } });
  }
  if (method === "POST" && path === `/invoices/${DRAFT}`) {
    posts.push({ path, key });
    if (draftFails > 0) {
      draftFails -= 1;
      return answer({ error: { message: "temporarily unavailable" } }, 500);
    }
    return answer({ id: DRAFT, object: "invoice", status: "draft", auto_advance: true });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "releasing-owner@example.com";
  await claimHandle(owner, "releasing", "Releasing", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestReleasing01", true);
  const store = (await storeForEmail(owner))!;
  const folder = await storeFolder(storeRef(store));
  const work = workKey(folder);
  // What the hold left: the store in the line of held stores, the draft written down under the member.
  await redis.pipeline([["ZADD", HELD_INDEX, ENDED, storeRef(store)], ["HSET", work, `d:${SUB}`, DRAFT]]);
  const draftNote = async () => (await redis.pipeline([["HGET", work, `d:${SUB}`]]))[0];
  const until = Date.now() + 60_000;

  part("The draft fails to go back once");
  draftFails = 1;
  const first = await releaseHolds(store, until);
  is("the release is not done, and the draft stays written down", [first.done, await draftNote()], [false, DRAFT]);
  is("the subscription was let go once", posts.filter((p) => p.path.startsWith("/subscriptions/")).length, 1);

  part("The next run, the member no longer held");
  const second = await releaseHolds(store, until);
  const draftPosts = posts.filter((p) => p.path === `/invoices/${DRAFT}`);
  is("the draft is tried again", draftPosts.length, 2);
  is("with the same idempotency key as its first try", [...new Set(draftPosts.map((p) => p.key))], [`closing-draft-back:${DRAFT}:${ENDED}`]);
  is("the subscription is not let go a second time", posts.filter((p) => p.path.startsWith("/subscriptions/")).length, 1);
  is("done, and the draft's note goes only now", [second.done, await draftNote()], [true, null]);

  part("A draft that keeps failing keeps the release not done");
  redis.clear();
  held = true;
  posts.length = 0;
  await redis.pipeline([["ZADD", HELD_INDEX, ENDED, storeRef(store)], ["HSET", work, `d:${SUB}`, DRAFT]]);
  draftFails = 2;
  await releaseHolds(store, until);
  const again = await releaseHolds(store, until);
  is("still not done, the draft still written down", [again.done, await draftNote()], [false, DRAFT]);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
