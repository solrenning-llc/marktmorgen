/**
 * 639 [GL7](37): what each person on a store's team did, counted as each
 * inbox reply is written: buyers answered and how long they waited, replies,
 * and deals won by whom they were given to. Room is taken before a person's
 * first numbers of a month; listed by address, never ranked.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { fileContact, readInbox, replyTo } from "@/lib/inbox";
import { readStages, writeDeal } from "@/lib/crm";
import { TEAM_WORK_PERSON_BYTES, monthOf, teamWorkFor } from "@/lib/team-work";
import { dataKey, monthOf as roomMonth } from "@/lib/store-data";
import { TEAM_WORK_KEEP_SECONDS } from "@/lib/team-work";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "teamowner@example.com";
const HELPER = "helper@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "teamshop", "Team Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Team00001", subscriptionId: "sub_Team00001", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const t0 = Date.UTC(2026, 10, 10, 12);
  const month = monthOf(t0);

  part("Counted as each reply is written");
  await fileContact({ store, email: "buyer@example.com", name: "Buyer", text: "Is it still open?", now: t0 });
  const id = (await readInbox(store.statsId)).find((c) => c.email === "buyer@example.com")!.id;
  // Kept for TEAM_WORK_KEEP_SECONDS: counted in the month it lapses (lib/store-data.ts, keepFor).
  const slot = () => Number(redis.run(["HGET", dataKey(store)!, `~${roomMonth(Date.now() + TEAM_WORK_KEEP_SECONDS * 1000)}`])) || 0;
  const before = slot();
  await replyTo(store, id, HELPER, "Yes, until Friday.", t0 + 10 * 60_000);
  await replyTo(store, id, HELPER, "And here is the link.", t0 + 11 * 60_000);
  await replyTo(store, id, OWNER, "Welcome!", t0 + 12 * 60_000);
  const [stage] = (await readStages(store.statsId)).filter((s) => s.kind === "won");
  await writeDeal(store.statsId!, { id: "dealteam01", title: "Coaching", email: "buyer@example.com", cents: 50_000, stage: stage.id, note: "", assignee: HELPER, createdAt: t0, updatedAt: t0 }, store);
  const work = await teamWorkFor(store.statsId!, [HELPER, OWNER], month);
  is("the helper answered the buyer, who waited ten minutes, and replied twice", [work[0].answered, work[0].averageWaitSeconds, work[0].replies], [1, 600, 2]);
  is("the owner's reply came after the store had answered: a reply, not an answer", [work[1].answered, work[1].averageWaitSeconds, work[1].replies], [0, null, 1]);
  is("the deal won by the one it was given to", [work[0].dealsWon, work[0].wonCents, work[1].dealsWon], [1, 50_000, 0]);
  is("each person's first numbers of the month took their room", slot() - before, 2 * TEAM_WORK_PERSON_BYTES, true);
  is("another month starts at nothing", (await teamWorkFor(store.statsId!, [HELPER], "2026-10"))[0].replies, 0);

  part("The page");
  const page = readFileSync("app/studio/team-work/page.tsx", "utf8");
  is("for a role that may change settings, by address, never sorted by numbers", [page.includes('"settings")'), page.includes(".sort((a, b) => a.localeCompare(b"), /sort\([^)]*replies|sort\([^)]*answered/.test(page)], [true, true, false]);
  is("reached from the team page", readFileSync("app/studio/team/page.tsx", "utf8").includes('"team-work"'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
