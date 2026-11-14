/**
 * A member deleted from the store never comes back in the ten-minute copy of the members' scores (nuvem I privacy
 * audit of main @b859938c0a, 14 November 2026, MEDIUM; the class of #4379, for lib/member-health.ts).
 *
 * The copy (nl:health:<statsId>) keeps each running member's address. A person's erasure writes their print
 * (lib/suppression.ts) and deletes the copy (forgetHealthCopy), but the copy is read again from Stripe, which keeps
 * the membership, so the next reading wrote the deleted member's address back for ten minutes, every time; and a
 * reading begun before an erasure and written after it did the same. Now the reading leaves out whoever the store
 * deleted, and the copy is kept only when nobody it names was deleted, in one step with the write
 * (keepUnlessErased), as lib/store-readings.ts and lib/membership-numbers.ts already do.
 */
import { memberHealth } from "@/lib/member-health";
import { suppressCommand } from "@/lib/suppression";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
let subs: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.pathname === "/v1/subscriptions") return answer({ object: "list", data: subs, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_health_erased_only_a_stand_in";
  redis.clear();
  const OWNER = "health-erased-owner@example.test";
  if (!(await claimHandle(OWNER, "healtherased", "Health Erased", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHealthErased1", true);
  const club = await addProduct(OWNER, "Weeknight Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const member = (id: string, email: string) => ({
    id, status: "active", currency: "usd", start_date: NOW - 90 * DAY,
    customer: { id: `cus_${id.slice(4)}`, email },
    metadata: { store: "healtherased", product: club.product.id },
    items: { data: [{ quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
  });
  subs = [member("sub_Ana000000001", "ana@example.test"), member("sub_Ben000000001", "ben@example.test")];
  const copy = () => String(redis.run(["GET", `nl:health:${store.statsId}`]) ?? "");

  part("A member the store deleted is left out of the reading and of its copy");
  redis.run(suppressCommand(store.listId!, "ana@example.test") as (string | number)[]);
  const health = await memberHealth(store, true);
  is("the reading names only the member who was not deleted", health?.members.map((m) => m.email), ["ben@example.test"]);
  is("and the ten-minute copy never holds the deleted member's address", copy().includes("ana@example.test"), false);

  part("A deletion while the reading runs: the copy is not kept with them in it");
  redis.run(["DEL", `nl:health:${store.statsId}`]);
  const original = redis.pipeline.bind(redis);
  let fenced = false;
  redis.pipeline = async (commands) => {
    // Ben is deleted after Stripe was read and just before the copy is written.
    const key = `nl:health:${store.statsId}`;
    const writesCopy = commands.some((c) => (c[0] === "SET" || c[0] === "EVAL") && c.some((x) => String(x) === key));
    if (!fenced && writesCopy) {
      fenced = true;
      await original([suppressCommand(store.listId!, "ben@example.test") as (string | number)[]]);
    }
    return original(commands);
  };
  try {
    await memberHealth(store, true);
  } finally { redis.pipeline = original; }
  is("the copy was about to be written", fenced, true);
  is("and it does not keep the member deleted meanwhile", copy().includes("ben@example.test"), false);
  done();
}

void main();
