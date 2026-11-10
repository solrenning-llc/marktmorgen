/**
 * An ended store's one whole export, when a part of it could not be read
 * (review of PR #3122, rule VR item 2: nothing shown to a customer promises
 * what does not work).
 *
 * A store whose plan has ended has ENDED_STORE_EXPORTS whole exports before
 * it closes and its data is erased (lib/plan-closing-rules.ts). The route
 * takes that turn before the file streams (app/api/store/export/route.ts).
 * A part that cannot be read was written into the file as "This part could
 * not be read just now. Download the file again in a few minutes."
 * (lib/store-export.ts), but downloading again was refused (429). Giving the
 * turn back is not done here: a part that always fails (a revoked Stripe
 * account, for one) would make the ended store's exports unbounded, past the
 * closing cost priced in tests/plan-cost-registry.ts; that is a decision for
 * the coordinator. So the file now says the truth to an ended store: the part
 * is not in this file, a store whose plan has ended downloads it once, and
 * starting a plan again lets it download again. A store whose plan runs keeps
 * the words it had, which are true for it. The refusal says "once", not
 * "1 times".
 *
 * Synthetic store and in-memory database only; the failing part is the
 * posts part, made to fail by its read throwing after the route answered.
 */
import { NextRequest } from "next/server";
import { GET as exportRoute } from "@/app/api/store/export/route";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import type { Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { ENDED_STORE_EXPORTS } from "@/lib/plan-closing-rules";
import { standingOf } from "@/lib/plan-standing";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

/** How many of the next reads of the posts list throw, and every command sent, to see what the export touched. */
let failPostReads = 0;
let failFormReads = 0;
let sent: Command[] = [];

const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  sent.push(...commands);
  for (const command of commands) {
    const key = String(command[1] ?? "");
    if (command[0] === "HVALS" && key.startsWith("nl:blog:meta:") && failPostReads > 0) {
      failPostReads -= 1;
      throw new Error("the posts could not be read (synthetic)");
    }
    if (command[0] === "HVALS" && key.startsWith("nl:forms:") && failFormReads > 0) {
      failFormReads -= 1;
      throw new Error("the forms could not be read (synthetic)");
    }
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

let stores = 0;
/** A new store each time; ended unless told it runs. */
async function aStore(ended: boolean): Promise<{ store: Store; cookie: string }> {
  const owner = `endedretry${++stores}@example.com`;
  await claimHandle(owner, `endedretry${stores}`, "Ended Retry", "Recipes.");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  if (ended) await setSubscription(owner, { customerId: `cus_endedretry${stores}`, subscriptionId: `sub_endedretry${stores}`, active: false });
  return { store: (await storeForEmail(owner))!, cookie: `${SESSION_COOKIE}=${await openSession(owner)}` };
}

/** The whole store's file; the parts named fail only once the route has answered, while the file streams. */
async function exportStore(who: { store: Store; cookie: string }, fail: { posts?: number; forms?: number } = {}): Promise<{ status: number; body: string }> {
  failPostReads = 0;
  failFormReads = 0;
  let response: Response;
  try {
    response = await exportRoute(new NextRequest("https://marktmorgen.com/api/store/export?what=store", { headers: { "x-nimbus-store": who.store.sid, cookie: who.cookie } }));
  } catch {
    return { status: 500, body: "threw" };
  }
  failPostReads = fail.posts ?? 0;
  failFormReads = fail.forms ?? 0;
  const body = await response.text();
  failPostReads = 0;
  failFormReads = 0;
  return { status: response.status, body };
}

const endedKey = (store: Store) => `nl:rl:export:${store.statsId}:ended:${Date.parse(store.planEndedAt) || 0}`;
const endedCount = async (store: Store) => (await pipeline([["GET", endedKey(store)]]))[0];
const unread = (body: string) => /"unreadPart\d+":"This part could not be read just now\. Download the file again in a few minutes\."/.test(body);
const unreadEnded = (body: string) =>
  /"unreadPart\d+":"This part could not be read just now, so it is not in this file\. A store whose plan has ended downloads this file once, and starting a plan again lets you download it again\."/.test(body);

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  is("what an ended store keeps is one whole export (this test is written for it)", ENDED_STORE_EXPORTS, 1);

  part("(a) An ended store whose one export had a part it could not read");
  const a = await aStore(true);
  is("the store's plan has ended", standingOf(a.store), "ended");
  const first = await exportStore(a, { posts: 1 });
  is("the file is made, and says the part is not in it, never to download again in a few minutes", [first.status, unreadEnded(first.body), unread(first.body)], [200, true, false]);
  const again = await exportStore(a);
  is("downloading again is refused, as the file now says", again.status, 429);

  part("(b) An ended store whose export was whole");
  const b = await aStore(true);
  const whole = await exportStore(b);
  is("the file is made whole, and its one turn stays taken", [whole.status, unread(whole.body), unreadEnded(whole.body), await endedCount(b.store)], [200, false, false, "1"]);
  const refused = await exportStore(b);
  is("the next is refused, as before", refused.status, 429);

  part("(c) Two parts an ended store could not read in its one export");
  const c = await aStore(true);
  const c1 = await exportStore(c, { posts: 1, forms: 1 });
  const c1Ended = (c1.body.match(/"unreadPart\d+":"This part could not be read just now, so it is not in this file\./g) ?? []).length;
  is("both parts say they are not in the file, and the file is still JSON", [c1.status, c1Ended, (() => { try { JSON.parse(c1.body); return true; } catch { return false; } })()], [200, 2, true]);
  const c5 = await exportStore(c);
  is("the turn stays spent: the next is refused", c5.status, 429);

  part("(d) The refusal's words");
  is("it says once, not \"1 times\"", [c5.body.includes("downloaded your store's main data once since your plan ended"), c5.body.includes("1 times")], [true, false]);

  part("(e) A store whose plan runs, with a part it could not read");
  const e = await aStore(false);
  is("the store's plan is not ended", standingOf(e.store) !== "ended", true);
  sent = [];
  const running = await exportStore(e, { posts: 1 });
  const touchedEnded = sent.some((command) => String(command[1] ?? "").includes(":ended:"));
  is("its file keeps the words true for it (download again), and the ended count is never touched", [running.status, unread(running.body), unreadEnded(running.body), touchedEnded], [200, true, false, false]);

  done();
}

void main();
