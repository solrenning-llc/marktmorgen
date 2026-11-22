/** A data copy must prove the referenced gift belongs to its store and, for a received gift, its recipient. */
import { claimHandle, ensureListId, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { COPIERS } from "@/lib/person-copy";
import { erasureScope } from "@/lib/person-erasure";
import { importedKey } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const EMAIL = "recipient@example.test", OTHER = "other@example.test", ID = "gft_" + "a".repeat(24);
const SECRET = "Synthetic private message for another person";
const original = redis.pipeline.bind(redis);
let sessions: Record<string, unknown>[] = [];
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_copy_only";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", has_more: false, data: sessions }), { status: 200 })) as typeof fetch;
async function world(bought = false) {
  redis.clear(); sessions = [];
  await claimHandle("owner@example.test", "syntheticgiftcopy", "Synthetic store", "");
  await ensureStatsId("owner@example.test"); await ensureListId("owner@example.test");
  await setStripeAccount("owner@example.test", "acct_1SyntheticGift", true);
  const store = (await storeForEmail("owner@example.test"))!;
  const scope = (await erasureScope(store, EMAIL))!;
  if (bought) sessions = [{ id: "cs_test_" + "s".repeat(24), status: "complete", payment_status: "paid", payment_intent: "pi_synthetic", metadata: { store: store.handle, gift: ID, product: "prod000001" } }];
  else redis.run(["HSET", importedKey(store.statsId!, EMAIL), "prod000001", JSON.stringify({ at: 1_790_000_000, job: `gift:${ID}`, items: null })]);
  const gift = { id: ID, s: store.statsId!, p: "prod000001", to: bought ? OTHER : EMAIL, from: "Synthetic sender", message: SECRET, at: 1_790_000_000 };
  redis.run(["SET", `nl:gift:${ID}`, JSON.stringify(gift)]);
  return { scope, gift };
}
async function main() {
  for (const kind of ["received foreign store", "received wrong recipient", "bought foreign store", "malformed JSON", "wrong ID", "lost reply", "extra reply", "non-text reply"] as const) {
    part(kind);
    const w = await world(kind === "bought foreign store");
    if (kind.includes("foreign store")) w.gift.s = "different_store";
    if (kind === "received wrong recipient") w.gift.to = OTHER;
    if (kind === "wrong ID") w.gift.id = "gft_" + "b".repeat(24);
    redis.run(["SET", `nl:gift:${ID}`, kind === "malformed JSON" ? "not-json" : JSON.stringify(w.gift)]);
    let writes = 0;
    redis.pipeline = async commands => {
      writes += commands.filter(c => !["GET", "HGETALL"].includes(String(c[0]))).length;
      if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:gift:${ID}`) {
        if (kind === "lost reply") return [];
        if (kind === "extra reply") return [JSON.stringify(w.gift), null];
        if (kind === "non-text reply") return [42];
      }
      return original(commands);
    };
    let result: unknown;
    try { result = await COPIERS["lib/gifts.ts"](w.scope).catch(() => "unknown"); }
    finally { redis.pipeline = original; }
    is("the copy cannot certify unknown ownership or contents", result, "unknown");
    is("another person's private message is not returned", JSON.stringify(result).includes(SECRET), false);
    is("copy reads write nothing", writes, 0);
  }
  for (const bought of [false, true]) {
    part(bought ? "control: their purchased gift may name another recipient" : "control: their received gift");
    const w = await world(bought);
    const out = await COPIERS["lib/gifts.ts"](w.scope) as { message: string; youBought?: boolean; youReceived?: boolean; to?: string }[];
    is("the valid gift is included", out.length, 1);
    is("its intended message is included", out[0]?.message, SECRET);
    is("the correct relationship is stated", bought ? out[0]?.youBought : out[0]?.youReceived, true);
    is("only a purchaser's copy names the recipient", out[0]?.to, bought ? OTHER : undefined);
    redis.run(["DEL", `nl:gift:${ID}`]);
    is("confirmed expiry is an empty section", await COPIERS["lib/gifts.ts"](w.scope), []);
  }
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
