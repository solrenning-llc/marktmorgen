/**
 * The branches of the podcast feed's liveness checks that tests/podcast-public-erasure.test.ts does not reach
 * (Claude 1's LOW on #4991, 7067078245):
 *   (a) keptStoreLive answering anything but 1 or 0: the kept feed is let go and rebuilt from the records, never served;
 *   (b) a kept feed whose store's erasure has begun (mark set, record and id key still there): 404;
 *   (c) a store from before ids (sid ""): keptStoreLive says "unknown", and its feed is built each time, never kept;
 *   (d) withLiveStore: erasing → null; another sid at the address → null; a legacy snapshot with the same statsId
 *       runs; one with another statsId → null;
 *   (e) the memory model of FEED_STORE_LIVE: each reply and its exact inner calls.
 * Synthetic data only; the Redis double, no network.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { ERASING_KEY, addProduct, claimHandle, ensureStatsId, erasingField, ownerKey, setProductPodcast, setSubscription, storeForEmail, storeHandleKey, storeIdCommand, storeRef, withLiveStore, type Store } from "@/lib/store";
import { savePodcast } from "@/lib/podcast";
import type { Podcast } from "@/lib/podcast-rules";
import { FEED_STORE_LIVE, cachedFeed, forgetPublicFeeds, keptStoreLive } from "@/lib/podcast-public-show";
import { MemoryRedis } from "@/lib/redis-memory";
import { POST as settings } from "@/app/api/store/podcast/public-settings/route";
import { GET as feed } from "@/app/api/store/podcast/public/[handle]/[product]/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
globalThis.fetch = (async () => {
  throw new Error("no request may be made here");
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
type Command = (string | number)[];
const original = redis.pipeline.bind(redis);
/** Answers the liveness script with this reply instead of running it, once. */
let liveReply: unknown = undefined;
const sent: string[] = [];
redis.pipeline = (async (commands: Command[]) => {
  for (const c of commands) sent.push(c.map(String).join(" ").slice(0, 120));
  if (liveReply !== undefined && commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:podcast-feed-store-live:v1")) {
    const reply = liveReply;
    liveReply = undefined;
    if (reply instanceof Error) throw reply;
    return [reply];
  }
  return original(commands);
}) as typeof redis.pipeline;

function podcast(id: string): Podcast {
  return { id, episodes: [{ id: "ep0000000001", title: "Episode 1", notes: "", pathname: "stores/x/p/1.mp3", bytes: 1001, contentType: "audio/mpeg", at: 1_790_000_001 }] };
}

async function open(owner: string, handle: string, pod: string): Promise<{ store: Store; pid: string }> {
  await claimHandle(owner, handle, "Synthetic Show", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic Weekly", "A synthetic show.", "9", null);
  if (!made.ok) throw new Error("no product");
  if (!(await setProductPodcast(owner, made.product.id, { id: pod, episodes: 1 })).ok) throw new Error("no podcast");
  await savePodcast(podcast(pod));
  const session = await openSession(owner);
  const on = await settings(new NextRequest(`${ORIGIN}/api/store/podcast/public-settings`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
    body: JSON.stringify({ action: "on", id: made.product.id, category: "Education", explicit: false, understood: true }),
  }));
  if (on.status !== 200) throw new Error("the feed was not turned on");
  return { store: (await storeForEmail(owner)) as Store, pid: made.product.id };
}

async function get(handle: string, pid: string): Promise<{ status: number; xml: string }> {
  const response = await feed(new NextRequest(`${ORIGIN}/api/store/podcast/public/${handle}/${pid}.xml`), { params: Promise.resolve({ handle, product: `${pid}.xml` }) });
  return { status: response.status, xml: await response.text() };
}

async function main(): Promise<void> {
  redis.clear();
  forgetPublicFeeds();

  part("(a) A liveness reply that is neither 1 nor 0, or a throw, lets the kept feed go and rebuilds it from the records");
  {
    const { pid } = await open("branch-a@example.com", "branchashow", "a".repeat(32));
    is("control: built and kept", [(await get("branchashow", pid)).status, Boolean(cachedFeed(`branchashow|${pid}`, Date.now()))], [200, true]);
    for (const reply of ["live?", 2, null, new Error("synthetic: the connection closed")]) {
      sent.length = 0;
      liveReply = reply;
      const answer = await get("branchashow", pid);
      is(`reply ${reply instanceof Error ? "a throw" : JSON.stringify(reply)}: the feed is answered from the records, not the cache`, [answer.status, answer.xml.includes("<rss"), sent.some((c) => c.startsWith("GET nl:store:handle:branchashow"))], [200, true, true]);
    }
  }

  part("(b) A kept feed whose store's erasure has begun (mark set, record and id still there) is not served");
  {
    const { store, pid } = await open("branch-b@example.com", "branchbshow", "b".repeat(32));
    is("control: built and kept", [(await get("branchbshow", pid)).status, Boolean(cachedFeed(`branchbshow|${pid}`, Date.now()))], [200, true]);
    redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]);
    is("the record and the id key are still there", [Number(redis.run(["EXISTS", await ownerKey(storeRef(store))])), Number(redis.run(["EXISTS", storeIdCommand(store.sid)[1]]))], [1, 1]);
    const answer = await get("branchbshow", pid);
    is("404, and no RSS sent", [answer.status, answer.xml.includes("<rss")], [404, false]);
    is("and the kept copy is let go", cachedFeed(`branchbshow|${pid}`, Date.now()), null);
    redis.run(["HDEL", ERASING_KEY, await erasingField(storeRef(store))]);
  }

  part("(c) A store from before ids: no id key to check, so its feed is never kept");
  {
    const { store, pid } = await open("branch-c@example.com", "branchcshow", "c".repeat(32));
    is("keptStoreLive cannot check a store with no id", await keptStoreLive({ ...store, sid: "" }), "unknown");
    // The record as a store from before ids holds it: no sid.
    const owner = await ownerKey(storeRef(store));
    const record = JSON.parse(String(redis.run(["GET", owner]))) as Record<string, unknown>;
    record.sid = "";
    redis.run(["SET", owner, JSON.stringify(record)]);
    forgetPublicFeeds();
    const first = await get("branchcshow", pid);
    is("its feed is built and answered", [first.status, first.xml.includes("<rss")], [200, true]);
    is("and not kept", cachedFeed(`branchcshow|${pid}`, Date.now()), null);
    is("built again the next time", (await get("branchcshow", pid)).status, 200);
  }

  part("(d) withLiveStore runs the work only for this very store, live and not erasing");
  {
    const owner = "branch-d@example.com";
    await claimHandle(owner, "branchdshow", "Synthetic Show", "");
    await ensureStatsId(owner);
    const store = (await storeForEmail(owner)) as Store;
    const ran = async (known: Store) => withLiveStore(known, async () => "ran");
    is("control: the same store, live: runs", await ran(store), "ran");
    is("another sid at the same address: null", await ran({ ...store, sid: "f".repeat(32) }), null);
    is("a snapshot from before ids with the same statsId: runs", await ran({ ...store, sid: "" }), "ran");
    is("a snapshot from before ids with another statsId: null", await ran({ ...store, sid: "", statsId: "e".repeat(32) }), null);
    redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]);
    is("its erasure has begun: null, the work not run", await ran(store), null);
  }

  part("(e) The memory model of FEED_STORE_LIVE: each reply and the inner calls it makes");
  {
    const memory = new MemoryRedis();
    const handle = storeHandleKey("modelshow");
    const id = storeIdCommand("d".repeat(32))[1];
    const field = "field-of-the-store";
    const rows = [
      { name: "no id key", id: null, handle: "ref", erasing: false, answer: 0, calls: 1 },
      { name: "the address leads elsewhere", id: "ref", handle: "other", erasing: false, answer: 0, calls: 2 },
      { name: "the address was let go", id: "ref", handle: "released:2026-11-21T00:00:00Z", erasing: false, answer: 0, calls: 2 },
      { name: "erasing", id: "ref", handle: "ref", erasing: true, answer: 0, calls: 3 },
      { name: "live", id: "ref", handle: "ref", erasing: false, answer: 1, calls: 3 },
    ];
    for (const row of rows) {
      memory.clear();
      if (row.id !== null) memory.run(["SET", id, row.id]);
      memory.run(["SET", handle, row.handle]);
      if (row.erasing) memory.run(["HSET", ERASING_KEY, field, "1"]);
      const before = memory.scriptCalls;
      is(`${row.name}: reply`, memory.run(["EVAL", FEED_STORE_LIVE, 3, handle, id, ERASING_KEY, field]), row.answer);
      is(`${row.name}: inner calls`, memory.scriptCalls - before, row.calls);
    }
  }

  redis.pipeline = original;
  done();
}

main().catch((error) => {
  redis.pipeline = original;
  console.error(error);
  process.exit(1);
});
