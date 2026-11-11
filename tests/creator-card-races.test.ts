/**
 * The creator's card and its slot in the store's data room never part (Codex
 * L on #1961, confirmed by Revisor 2, C3-134): the card is written and its
 * slot set to its size in one script (SAVE_CARD), and a removal deletes only
 * the card it read, setting its slot to nothing in the same step (DROP_CARD),
 * so a save racing another, or a removal, never leaves a kept card larger
 * than what its slot holds. The real card and data-room code against the
 * in-memory Redis double only; the race is made by holding one write until
 * the other is done.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { dropCreatorCard, saveCreatorCard } from "@/lib/creator-card";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const long = { on: true, name: "Synthetic business", note: "x".repeat(300) };
const short = { on: true, name: "Synthetic business", note: "x" };

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "card-race@example.test";
  await claimHandle(owner, "card-race", "Synthetic business", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_card", subscriptionId: "sub_card", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const key = `nl:vcard:${store.statsId}`;
  const original = redis.pipeline;
  const covered = async (label: string) => {
    const [raw, held] = await original.call(redis, [["GET", key], ["HGET", dataKey(store)!, "card"]]);
    const kept = typeof raw === "string" ? dataBytes([raw], 1) : 0;
    is(`${label}: the kept card is what its slot holds`, [Number(held ?? 0)], [kept]);
  };
  // Held until released: the first write of the card (the script, or a SET of it), or the first removal.
  const hold = (matches: (c: (string | number)[]) => boolean) => {
    const entered = latch();
    const resume = latch();
    let armed = true;
    redis.pipeline = async (commands) => {
      if (armed && commands.some(matches)) {
        armed = false;
        entered.release();
        await resume.promise;
      }
      return original.call(redis, commands);
    };
    return { entered, resume };
  };

  part("A long save held while a short one lands, then let go (Codex L 1)");
  {
    const writesCard = (c: (string | number)[]) => (c[0] === "SET" && c[1] === key) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:card-save"));
    const { entered, resume } = hold(writesCard);
    try {
      const first = saveCreatorCard(store.statsId!, long, store);
      await entered.promise;
      const second = await saveCreatorCard(store.statsId!, short, store);
      resume.release();
      const a = await first;
      is("both saves went through", [a.ok, second.ok], [true, true]);
    } finally {
      resume.release();
      redis.pipeline = original;
    }
    await covered("long save after a short one");
  }

  part("A removal held while a save lands, then let go (Codex L 2)");
  await saveCreatorCard(store.statsId!, long, store);
  {
    // The removal's own script, or (before it) the step that gave the slot back after the card was deleted.
    const removes = (c: (string | number)[]) => c[0] === "EVAL" && (String(c[1]).startsWith("-- marktmorgen:card-drop") || (c[8] === "card" && Number(c[9]) === 0));
    const { entered, resume } = hold(removes);
    try {
      const removal = dropCreatorCard(store.statsId!, store);
      await entered.promise;
      const saved = await saveCreatorCard(store.statsId!, short, store);
      resume.release();
      await removal;
      is("the save that raced the removal went through", saved.ok, true);
    } finally {
      resume.release();
      redis.pipeline = original;
    }
    await covered("a removal and a later save");
  }

  part("A removal on its own takes the card and its whole slot");
  await dropCreatorCard(store.statsId!, store);
  const [gone, slot] = await original.call(redis, [["GET", key], ["HGET", dataKey(store)!, "card"]]);
  is("nothing kept, nothing held", [gone, Number(slot ?? 0)], [null, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
