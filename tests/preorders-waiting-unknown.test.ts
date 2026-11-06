/**
 * A product's pre-orders still waiting, read only in their exact shape (CX-123 rule 24; sweep APP3 finding 1,
 * tests/sweep-app3-preorders.proof.test.ts on claude5/sweep-app-3). Synthetic only: the in-memory Redis double,
 * every fetch answers 404.
 *
 * Before: lib/preorders.ts waitingCount read an HVALS that answered no reply, a number or text as "nobody waits":
 *   1. app/api/store/product/route.ts removed a product whose buyers had paid for it and still waited;
 *   2. app/api/store/waitlist/route.ts put an EMPTY product on sale with paid pre-orders waiting;
 *   3. queueRelease put no hand-over job in line, so the buyers who paid were never handed it over, and
 *      runPreorderReleases dropped a job whose HGETALL answered in another shape, as if nothing waited.
 * Now: an unknown read throws UnknownReplyError; removal answers 503 "unavailable" and keeps the product; the
 * empty-product release is refused the same way and stays coming soon; queueRelease puts the job in line whenever
 * it cannot tell, and the five-minute job keeps a job whose read is unknown, so it is tried again.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductLink, storeForEmail } from "@/lib/store";
import type { Listing, Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { isSoon, setSoon } from "@/lib/waitlist";
import { queueRelease, runPreorderReleases, waitingCount } from "@/lib/preorders";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as waitlistRoute } from "@/app/api/store/waitlist/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "preorders.waiting@example.com";
const HANDLE = "prewait";
const ORIGIN = "https://marktmorgen.com";
const JOBS = "nl:pre:jobs";
const original = redis.pipeline.bind(redis);
const WAITING = JSON.stringify({ to: "buyer@example.com", at: 1_700_000_000, pi: "" });
const CHECKOUT = `cs_test_${"a".repeat(24)}`;

const post = (route: (r: NextRequest) => Promise<Response>, path: string, session: string, body: unknown) =>
  route(new NextRequest(`${ORIGIN}/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
const answer = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

/** Every `command` of `key` answers `reply` while `work` runs; everything else is real. */
async function withBent<T>(command: string, key: string, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    return replies.map((r, i) => (commands[i][0] === command && commands[i][1] === key ? reply : r));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function rejection(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "resolved";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

const SHAPES: [string, unknown][] = [
  ["no reply", undefined],
  ["a number", 3],
  ["text", "OK"],
  ["a list with a number in it", [WAITING, 7]],
  ["a list with text that is not a pre-order", ["not json"]],
];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Pre Shop", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const sid = (await storeForEmail(OWNER))!.statsId!;
  const store = async () => (await storeForEmail(OWNER))!;

  /** A product coming soon; with one buyer who paid for a pre-order and waits (or none); with a link in it, or empty. */
  const setUp = async (title: string, withContent: boolean, withBuyer = true) => {
    const made = await addProduct(OWNER, title, "", "29", null);
    if (!made.ok) throw new Error("no product");
    const pid = made.product.id;
    if (withContent) await setProductLink(OWNER, pid, "https://example.com/the-thing");
    await setSoon(await store(), pid, true);
    const key = `nl:pre:${sid}:${pid}`;
    if (withBuyer) await redis.pipeline([["HSET", key, CHECKOUT, WAITING]]);
    return { pid, key };
  };
  const jobQueued = async (pid: string) => (await redis.pipeline([["SISMEMBER", JOBS, `${sid}|${pid}|${HANDLE}`]]))[0] === 1;

  part("Healthy control: read exactly");
  {
    const { pid } = await setUp("Course A", true);
    is("one buyer waits", await waitingCount(await store(), pid), 1);
    is("removing the product is refused while a paid pre-order waits", await answer(await post(productRoute, "product", session, { action: "remove", id: pid })), [409, "preorders"]);
    is("and the product is still there", Boolean(await readListing(await store(), pid)), true);
  }
  {
    const { pid } = await setUp("Course A2", true, false);
    is("nobody waits on a product nobody pre-ordered (an exact empty reply)", await waitingCount(await store(), pid), 0);
    is("so it can be removed", await answer(await post(productRoute, "product", session, { action: "remove", id: pid })), [200, "ok"]);
    is("and it is gone", await readListing(await store(), pid), null);
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
  {
    const { pid } = await setUp("Course C2", true, false);
    await queueRelease(await store(), pid);
    is("with nobody waiting (read exactly), no hand-over job is queued", await jobQueued(pid), false);
  }

  for (const [label, reply] of SHAPES) {
    part(`Unknown (${label}): the HVALS of the product's pre-orders answers in another shape`);
    {
      const { pid, key } = await setUp(`Course W ${label}`, true);
      const shop = await store();
      is(`(${label}) waitingCount says it does not know`, await withBent("HVALS", key, reply, () => rejection(() => waitingCount(shop, pid))), "UnknownReplyError");
    }
    {
      const { pid, key } = await setUp(`Course D ${label}`, true);
      const removed = await withBent("HVALS", key, reply, () => post(productRoute, "product", session, { action: "remove", id: pid }));
      is(`(${label}) removal answers 503 "unavailable"`, await answer(removed), [503, "unavailable"]);
      is(`(${label}) the product is kept`, Boolean(await readListing(await store(), pid)), true);
      is(`(${label}) and its buyer who paid still waits for it`, await waitingCount(await store(), pid), 1);
    }
    {
      const { pid, key } = await setUp(`Course E ${label}`, false);
      const released = await withBent("HVALS", key, reply, () => post(waitlistRoute, "waitlist", session, { action: "soon", id: pid, on: false }));
      is(`(${label}) taking the EMPTY product off coming soon is refused, 503 "unavailable"`, await answer(released), [503, "unavailable"]);
      is(`(${label}) it stays coming soon (no buy button on an empty product)`, await isSoon(await store(), pid), true);
    }
    {
      const { pid, key } = await setUp(`Course F ${label}`, true);
      await withBent("HVALS", key, reply, () => post(waitlistRoute, "waitlist", session, { action: "soon", id: pid, on: false }).catch(() => null));
      is(`(${label}) on sale, its hand-over job IS queued (unknown is never "nobody waits")`, [await isSoon(await store(), pid), await jobQueued(pid)], [false, true]);
      is(`(${label}) and its buyer still waits, for the job to hand it over`, await waitingCount(await store(), pid), 1);
    }
  }

  part("queueRelease: a job write that answers in another shape is not done");
  {
    const { pid } = await setUp("Course G", true);
    const member = `${sid}|${pid}|${HANDLE}`;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await original(commands);
      return replies.map((r, i) => (commands[i][0] === "SADD" && commands[i][1] === JOBS && commands[i][2] === member ? "OK" : r));
    }) as typeof redis.pipeline;
    try {
      is("queueRelease says it does not know whether the job is in line", await rejection(async () => queueRelease(await store(), pid)), "UnknownReplyError");
    } finally {
      redis.pipeline = original;
    }
  }

  part("The five-minute job keeps a job whose read is unknown");
  // Only this part's jobs are in line: the ones queued above are another product's, not read here.
  await redis.pipeline([["DEL", JOBS]]);
  {
    const jobStore = { ...(await store()), stripeAccountId: "acct_test_prewait1" } as Store;
    const { pid, key } = await setUp("Course H", true);
    const product = (await readListing(await store(), pid)) as Listing;
    await setSoon(await store(), pid, false);
    const member = `${sid}|${pid}|${HANDLE}`;
    for (const [label, reply] of SHAPES) {
      await redis.pipeline([["SADD", JOBS, member]]);
      const given = await withBent("HGETALL", key, reply, () => runPreorderReleases(async () => jobStore, async (_s: Store, id: string) => (id === pid ? product : null), () => ({ base: ORIGIN, from: "x@example.com", ordersLink: async () => null, recordStart: async () => {} }), Date.now() + 5_000));
      is(`(${label}) nothing is handed over, and the job stays in line to be tried again`, [given, await jobQueued(pid)], [0, true]);
    }
    is("its buyer still waits", await waitingCount(await store(), pid), 1);
  }
  {
    const jobStore = { ...(await store()), stripeAccountId: "acct_test_prewait1" } as Store;
    const { pid } = await setUp("Course I", true, false);
    const product = (await readListing(await store(), pid)) as Listing;
    await setSoon(await store(), pid, false);
    await redis.pipeline([["SADD", JOBS, `${sid}|${pid}|${HANDLE}`]]);
    await runPreorderReleases(async () => jobStore, async (_s: Store, id: string) => (id === pid ? product : null), () => ({ base: ORIGIN, from: "x@example.com", ordersLink: async () => null, recordStart: async () => {} }), Date.now() + 5_000);
    is("control: with nothing waiting, read exactly, the job is done and leaves the line", await jobQueued(pid), false);
  }
  done();
}

main();
