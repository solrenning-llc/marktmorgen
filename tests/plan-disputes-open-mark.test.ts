/**
 * A plan dispute still open, re-read by id, whose store cannot be read just
 * now (rule 24; Claude 5 on #2884). The store lookup answered null for an
 * unknown reply, and the open mark ("open:<store id>") was overwritten with
 * "unmatched": only open marks are re-read, so the bank's later decision was
 * never read again and a creator whose dispute was won stayed paused for
 * good, while the run said it was complete. Now the open mark is given up
 * only when the store's id is confirmed gone; otherwise the re-read fails,
 * the mark stays and the next run reads it. A run with a failure is never
 * complete (Claude 5's LOW).
 * Synthetic only: the Redis stub and a stand-in for Stripe.
 */
import { SEEN_KEY, syncPlanDisputes } from "@/lib/plan-disputes";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_dispute_open_mark_only";
const DISPUTE = "du_OpenMark1";
const CREATED = Math.floor(Date.now() / 1000) - 200 * 24 * 60 * 60;
let stripeStatus = "needs_response";
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    asked.push(url.pathname);
    if (url.pathname === "/v1/disputes") return Response.json({ object: "list", data: [], has_more: false });
    if (url.pathname === `/v1/disputes/${DISPUTE}`) return Response.json({ id: DISPUTE, object: "dispute", status: stripeStatus, created: CREATED });
    return new Response(JSON.stringify({ error: { message: "missing" } }), { status: 404 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const markOf = async (id: string) => (await real([["HGET", SEEN_KEY, id]]))[0];

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  const owner = "plan-dispute-open-mark@example.com";
  await claimHandle(owner, "openmark", "Open Mark", "");
  await ensureStoreId(owner);
  const sid = (await storeForEmail(owner))!.sid;
  await real([["HSET", SEEN_KEY, DISPUTE, `open:${sid}`]]);

  part("Control: the open dispute is re-read and written on its store");
  await syncPlanDisputes(Date.now() + 10_000);
  is("written on the store as open", (await storeForEmail(owner))!.planDisputes?.map((d) => d.status), ["open"]);
  is("the open mark stays", await markOf(DISPUTE), `open:${sid}`);

  const unknowns: [string, (c: Commands) => boolean, unknown[]][] = [
    ["the store's id answers undefined", (c) => c[0]?.[0] === "GET" && c[0][1] === `nl:store:id:${sid}`, [undefined]],
    ["the store's id answers a number", (c) => c[0]?.[0] === "GET" && c[0][1] === `nl:store:id:${sid}`, [42]],
    ["the store's id answers nothing", (c) => c[0]?.[0] === "GET" && c[0][1] === `nl:store:id:${sid}`, []],
    ["the store's id and its existence both answer nothing", (c) => (c[0]?.[0] === "GET" || c[0]?.[0] === "EXISTS") && c[0][1] === `nl:store:id:${sid}`, []],
  ];
  stripeStatus = "won";
  for (const [what, matches, reply] of unknowns) {
    part(`The bank decided, and ${what}`);
    await real([["HSET", SEEN_KEY, DISPUTE, `open:${sid}`]]);
    redis.pipeline = (async (c: Commands) => (matches(c) ? [...reply] : real(c))) as typeof redis.pipeline;
    let counts: Awaited<ReturnType<typeof syncPlanDisputes>> | null = null;
    try {
      counts = await syncPlanDisputes(Date.now() + 10_000);
    } catch {
      counts = null;
    } finally {
      redis.pipeline = real;
    }
    is("the open mark is not given up", await markOf(DISPUTE), `open:${sid}`);
    is("the run is not complete", counts?.complete ?? false, false);
  }

  part("A healthy run then reads the decision");
  asked.length = 0;
  const healthy = await syncPlanDisputes(Date.now() + 10_000);
  is("asked of Stripe by id", asked.includes(`/v1/disputes/${DISPUTE}`), true);
  is("the store's dispute is won", (await storeForEmail(owner))!.planDisputes?.map((d) => d.status), ["won"]);
  is("remembered as final", await markOf(DISPUTE), "final");
  is("and that run is complete", healthy.complete, true);

  part("Control: a store confirmed gone gives the open mark up");
  const gone = "fedcba9876543210fedcba9876543210";
  await real([["HSET", SEEN_KEY, "du_GoneStore1", `open:${gone}`]]);
  const goneFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/disputes/du_GoneStore1") return Response.json({ id: "du_GoneStore1", object: "dispute", status: "won", created: CREATED });
    return goneFetch(input);
  }) as typeof fetch;
  await syncPlanDisputes(Date.now() + 10_000);
  globalThis.fetch = goneFetch;
  is("marked unmatched", String(await markOf("du_GoneStore1")).startsWith("unmatched:"), true);

  part("A run with a failed re-read is never complete");
  await real([["HSET", SEEN_KEY, "du_Failing1", `open:${sid}`]]);
  const failing = await syncPlanDisputes(Date.now() + 10_000);
  is("one failure counted", failing.failed, 1);
  is("not complete", failing.complete, false);
  done();
}

void main();
