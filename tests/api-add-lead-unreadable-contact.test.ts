/**
 * Defect #4205: an address whose kept row on the list does not read as a
 * contact (a truncated write, say) is unknown, never absent. Adding it through
 * the API with `agreed: true` must not write a new consented contact over it:
 * the row, the counters and the API requests stay as they were, and the
 * answer is "unavailable". The import and its dry run read rows the same way
 * (lib/contacts.ts, importContactRows and previewContactRows) and refuse too.
 * A readable new address is still added. Synthetic data, in-memory Redis.
 */
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { agreedKey, importContactRows, leadsKey, parseContact, previewContactRows } from "@/lib/contacts";
import { POST as postLead } from "@/app/api/v1/leads/route";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => {
  throw new Error("No outside requests in this test");
}) as typeof fetch;

const call = async (key: string, body: unknown) => {
  const response = await postLead(
    new Request("https://marktmorgen.com/api/v1/leads", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  );
  return { status: response.status, json: (await response.json()) as { error?: string; data?: Record<string, unknown> } };
};

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "unreadable-lead@example.com";
  await claimHandle(OWNER, "unreadable-lead", "Unreadable Lead Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Unread0001", subscriptionId: "sub_Unread0001", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId!;
  const writer = await makeKey(store.sid!, "Writer", Date.now(), true);
  if (!writer.ok) throw new Error("no key");

  const address = "cal@example.com";
  const unreadable = '{"agreed":false,"unsub":true,"unsubAt":"2026-11-01T00:00:00.000Z","t":"tok';
  await redis.pipeline([["HSET", leadsKey(listId), address, unreadable]]);
  const read = async () => (await redis.pipeline([["HGET", leadsKey(listId), address], ["GET", agreedKey(listId)], ["HLEN", leadsKey(listId)]])) as unknown[];
  const before = await read();
  const usedBefore = await allowanceUsed(store, "api");

  part("The API: an unreadable row is not written over");
  const answer = await call(writer.key, { email: address, agreed: true });
  is("refused as unavailable, never added", [answer.status >= 500, answer.json.error, answer.json.data], [true, "unavailable", undefined]);
  is("the row, the agreed counter and the list's size are as they were", await read(), before);
  // The request itself is counted at the door (lib/api-guard.ts), as every refused request is; a write's units are not.
  is("only the request itself counted, never a write's units", (await allowanceUsed(store, "api")) - usedBefore <= 1, true);

  part("The import and its dry run read the row the same way");
  let imported = "returned";
  try {
    await importContactRows(listId, [{ email: address, name: "", tags: [] }], store);
  } catch {
    imported = "threw";
  }
  is("the import refuses, nothing written", [imported, await read()], ["threw", before]);
  let previewed = "returned";
  try {
    await previewContactRows(listId, [{ email: address, name: "", tags: [] }]);
  } catch {
    previewed = "threw";
  }
  is("the dry run does not call it a new address", previewed, "threw");

  part("Control: a readable new address is still added");
  const fresh = await call(writer.key, { email: "dee@example.com", agreed: true });
  is("added", [fresh.status, fresh.json.data], [200, { email: "dee@example.com", status: "added" }]);
  const [kept] = (await redis.pipeline([["HGET", leadsKey(listId), "dee@example.com"]])) as unknown[];
  is("agreeing", parseContact(kept)?.agreed, true);
  done();
}

void main();
