/**
 * #4108: a store that never proved a custom domain could keep its real owner out for good. connectDomain answered
 * "taken" to the owner while another store's unproven "?<handle>" claim sat on the key, and the claim weighed the
 * same as a proven one in proveDomain. An unproven claim serves nothing, so it must not keep out the store that
 * proves the domain: the TXT record (proofRecord, made from the store's own id) wins over it. A proven holder still
 * keeps its domain, and a store without the record still gets nothing. Synthetic only: resolveTxt and Vercel are
 * stand-ins; nothing real is asked.
 */
import dns from "node:dns/promises";
import { connectDomain, domainKey, proofRecord } from "@/lib/domains";
import { proveDomain } from "@/lib/domain-proof";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.VERCEL_API_TOKEN = "test-token";
process.env.VERCEL_PROJECT_ID = "prj_test4108";

const owner = { sid: "s4108owner00000000000000000000001", handle: "realowner", previousHandles: [] as string[] };
const squatter = { sid: "s4108squatter000000000000000000001", handle: "squatter", previousHandles: [] as string[] };
const pro = (s: typeof owner) => ({ ...s, subscriptionActive: true, tier: "pro", domain: null }) as unknown as Store;

/** The DNS: only the real owner's proof record is published for each domain. */
let asked = 0;
(dns as { resolveTxt: (host: string) => Promise<string[][]> }).resolveTxt = async (host: string) => {
  asked += 1;
  const name = host.replace(/^_marktmorgen\./, "");
  return [[proofRecord(owner, name).value]];
};

/** Vercel: the domain is already on the project (the squatter added it), or refuses it. */
let addStatus = 409;
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const status = method === "POST" ? addStatus : 200;
  return new Response(JSON.stringify({}), { status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

/** The stand-in runs no Lua: the compare-and-set swaps of lib/domain-proof.ts and lib/domains.ts, played here. */
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('if redis.call("GET", KEYS[1]) ~= ARGV[1]')) {
    const [, script, , key, expected, next] = commands[0].map(String);
    if (redis.run(["GET", key]) !== expected) return [0];
    redis.run(script.includes("KEEPTTL") ? ["SET", key, next, "KEEPTTL"] : ["SET", key, next]);
    return [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

let n = 0;
const domain = () => `famous${(n += 1)}.creator4108.com`;
const held = (name: string) => redis.run(["GET", domainKey(name)]);

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("The owner connects a domain another store only claimed, unproven");
  const a = domain();
  is("the squatter's claim is taken first", await connectDomain(pro(squatter), a), { ok: true, name: a });
  is("the squatter's claim is unproven", held(a), "?squatter");
  is("the owner may connect it too: an unproven claim keeps nobody out", await connectDomain(pro(owner), a), { ok: true, name: a });
  is("connecting does not move the squatter's claim", held(a), "?squatter");

  part("The owner's TXT record wins over the unproven claim");
  asked = 0;
  is("the owner proves it", [await proveDomain(owner, a), asked, held(a)], ["proved", 1, "realowner"]);
  is("the squatter's check now finds it taken", await proveDomain(squatter, a), "taken");
  is("and still holds nothing", held(a), "realowner");

  part("A claim expired: the squatter's check claims it again, the owner's proof still wins");
  const b = domain();
  await connectDomain(pro(squatter), b);
  redis.run(["DEL", domainKey(b)]);
  is("the squatter's check without the record: waiting", await proveDomain(squatter, b), "waiting");
  is("the owner proves it all the same", [await proveDomain(owner, b), held(b)], ["proved", "realowner"]);

  part("Without the owner's record, an unproven claim of another store still answers taken");
  const c = domain();
  redis.run(["SET", domainKey(c), "?realowner", "EX", 600]);
  asked = 0;
  is("the squatter cannot take the owner's claim", [await proveDomain(squatter, c), held(c)], ["taken", "?realowner"]);

  part("A proven holder keeps its domain, and the DNS is not asked for it");
  const d = domain();
  redis.run(["SET", domainKey(d), "someoneelse"]);
  asked = 0;
  is("connect: taken", await connectDomain(pro(owner), d), { ok: false, reason: "taken" });
  is("prove: taken, DNS not asked", [await proveDomain(owner, d), asked, held(d)], ["taken", 0, "someoneelse"]);

  part("Vercel refusing the owner's connect never drops the other store's claim");
  const e = domain();
  redis.run(["SET", domainKey(e), "?squatter", "EX", 600]);
  addStatus = 400;
  is("refused as a bad name", await connectDomain(pro(owner), e), { ok: false, reason: "shape" });
  is("the claim it did not take stays", held(e), "?squatter");
  addStatus = 409;

  done();
}

void main();
