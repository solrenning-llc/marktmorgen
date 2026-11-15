/**
 * The studio's member health after a buyer's erasure (#4749, found by Codex L): the payment provider still lists the
 * erased buyer's running subscription, so a refresh read it again and named them, with their address and score, in the
 * report and its ten-minute copy. A person deleted from the store (lib/suppression.ts, nl:erased) is now left out of
 * the named rows, and the copy is kept only when nobody it names was deleted, checked in one step with the write
 * (keepUnlessErased), so a refresh already in flight when the erasure finishes cannot put them back. The other
 * buyers' rows and the counts stay. Synthetic data, in-memory Redis, mocked Stripe.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { memberHealth } from "@/lib/member-health";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
let subs: Record<string, unknown>[] = [];
let beforeAnswer: (() => Promise<void>) | null = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.pathname === "/v1/subscriptions") {
    const wait = beforeAnswer;
    beforeAnswer = null;
    if (wait) await wait();
    return answer({ object: "list", data: subs, has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  const realError = console.error;
  console.error = () => {};
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_member_health_erasure";
  process.env.RESEND_API_KEY = "re_test_member_health_erasure";
  const world = await makeWorld();
  const member = (id: string, email: string) => ({
    id, status: "active", currency: "usd", start_date: NOW - 90 * DAY,
    customer: { id: `cus_${id.slice(4)}`, email },
    metadata: { store: world.store.handle, product: world.courseProduct },
    items: { data: [{ quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
  });
  subs = [member("sub_Ana000000001", "ana@example.com"), member("sub_Ben000000001", "ben@example.com"), member("sub_Cai000000001", "cai@example.com")];
  const cacheKey = `nl:health:${world.store.statsId}`;
  const cached = async () => (await redis.pipeline([["GET", cacheKey]]))[0];

  part("A refresh after a buyer's erasure (the provider still lists the subscription)");
  is("all three named members are present at first", (await memberHealth(world.store, true))?.members.length, 3);
  is("erasure completes", (await erasePerson(world.store, "ana@example.com", { kind: "person" })).ok, true);
  is("erasure deletes the old copy", await cached(), null);
  const fresh = await memberHealth(world.store, true);
  is("only the other buyers are named in the new report", fresh?.members.map((m) => m.email).sort(), ["ben@example.com", "cai@example.com"]);
  is("the counts still count every running member", fresh ? fresh.counts.well + fresh.counts.slipping + fresh.counts.risk : null, 3);
  is("the replacement copy does not name Ana", String(await cached()).includes("ana@example.com"), false);
  is("a copy hit does not name Ana", (await memberHealth(world.store))?.members.map((m) => m.email).sort(), ["ben@example.com", "cai@example.com"]);

  part("A refresh already in flight when an erasure finishes cannot put the buyer back");
  beforeAnswer = async () => {
    is("the erasure finishes while the provider's answer is on its way", (await erasePerson(world.store, "ben@example.com", { kind: "person" })).ok, true);
  };
  const raced = await memberHealth(world.store, true);
  is("the report does not name Ben", raced?.members.some((m) => m.email === "ben@example.com"), false);
  is("no copy names Ben", String(await cached()).includes("ben@example.com"), false);
  is("a copy hit does not name Ben", (await memberHealth(world.store))?.members.some((m) => m.email === "ben@example.com"), false);

  part("When who was deleted cannot be read, nobody is named");
  const realPipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((c) => c[0] === "HMGET" && String(c[1]).startsWith("nl:erased:")) ? [] : realPipeline(commands)) as typeof redis.pipeline;
  const unknown = await memberHealth(world.store, true).then((h) => h?.members.map((m) => m.email) ?? null, (error: Error) => error.name);
  redis.pipeline = realPipeline;
  is("the reading fails rather than name someone who may be deleted", unknown, "UnknownReplyError");
  console.error = realError;
  done();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
