/**
 * A person's erasure in a closed store is never refused for its cost
 * (owner's decision DONO-20261113-DEC-1, 13 November 2026, option (a)).
 *
 * Before: a store whose plan ended has 100 studio units a month
 * (NON_PAYING_ALLOWANCES.ended.studio), and lib/person-erasure.ts took the
 * whole erasure from them. Past about 58 products with no course, the
 * erasure needed more than the window holds, and it answered "limit": a
 * deletion the law requires could not be made at all.
 *
 * Now the part past what is left of the store's window is paid by the
 * company's own funded exposure for it (`erasure_overflow`), never taken
 * from the store's window and never refused for it: the store's window is
 * spent first, the rest is counted in the company's month, at no more than
 * the worst case a single erasure can cost (ERASE_WORST_UNITS). A count the
 * company's ledger does not confirm leaves the erasure undone, to be pressed
 * again, never "done".
 *
 * Synthetic: an in-memory Redis; no email or Stripe call leaves the process.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { erasePerson } from "@/lib/person-erasure";
import { erasureUnits } from "@/lib/erasure-rules";
import { NON_PAYING_ALLOWANCES } from "@/lib/store-allowance-rules";
import { takeAllowance } from "@/lib/store-allowance";
import { standingOf } from "@/lib/plan-standing";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** When set, every reply to a command on a key starting with this is bent to an unknown value. */
let bendPrefix = "";
redis.pipeline = (async (commands: Command[]) => {
  const replies = await real(commands);
  if (bendPrefix) commands.forEach((c, i) => {
    if (c.some((part) => typeof part === "string" && part.startsWith(bendPrefix))) replies[i] = "not a count";
  });
  return replies;
}) as typeof redis.pipeline;

const allowKeys = async (): Promise<string[]> => ((await real([["SCAN", 0, "MATCH", "nl:allow:studio:*", "COUNT", 10_000]]))[0] as [string, string[]])[1];
const studioUsed = async (): Promise<number> => {
  const keys = await allowKeys();
  if (!keys.length) return 0;
  return Number((await real([["GET", keys[0]]]))[0] ?? 0);
};

/** A store whose plan ended, with `products` products and no course. */
async function closedStore(owner: string, handle: string, products: number): Promise<Store> {
  await claimHandle(owner, handle, handle, "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  const tag = handle.replace(/[^a-z0-9]/gi, "").slice(0, 10);
  await setSubscription(owner, { customerId: `cus_${tag}`, subscriptionId: `sub_${tag}`, active: true, tier: "creator" });
  for (let i = 0; i < products; i++) {
    const made = await addProduct(owner, `Product ${i + 1}`, "A product.", "9", null);
    if (!made.ok) throw new Error(`product ${i + 1} was not added: ${made.reason}`);
  }
  await setSubscription(owner, { active: false });
  const store = await storeForEmail(owner);
  if (!store) throw new Error("no store");
  return store;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_erasure_closed_funded_stand_in";
  process.env.RESEND_API_KEY = "re_test_erasure_closed_funded_stand_in";

  part("A closed store with more products than its window covers");
  const store = await closedStore("closed-owner@example.com", "closed-many", 70);
  is("the store's plan has ended", standingOf(store), "ended");
  is("it has 70 products and no course", store.catalog.items.length, 70);
  const needed = erasureUnits({ products: 70 });
  is("the erasure needs more than an ended store's whole window", needed > NON_PAYING_ALLOWANCES.ended.studio, true);

  const byTeam = await erasePerson(store, "ann@example.com", { kind: "team", who: "closed-owner@example.com", role: "owner" });
  is("the team's erasure is not refused for its cost", byTeam.ok ? "ok" : byTeam.reason, "ok");
  is("the store's window is spent first, all of it", await studioUsed(), NON_PAYING_ALLOWANCES.ended.studio);

  const byPerson = await erasePerson(store, "bob@example.com", { kind: "person" });
  is("the person's own erasure, with the window already spent, is not refused either", byPerson.ok ? "ok" : byPerson.reason, "ok");
  is("and takes nothing more from the store's window", await studioUsed(), NON_PAYING_ALLOWANCES.ended.studio);
  is("the store's other studio work is still refused past its window", (await takeAllowance(store, "studio", 1)).ok, false);

  part("A store whose window had room for part of it");
  redis.clear();
  const part59 = await closedStore("part-owner@example.com", "closed-part", 59);
  const first = await takeAllowance(part59, "studio", 10);
  is("ten of its studio units were already used this month", first.ok, true);
  const mid = await erasePerson(part59, "cy@example.com", { kind: "team", who: "part-owner@example.com", role: "owner" });
  is("its erasure is made", mid.ok ? "ok" : mid.reason, "ok");
  is("what was left of its window was used, never more", await studioUsed(), NON_PAYING_ALLOWANCES.ended.studio);

  part("An unknown count of the company's part never makes it done");
  redis.clear();
  const unknown = await closedStore("unknown-owner@example.com", "closed-unknown", 70);
  bendPrefix = "nl:erase:funded:";
  const unread = await erasePerson(unknown, "dee@example.com", { kind: "person" });
  bendPrefix = "";
  is("it is not done", unread.ok, false);
  is("it is to be pressed again, never refused for its cost", unread.ok ? "ok" : unread.reason, "unavailable");
  const again = await erasePerson(unknown, "dee@example.com", { kind: "person" });
  is("pressed again, it is made", again.ok ? "ok" : again.reason, "ok");

  done();
}

void main();
