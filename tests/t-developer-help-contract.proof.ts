import assert from "node:assert/strict";
import type { Product } from "@/lib/catalog";
import type { Store } from "@/lib/store";

type Metrics = { commands: number; cases: number; networkAttempts: number };
const metrics = (globalThis as typeof globalThis & { __tDeveloperHelp: Metrics }).__tDeveloperHelp;

async function healthyCase(name: string, run: () => Promise<void>): Promise<void> {
  assert.ok(++metrics.cases <= 12, "reserved case ceiling");
  await run();
  console.log(`PASS ${name}`);
}

async function main(): Promise<void> {
  // The runner blocks fetch and socket connections before these real modules initialize.
  const catalog = await import("@/lib/catalog");
  const contacts = await import("@/lib/contacts");
  const api = await import("@/lib/api-read");
  const fields = await import("@/lib/api-fields");
  const redis = await import("@/lib/redis");
  const at = "2026-11-06T12:00:00.000Z";
  const product = (id: string, hidden: boolean): Product => ({
    id, title: `Synthetic ${id}`, summary: "Synthetic contract fixture", priceCents: 0,
    createdAt: at, file: null, link: null, recurring: null, options: [], call: null,
    stock: null, bumps: [], funnel: null, plan: null, course: null, image: null,
    display: "button", fields: [], pwyw: null, about: false, keys: null, stamp: false,
    preview: 0, page: false, bundle: null, hidden,
  });
  const draft = product("draft0000001", true);
  const published = product("public000001", false);
  const store = {
    sid: "b".repeat(32), handle: "g6-synthetic", name: "Synthetic contract store", currency: "usd",
    domain: null, listId: "g6-synthetic-list",
    catalog: { id: "a".repeat(32), items: [draft, published].map((p) => ({ id: p.id, kind: p.hidden ? catalog.KIND.hidden : catalog.KIND.free, options: [] })), head: [], inline: null },
  } as unknown as Store;
  let productPage: Awaited<ReturnType<typeof api.products>>;
  await healthyCase("persisted product writer preserves draft, order and API row shape", async () => {
    for (const p of [draft, published]) await redis.redisPipeline(catalog.productWrites(store.catalog.id!, p));
    const restored = await catalog.readListings(store);
    assert.deepEqual(restored.map((p) => [p.id, p.hidden]), [[draft.id, true], [published.id, false]]);
    let reserved = 0;
    productPage = await api.products(store, null, async (units) => { assert.ok(units >= 0); reserved++; return null; });
    assert.ok(!(productPage instanceof Response));
    assert.equal(reserved, 1, "synthetic admission callback, not a financial approval");
    assert.deepEqual(productPage.data.map((p) => [p.id, p.hidden, p.kind, p.interval]), [[draft.id, true, "free", null], [published.id, false, "free", null]]);
    for (const row of productPage.data) assert.deepEqual(Object.keys(row), [...api.PRODUCT_FIELDS]);
    assert.equal(productPage.next, null);
  });
  await healthyCase("product projection keeps paging and selects documented fields", async () => {
    const response = fields.apiOkFields(new Request("https://synthetic.invalid/api/v1/products?fields=id,hidden"), productPage);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ id: draft.id, hidden: true }, { id: published.id, hidden: false }], next: null });
  });

  await healthyCase("real contact writer round-trips consent, products and UTC fields", async () => {
    // null is the writer's existing company-list mode; no store capacity/admission claim.
    const yes = await contacts.upsertContact(store.listId!, "YES@example.test", { agreed: true, explicit: true, source: "free", productId: published.id, title: published.title, at }, null);
    const no = await contacts.upsertContact(store.listId!, "no@example.test", { agreed: false, explicit: false, source: "buyer" }, null);
    assert.equal(yes.joined, true);
    assert.equal(no.joined, false);
    const [raw] = await redis.redisPipeline([["HGET", contacts.leadsKey(store.listId!), "yes@example.test"]]);
    const restored = contacts.parseContact(raw);
    assert.ok(restored);
    assert.equal(restored.agreedAt, at);
    assert.deepEqual(restored.ids, [published.id]);
    const page = await api.chargedLeads(store, null, false, async () => async () => null);
    assert.ok(!(page instanceof Response));
    assert.equal(page.data.length, 2);
    assert.equal(page.next, null);
    for (const row of page.data) assert.deepEqual(Object.keys(row), [...api.LEAD_FIELDS]);
    const yesRow = page.data.find((row) => row.email === "yes@example.test");
    assert.ok(yesRow);
    assert.equal(yesRow.agreed, true);
    assert.equal(yesRow.agreed_at, at);
    assert.equal(yesRow.unsubscribed, false);
    assert.deepEqual(yesRow.product_ids, [published.id]);
    for (const field of ["first_at", "last_at"]) {
      const value: unknown = yesRow[field];
      assert.equal(typeof value, "string");
      assert.equal(new Date(value as string).toISOString(), value);
    }
  });
  await healthyCase("agreed lead filter and projection retain a healthy terminal cursor", async () => {
    const page = await api.chargedLeads(store, null, true, async () => async () => null);
    assert.ok(!(page instanceof Response));
    const response = fields.apiOkFields(new Request("https://synthetic.invalid/api/v1/leads?fields=email,agreed"), page);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ email: "yes@example.test", agreed: true }], next: null });
  });
  assert.equal(metrics.networkAttempts, 0);
  assert.ok(metrics.commands <= 5_000);
  console.log(JSON.stringify({ healthyCases: metrics.cases, syntheticCommands: metrics.commands, networkAttempts: metrics.networkAttempts, externalHttp: 0, providerCalls: 0 }));
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
