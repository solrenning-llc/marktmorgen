/**
 * Review proof for #3034: two accepted link changes that read the same
 * history must not overwrite one another. Synthetic in-memory Redis only.
 */
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { changeLink, readSentLinks, sentLinkKey, type SentEmail } from "@/lib/sent-links";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, {
    customerId: "cus_ConcurrentLinks",
    subscriptionId: "sub_ConcurrentLinks",
    active: true,
    tier: "pro",
    period: paidPeriod(),
  });
  const store = (await storeForEmail(OWNER))!;
  const email: SentEmail = {
    id: "e".repeat(24),
    listId: store.listId!,
    handle: store.handle,
    body: "Watch: https://example.com/first",
    sent: 1,
    links: true,
  };

  const key = sentLinkKey(email.id);
  const original = redis.pipeline;
  let reads = 0;
  let letReadsFinish!: () => void;
  const bothRead = new Promise<void>((resolve) => { letReadsFinish = resolve; });
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key && reads < 2) {
      reads += 1;
      if (reads === 2) letReadsFinish();
      await bothRead;
      return [null];
    }
    return original.call(redis, commands);
  };

  part("Two accepted concurrent changes keep both history entries");
  const [one, two] = await Promise.all([
    changeLink(store, email, 0, "https://example.com/one"),
    changeLink(store, email, 0, "https://example.com/two"),
  ]);
  redis.pipeline = original;
  const kept = await readSentLinks(email.id);
  is("both requests report success", [one.ok, two.ok], [true, true]);
  is(
    "both accepted changes remain in the durable history",
    kept?.changes.map((change) => change.to),
    ["https://example.com/one", "https://example.com/two"],
  );
  done();
}

void main();
