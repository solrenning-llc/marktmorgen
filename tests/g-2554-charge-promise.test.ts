/** Independent G proof: actual hold/news/letter, synthetic Redis/HTTP only. */
import { holdCharges, startCallBudget } from "@/lib/closing-holds";
import { chargeable } from "@/lib/closing-buyers-rules";
import { closingLetter, closingNews, removalDay } from "@/lib/plan-closing";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  process.env.STRIPE_SECRET_KEY = "sk_test_g_synthetic_only";
  const sub = { id: "sub_member0001", status: "active", metadata: { store: "gproof" }, pause_collection: null, customer: { email: "member@example.com" } };
  let posts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.stripe.com") throw new Error("Unexpected synthetic request");
    if (url.pathname === "/v1/subscriptions/search") return Response.json({ object: "search_result", data: [sub], has_more: false });
    if (url.pathname === "/v1/invoices") return Response.json({ object: "list", data: [], has_more: false });
    if (url.pathname === "/v1/subscriptions/sub_member0001" && init?.method === "POST") {
      posts += 1;
      return Response.json({ error: { message: "synthetic provider refusal", code: "account_invalid" } }, { status: 400 });
    }
    throw new Error(`Unexpected synthetic request: ${init?.method} ${url.pathname}`);
  }) as typeof fetch;
  console.error = () => {};
  try {
    part("A membership still chargeable contradicts an unconditional no-more-charges promise");
    for (const budget of [0, 100]) {
      redis.clear();
      posts = 0;
      await claimHandle("g@example.com", "gproof", "G Proof", "");
      const made = await storeForEmail("g@example.com");
      if (!made) throw new Error("control: store creation failed");
      const store = { ...made, stripeAccountId: "acct_gproof0001" };
      const endedAt = Date.now() - 2 * 86_400_000;
      const day = removalDay(endedAt);
      await startCallBudget(await storeFolder(storeRef(store)), budget, endedAt);
      const hold = await holdCharges(store, endedAt, Number.POSITIVE_INFINITY);
      is(`budget ${budget}: real hold finished listing with one unpaused member`, [hold.done, hold.failed, hold.over, posts], budget === 0 ? [true, 0, 1, 0] : [true, 1, 0, 1]);
      is(`budget ${budget}: synthetic provider member remains chargeable`, [sub.pause_collection, chargeable(sub)], [null, true]);
      const news = await closingNews(store, endedAt, day, 0);
      const text = closingLetter("ended", store.name, endedAt, day, Date.now(), news).text;
      is(`budget ${budget}: actual news preserves the unpaused count and conditional warning`, [Number(news.notHeld) + Number(news.overLimit), text.includes("If a member is charged before then, please refund them from Stripe.")], [1, true]);
      is(`budget ${budget}: the SAME letter must not certify that nobody can be charged`, text.includes("Since your plan ended, none of your members is charged again"), false);
    }
    const unknown = closingLetter("week", "G Proof", Date.now(), Date.now() + 7 * 86_400_000, Date.now(), { buyersBy: null, untold: 0, members: null, unused: "", notHeld: null, overLimit: null }).text;
    is("unknown hold: warning remains explicit", unknown.includes("We could not check just now whether every membership's payments are paused."), true);
    is("unknown hold: no unconditional no-more-charges assurance", unknown.includes("Since your plan ended, none of your members is charged again"), false);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
