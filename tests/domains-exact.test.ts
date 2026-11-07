/**
 * A creator's own domain, read exactly (CX-123 rules 24/30; sweep A2 findings 1-3, branch claude5/sweep-a2,
 * tests/sweep-a2-domains.proof.test.ts). Who holds a domain (nl:domain:<name>) decides whether Vercel is asked to
 * drop it and whether its key is deleted; a reply in an unknown shape is not "nobody holds it":
 *
 * 1. disconnectDomain: an unknown read of the holder sends nothing to Vercel and deletes nothing, so a domain another
 *    store proved after this store's claim lapsed keeps serving that store; the key is let go only while it still
 *    holds what was read (compare and delete), and a let-go that cannot be confirmed is said as not done.
 * 2. connectDomain: a SET NX reply that is neither "OK" nor nil is read back; another store's claim is "taken" and
 *    Vercel is not asked; nothing readable is unknown and Vercel is not asked. A claim Vercel refuses is let go only
 *    while the key still holds this store's own claim, never another store's.
 * 3. proveDomain: an unknown first read of the holder is never "taken" about the store's own proved domain.
 * 4. domainStatus: an unknown read of whether the domain is proved is not "not live" (the studio's check would take a
 *    live domain off), it is not known.
 *
 * Synthetic only: Vercel is a stand-in fetch, the DNS a stand-in resolveTxt, Redis the in-memory stand-in.
 */
import dns from "node:dns/promises";
import { connectDomain, disconnectDomain, domainKey, domainStatus, proofRecord } from "@/lib/domains";
import { proveDomain } from "@/lib/domain-proof";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, getOf, setNx, type Command } from "./l10b-replies";

process.env.VERCEL_API_TOKEN = "test-token";
process.env.VERCEL_PROJECT_ID = "prj_exact";
const NAME = "shop.example.com";
const KEY = domainKey(NAME);

const vercelCalls: string[] = [];
let postStatus = 200;
let deleteStatus = 200;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  vercelCalls.push(`${method} ${url.pathname}`);
  let body: unknown = {};
  if (method === "GET" && url.pathname === `/v9/projects/prj_exact/domains/${NAME}`) body = { name: NAME, apexName: "example.com", verified: true };
  if (method === "GET" && url.pathname.startsWith("/v6/domains/")) body = { misconfigured: false };
  const status = method === "POST" ? postStatus : method === "DELETE" ? deleteStatus : 200;
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

let dnsAsked = 0;
const mine = { sid: "s_exact_me", handle: "mystore", previousHandles: [] as string[] };
(dns as { resolveTxt: (host: string) => Promise<string[][]> }).resolveTxt = async (host: string) => {
  dnsAsked += 1;
  return [[proofRecord(mine, host.replace(/^_marktmorgen\./, "")).value]];
};
const me = { ...mine, subscriptionActive: true, tier: "scale", trialEnds: 0, planEndedAt: "", subscriptionId: "sub_x" } as unknown as Store;

const held = () => redis.run(["GET", KEY]);
const reset = (value?: string) => {
  redis.clear();
  clearAnswers();
  vercelCalls.length = 0;
  dnsAsked = 0;
  postStatus = 200;
  deleteStatus = 200;
  if (value !== undefined) redis.run(["SET", KEY, value]);
};
/** What a call came to: its answer, or "try again" when it said it could not tell (it threw). */
const outcome = async <T>(run: Promise<T>): Promise<T | "try again"> => run.catch(() => "try again" as const);
/** The pipeline that lets the domain's key go: a DEL or a script naming the key. */
const letGo = (c: Command) => (c[0] === "DEL" || c[0] === "EVAL") && c.some((x) => String(x) === KEY);
const vercelDelete = `DELETE /v9/projects/prj_exact/domains/${NAME}`;
const UNKNOWN_READS: [string, (real: unknown[]) => unknown][] = [
  ...UNREADABLE,
  ["no reply at all", () => []],
  ["a reply too many", () => [null, null]],
  ["not a list", () => null],
  ["an object", () => [{ handle: "x" }]],
];

async function main(): Promise<void> {
  console.error = () => {};

  part("1. disconnectDomain — healthy controls");
  reset("otherstore");
  is("held by another store: removed from this store, Vercel not asked, its key kept", [await disconnectDomain(NAME, ["mystore"]), vercelCalls, held()], ["removed", [], "otherstore"]);
  reset("mystore");
  is("this store's own proved domain: removed, dropped at Vercel, its key gone", [await disconnectDomain(NAME, ["mystore"]), vercelCalls, held()], ["removed", [vercelDelete], null]);
  reset("?mystore");
  is("this store's own claim not proved yet: the same", [await disconnectDomain(NAME, ["mystore"]), vercelCalls, held()], ["removed", [vercelDelete], null]);
  reset();
  is("held by nobody: removed, dropped at Vercel", [await disconnectDomain(NAME, ["mystore"]), vercelCalls, held()], ["removed", [vercelDelete], null]);
  reset("mystore");
  deleteStatus = 500;
  is("Vercel refusing the drop: unavailable (nothing changed), its key kept", [await disconnectDomain(NAME, ["mystore"]), vercelCalls, held()], ["unavailable", [vercelDelete], "mystore"]);
  reset("mystore");
  deleteStatus = 404;
  is("Vercel no longer having it (a retry): removed, its key gone", [await disconnectDomain(NAME, ["mystore"]), vercelCalls, held()], ["removed", [vercelDelete], null]);

  part("1. disconnectDomain — the holder read in an unknown shape: nothing sent to Vercel, nothing deleted");
  for (const [shape, reply] of UNKNOWN_READS) {
    reset("otherstore");
    answer(getOf(KEY), reply);
    const out = await outcome(disconnectDomain(NAME, ["mystore"]));
    is(`read as ${shape}: try again, Vercel not asked, the other store's key kept`, [out, vercelCalls, held()], ["try again", [], "otherstore"]);
  }

  part("1. disconnectDomain — the key let go only while it holds what was read");
  reset("mystore");
  answer(letGo, (real) => real, { before: () => void redis.run(["SET", KEY, "otherstore"]) });
  await outcome(disconnectDomain(NAME, ["mystore"]));
  is("another store took the domain between the read and the let-go: its key kept", held(), "otherstore");
  reset("mystore");
  answer(letGo, () => [], { run: false });
  // Review L1 (Claude 4 team, comment 6696444077): Vercel has already dropped the domain by then, so this is not
  // "unavailable, nothing changed"; it is its own answer, "unfinished", and the next press lets the key go.
  is("the let-go's reply lost: unfinished (dropped at Vercel, not unavailable), the key kept for the next try", [await outcome(disconnectDomain(NAME, ["mystore"])), vercelCalls, held()], ["unfinished", [vercelDelete], "mystore"]);
  reset("mystore");
  answer(letGo, THROWS, { run: false });
  is("the let-go failing: unfinished, not said as done", [await outcome(disconnectDomain(NAME, ["mystore"])), vercelCalls, held()], ["unfinished", [vercelDelete], "mystore"]);

  part("2. connectDomain — healthy controls");
  reset();
  is("a free domain: claimed, added at Vercel", [await connectDomain(me, NAME), vercelCalls.filter((c) => c.startsWith("POST")).length, held()], [{ ok: true, name: NAME }, 1, "?mystore"]);
  reset("otherstore");
  is("held by another store: taken, Vercel not asked, its key kept", [await connectDomain(me, NAME), vercelCalls.length, held()], [{ ok: false, reason: "taken" }, 0, "otherstore"]);
  reset();
  postStatus = 500;
  is("a free domain Vercel refuses: unavailable, this store's claim let go", [await connectDomain(me, NAME), held()], [{ ok: false, reason: "unavailable" }, null]);

  part("2. connectDomain — the SET NX answered neither OK nor nil while another store holds the domain");
  for (const [shape, reply] of ODD) {
    reset("otherstore");
    postStatus = 500;
    answer(setNx(KEY), reply);
    const made = await outcome(connectDomain(me, NAME));
    is(`answered ${shape}: taken, Vercel not asked, the other store's key kept`, [made, vercelCalls.length, held()], [{ ok: false, reason: "taken" }, 0, "otherstore"]);
  }

  part("2. connectDomain — the SET NX answered oddly and the write landed: this store's claim, read back");
  for (const [shape, reply] of ODD) {
    reset();
    answer(setNx(KEY), reply);
    is(`answered ${shape}, the claim ours: connected`, [await outcome(connectDomain(me, NAME)), held()], [{ ok: true, name: NAME }, "?mystore"]);
  }

  part("2. connectDomain — the claim not known: Vercel not asked");
  for (const [shape, reply] of UNREADABLE) {
    reset();
    answer(setNx(KEY), () => ["QUEUED"], { run: false });
    answer(getOf(KEY), reply);
    is(`the claim odd and its read-back ${shape}: try again, Vercel not asked`, [await outcome(connectDomain(me, NAME)), vercelCalls.length], ["try again", 0]);
  }

  part("2. connectDomain — a claim Vercel refuses is let go only while it is still this store's");
  reset();
  postStatus = 500;
  answer(letGo, (real) => real, { before: () => void redis.run(["SET", KEY, "otherstore"]) });
  is("another store's claim in the key by then: kept", [await outcome(connectDomain(me, NAME)), held()], [{ ok: false, reason: "unavailable" }, "otherstore"]);

  part("3. proveDomain — healthy controls");
  reset("mystore");
  is("this store's own proved domain: proved", await proveDomain(mine, NAME), "proved");
  reset("otherstore");
  is("held by another store: taken, the DNS not asked", [await proveDomain(mine, NAME), dnsAsked], ["taken", 0]);

  part("3. proveDomain — the first read in an unknown shape is never 'taken' about the store's own domain");
  for (const [shape, reply] of UNKNOWN_READS) {
    reset("mystore");
    answer(getOf(KEY), reply);
    const proof = await outcome(proveDomain(mine, NAME));
    is(`read as ${shape}: try again, the DNS not asked, the key kept`, [proof, dnsAsked, held()], ["try again", 0, "mystore"]);
  }

  part("4. domainStatus — healthy control, then whether it is proved read in an unknown shape");
  reset("mystore");
  is("proved, verified and configured: live", (await domainStatus(NAME, mine))?.live, true);
  for (const [shape, reply] of UNKNOWN_READS) {
    reset("mystore");
    answer(getOf(KEY), reply);
    const status = await outcome(domainStatus(NAME, mine));
    const said = status === null || status === "try again" ? "not known" : status.live ? "live" : "not live";
    is(`proved read as ${shape}: not known (null or try again), never 'not live'`, said, "not known");
  }

  clearAnswers();
  done();
}

void main();
