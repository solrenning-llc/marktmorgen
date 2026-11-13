/**
 * #3946 (Codex L, hidden): erasePerson runs its destructive erasers although the
 * suppression write (ERASED_PRINT) answered with no confirmed HSET reply.
 * Synthetic only: the in-memory Redis stand-in.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { suppressedKey } from "@/lib/suppression";
import { erasePerson } from "@/lib/person-erasure";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "fence-owner@example.com";
const PERSON = "fence-person@example.com";
const original = redis.pipeline.bind(redis);
const isPrint = (commands: (string | number)[][]) =>
  commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:erased-print:v1");

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_zz_3946_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_zz_3946_only_a_stand_in";
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;
  await claimHandle(OWNER, "fenceshop", "Fence Shop", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_zz3946", subscriptionId: "sub_zz3946", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  for (const [name, reply] of [["empty pipeline answer", []], ["undefined reply", [undefined]], ["null reply", [null]], ["string reply", ["0"]], ["extra reply", [1, 1]]] as [string, unknown[]][]) {
    part(name);
    await upsertContact(store.listId!, PERSON, { agreed: true, explicit: true, source: "free" }, ROOM);
    let intercepted = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (isPrint(commands)) {
        intercepted += 1;
        return reply; // the write is NOT applied
      }
      return original(commands);
    }) as typeof redis.pipeline;
    let result: { ok: boolean } | "threw";
    try {
      result = await erasePerson(store, PERSON, { kind: "team", who: OWNER, role: "owner" });
    } catch {
      result = "threw";
    } finally {
      redis.pipeline = original;
    }
    is("the print command was intercepted", intercepted, 1);
    is("no print was written", redis.run(["HLEN", suppressedKey(store.listId!)]), 0);
    is("erasure does not report success", result !== "threw" && result.ok === true, false);
    is("the contact is kept for a retry (no eraser ran)", typeof redis.run(["HGET", leadsKey(store.listId!), PERSON]), "string");
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
