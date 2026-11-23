/** Synthetic mismatched kept records: identity must match the field that was read. */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { contactFor, decideLeads, forgetLeadPerson, leadId, leadOf, readLeads } from "@/lib/affiliate-leads";
import { leadsKey, type LeadRecord } from "@/lib/affiliate-lead-rules";
import { COPIERS } from "@/lib/person-copy";
import { UnknownReplyError } from "@/lib/redis-reply";
import { idleSweep, readBook } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
const A = "ana.identity@example.test", B = "ben.identity@example.test";
const owner = "lead-identity-owner@example.test";
const NOW = Math.floor(Date.now() / 1000);
const original = redis.pipeline.bind(redis);
let store: Store, key: string, aid: string, bid: string;
const copier = COPIERS["lib/affiliate-leads.ts"];
const scope = (email: string) => ({ store, email }) as unknown as Parameters<typeof copier>[0];

beforeEach(async () => {
  redis.pipeline = original;
  redis.clear();
  await claimHandle(owner, "leadidentity", "Lead Identity", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_LeadIdentity", subscriptionId: "sub_LeadIdentity", active: true, tier: "creator", period: paidPeriod() });
  store = (await storeForEmail(owner))!;
  key = leadsKey(store.statsId!);
  aid = leadId(store.statsId!, A);
  bid = leadId(store.statsId!, B);
});

const lead = (over: Partial<LeadRecord> = {}): LeadRecord => ({
  id: aid, aff: "aaaaaaaaaaaa", kind: "signup", at: NOW - 86_400,
  end: 0, ref: "", pi: "", paid: 0, title: "", email: A, cents: 500,
  currency: "usd", hold: 0, daily: 10, budget: 10_000, state: "open", d: 0, why: "", ...over,
});
const put = async (value: LeadRecord) => { await original([["HSET", key, aid, JSON.stringify(value)]]); };
const raw = async () => (await original([["HGET", key, aid]]))[0];

test("control: matching identity is read, copied, approved and anonymised", async () => {
  await put(lead());
  assert.equal((await leadOf(store, A))?.id, aid);
  assert.equal((await leadOf(store, "Ana.Identity@Example.test"))?.id, aid);
  assert.equal((await readLeads(store)).length, 1);
  assert.equal((await copier(scope(A)) as LeadRecord[])[0].email, A);
  assert.deepEqual(await decideLeads(store, [aid], "approve"), { ok: true, changed: 1 });
  assert.equal(await forgetLeadPerson(store, A), 1);
  assert.equal((await leadOf(store, A))?.email, "");
  assert.deepEqual(await copier(scope(A)), []);
  assert.equal((await readLeads(store))[0].state, "approved");
});

test("a whole-program read rejects a record whose id differs from its hash field", async () => {
  await put(lead({ id: bid }));
  await assert.rejects(() => readLeads(store), UnknownReplyError);
});

test("the payable book rejects a lead whose id differs from its hash field", async () => {
  await put(lead({ id: bid }));
  await assert.rejects(() => readBook(store), UnknownReplyError);
});

test("the idle sweep rejects the same inconsistent lead before judging what is owed", async () => {
  await put(lead({ id: bid }));
  const enabled = { ...store, affiliates: { ...store.affiliates, enabled: true, idle: 90, recurring: 0 } } as Store;
  await assert.rejects(() => idleSweep(enabled), UnknownReplyError);
});

test("a decision cannot write a second field from an id read under another field", async () => {
  const kept = lead({ id: bid });
  await put(kept);
  await assert.rejects(() => decideLeads(store, [bid], "approve"), UnknownReplyError);
  assert.equal((await original([["HGET", key, bid]]))[0], null);
  assert.equal(await raw(), JSON.stringify(kept));
});

test("the person's reader rejects another embedded id even with their email", async () => {
  await put(lead({ id: bid }));
  await assert.rejects(() => leadOf(store, A), UnknownReplyError);
});

test("the person's reader rejects another person's email even with the expected id", async () => {
  await put(lead({ email: B }));
  await assert.rejects(() => leadOf(store, A), UnknownReplyError);
});

test("the person's copier fails instead of claiming their inconsistent lead is absent", async () => {
  await put(lead({ email: B }));
  await assert.rejects(() => copier(scope(A)), UnknownReplyError);
});

test("erasure refuses an inconsistent id without rewriting it", async () => {
  const kept = lead({ id: bid });
  await put(kept);
  await assert.rejects(() => forgetLeadPerson(store, A), UnknownReplyError);
  assert.equal(await raw(), JSON.stringify(kept));
});

test("erasure refuses another person's email without changing that record", async () => {
  const kept = lead({ email: B });
  await put(kept);
  await assert.rejects(() => forgetLeadPerson(store, A), UnknownReplyError);
  assert.equal(await raw(), JSON.stringify(kept));
});

test("contact credit rejects a record whose id is not the field read for this buyer", async () => {
  await put(lead({ id: bid }));
  const credited = { ...store, affiliates: { ...store.affiliates, enabled: true, contacts: true, lead: { kind: "signup", cents: 500, hold: 0, daily: 10, budget: 10_000 } } } as Store;
  // main's contactFor throws on a lead that does not read exactly, never takes it for "no lead" (Claude 6 on #4413): the
  // checkout sweep leaves the order for its next run instead of settling it with no credit. So does this one.
  await assert.rejects(contactFor(credited, A, NOW), UnknownReplyError);
});

test("control: exact nil is absent and an already anonymised matching lead stays usable", async () => {
  assert.equal(await leadOf(store, A), null);
  await put(lead({ email: "" }));
  assert.equal((await leadOf(store, A))?.id, aid);
  assert.equal(await forgetLeadPerson(store, A), 0);
  assert.equal((await readLeads(store))[0].id, aid);
});
