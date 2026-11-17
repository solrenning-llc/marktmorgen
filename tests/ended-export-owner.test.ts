/**
 * After a plan ends, the whole store's file belongs to the owner (issue #4081).
 *
 * A store whose plan has ended has ENDED_STORE_EXPORTS whole exports before
 * it closes (lib/plan-closing-rules.ts), counted for that ending per store
 * (app/api/store/export/route.ts). The terms (app/terms/page.tsx) and the
 * studio's closing card (app/studio/page.tsx) promise that download to the
 * owner before the closing day. Any teammate with the "export" permission (an
 * Admin) could take it first, and the owner was then refused (429). Now, once
 * the plan has ended, a teammate is refused (403) before anything is counted,
 * and the owner's one download stays theirs. While the plan runs, a teammate
 * with "export" downloads as before.
 *
 * Synthetic stores, synthetic team members and the in-memory database only.
 */
import { NextRequest } from "next/server";
import { GET as exportRoute } from "@/app/api/store/export/route";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import type { Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { ENDED_STORE_EXPORTS } from "@/lib/plan-closing-rules";
import { standingOf } from "@/lib/plan-standing";
import { putMember } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

let sent: Command[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  sent.push(...commands);
  return pipeline(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

let stores = 0;
/** A new store with an Admin on its team; ended unless told it runs. */
async function aStore(ended: boolean): Promise<{ store: Store; owner: string; admin: string }> {
  const owner = `endedowner${++stores}@example.com`;
  const admin = `endedadmin${stores}@example.com`;
  await claimHandle(owner, `endedowner${stores}`, "Ended Owner", "Recipes.");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  if (ended) await setSubscription(owner, { customerId: `cus_endedowner${stores}`, subscriptionId: `sub_endedowner${stores}`, active: false });
  const store = (await storeForEmail(owner))!;
  is(`the Admin joins store ${stores}'s team`, await putMember(store, admin, "admin"), true);
  return { store, owner, admin };
}

async function exportStore(store: Store, email: string): Promise<{ status: number; body: string; type: string }> {
  const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
  const response = await exportRoute(new NextRequest("https://marktmorgen.com/api/store/export?what=store", { headers: { "x-nimbus-store": store.sid, cookie } }));
  return { status: response.status, body: await response.text(), type: response.headers.get("Content-Type") ?? "" };
}

const endedKey = (store: Store) => `nl:rl:export:${store.statsId}:ended:${Date.parse(store.planEndedAt) || 0}`;
const endedCount = async (store: Store) => (await pipeline([["GET", endedKey(store)]]))[0];
const REFUSAL = "After a plan ends, only the store's owner can download the whole store's file. Your list, sales and numbers can still be downloaded one by one from the studio.";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  is("what an ended store keeps is one whole export (this test is written for it)", ENDED_STORE_EXPORTS, 1);

  part("(a) An ended store: an Admin asks for the whole store's file first");
  const a = await aStore(true);
  is("the store's plan has ended", standingOf(a.store), "ended");
  sent = [];
  const byAdmin = await exportStore(a.store, a.admin);
  is("the Admin is refused with a plain sentence, and no file is made", [byAdmin.status, byAdmin.body, byAdmin.type.startsWith("text/plain")], [403, REFUSAL, true]);
  is("nothing is counted for the refused Admin: the ended count was never touched", [await endedCount(a.store), sent.some((command) => String(command[1] ?? "").includes(":ended:"))], [null, false]);

  part("(b) The owner then downloads the store's one file");
  const byOwner = await exportStore(a.store, a.owner);
  is("the owner gets the file", [byOwner.status, byOwner.type.startsWith("application/json"), (() => { try { JSON.parse(byOwner.body); return true; } catch { return false; } })()], [200, true, true]);
  is("the owner's download is the one counted", await endedCount(a.store), "1");
  const again = await exportStore(a.store, a.owner);
  is("a second download by the owner is refused, as before", again.status, 429);
  const before = await endedCount(a.store);
  const adminAfter = await exportStore(a.store, a.admin);
  is("the Admin is still refused with 403, never told the count was spent", [adminAfter.status, adminAfter.body], [403, REFUSAL]);
  is("and the refused Admin leaves the count where the owner's tries put it", await endedCount(a.store), before);

  part("(c) A store whose plan runs: an Admin downloads as before");
  const c = await aStore(false);
  is("the store's plan is not ended", standingOf(c.store) !== "ended", true);
  sent = [];
  const running = await exportStore(c.store, c.admin);
  is("the Admin gets the file, and the ended count is never touched", [running.status, sent.some((command) => String(command[1] ?? "").includes(":ended:"))], [200, false]);

  done();
}

void main();
