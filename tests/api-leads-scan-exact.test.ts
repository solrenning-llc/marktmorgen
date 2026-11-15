/**
 * Rule 24 (CX-123), MR inventory: a page of the creator's list read through
 * the API (GET /api/v1/leads, lib/api-read.ts scanLeads) answers in HSCAN's
 * exact shape, [cursor, [field, value, ...]], or it is unknown. A page in any
 * other shape was read as "no rows and no next page", so a developer's sync
 * stopped there and took a part of the list for all of it. Now the read
 * throws and the route answers 502 "unavailable"; a confirmed empty list and a
 * healthy page are unchanged. Synthetic data only; only the HSCAN reply is
 * replaced.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GET } from "@/app/api/v1/leads/route";
import { makeKey } from "@/lib/api-keys";
import { leads } from "@/lib/api-read";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let injected: unknown[] | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (injected && batch.some((c) => c[0] === "HSCAN")) return injected;
  return real(batch);
}) as typeof redis.pipeline;

const OWNER = "leads-scan-exact@example.com";
const lead = (agreed: boolean) => JSON.stringify({ agreed, agreedAt: "2026-09-12T14:03:22.000Z", firstAt: "", lastAt: "", titles: [], ids: [], source: "free", unsub: false, unsubAt: "", t: "f".repeat(40), name: "Synthetic Person", tags: [], importedAt: "" });

const fixture = (async () => {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "leads-scan-exact", "Leads Scan Exact", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_LeadsScan1", subscriptionId: "sub_LeadsScan1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await ensureListId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  await real([["HSET", `nl:store:leads:${store.listId}`, "one@example.com", lead(true), "two@example.com", lead(false)]]);
  const key = await makeKey(store.sid, "Synthetic reader");
  if (!key.ok) throw new Error("no key");
  const get = async (path: string) => {
    const r = await GET(new Request(`https://marktmorgen.com${path}`, { headers: { Authorization: `Bearer ${key.key}` } }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { store, get };
})();

const row = lead(true);
const MALFORMED: [string, unknown[]][] = [
  ["no reply at all", []],
  ["a null reply", [null]],
  ["a number for the page", [7]],
  ["the cursor alone", [["0"]]],
  ["three parts", [["0", [], "x"]]],
  ["rows that are not a list", [["0", "rows"]]],
  ["rows as null", [["0", null]]],
  ["an odd row list", [["0", ["one@example.com", row, "two@example.com"]]]],
  ["a row that is not text", [["0", ["one@example.com", 5]]]],
  ["a field that is not text", [["0", [5, row]]]],
  ["a cursor that is not a number", [["next", ["one@example.com", row]]]],
  ["a cursor that is null", [[null, ["one@example.com", row]]]],
];

for (const [label, reply] of MALFORMED) {
  test(`leads: ${label} is unknown, never the end of the list`, async () => {
    const { store } = await fixture;
    injected = reply;
    try {
      await assert.rejects(() => leads(store, null, false), (error: unknown) => error instanceof UnknownReplyError);
      await assert.rejects(() => leads(store, "1234", true), (error: unknown) => error instanceof UnknownReplyError);
    } finally {
      injected = null;
    }
  });

  test(`GET /api/v1/leads: ${label} answers 502 unavailable, never an empty or last page`, async () => {
    const { get } = await fixture;
    injected = reply;
    try {
      const r = await get("/api/v1/leads");
      assert.equal(r.status, 502);
      assert.equal(r.body.error, "unavailable");
      assert.equal("data" in r.body, false);
    } finally {
      injected = null;
    }
  });
}

test("healthy control: the whole list in one page, then the end", async () => {
  const { store, get } = await fixture;
  const page = await leads(store, null, false);
  assert.deepEqual(page.data.map((r) => r.email).sort(), ["one@example.com", "two@example.com"]);
  assert.equal(page.next, null);
  const agreed = await leads(store, null, true);
  assert.deepEqual(agreed.data.map((r) => r.email), ["one@example.com"]);
  const r = await get("/api/v1/leads");
  assert.equal(r.status, 200);
  assert.equal((r.body.data as unknown[]).length, 2);
});

test("healthy control: a page with a next cursor keeps it, as text or as Redis's number", async () => {
  const { store } = await fixture;
  injected = [["4096", ["one@example.com", row]]];
  try {
    const page = await leads(store, null, false);
    assert.deepEqual(page.data.map((r) => r.email), ["one@example.com"]);
    assert.equal(page.next, "4096");
  } finally {
    injected = null;
  }
  injected = [[4096, ["one@example.com", row]]];
  try {
    assert.equal((await leads(store, null, false)).next, "4096");
  } finally {
    injected = null;
  }
});

test("confirmed absence: an empty list, and a store without a list, stay empty", async () => {
  const { store } = await fixture;
  const empty = await leads({ ...store, listId: "synthetic-empty-list" } as Store, null, false);
  assert.deepEqual(empty, { data: [], next: null });
  injected = [["0", []]];
  try {
    assert.deepEqual(await leads(store, null, false), { data: [], next: null });
  } finally {
    injected = null;
  }
  assert.deepEqual(await leads({ ...store, listId: undefined } as unknown as Store, null, false), { data: [], next: null });
});
