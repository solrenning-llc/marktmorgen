/**
 * Codex L-20261120-1034 (MEDIUM, erasure and personal data; #5010 row 27). The checkout's gift draft (lib/gifts.ts
 * startGift) was written with a plain SET on the Store the route read first. When the store's erasure began, or its
 * account moved, before that write, the draft came back anyway with the recipient's address, the giver's name and the
 * private message, kept GIFT_PENDING_SECONDS, and startGift said ok. It is now written through setWhileStoreLive
 * (lib/store-live-cache.ts): only while the store is still its own and not erasing, in one step; otherwise nothing is
 * kept and the checkout is refused as "unavailable". Synthetic store and Redis only; no checkout is made.
 */
import { ERASING_KEY, addProduct, claimHandle, ensureStatsId, ensureStoreId, erasingField, setProductLink, setStripeAccount, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { GIFT_PENDING_SECONDS } from "@/lib/gift-rules";
import { startGift } from "@/lib/gifts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_gifts_only_a_stand_in";

const OWNER = "gift-fence@example.com";
const INPUT = { to: "friend-fence@example.com", from: "Ana", message: "A private note" };

async function shop() {
  redis.clear();
  await claimHandle(OWNER, "giftfence", "Gift Fence", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGiftFence01", true);
  const made = await addProduct(OWNER, "Bread Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/bread");
  const store = (await storeForEmail(OWNER))!;
  return { store, product: (await readListing(store, made.product.id))! };
}

/** The keys of gift drafts now kept. */
const drafts = () => redis.keys().filter((key) => /^nl:gift:[^:]+$/.test(key));

async function main(): Promise<void> {
  part("A live store keeps its gift draft, as before (control)");
  {
    const { store, product } = await shop();
    const real = redis.pipeline.bind(redis);
    let commands = 0;
    redis.pipeline = (async (batch: (string | number)[][]) => {
      commands += batch.length;
      return real(batch);
    }) as typeof redis.pipeline;
    const started = await startGift(store, product, INPUT);
    redis.pipeline = real;
    is("it starts", started.ok, true);
    const key = started.ok ? `nl:gift:${started.gift.id}` : "";
    const ttl = Number((await redis.pipeline([["TTL", key]]))[0]);
    is("its draft is kept, for GIFT_PENDING_SECONDS", [drafts().length, ttl > GIFT_PENDING_SECONDS - 5 && ttl <= GIFT_PENDING_SECONDS], [1, true]);
    is("in one write: the fenced script, one pipeline command", commands, 1);
  }

  part("The store's erasure began before the draft is written");
  {
    const { store, product } = await shop();
    await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), "1"]]);
    const started = await startGift(store, product, INPUT);
    is("refused as unavailable", started.ok ? "started" : started.reason, "unavailable");
    is("and no draft with the address and the message is kept", drafts(), []);
  }

  part("The store's account moved before the draft is written");
  {
    const { store, product } = await shop();
    await redis.pipeline([["SET", storeIdCommand(store.sid)[1], "another-ref"]]);
    const started = await startGift(store, product, INPUT);
    is("refused as unavailable", started.ok ? "started" : started.reason, "unavailable");
    is("and nothing is kept", drafts(), []);
  }

  part("The store was erased: its id key is gone");
  {
    const { store, product } = await shop();
    await redis.pipeline([["DEL", storeIdCommand(store.sid)[1]]]);
    const started = await startGift(store, product, INPUT);
    is("refused as unavailable", started.ok ? "started" : started.reason, "unavailable");
    is("and nothing is kept", drafts(), []);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
