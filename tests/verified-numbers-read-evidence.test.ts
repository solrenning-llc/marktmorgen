import { readVerified, verifiedFrom, type Verified } from "@/lib/verified-numbers";
import type { StatsData } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const now = Date.UTC(2026, 10, 5, 12);
const statsId = "b".repeat(32);
const key = `nl:verified:${statsId}`;
const owner = { statsId };
const window = { visitors: 12, views: 20, checkouts: 4, sales: 2, cents: 500 };
const data = {
  currency: "usd", sales: "ok",
  totals: { d7: window, d30: window, d90: window },
  channels: { d30: [{ source: "direct", visits: 12, sales: 2, cents: 500 }] },
  products: [{ id: "guide", title: "A guide", d30: { sales: 2, cents: 500 } }],
  salesCountries: { d90: [{ country: "US", sales: 1 }, { country: "GB", sales: 1 }] },
} as unknown as StatsData;
const known = verifiedFrom(data, new Map(), now);
const unavailable = verifiedFrom({ ...data, sales: "error" }, new Map(), now);
const pipeline = redis.pipeline.bind(redis);
let override: unknown[] | null = null;
let reads = 0;
redis.pipeline = async commands => {
  if (commands[0]?.[0] === "GET" && commands[0]?.[1] === key) {
    reads++;
    if (override) return override;
  }
  return pipeline(commands);
};
let network = 0;
globalThis.fetch = async () => { network++; throw new Error("A stored reading must not contact a provider"); };

async function roundtrip(value: unknown): Promise<Verified | null> {
  override = null;
  await pipeline([["SET", key, JSON.stringify(value)]]);
  return readVerified(owner);
}

function changed(path: string, value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(known)) as Record<string, unknown>;
  const parts = path.split(".");
  let parent = copy;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  if (value === undefined) delete parent[parts.at(-1)!];
  else parent[parts.at(-1)!] = value;
  return copy;
}

async function main() {
  redis.clear();
  part("The producer's complete known and unknown-sales records remain readable");
  is("known stored figures roundtrip unchanged", await roundtrip(known), known);
  is("a producer currency in uppercase remains unchanged", await roundtrip({ ...known, currency: "USD" }), { ...known, currency: "USD" });
  is("unknown sales remain explicit nulls without products or countries", await roundtrip(unavailable), unavailable);
  const zero = verifiedFrom({ ...data, totals: { d7: { ...window, visitors: 0, views: 0, checkouts: 0, sales: 0, cents: 0 }, d30: { ...window, visitors: 0, views: 0, checkouts: 0, sales: 0, cents: 0 }, d90: { ...window, visitors: 0, views: 0, checkouts: 0, sales: 0, cents: 0 }, all: window }, channels: { d7: [], d30: [], d90: [] }, products: [], salesCountries: { d7: [], d30: [], d90: [] } }, new Map(), now);
  is("confirmed zero is not confused with an unknown record", await roundtrip(zero), zero);

  part("Partial paid readings cannot become confirmed shared totals");
  const partial = verifiedFrom({ ...data, partial: true }, new Map(), now);
  is("partial producer does not certify sales", partial.salesRead, false);
  is("partial producer keeps sales unknown", partial.windows.d30.sales, null);
  is("partial producer keeps revenue unknown", partial.windows.d30.cents, null);
  is("partial producer does not share product totals", partial.products, []);
  is("partial producer does not share country totals", partial.countries, []);
  is("the actual stored reader preserves unavailable paid coverage", (await roundtrip(partial))?.salesRead, false);
  is("confirmed traffic remains available in a partial paid reading", partial.windows.d30.visitors, window.visitors);
  is("new producer records identify the coverage-aware contract", (known as unknown as Record<string, unknown>).coverageVersion, 1);
  is("a legacy snapshot without coverage provenance remains unavailable", await roundtrip(changed("coverageVersion", undefined)), null);

  part("A partial JSON object cannot certify any shared numbers");
  for (const field of ["day", "at", "currency", "salesRead", "windows", "channels", "products", "countries", "windows.d7", "windows.d90", "windows.d30.sales", "windows.d30.visitors"]) {
    is("missing " + field + " is unavailable", await roundtrip(changed(field, undefined)), null);
  }
  for (const value of [false, [], "known", 1]) {
    is("unknown d30 shape is unavailable: " + JSON.stringify(value), await roundtrip(changed("windows.d30", value)), null);
  }
  const invalid: [string, unknown][] = [
    ["day", "2026-02-30"], ["day", "not a day"], ["day", "2026-11-04"],
    ["at", -1], ["at", 1.5], ["at", Number.MAX_SAFE_INTEGER], ["at", String(known.at)],
    ["currency", null], ["currency", "not-money"], ["salesRead", "true"],
    ["windows.d7.visitors", -1], ["windows.d7.views", 1.5], ["windows.d30.checkouts", Number.MAX_SAFE_INTEGER + 1],
    ["windows.d30.sales", null], ["windows.d30.sales", "2"], ["windows.d90.cents", -1], ["windows.d90.cents", null],
    ["channels", null], ["channels", [null]], ["channels.0.visits", "12"], ["channels.0.sales", null], ["channels.0.cents", 1.5], ["channels.0.source", null],
    ["products", false], ["products", [{}]], ["products.0.title", null], ["products.0.cents", Number.MAX_SAFE_INTEGER + 1],
    ["countries", {}], ["countries", [null]], ["countries.0.country", null], ["countries.0.share", -0.1], ["countries.0.share", 1.1], ["countries.0.share", "0.5"],
    ["salesRead", false], ["windows", { d30: true }],
  ];
  for (const [path, value] of invalid) is("unknown " + path + " stays unavailable: " + JSON.stringify(value), await roundtrip(changed(path, value)), null);
  for (const [path, value] of [["windows.d30.sales", 1], ["channels.0.cents", 500], ["products", known.products], ["countries", known.countries]] as [string, unknown][]) {
    const copy = JSON.parse(JSON.stringify(unavailable)) as Record<string, unknown>;
    const parts = path.split(".");
    let parent = copy;
    for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
    parent[parts.at(-1)!] = value;
    is("sales not read cannot carry known " + path, await roundtrip(copy), null);
  }
  for (const raw of [
    JSON.stringify(known).replace('"salesRead":true', '"salesRead":false,"salesRead":true'),
    JSON.stringify(known).replace('"sales":2', '"sales":null,"sales":2'),
  ]) {
    override = null;
    await pipeline([["SET", key, raw]]);
    is("conflicting duplicate JSON members remain unavailable", await readVerified(owner), null);
  }

  part("The actual GET requires one own inert reply");
  for (const reply of [[], [JSON.stringify(known), null], [undefined], [{ day: known.day, windows: known.windows }]]) {
    override = reply;
    is("unknown GET envelope is unavailable: " + JSON.stringify(reply), await readVerified(owner), null);
  }
  let getters = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", { get() { getters++; return JSON.stringify(known); } });
  override = accessor;
  is("accessor GET reply is unavailable", await readVerified(owner), null);
  is("no GET accessor ran", getters, 0);
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: JSON.stringify(known) }));
  override = inherited;
  is("inherited GET reply is unavailable", await readVerified(owner), null);
  let traps = 0;
  let transportThenReads = 0;
  override = new Proxy([JSON.stringify(known)], {
    get(target, field, receiver) {
      if (field === "then") { transportThenReads++; return undefined; }
      traps++;
      return Reflect.get(target, field, receiver);
    },
    getOwnPropertyDescriptor(target, field) { traps++; return Reflect.getOwnPropertyDescriptor(target, field); },
  });
  is("executable GET response remains unavailable", await readVerified(owner), null);
  is("no consumer response trap ran", traps, 0);
  is("the async transport's Promise probe is explicitly accounted for", transportThenReads, 1);
  override = null;
  await pipeline([["DEL", key]]);
  is("a confirmed absent copy remains unavailable", await readVerified(owner), null);
  const before = reads;
  is("a store without a numbers id makes no read", await readVerified({ statsId: null }), null);
  is("no read without an id", reads, before);
  is("no provider was contacted for a malformed copy", network, 0);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
