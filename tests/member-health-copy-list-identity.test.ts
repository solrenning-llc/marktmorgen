/** An in-flight legacy Store snapshot cannot infer that a missing erasure namespace means nobody was erased. */
import { memberHealth, forgetHealthCopy } from "@/lib/member-health";
import { suppressCommand } from "@/lib/suppression";
import { addProduct, claimHandle, ensureListId, ownerKey, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const EMAIL = "erased-list-identity@example.test";
let subscriptions: unknown[] = [];
let duringRead: (() => Promise<void>) | null = null;
process.env.STRIPE_SECRET_KEY = "sk_test_list_identity_only";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw Error("Only the synthetic Stripe source is allowed");
  if (url.pathname === "/v1/subscriptions" && duringRead) {
    const erasure = duringRead;
    duringRead = null;
    await erasure();
  }
  return new Response(JSON.stringify({ object: "list", data: url.pathname === "/v1/subscriptions" ? subscriptions : [], has_more: false }));
}) as typeof fetch;

async function seed() {
  redis.clear();
  duringRead = null;
  const owner = "listless-owner@example.test";
  if (!(await claimHandle(owner, "listless-health", "Synthetic store", "")).ok) throw Error("No store");
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  const made = await addProduct(owner, "Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw Error("No product");
  // A real legacy record, read through the production parser; new stores already have both namespace ids.
  const key = await ownerKey(owner);
  const record = JSON.parse(String(redis.run(["GET", key])));
  record.listId = null;
  redis.run(["SET", key, JSON.stringify(record)]);
  const store = (await storeForEmail(owner))!;
  const now = Math.floor(Date.now() / 1000);
  subscriptions = [EMAIL, "remaining@example.test"].map((email, i) => ({
    id: `sub_ListIdentity000${i}`, status: "active", currency: "usd", start_date: now - 90 * 86400,
    customer: { id: `cus_ListIdentity000${i}`, email }, metadata: { store: store.handle, product: made.product.id },
    items: { data: [{ quantity: 1, current_period_end: now + 86400, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
  }));
  return { owner, store, key: `nl:health:${store.statsId}` };
}

function copy(key: string): { members: { email: string }[] } | null {
  const value = redis.run(["GET", key]);
  return typeof value === "string" ? JSON.parse(value) : null;
}

async function main() {
  part("The erasure creates its namespace while a refresh retains an older Store snapshot");
  for (const mode of ["before-refresh", "during-refresh"] as const) {
    const { owner, store, key } = await seed();
    let erased = false;
    const erase = async () => {
      // This is the namespace preparation and the print-before-delete order used by erasureScope/person-erasure.
      const current = await ensureListId(owner);
      if (!current?.listId) throw Error("The erasure namespace was not saved");
      await redis.pipeline([suppressCommand(current.listId, EMAIL)]);
      await forgetHealthCopy(current);
      if (redis.run(["GET", key]) !== null) throw Error("The erasure did not remove its copy");
      erased = true;
    };
    if (mode === "before-refresh") await erase();
    else duringRead = erase;
    const live = await memberHealth(store, true);
    const current = (await storeForEmail(owner))!;
    is(`${mode}: the completed erasure has an id that the captured snapshot lacks`, [erased, store.listId, typeof current.listId], [true, null, "string"]);
    is(`${mode}: the live source still answered, so this is not a failed refresh`, live?.members.length, 2);
    is(`${mode}: the stale snapshot never repopulates the local copy`, copy(key), null);
    await memberHealth(current, true);
    is(`${mode}: a new snapshot uses the saved namespace and keeps only the remaining member`, copy(key)?.members.map(member => member.email), ["remaining@example.test"]);
  }
  part("Healthy copies remain available");
  const known = await seed();
  const current = await ensureListId(known.owner);
  if (!current) throw Error("No current store");
  await memberHealth(current, true);
  is("a known namespace with no erasures still keeps both members", copy(known.key)?.members.length, 2);
  const empty = await seed();
  subscriptions = [];
  await memberHealth(empty.store as Store, true);
  is("an empty legacy copy carries no person and can still be cached", copy(empty.key)?.members, []);
  done();
}

void main();
