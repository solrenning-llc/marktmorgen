/**
 * Issue #4204 (Codex C2, MEDIUM; rule 24): GET /api/v1/events (the samples Zapier and other tools show a creator)
 * reads the deliveries the store's log names (lib/webhooks.ts recentMessagesOf). A delivery that was there but did
 * not read (its record not JSON, without its id or body, or its body not JSON) was skipped with `continue`, so the
 * answer was HTTP 200 with a shorter, or empty, history that looked complete. Now a delivery present but unreadable
 * makes the reading unavailable (DeliveriesUnreadable, HTTP 502), as a reading not answered exactly already is. A
 * delivery gone (expired), of another event, of another store, repeated, or given up with no message kept (body "",
 * as lib/webhooks.ts writes it) is still left out, as before.
 *
 * Synthetic store, key and Redis only.
 */
import { GET } from "@/app/api/v1/events/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const owner = "events-unreadable@example.test";

const record = (id: string, statsId: string, extra: Record<string, unknown>) =>
  JSON.stringify({ id, statsId, type: "sale.completed", eventId: `evt_${id}`, endpoint: "wh_x", attempts: 0, state: "queued", next: 0, lastStatus: 0, lastError: "", lastAt: 0, createdAt: Date.now(), ...extra });

/** A store whose log names a good delivery and, newest first, one more stored exactly as `raw` says. */
async function world(raw: ((statsId: string, id: string) => string) | null): Promise<() => Promise<{ status: number; data: unknown[] | null }>> {
  redis.clear();
  await claimHandle(owner, "events-unreadable", "Synthetic events", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_EvUnread1", subscriptionId: "sub_EvUnread1", active: true, tier: "scale", period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  const made = await makeKey(shop.sid, "Synthetic reader");
  if (!made.ok) throw new Error("no key");
  const good = "dlv_" + "a".repeat(24);
  await redis.pipeline([["SET", "nl:hooks:d:" + good, record(good, shop.statsId!, { body: JSON.stringify({ id: "evt_good", type: "sale.completed" }) })], ["LPUSH", "nl:hooks:log:" + shop.statsId, good]]);
  if (raw) {
    const other = "dlv_" + "b".repeat(24);
    await redis.pipeline([["SET", "nl:hooks:d:" + other, raw(shop.statsId!, other)], ["LPUSH", "nl:hooks:log:" + shop.statsId, other]]);
  }
  return async () => {
    const response = await GET(new Request("https://marktmorgen.com/api/v1/events?type=sale.completed&limit=3", { headers: { Authorization: "Bearer " + made.key } }));
    const json = (await response.json()) as { data?: unknown[] };
    return { status: response.status, data: json.data ?? null };
  };
}

async function main(): Promise<void> {
  part("Controls: what is left out as before");
  let read = await world(null);
  let got = await read();
  is("one delivery kept: sent", [got.status, got.data?.length], [200, 1]);
  read = await world((statsId, id) => record(id, statsId, { type: "refund.issued", body: JSON.stringify({ id: "evt_other" }) }));
  got = await read();
  is("a delivery of another event: left out", [got.status, got.data?.length], [200, 1]);
  read = await world((statsId, id) => record(id, "someone-else", { body: JSON.stringify({ id: "evt_theirs" }) }));
  got = await read();
  is("a delivery of another store: left out", [got.status, got.data?.length], [200, 1]);
  read = await world((statsId, id) => record(id, statsId, { body: "", state: "failed", givenUp: true }));
  got = await read();
  is("a delivery given up, its message not kept (body \"\"): left out", [got.status, got.data?.length], [200, 1]);

  part("A delivery there that does not read: unavailable, never a shorter history");
  for (const [label, raw] of [
    ["its record is not JSON", () => "{\"id\":\"dlv_trunc"],
    ["its record has no body", (statsId: string, id: string) => record(id, statsId, {})],
    ["its record has no id", (statsId: string, id: string) => {
      const value = JSON.parse(record(id, statsId, { body: "{}" })) as Record<string, unknown>;
      delete value.id;
      return JSON.stringify(value);
    }],
    ["its body is not JSON", (statsId: string, id: string) => record(id, statsId, { body: "{\"id\":\"evt_trunc" })],
  ] as [string, (statsId: string, id: string) => string][]) {
    read = await world(raw);
    got = await read();
    is(`${label}: 502`, got.status, 502);
  }

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
