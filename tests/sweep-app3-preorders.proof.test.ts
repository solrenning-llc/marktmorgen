/**
 * Sweep APP3 proof (CX-123 rule 24), synthetic only. lib/preorders.ts:128-132 waitingCount:
 *   const [raw] = await redisPipeline([["HVALS", entriesKey(store.statsId, productId)]]);
 *   return preorderCounts((Array.isArray(raw) ? raw : []).map(parsePreorder)...).waiting;
 * An HVALS of a product's pre-orders that answers in another shape (no reply, a number, text) reads as "nobody is
 * waiting". Three decisions are taken on that number:
 *   1. app/api/store/product/route.ts:276 — "Paid pre-orders wait for it: it stays until they are handed over or
 *      refunded, so nobody paid for something deleted." Unknown → the product is removed while buyers who paid wait.
 *   2. app/api/store/waitlist/route.ts:41 — off "coming soon" is refused while the product has nothing in it and
 *      pre-orders wait. Unknown → the empty product goes on sale (its buy button opens) with paid pre-orders waiting.
 *   3. lib/preorders.ts:139-145 queueRelease — the hand-over job is put in line only when someone waits. Unknown →
 *      the product is on sale and no job is queued, so the buyers who paid are never handed it over (the five-minute
 *      job only reads that line; nothing puts it back unless the creator toggles the product again).
 * Nothing real is called: the in-memory Redis double; every fetch answers 404. The waitlist route's last step,
 * next/server `after` (the immediate hand-over run), is outside a request scope here and logs "changing a waitlist
 * failed"; every write the checks read (the soon mark, the job line) is made before it.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductLink, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { isSoon, setSoon } from "@/lib/waitlist";
import { waitingCount } from "@/lib/preorders";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as waitlistRoute } from "@/app/api/store/waitlist/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "preorders.app3@example.com";
const ORIGIN = "https://marktmorgen.com";
const JOBS = "nl:pre:jobs";
const original = redis.pipeline.bind(redis);

const post = (route: (r: NextRequest) => Promise<Response>, path: string, session: string, body: unknown) =>
  route(new NextRequest(`${ORIGIN}/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
const answer = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

/** Every HVALS of this product's pre-orders answers `reply` while `work` runs; everything else is real. */
async function withBentHvals<T>(key: string, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    return replies.map((r, i) => (commands[i][0] === "HVALS" && commands[i][1] === key ? reply : r));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "preapp3", "Pre Shop", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const sid = (await storeForEmail(OWNER))!.statsId!;

  /** A product coming soon with one buyer who paid for a pre-order and waits; with a link in it, or empty. */
  const setUp = async (title: string, withContent: boolean) => {
    const made = await addProduct(OWNER, title, "", "29", null);
    if (!made.ok) throw new Error("no product");
    const pid = made.product.id;
    if (withContent) await setProductLink(OWNER, pid, "https://example.com/the-thing");
    await setSoon((await storeForEmail(OWNER))!, pid, true);
    const key = `nl:pre:${sid}:${pid}`;
    await redis.pipeline([["HSET", key, `cs_test_${"a".repeat(24)}`, JSON.stringify({ to: "buyer@example.com", at: 1_700_000_000, pi: `pi_${"b".repeat(24)}` })]]);
    return { pid, key };
  };
  const store = async () => (await storeForEmail(OWNER))!;
  const jobQueued = async (pid: string) => (await redis.pipeline([["SISMEMBER", JOBS, `${sid}|${pid}|preapp3`]]))[0] === 1;

  part("Healthy control");
  {
    const { pid } = await setUp("Course A", true);
    is("one buyer waits", await waitingCount(await store(), pid), 1);
    is("removing the product is refused while a paid pre-order waits", await answer(await post(productRoute, "product", session, { action: "remove", id: pid })), [409, "preorders"]);
    is("and the product is still there", Boolean(await readListing(await store(), pid)), true);
  }
  {
    const { pid } = await setUp("Course B", false);
    is("taking an EMPTY product off coming soon is refused while a pre-order waits", await answer(await post(waitlistRoute, "waitlist", session, { action: "soon", id: pid, on: false })), [400, "empty"]);
    is("and it is still coming soon (no buy button)", await isSoon(await store(), pid), true);
  }
  {
    const { pid } = await setUp("Course C", true);
    await post(waitlistRoute, "waitlist", session, { action: "soon", id: pid, on: false }).catch(() => null);
    is("a product with something in it goes on sale and its hand-over job is queued", [await isSoon(await store(), pid), await jobQueued(pid)], [false, true]);
  }

  for (const [label, reply] of [["no reply", undefined], ["a number", 3], ["text", "OK"]] as const) {
    part(`DEFECT (${label}): the HVALS of the product's pre-orders answers in another shape`);
    {
      const { pid, key } = await setUp(`Course D ${label}`, true);
      const removed = await withBentHvals(key, reply, () => post(productRoute, "product", session, { action: "remove", id: pid }));
      is(`DEFECT (${label}): the product is removed`, (await answer(removed))[0], 200);
      is(`DEFECT (${label}): it is gone from the store`, await readListing(await store(), pid), null);
      is(`DEFECT (${label}): while the buyer who paid still waits for it`, await waitingCount(await store(), pid), 1);
    }
    {
      const { pid, key } = await setUp(`Course E ${label}`, false);
      await withBentHvals(key, reply, () => post(waitlistRoute, "waitlist", session, { action: "soon", id: pid, on: false }).catch(() => null));
      is(`DEFECT (${label}): the EMPTY product is taken off coming soon (its buy button opens)`, await isSoon(await store(), pid), false);
      is(`DEFECT (${label}): with the paid pre-order still waiting`, await waitingCount(await store(), pid), 1);
    }
    {
      const { pid, key } = await setUp(`Course F ${label}`, true);
      await withBentHvals(key, reply, () => post(waitlistRoute, "waitlist", session, { action: "soon", id: pid, on: false }).catch(() => null));
      is(`DEFECT (${label}): the product is on sale and NO hand-over job is queued`, [await isSoon(await store(), pid), await jobQueued(pid)], [false, false]);
      is(`DEFECT (${label}): while its buyer waits`, await waitingCount(await store(), pid), 1);
    }
  }
  done();
}

main();
