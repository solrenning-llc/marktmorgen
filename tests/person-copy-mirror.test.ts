/**
 * 619 [SZ3] unit 2: the readers for the copy of a person's data that the five
 * small modules gained, each held to its module's own erasure. What is
 * written is found by the reader; after the real erasure, the reader finds
 * nothing. So a reader and the erasure can never drift onto different keys.
 */
import { createHash } from "node:crypto";
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { ERASERS, erasureScope } from "@/lib/person-erasure";
import { COPIERS, COPY_PLAN } from "@/lib/person-copy";
import { stepCampaign } from "@/lib/mail-links";
import { feedToken } from "@/lib/podcast-access";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "mirrorowner@example.com";
const PERSON = "grace@example.com";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "mirrorshop", "Mirror Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const listId = store.listId!;
  const session = "cs_test_" + "m".repeat(20);
  // The records each module keeps, written as the module writes them.
  redis.run(["HSET", `nl:wl:${statsId}:prod000001`, PERSON, JSON.stringify({ at: 1_790_000_000, ok: 1_790_000_100, c: true, t: "secret-token" })]);
  redis.run(["SADD", `nl:mail:clk:${listId}:${sha(`nimbus-clk:${PERSON}`).slice(0, 32)}`, stepCampaign("0".repeat(16), "1".repeat(16))]);
  redis.run(["SADD", `nl:assist:remindwho:${statsId}:${sha(`nimbus-assist-remind:${statsId}:${PERSON}`).slice(0, 32)}`, session]);
  redis.run(["SET", `nl:assist:remind:${session}`, JSON.stringify({ s: statsId, e: PERSON, t: "Email me a reminder if I don't finish this order", v: "1", l: "en", at: 1_790_000_000_000 })]);
  redis.run(["RPUSH", `nl:esync:log:${statsId}`, "job1"]);
  redis.run(["SET", "nl:esync:j:job1", JSON.stringify({ id: "job1", statsId, email: PERSON, firstName: "Grace", products: [], title: "Free guide", source: "free", attempts: 1, state: "added", next: 0, lastError: "", note: "Added", lastAt: 1, createdAt: 1 })]);
  const token = await feedToken(store, "prod000001", PERSON);
  const scope = { ...(await erasureScope(store, PERSON))!, productIds: ["prod000001"] };

  const modules = ["lib/waitlist.ts", "lib/mail-clicks.ts", "lib/podcast-access.ts", "lib/assistant-reminder.ts", "lib/email-sync.ts"];
  part("Each reader finds what its module keeps");
  is("all five are copied now", modules.map((m) => COPY_PLAN[m].how), modules.map(() => "copied"));
  const found = await Promise.all(modules.map((m) => COPIERS[m](scope)));
  is("one record each", found.map((r) => r.length), [1, 1, 1, 1, 1]);
  const text = JSON.stringify(found);
  is("the waitlist link's secret and the feed's address are not in it", [text.includes("secret-token"), token ? text.includes(token) : false], [false, false]);
  is("the reminder says the sentence checked and when", found[3][0], { address: PERSON, sentence: "Email me a reminder if I don't finish this order", version: "1", at: "2026-09-21T14:13:20.000Z" });

  part("After the erasure, each finds nothing");
  for (const name of modules) await ERASERS.find((e) => e.module === name)!.run(scope, [], new Set());
  is("nothing left to copy", (await Promise.all(modules.map((m) => COPIERS[m](scope)))).map((r) => r.length), [0, 0, 0, 0, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
