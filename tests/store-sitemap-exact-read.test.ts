/** HTTP consumer proof only. Catalogue parsing remains owned by C4/#2909. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { addProduct, claimHandle, ensureStatsId, storeForEmail, type Store } from "../lib/store";
import { productWrites } from "../lib/catalog";
import { GET } from "../app/[handle]/store-sitemap/route";
import { store as redis } from "./redis-stub";

// Own-file aliases isolate only the HTTP lookup and pre-admitted public budget.
// All writers, catalogue reads, sitemap construction, serialization and GET code remain real.
export * from "../lib/store";
export * from "../lib/traffic";

redis.clear();
const catalogId = "a".repeat(32);
let admissions = 0;
const fixture: Promise<Store> = (async () => {
  const owner = "sitemap-route-proof@example.test";
  assert.equal((await claimHandle(owner, "sitemaprouteproof", "Fictional map", "Synthetic evidence.")).ok, true);
  await ensureStatsId(owner);
  const first = await addProduct(owner, "Fictional first guide", "", "12", null);
  const second = await addProduct(owner, "Fictional second guide", "", "12", null);
  assert.ok(first.ok && second.ok);
  const shop = await storeForEmail(owner);
  assert.ok(shop);
  await redis.pipeline([...productWrites(catalogId, first.product), ...productWrites(catalogId, second.product)]);
  return { ...shop, catalog: { ...shop.catalog, id: catalogId, head: [], inline: null } };
})();

export async function storeForPage(handle: string): Promise<Store | null> {
  return handle === "sitemaprouteproof" ? fixture : null;
}

export async function takePublicRequest(_store: Store, kind: string, now: number, units: number): Promise<boolean> {
  assert.equal(kind, "public");
  assert.ok(Number.isFinite(now));
  assert.ok(Number.isSafeInteger(units) && units > 0);
  admissions++;
  return true; // Synthetic admission, never financial or production authorization.
}

type Mode = "healthy" | "known-null" | "missing-envelope" | "partial-envelope" | "extra-envelope" | "malformed-record" | "transport-error";
const listingReads = (commands: Parameters<typeof redis.pipeline>[0]) =>
  commands.length === 2 && commands.every(c => c[0] === "GET" && String(c[1]).startsWith(`nl:catalog:${catalogId}:l:`));

async function responseFor(mode: Mode, context: TestContext): Promise<Response> {
  await fixture;
  const original = redis.pipeline;
  const before = admissions;
  let intercepted = 0;
  redis.pipeline = async commands => {
    if (!listingReads(commands)) return original.call(redis, commands);
    intercepted++;
    if (mode === "transport-error") throw new Error("Synthetic catalogue transport failure");
    const reply = await original.call(redis, commands);
    if (mode === "missing-envelope") return [];
    if (mode === "partial-envelope") return reply.slice(0, 1);
    if (mode === "extra-envelope") return [...reply, null];
    if (mode === "malformed-record") return [reply[0], "{"];
    if (mode === "known-null") return [reply[0], null];
    return reply;
  };
  try {
    try {
      const response = await GET(new Request("https://synthetic.invalid/@sitemaprouteproof/sitemap.xml"), { params: Promise.resolve({ handle: "@sitemaprouteproof" }) });
      context.diagnostic(JSON.stringify({ mode, outcome: "response", status: response.status }));
      return response;
    } catch (error) {
      context.diagnostic(JSON.stringify({ mode, outcome: "threw", name: error instanceof Error ? error.name : typeof error }));
      throw error;
    }
  } finally {
    redis.pipeline = original;
    assert.equal(admissions - before, 1, "the route passed the synthetic admission");
    assert.equal(intercepted, 1, "the route actually reached the external catalogue read");
  }
}

test("healthy real HTTP sitemap returns both products as cacheable XML", async context => {
  const response = await responseFor("healthy", context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /application\/xml/);
  assert.match(response.headers.get("Cache-Control") ?? "", /s-maxage=3600/);
  const xml = await response.text();
  assert.match(xml, /fictional-first-guide/);
  assert.match(xml, /fictional-second-guide/);
});

test("an explicit catalogue GET null remains omitted from a successful HTTP sitemap", async context => {
  const response = await responseFor("known-null", context);
  assert.equal(response.status, 200);
  const xml = await response.text();
  assert.match(xml, /fictional-first-guide/);
  assert.doesNotMatch(xml, /fictional-second-guide/);
});

for (const mode of ["missing-envelope", "partial-envelope", "extra-envelope", "malformed-record", "transport-error"] as const) {
  test(`real HTTP sitemap returns a non-cacheable 503 for ${mode}`, async context => {
    const response = await responseFor(mode, context);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Retry-After"), "3600");
    assert.match(response.headers.get("Content-Type") ?? "", /text\/plain/);
    assert.doesNotMatch(await response.text(), /<urlset|<loc>/);
  });
}
