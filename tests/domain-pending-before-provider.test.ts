/**
 * Codex L-20261120-0152 (MEDIUM, #5010 row 34): connectDomain asked Vercel to add the domain before anything about it
 * was written in the store, and the route wrote it only after Vercel answered. A store deleted while that request
 * waited had no domain on its record, so the delete went through, and the domain stayed on the provider's project
 * with no record left to take it off.
 *
 * Now the domain is written into the store as pending (same store, same id, none before) before the provider is
 * asked, so the existing delete refusal ("domain") holds for the whole request. A provider refusal clears it only
 * while it is still that same pending domain, and the claim is let go only once that clear is confirmed; a pending
 * write that cannot be confirmed asks the provider nothing. Synthetic store, synthetic provider, no network.
 */
import { createStore, claimHandle, deleteStore as deleteWith, storeForEmail, storeRef, type Store, type StoreDomain } from "@/lib/store";
import * as storeLib from "@/lib/store";
import { queueDeleted } from "@/lib/closed-store-data";
import { connectDomain, domainKey } from "@/lib/domains";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.VERCEL_API_TOKEN = "test-token";
process.env.VERCEL_PROJECT_ID = "prj_pending";
const NAME = "shop.example.com";
const KEY = domainKey(NAME);
const deleteStore = (ref: string) => deleteWith(ref, queueDeleted);
// Read through the module, so a store library without it fails here, not at build time.
type ReplaceDomainIf = (email: string, sid: string, before: string | null, domain: StoreDomain | null) => Promise<Store | null>;
const replaceDomainIf: ReplaceDomainIf = (...args) => {
  const real = (storeLib as { replaceDomainIf?: ReplaceDomainIf }).replaceDomainIf;
  return real ? real(...args) : Promise.reject(new Error("replaceDomainIf is missing"));
};

let postStatus = 200;
let postThrows = false;
let getStatus = 200;
let duringPost: (() => Promise<void>) | null = null;
const posts: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (method === "POST") {
    posts.push(url.pathname);
    if (duringPost) await duringPost();
    if (postThrows) throw new TypeError("fetch failed");
  }
  // A GET answers 200 (the domain is on this project) unless the test says it is on another one.
  const status = method === "POST" ? postStatus : getStatus;
  return new Response(JSON.stringify({ name: NAME }), { status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

/** The pending-domain writer the route hands connectDomain: the same store, the same id, nothing else changed. */
const pendingFor = (ref: string, sid: string) => ({
  keep: async (name: string) => (await replaceDomainIf(ref, sid, null, { name, addedAt: new Date(0).toISOString(), liveAt: "" })) !== null,
  clear: async (name: string) => (await replaceDomainIf(ref, sid, name, null)) !== null,
});

let n = 0;
async function extraStore(): Promise<{ ref: string; store: Store }> {
  n += 1;
  const owner = `pending${n}@example.com`;
  await claimHandle(owner, `pendingfirst${n}`, "First", "");
  const made = await createStore(owner, `pendingextra${n}`, "Extra", "");
  if (!made.ok) throw new Error(`no extra store: ${JSON.stringify(made)}`);
  return { ref: storeRef(made.store), store: made.store };
}
/** The store as connectDomain sees it, on a plan that may use a domain (only this read is synthetic). */
const onPlan = (store: Store): Store => ({ ...store, subscriptionActive: true, tier: "scale" }) as Store;
const domainOf = async (ref: string) => (await storeForEmail(ref))?.domain?.name ?? null;

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();

  part("A delete while the provider is asked is refused: the domain is already on the store");
  {
    const { ref, store } = await extraStore();
    let deleted: unknown = "not tried";
    let seenDuring: string | null = "not read";
    duringPost = async () => {
      seenDuring = await domainOf(ref);
      deleted = await deleteStore(ref).catch(() => "threw");
    };
    const result = await connectDomain(onPlan(store), NAME, pendingFor(ref, store.sid)).catch(() => "threw" as const);
    duringPost = null;
    is("while the provider is asked, the store already holds the domain", seenDuring, NAME);
    is("so the delete is refused for it, never done", deleted, { ok: false, reason: "domain" });
    is("the connection answers ok", result, { ok: true, name: NAME });
    is("and the store keeps the domain, so Remove can take it off later", await domainOf(ref), NAME);
  }

  part("The provider refuses: the pending domain is cleared, then the claim is let go");
  for (const [status, reason] of [[400, "shape"], [409, "elsewhere"]] as const) {
    redis.run(["DEL", KEY]);
    const { ref, store } = await extraStore();
    postStatus = status;
    getStatus = 404; // not on this project: a 409 is another project's
    const result = await connectDomain(onPlan(store), NAME, pendingFor(ref, store.sid)).catch(() => "threw" as const);
    postStatus = 200;
    getStatus = 200;
    is(`a ${status}: ${reason}`, result, { ok: false, reason });
    is(`a ${status}: the store holds no domain`, await domainOf(ref), null);
    is(`a ${status}: the claim is let go`, redis.run(["GET", KEY]), null);
  }

  // Claude 1 2as's MEDIUM on #5108: an answer that is not known may have added the domain at Vercel. It is never taken
  // as a refusal: the pending domain and the claim stay, so the studio's Remove can take it off at Vercel and here.
  part("An unknown answer is not a refusal: the pending domain and the claim stay");
  for (const [label, status, throws] of [["a 500", 500, false], ["a 503", 503, false], ["no answer (the wrapper's 502)", 200, true]] as const) {
    redis.run(["DEL", KEY]);
    const { ref, store } = await extraStore();
    postStatus = status;
    postThrows = throws;
    const result = await connectDomain(onPlan(store), NAME, pendingFor(ref, store.sid)).catch(() => "threw" as const);
    postStatus = 200;
    postThrows = false;
    is(`${label}: unavailable`, result, { ok: false, reason: "unavailable" });
    is(`${label}: the store still holds the domain, for Remove`, await domainOf(ref), NAME);
    is(`${label}: the claim is kept`, redis.run(["GET", KEY]) !== null, true);
  }

  part("A pending write that cannot be confirmed asks the provider nothing");
  {
    redis.run(["DEL", KEY]);
    const { store } = await extraStore();
    posts.length = 0;
    const refused = { keep: async () => false, clear: async () => true };
    const result = await connectDomain(onPlan(store), NAME, refused).catch(() => "threw" as const);
    is("unavailable, with no request to the provider", [result, posts.length], [{ ok: false, reason: "unavailable" }, 0]);
    is("and the claim is let go", redis.run(["GET", KEY]), null);
  }

  // Claude 1 f9afa7's LEVE on #5108: a second press that read the store before the first one wrote its pending domain
  // is refused by that write, and must not let go of the first press's claim (the same value, this store's).
  part("A second press, read before the first wrote, leaves the first press's claim");
  {
    redis.run(["DEL", KEY]);
    const { ref, store } = await extraStore();
    let second: unknown = "not tried";
    duringPost = async () => {
      duringPost = null;
      second = await connectDomain(onPlan(store), NAME, pendingFor(ref, store.sid)).catch(() => "threw" as const);
    };
    const first = await connectDomain(onPlan(store), NAME, pendingFor(ref, store.sid)).catch(() => "threw" as const);
    is("the second press, read before the first wrote, is refused", second, { ok: false, reason: "unavailable" });
    is("the first press connects", first, { ok: true, name: NAME });
    is("and keeps its claim", redis.run(["GET", KEY]) !== null, true);
    is("and its domain", await domainOf(ref), NAME);
  }

  part("A refusal whose clear cannot be confirmed keeps the claim, so Remove can finish it");
  {
    redis.run(["DEL", KEY]);
    const { ref, store } = await extraStore();
    postStatus = 400;
    const stuck = { keep: pendingFor(ref, store.sid).keep, clear: async () => false };
    const result = await connectDomain(onPlan(store), NAME, stuck).catch(() => "threw" as const);
    postStatus = 200;
    is("refused as a bad name", result, { ok: false, reason: "shape" });
    is("the claim is kept while the store may still hold the domain", redis.run(["GET", KEY]) !== null, true);
    is("and the store does hold it", await domainOf(ref), NAME);
    redis.run(["DEL", KEY]);
  }

  part("Only the same store, the same id and no domain before: the pending write is exact");
  {
    const { ref, store } = await extraStore();
    is("another id is refused", await replaceDomainIf(ref, "x".repeat(store.sid.length), null, { name: NAME, addedAt: "", liveAt: "" }), null);
    is("a store that already has a domain is refused", await replaceDomainIf(ref, store.sid, null, { name: NAME, addedAt: "", liveAt: "" }).then(() => replaceDomainIf(ref, store.sid, null, { name: "other.example.com", addedAt: "", liveAt: "" })), null);
    is("a clear of another name is refused", await replaceDomainIf(ref, store.sid, "other.example.com", null), null);
    is("the domain is still the first one", await domainOf(ref), NAME);
  }

  done();
}

void main();
