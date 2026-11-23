/**
 * Claude 1's LOW on #5071 (#5285 board): a removal of the creator's business card whose answer could not be confirmed
 * was told with the save's sentence ("We could not confirm your business card was saved…"), so the editor said
 * something about saving after the creator pressed Remove. Each now says what it was: a removal not confirmed says
 * "removed", a save not confirmed still says "saved". Both are the same CardSaveUnconfirmed (the route's 503), so
 * nothing else changes. The real card code against the in-memory Redis double; synthetic data.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { CardSaveUnconfirmed, dropCreatorCard, saveCreatorCard } from "@/lib/creator-card";
import { storeLiveFence } from "@/lib/store-live-cache";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const failure = async (work: () => Promise<unknown>): Promise<Error | null> => work().then(() => null, (error: unknown) => error as Error);

async function main(): Promise<void> {
  redis.clear();
  const owner = "card-remove-words@example.test";
  await claimHandle(owner, "card-remove-words", "Synthetic business", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_cardwords", subscriptionId: "sub_cardwords", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const card = { on: true, name: "Synthetic business", note: "Hello" };

  part("A removal not confirmed says it was a removal");
  {
    await saveCreatorCard(store.statsId!, card, store, await storeLiveFence(store));
    // The removal's one script answers in a shape that confirms nothing.
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands[0]?.[0] === "EVAL" ? [["?"]] : real(commands)) as typeof redis.pipeline;
    const error = await failure(() => dropCreatorCard(store.statsId!, store, null));
    const later = await failure(async () => {
      redis.pipeline = (async (commands: (string | number)[][]) =>
        commands[0]?.[0] === "EVAL" ? [["?"]] : real(commands)) as typeof redis.pipeline;
      return dropCreatorCard(store.statsId!, store, await storeLiveFence(store));
    });
    redis.pipeline = real;
    is("with no fence: the removal is unconfirmed (the route's 503)", error instanceof CardSaveUnconfirmed, true);
    is("and its words say removed, not saved", [/removed/.test(error?.message ?? ""), /was saved/.test(error?.message ?? "")], [true, false]);
    is("with an answer that confirms nothing: unconfirmed too", later instanceof CardSaveUnconfirmed, true);
    is("and its words say removed, not saved", [/removed/.test(later?.message ?? ""), /was saved/.test(later?.message ?? "")], [true, false]);
  }

  part("Control: a save not confirmed still says it was a save");
  {
    const error = await failure(() => saveCreatorCard(store.statsId!, card, store, null));
    is("the save is unconfirmed", error instanceof CardSaveUnconfirmed, true);
    is("and its words still say saved", /was saved/.test(error?.message ?? ""), true);
  }

  done();
}

void main().catch((error) => {
  console.error = globalThis.console.log;
  console.log(error);
  process.exit(1);
});
