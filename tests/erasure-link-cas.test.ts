/**
 * Two presses of the same erasure link (Codex L, issue #4281, LOW). confirmErasure read the grant once, erased store
 * by store, and then wrote what was left with an unconditional SET for at least 60 seconds, and deleted the key with
 * an unconditional DEL. A press that finished and deleted the link in another tab was undone: the used link worked
 * again for the stores the slower press left, and an expiring link lived on for a minute more. What is left is now
 * written only while the link still holds what this press read, keeping its own expiry, and the link is deleted
 * under the same check. Synthetic in-memory Redis only.
 */
import { createHash } from "node:crypto";
import { confirmErasure } from "@/lib/erasure-request";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const token = "c".repeat(64);
const key = `nl:erase:link:${createHash("sha256").update(`nimbus-erase-link:${token}`).digest("hex").slice(0, 40)}`;
const email = "two-presses@example.com";
const GONE_STORE = "f".repeat(32);
const original = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  redis.clear();
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }))) as typeof fetch;
  process.env.RESEND_API_KEY = "re_test_erasure_link_only";
  const owner = "two-presses-owner@example.com";
  await claimHandle(owner, "twopresses", "Two Presses", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_two_presses", subscriptionId: "sub_two_presses", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  // One store that erases, one that cannot be reached, so this press leaves it to do.
  const grant = JSON.stringify({ e: email, s: [store.sid, GONE_STORE] });

  part("Another press finished and deleted the link while this one ran");
  await upsertContact(store.listId!, email, { agreed: true, explicit: true, source: "free" }, ROOM);
  await original([["SET", key, grant, "EX", 3600]]);
  let raced = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // Just before this press writes what is left, the other press deletes the link.
    if (!raced && commands.some((c) => c.includes(key) && c[0] !== "GET" && c[0] !== "TTL")) {
      raced = true;
      await original([["DEL", key]]);
    }
    return original(commands);
  }) as typeof redis.pipeline;
  let result;
  try {
    result = await confirmErasure(token);
  } finally {
    redis.pipeline = original;
  }
  is("(setup) the other press landed before this one's write", raced, true);
  is("the used link is not written back", redis.run(["GET", key]), null);
  is("and this press does not say there is more to do on it", result.state === "more", false);

  part("A press with stores left keeps the link's own expiry, never stretching it");
  await upsertContact(store.listId!, email, { agreed: true, explicit: true, source: "free" }, ROOM);
  await original([["SET", key, grant, "EX", 10]]);
  const left = await confirmErasure(token);
  is("the store it could not reach is still to do", [left.state, left.later], ["more", [GONE_STORE]]);
  is("written with what is left", redis.run(["GET", key]), JSON.stringify({ e: email, s: [GONE_STORE] }));
  const ttl = Number(redis.run(["TTL", key]));
  is("within the 10 seconds it had, not 60", ttl > 0 && ttl <= 10, true);
  done();
}

void main();
