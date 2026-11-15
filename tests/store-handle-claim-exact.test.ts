/**
 * A handle is claimed exactly (CX-123 rule 24, lib/store.ts claimHandle,
 * createStore, renameHandle): the SET NX that takes a handle answers "OK"
 * (ours) or nil (somebody else's). Any other answer, or none, is read back:
 * the key holding this store's own key is ours, another value is somebody
 * else's, anything else is unknown and throws, and is never a handle won.
 *
 *   - a malformed reply never makes a store, or moves one, onto another
 *     store's handle, and a failed write after it never deletes the other
 *     store's handle;
 *   - a handle has no expiry, so a claim that may have landed but could not
 *     be read back is let go (compare-and-delete with this store's own key),
 *     never left locked to a store that does not exist.
 *
 * Healthy claims, a handle really taken (nil), and a failed store write after
 * a won claim (the handle given back) stay as before.
 */
import { createHash } from "node:crypto";
import { claimHandle, createStore, renameHandle, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OTHER = "handle-other@example.com";
const OWNER = "handle-owner@example.com";
const ownerKey = (ref: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${ref.toLowerCase()}`).digest("hex").slice(0, 40)}`;
const handleKey = (handle: string) => `nl:store:handle:${handle}`;

/**
 * How the handle's SET NX is answered:
 *   "real"      as Redis answers;
 *   "drop"      no reply for it (whether or not it landed);
 *   a value     that value in its place;
 *   "throw"     the request fails after the write was sent.
 * `readBack` does the same for a GET of the handle after it.
 */
let claimReply: unknown = "real";
let readBack: unknown = "real";
let target = "";
/** Store writes that fail, as a Redis outage halfway would. */
let failWritesOf = "";
const pipeline = redis.pipeline.bind(redis);
const shaped = (real: unknown[], at: number, how: unknown): unknown[] => {
  if (how === "throw") throw new Error("synthetic: connection reset");
  if (how === "drop") return real.filter((_, i) => i !== at);
  return real.map((r, i) => (i === at ? how : r));
};
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (failWritesOf && commands.some((c) => c[0] !== "GET" && c.slice(1).includes(failWritesOf))) {
    throw new Error("synthetic: the store could not be written");
  }
  const real = await pipeline(commands);
  const nx = commands.findIndex((c) => c[0] === "SET" && c[1] === target && c.includes("NX"));
  if (nx >= 0 && claimReply !== "real") return shaped(real, nx, claimReply);
  const get = commands.findIndex((c) => c[0] === "GET" && c[1] === target);
  if (get >= 0 && readBack !== "real") return shaped(real, get, readBack);
  return real;
}) as typeof redis.pipeline;

function reset(): void {
  claimReply = "real";
  readBack = "real";
  target = "";
  failWritesOf = "";
}

/** What a promise came to: its value, or "threw". */
async function outcome<T>(work: () => Promise<T>): Promise<T | "threw"> {
  try {
    return await work();
  } catch {
    return "threw";
  }
}

const held = async (handle: string) => (await pipeline([["GET", handleKey(handle)]]))[0];
const ODD: [string, unknown][] = [["no reply", "drop"], ["a number", 1], ["a list", ["OK"]], ["an empty string", ""], ["the request failed", "throw"]];

async function main(): Promise<void> {
  redis.clear();
  is("setup: the other store", (await claimHandle(OTHER, "contested", "Other", "")).ok, true);
  is("setup: the owner's first store", (await claimHandle(OWNER, "ownerfirst", "Owner", "")).ok, true);
  const otherRef = await held("contested");

  part("a malformed reply never makes a store on another store's handle");
  for (const [label, odd] of ODD) {
    const fresh = `fresh-${label.replace(/\W/g, "")}@example.com`;
    target = handleKey("contested");
    claimReply = odd;
    const first = await outcome(() => claimHandle(fresh, "contested", "Fresh", ""));
    const extra = await outcome(() => createStore(OWNER, "contested", "Extra", ""));
    const moved = await outcome(() => renameHandle(OWNER, "contested"));
    reset();
    is(`${label}: claimHandle says taken`, first === "threw" ? first : first.ok ? "made" : first.reason, "taken");
    is(`${label}: createStore says taken`, extra === "threw" ? extra : extra.ok ? "made" : extra.reason, "taken");
    is(`${label}: renameHandle says taken`, moved === "threw" ? moved : moved.ok ? "moved" : moved.reason, "taken");
    is(`${label}: no first store was made`, (await storeForEmail(fresh))?.handle ?? null, null);
    is(`${label}: the owner's store kept its address`, (await storeForEmail(OWNER))?.handle, "ownerfirst");
    is(`${label}: the handle still leads to the other store`, await held("contested"), otherRef);
  }

  part("a failed write after a malformed reply never deletes the other store's handle");
  for (const [label, odd] of [["no reply", "drop"], ["a number", 1]] as const) {
    const fresh = `failed-${label.replace(/\W/g, "")}@example.com`;
    target = handleKey("contested");
    claimReply = odd;
    failWritesOf = ownerKey(fresh);
    await outcome(() => claimHandle(fresh, "contested", "Fresh", ""));
    failWritesOf = ownerKey(OWNER);
    await outcome(() => renameHandle(OWNER, "contested"));
    reset();
    is(`${label}: the other store's handle is kept`, await held("contested"), otherRef);
  }

  part("a claim that landed but was answered oddly is read back as ours");
  for (const [label, odd] of ODD) {
    const tag = `t${ODD.findIndex(([l]) => l === label)}`;
    const fresh = `landed-${tag}@example.com`;
    target = handleKey(`landed${tag}`);
    claimReply = odd;
    const first = await outcome(() => claimHandle(fresh, `landed${tag}`, "Landed", ""));
    reset();
    is(`${label}: claimHandle makes the store`, first !== "threw" && first.ok, true);
    is(`${label}: and the handle leads to it`, await held(`landed${tag}`), fresh);
    target = handleKey(`moved${tag}`);
    claimReply = odd;
    const moved = await outcome(() => renameHandle(fresh, `moved${tag}`));
    reset();
    is(`${label}: renameHandle moves the store`, moved !== "threw" && moved.ok, true);
    is(`${label}: and the new handle leads to it`, await held(`moved${tag}`), fresh);
  }

  part("a claim that may have landed and cannot be read back is unknown, and let go");
  for (const [label, odd] of ODD) {
    const tag = `t${ODD.findIndex(([l]) => l === label)}`;
    const fresh = `unread-${tag}@example.com`;
    target = handleKey(`unread${tag}`);
    claimReply = odd;
    readBack = "throw";
    const first = await outcome(() => claimHandle(fresh, `unread${tag}`, "Unread", ""));
    reset();
    is(`${label}: claimHandle throws`, first, "threw");
    is(`${label}: no store was made`, (await storeForEmail(fresh))?.handle ?? null, null);
    is(`${label}: the handle is not locked forever`, await held(`unread${tag}`), null);
    target = handleKey(`unreadextra${tag}`);
    claimReply = odd;
    readBack = 7;
    const extra = await outcome(() => createStore(OWNER, `unreadextra${tag}`, "Unread", ""));
    reset();
    is(`${label}: createStore throws`, extra, "threw");
    is(`${label}: its handle is not locked forever`, await held(`unreadextra${tag}`), null);
    target = handleKey(`unreadmove${tag}`);
    claimReply = odd;
    readBack = "drop";
    const moved = await outcome(() => renameHandle(OWNER, `unreadmove${tag}`));
    reset();
    is(`${label}: renameHandle throws`, moved, "threw");
    is(`${label}: the store kept its address`, (await storeForEmail(OWNER))?.handle, "ownerfirst");
    is(`${label}: the new handle is not locked forever`, await held(`unreadmove${tag}`), null);
  }
  part("an unreadable claim on another store's handle leaves that handle alone");
  target = handleKey("contested");
  claimReply = "throw";
  readBack = "throw";
  is("claimHandle throws", await outcome(() => claimHandle("unread-other@example.com", "contested", "X", "")), "threw");
  is("createStore throws", await outcome(() => createStore(OWNER, "contested", "X", "")), "threw");
  is("renameHandle throws", await outcome(() => renameHandle(OWNER, "contested")), "threw");
  reset();
  is("the other store's handle is kept", await held("contested"), otherRef);

  part("healthy claims, a handle really taken, and a failed write after a won claim");
  is("claimHandle on a free handle", (await claimHandle("healthy@example.com", "healthyone", "H", "")).ok, true);
  is("claimHandle on a taken handle", await claimHandle("late@example.com", "healthyone", "L", ""), { ok: false, reason: "taken" });
  const extra = await createStore(OWNER, "healthyextra", "E", "");
  is("createStore on a free handle", extra.ok, true);
  is("createStore on a taken handle", await createStore(OWNER, "healthyone", "E", ""), { ok: false, reason: "taken" });
  is("renameHandle on a free handle", (await renameHandle("healthy@example.com", "healthytwo")).ok, true);
  is("renameHandle on a taken handle", await renameHandle(OWNER, "healthytwo"), { ok: false, reason: "taken" });
  failWritesOf = ownerKey("broken@example.com");
  is("a failed first store write throws", await outcome(() => claimHandle("broken@example.com", "givenback", "B", "")), "threw");
  reset();
  is("and the handle it won is given back", await held("givenback"), null);
  failWritesOf = ownerKey(OWNER);
  is("a failed rename write throws", await outcome(() => renameHandle(OWNER, "givenbacktoo")), "threw");
  reset();
  is("and the handle it won is given back", await held("givenbacktoo"), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
