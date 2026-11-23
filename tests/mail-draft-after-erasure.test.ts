/**
 * A mail draft is written only while its store is live (Codex X4-20261119-2140, #5010 row 111): saveDraftUnlocked wrote
 * a new draft with a plain HSET and an edit through DRAFT_SET_HELD, which checked only the edit's lease, so a save in
 * flight while the store was erased put the erased draft back (its subject, its text, who it was meant for). Both now
 * write through DRAFT_SET_LIVE, the store's fence (the rule of store-cache-live:v3) read in the same step as the write:
 * a store being erased, erased, or whose id key now names another store gets nothing written and the save answers
 * "list"; a live store saves as before, and an edit still needs its own lease.
 * The whole studio request that saves a draft (POST /api/store/mail, action draft-save) is measured against the studio
 * unit's 27 commands (coordinator 964c). Synthetic store; in-memory Redis.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { listDrafts, saveDraft } from "@/lib/mail-drafts";
import { ERASING_KEY, claimHandle, ensureListId, ensureStatsId, ensureStoreId, erasingField, setSubscription, storeForEmail, storeRef, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "drafts-erase@example.test";
const input = { subject: "Spring sale", body: "Twenty percent off, this week only.", productId: "" };

async function liveStore(): Promise<Store> {
  redis.clear();
  if (!(await claimHandle(OWNER, "draftserase", "Fictional Drafts", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_draftserase01", subscriptionId: "sub_draftserase01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  if (!store.sid || !store.listId) throw new Error("no ids");
  return store;
}
async function erasing(store: Store, on: boolean): Promise<void> {
  const field = await erasingField(storeRef(store));
  redis.run(on ? ["HSET", ERASING_KEY, field, String(Date.now())] : ["HDEL", ERASING_KEY, field]);
}
const draftCount = (store: Store) => Number(redis.run(["HLEN", `nl:mail:drafts:${store.listId}`]));

async function main(): Promise<void> {
  part("A live store's draft is saved, and edited under its lease, as before");
  {
    const store = await liveStore();
    const made = await saveDraft(store, OWNER, input);
    is("a new draft is saved", [made.ok, draftCount(store)], [true, 1]);
    if (!made.ok) throw new Error("no draft");
    const edited = await saveDraft(store, OWNER, { ...input, id: made.draft.id, body: "Twenty-five percent off." });
    is("an edit is saved", [edited.ok, (await listDrafts(store.listId))[0]?.body], [true, "Twenty-five percent off."]);
  }

  part("The store's erasure began while the draft was being saved: nothing is written");
  {
    const store = await liveStore();
    await erasing(store, true);
    const made = await saveDraft(store, OWNER, input);
    is("a new draft is refused as having no list", made, { ok: false, reason: "list" });
    is("and no draft is written", draftCount(store), 0);
    await erasing(store, false);
    const control = await saveDraft(store, OWNER, input);
    is("control: the same save once the mark is gone is kept", [control.ok, draftCount(store)], [true, 1]);
  }

  part("An edit in flight while the store is erased writes nothing over the kept draft");
  {
    const store = await liveStore();
    const made = await saveDraft(store, OWNER, input);
    if (!made.ok) throw new Error("no draft");
    await erasing(store, true);
    const edited = await saveDraft(store, OWNER, { ...input, id: made.draft.id, body: "Rewritten during the erasure." });
    is("the edit is refused", edited, { ok: false, reason: "list" });
    is("and the draft is as it was", (await listDrafts(store.listId))[0]?.body, input.body);
  }

  part("The store's erasure ended (its id key gone) while the draft was being saved: nothing is written");
  {
    const store = await liveStore();
    redis.run(["DEL", `nl:store:id:${store.sid}`]);
    const made = await saveDraft(store, OWNER, input);
    is("the save is refused", made, { ok: false, reason: "list" });
    is("and no draft is written back", draftCount(store), 0);
  }

  part("The store's id key now names another store (its account moved): nothing is written under the old ref");
  {
    const store = await liveStore();
    redis.run(["SET", `nl:store:id:${store.sid}`, "someone-else@example.test"]);
    const made = await saveDraft(store, OWNER, input);
    is("the save is refused", made, { ok: false, reason: "list" });
    is("and no draft is written", draftCount(store), 0);
  }

  part("The studio's whole request that saves a draft stays inside the studio unit's envelope (coordinator 964c)");
  {
    const store = await liveStore();
    const session = await openSession(OWNER);
    const real = redis.pipeline.bind(redis);
    const sent: (string | number)[][] = [];
    redis.pipeline = (async (commands: (string | number)[][]) => {
      sent.push(...commands);
      return real(commands);
    }) as typeof redis.pipeline;
    let status = 0;
    try {
      const response = await mailRoute(new NextRequest("https://marktmorgen.com/api/store/mail", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ action: "draft-save", ...input }),
      }));
      status = response.status;
    } finally {
      redis.pipeline = real;
    }
    // Billed as Upstash bills a script, one plus every redis.call in its text (an upper bound: every branch counted),
    // and padded with the whole take allowance and lockedUntil's worst case, as tests/outreach-sender-erasure-fence.test.ts does.
    const billed = sent.reduce((sum, c) => sum + (c[0] === "EVAL" ? 1 + (String(c[1]).match(/redis\.call\(/g) ?? []).length : 1), 0);
    const measured = billed + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
    const envelope = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
    const drafts = sent.filter((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:draft-set-live:"));
    console.log("MAIL_DRAFT_SAVE_ROUTE", JSON.stringify({ billed, takeWorst: TAKE_COMMANDS, lockedUntilWorst: LOCKED_UNTIL_STAR_COMMANDS, measured, envelope }));
    is("the draft is saved (200), through the fenced write", [status, draftCount(store), drafts.length], [200, 1, 1]);
    is(`its billed commands, padded (${measured}), stay within the studio unit's ${envelope}`, measured <= envelope, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
