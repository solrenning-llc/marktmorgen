/** A store lookup that failed cannot prove that a person's deletion finished. */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { confirmErasure, readErasureLink } from "@/lib/erasure-request";
import { POST } from "@/app/api/privacy/erase/route";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const token = "a".repeat(64);
const key = `nl:erase:link:${createHash("sha256").update(`nimbus-erase-link:${token}`).digest("hex").slice(0, 40)}`;
const email = "erasure-retry@example.com";
const original = redis.pipeline.bind(redis);
const cases: [string, unknown[] | "throw"][] = [["transport error", "throw"], ["missing reply", []], ["undefined reply", [undefined]], ["null reply", [null]], ["wrong scalar", [7]]];

async function main(): Promise<void> {
  redis.clear();
  globalThis.fetch = async () => { throw new Error("no provider calls allowed in this test"); };
  const owner = "erasure-evidence-owner@example.com";
  await claimHandle(owner, "erasureevidence", "Erasure Evidence", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_erasure_evidence", subscriptionId: "sub_erasure_evidence", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  await upsertContact(store.listId!, email, { agreed: true, explicit: true, source: "free" }, ROOM);
  for (const [name, reply] of cases) {
    part(name);
    const grant = JSON.stringify({ e: email, s: [store.sid] });
    await original([["SET", key, grant, "EX", 3600]]);
    let indexReads = 0;
    redis.pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "GET" && c[1] === `nl:store:id:${store.sid}`)) {
        indexReads += 1;
        if (reply === "throw") throw new Error("synthetic store read failed");
        return reply;
      }
      return original(commands);
    };
    try {
      let refused = false;
      try { await readErasureLink(token); } catch { refused = true; }
      is("the preview refuses an unconfirmed store instead of showing an empty scope", refused, true);
      const done = await confirmErasure(token);
      is("unreadable store is still to do, never counted as deleted", done, { state: "more", deleted: [], later: [store.sid] });
      is("the grant still names the same store", redis.run(["GET", key]), grant);
      is("the person's contact still exists, proving deletion was not done", typeof redis.run(["HGET", leadsKey(store.listId!), email]), "string");
      const response = await POST(new NextRequest("https://marktmorgen.com/api/privacy/erase", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://marktmorgen.com", host: "marktmorgen.com" },
        body: new URLSearchParams({ action: "confirm", token }),
      }));
      const location = new URL(response.headers.get("location") ?? "https://marktmorgen.com/no-redirect");
      is("the public confirmation offers another press and never claims done", [response.status, location.searchParams.get("status"), location.searchParams.get("token")], [303, "more", token]);
      is("both preview and confirmation used the real store lookup", indexReads >= 2, true);
    } finally { redis.pipeline = original; }
  }
  part("A confirmed store can finish the same deletion");
  const link = await readErasureLink(token);
  is("the same link can be read after recovery", [link?.email, link?.stores.map((s) => s.sid)], [email, [store.sid]]);
  const done = await confirmErasure(token);
  is("real erasure finishes once its store can be read", [done.state, done.deleted, done.later], ["done", [store.name], []]);
  is("the contact really is removed", redis.run(["HGET", leadsKey(store.listId!), email]), null);
  is("the grant goes only after confirmed erasure", redis.run(["GET", key]), null);
  is("the consumed link cannot delete again", (await confirmErasure(token)).state, "gone");
  finishChecks();
}
const finishChecks = done;
main().catch((error) => { console.error(error); process.exit(1); });
