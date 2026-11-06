/**
 * Sweep A2 proof (CX-123 rules 24/30), synthetic only; Vercel and the DNS are stand-ins.
 *
 * 1. lib/domains.ts disconnectDomain (lines 315-321): the GET of the domain's owner key is read with
 *    `typeof raw === "string" ? ... : ""`, so an unknown reply means "nobody holds it" and the domain is DELETEd from
 *    the Vercel project and its key DELeted, even when the claim lapsed and ANOTHER store proved it since: that other
 *    creator's live domain stops serving.
 * 2. lib/domains.ts connectDomain (lines 287-296): only a nil reply to the SET NX means "taken"; any other unknown
 *    reply is taken as "claimed", and when Vercel then refuses, `DEL domainKey(name)` deletes the claim that belongs
 *    to ANOTHER store (its proved domain stops serving until that creator checks again).
 * 3. lib/domain-proof.ts proveDomain (lines 50-53): the first GET read the same way; an unknown reply on this store's
 *    own proved domain goes to claimMark, which finds the key held ("handle" is not "?handle") and answers "taken":
 *    the creator is told (409 "taken", app/api/store/domain/route.ts:63) that their own domain is someone else's.
 *    (Its SET NX claim was already made exact in lot L10b; this is the read before it.)
 */
import dns from "node:dns/promises";
import { connectDomain, disconnectDomain, domainKey, proofRecord } from "@/lib/domains";
import { proveDomain } from "@/lib/domain-proof";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.VERCEL_API_TOKEN = "test-token";
process.env.VERCEL_PROJECT_ID = "prj_sweep";
const vercelCalls: string[] = [];
let postStatus = 200;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  vercelCalls.push(`${method} ${url.pathname}`);
  const status = method === "POST" ? postStatus : 200;
  return new Response("{}", { status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const original = redis.pipeline.bind(redis);
const getUnknown = (prefix: string) => {
  let once = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (once && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith(prefix)) { once = false; return []; }
    return original(commands);
  }) as typeof redis.pipeline;
};
const read = async (name: string) => (await original([["GET", domainKey(name)]]))[0];

async function main() {
  const NAME = "shop.example.com";
  part("1. disconnectDomain — healthy control: the domain lapsed and was proved by another store; only this store's side goes");
  redis.clear(); vercelCalls.length = 0;
  await original([["SET", domainKey(NAME), "otherstore"]]);
  is("healthy: true, nothing sent to Vercel, the other store's key kept", [await disconnectDomain(NAME, ["mystore"]), vercelCalls, await read(NAME)], [true, [], "otherstore"]);

  part("1. DEFECT: the same, the owner GET answering in an unknown shape");
  vercelCalls.length = 0;
  getUnknown("nl:domain:");
  const out = await disconnectDomain(NAME, ["mystore"]);
  redis.pipeline = original;
  is("DEFECT: the other store's domain was DELETEd from the Vercel project", vercelCalls, [`DELETE /v9/projects/prj_sweep/domains/${NAME}`]);
  is("DEFECT: and its owner key deleted (it no longer serves the other store)", [out, await read(NAME)], [true, null]);

  part("2. connectDomain — healthy control: a domain another store holds is 'taken', nothing deleted");
  const me = { sid: "s_me", handle: "mystore", previousHandles: [], subscriptionActive: true, tier: "scale", trialEnds: 0, planEndedAt: "", subscriptionId: "sub_x" } as unknown as Store;
  redis.clear(); vercelCalls.length = 0; postStatus = 500;
  await original([["SET", domainKey(NAME), "otherstore"]]);
  is("healthy: taken, Vercel not asked, the other store's key kept", [await connectDomain(me, NAME), vercelCalls.length, await read(NAME)], [{ ok: false, reason: "taken" }, 0, "otherstore"]);

  part("2. DEFECT: the SET NX reply is unknown (not nil, not OK) and Vercel refuses");
  let once = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (once && commands[0]?.[0] === "SET" && commands[0].includes("NX")) { once = false; await original(commands); return []; }
    return original(commands);
  }) as typeof redis.pipeline;
  const made = await connectDomain(me, NAME);
  redis.pipeline = original;
  is("DEFECT: went on to Vercel as if claimed", [made, vercelCalls.some((c) => c.startsWith("POST"))], [{ ok: false, reason: "unavailable" }, true]);
  is("DEFECT: and deleted the OTHER store's claim on its way out", await read(NAME), null);
  postStatus = 200;

  part("3. proveDomain — healthy control: this store's own proved domain is 'proved'");
  const mine = { sid: "s_me", handle: "mystore", previousHandles: [] as string[] };
  (dns as { resolveTxt: (host: string) => Promise<string[][]> }).resolveTxt = async (host: string) => [[proofRecord(mine, host.replace(/^_marktmorgen\./, "")).value]];
  redis.clear();
  await original([["SET", domainKey(NAME), "mystore"]]);
  is("healthy: proved", await proveDomain(mine, NAME), "proved");
  part("3. DEFECT: the first GET answers in an unknown shape");
  getUnknown("nl:domain:");
  const proof = await proveDomain(mine, NAME);
  redis.pipeline = original;
  is("DEFECT: this store's own proved domain is answered 'taken' (shown as taken by someone else)", [proof, await read(NAME)], ["taken", "mystore"]);
  done();
}
main();
