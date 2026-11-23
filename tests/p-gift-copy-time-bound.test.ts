/**
 * Claude 5 ibuF's LOW on #5198: a gift read for the person's copy (lib/person-copy.ts giftForCopy) bounds its times as
 * groupForCopy does. A time past the largest date JavaScript can write is an unknown copy (UnknownReplyError), never a
 * RangeError from iso() and never a wrong date; the largest date it can write is still copied. Synthetic store only.
 */
import { claimHandle, ensureListId, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { COPIERS } from "@/lib/person-copy";
import { erasureScope } from "@/lib/person-erasure";
import { importedKey } from "@/lib/imported-purchases";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const EMAIL = "recipient@example.test", ID = "gft_" + "c".repeat(24);
const LATEST = 8_640_000_000_000;
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_copy_only";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", has_more: false, data: [] }), { status: 200 })) as typeof fetch;

async function copyWith(times: Record<string, number>): Promise<unknown> {
  redis.clear();
  await claimHandle("owner@example.test", "syntheticgifttime", "Synthetic store", "");
  await ensureStatsId("owner@example.test"); await ensureListId("owner@example.test");
  await setStripeAccount("owner@example.test", "acct_1SyntheticTime", true);
  const store = (await storeForEmail("owner@example.test"))!;
  const scope = (await erasureScope(store, EMAIL))!;
  redis.run(["HSET", importedKey(store.statsId!, EMAIL), "prod000001", JSON.stringify({ at: 1_790_000_000, job: `gift:${ID}`, items: null })]);
  const gift = { id: ID, s: store.statsId!, p: "prod000001", to: EMAIL, from: "Synthetic sender", message: "Synthetic message", at: 1_790_000_000, ...times };
  redis.run(["SET", `nl:gift:${ID}`, JSON.stringify(gift)]);
  try {
    return await COPIERS["lib/gifts.ts"](scope);
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other error: ${(error as Error).name}`;
  }
}

async function main() {
  for (const field of ["at", "given", "revoked"] as const) {
    part(`a gift whose ${field} is past the latest date`);
    is("the copy is unknown, not a RangeError", await copyWith({ [field]: LATEST + 1 }), "unknown");
  }
  part("control: the latest date is still copied");
  const out = await copyWith({ given: LATEST }) as { given?: string }[];
  is("the gift is copied with that date", Array.isArray(out) ? out[0]?.given : out, new Date(LATEST * 1000).toISOString());
  done();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
