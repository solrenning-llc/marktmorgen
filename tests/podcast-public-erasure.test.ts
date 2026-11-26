/**
 * A podcast's public feed after its store's erasure (Codex L-20261120-1144 and L-20261120-1151).
 *
 *   - The public GET answered from its in-memory cache before reading the store, so an erased store's feed, and the
 *     whole Store object kept beside it, were served for up to five minutes after the erasure finished.
 *   - A settings write that read the store before the erasure, and wrote after it, put the store's data room and
 *     nl:pod:<id>:public back: the walk had passed them, and nothing would delete them again.
 *
 * Synthetic data only; the Redis double, no network.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductPodcast, setSubscription, storeForEmail, storeRef, type Store } from "@/lib/store";
import { savePodcast } from "@/lib/podcast";
import type { Podcast } from "@/lib/podcast-rules";
import { dataKey } from "@/lib/store-data";
import { WALK_KEY, eraseClosed, markDue } from "@/lib/closed-store-data";
import { closeForErasure } from "./closed-for-erasure";
import { POST as settings } from "@/app/api/store/podcast/public-settings/route";
import { GET as feed } from "@/app/api/store/podcast/public/[handle]/[product]/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { runStoreJob } from "@/lib/store-lock-wait";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

globalThis.fetch = (async () => {
  throw new Error("no request may be made here");
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";

type Command = (string | number)[];
const original = redis.pipeline.bind(redis);
/** Run once, just before the first pipeline that names `key` (a SET of it, or a script with it as its first key). */
let beforeSet: { key: string; run: () => Promise<void> } | null = null;
redis.pipeline = (async (commands: Command[]) => {
  if (beforeSet && commands.some((c) => (c[0] === "SET" && c[1] === beforeSet!.key) || (c[0] === "EVAL" && c[3] === beforeSet!.key))) {
    const hook = beforeSet;
    beforeSet = null;
    await hook.run();
  }
  return original(commands);
}) as typeof redis.pipeline;

function podcast(id: string): Podcast {
  const one = (n: number) => ({ id: `ep000000000${n}`, title: `Episode ${n}`, notes: "", pathname: `stores/x/p/${n}.mp3`, bytes: 1000 + n, contentType: "audio/mpeg", at: 1_790_000_000 + n });
  return { id, episodes: [one(1), one(2)] };
}

async function open(owner: string, handle: string, pod: string): Promise<{ store: Store; pid: string; session: string }> {
  await claimHandle(owner, handle, "Synthetic Show", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic Weekly", "A synthetic show.", "9", null);
  if (!made.ok) throw new Error("no product");
  if (!(await setProductPodcast(owner, made.product.id, { id: pod, episodes: 2 })).ok) throw new Error("no podcast");
  await savePodcast(podcast(pod));
  return { store: (await storeForEmail(owner)) as Store, pid: made.product.id, session: await openSession(owner) };
}

async function turnOn(session: string, pid: string): Promise<number> {
  const response = await settings(
    new NextRequest(`${ORIGIN}/api/store/podcast/public-settings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ action: "on", id: pid, category: "Education", explicit: false, understood: true }),
    }),
  );
  return response.status;
}

async function get(handle: string, pid: string): Promise<{ status: number; xml: string }> {
  const response = await feed(new NextRequest(`${ORIGIN}/api/store/podcast/public/${handle}/${pid}.xml`), { params: Promise.resolve({ handle, product: `${pid}.xml` }) });
  return { status: response.status, xml: await response.text() };
}

/** Runs the closing walk until it says it is done (or six walks), as a fresh walk: the last one's gap is not waited out. */
async function walk(T: number): Promise<void> {
  redis.run(["DEL", WALK_KEY]);
  for (let run = 0; run < 6; run += 1) {
    const report = await eraseClosed(Date.now() + 30_000, async () => {}, T);
    if (report.done) break;
  }
}

async function main(): Promise<void> {
  redis.clear();

  part("A feed cached before its store's erasure is not served after it (L-20261120-1144)");
  {
    const owner = "cached-show@example.com";
    const handle = "cachedshow";
    const pod = "d".repeat(32);
    const { pid, session } = await open(owner, handle, pod);
    is("control: the feed is turned on", await turnOn(session, pid), 200);
    const warmed = await get(handle, pid);
    is("control: the public feed answers and is now cached", [warmed.status, warmed.xml.includes("<rss")], [200, true]);
    const T = Date.now();
    await closeForErasure(owner);
    await markDue(storeRef((await storeForEmail(owner))!), T - 1000);
    await walk(T);
    is("the store's record is gone", await storeForEmail(owner), null);
    const after = await get(handle, pid);
    is("the erased store's cached feed is not served", after.status, 404);
    is("and no RSS is sent", after.xml.includes("<rss"), false);
  }

  part("A settings write in flight when the erasure runs leaves nothing behind it (L-20261120-1151)");
  {
    const owner = "flight-show@example.com";
    const handle = "flightshow";
    const pod = "e".repeat(32);
    const key = `nl:pod:${pod}:public`;
    const { store, pid, session } = await open(owner, handle, pod);
    const room = dataKey(store) ?? "";
    let erased: Promise<void> | null = null;
    let reached = false;
    // Paused at its first write, the room's count (TAKE_DATA), with the settings' SET still to come.
    beforeSet = {
      key: room,
      run: async () => {
        reached = true;
        // The store is closed and walked while the write waits. Not awaited here: a write that holds what the closing
        // needs makes it wait, and then the walk deletes what the write left.
        // The plan's end and the closing walk are scheduled jobs (cron/plans, cron/closing, cron/closed-data): they wait
        // the job's whole wait for the store's lock, never a person's (lib/store-lock-wait.ts, #5010 row 182).
        erased = runStoreJob(async () => {
          const T = Date.now();
          await closeForErasure(owner);
          await markDue(storeRef((await storeForEmail(owner))!), T - 1000);
          await walk(T);
        });
        await Promise.race([erased, new Promise((resolve) => setTimeout(resolve, 1_500))]);
      },
    };
    const status = await turnOn(session, pid);
    beforeSet = null;
    if (erased) await erased;
    is("the write reached its first write while the walk ran", reached, true);
    is("the write was answered", status, 200);
    is("the store's record is gone", await storeForEmail(owner), null);
    is("no public settings are left behind", redis.run(["GET", key]), null);
    is("no data room is left behind", Number(redis.run(["EXISTS", room])), 0);
  }

  redis.pipeline = original;
  done();
}

main().catch((error) => {
  redis.pipeline = original;
  console.error(error);
  process.exit(1);
});
