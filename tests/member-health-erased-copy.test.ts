/**
 * #3967 (Codex L, erasure, MEDIUM): the members' scores copy (nl:health:<statsId>, lib/member-health.ts) never keeps
 * a person this store has deleted. A membership stays on the creator's Stripe account after the person's erasure,
 * so a refresh reads them again: their address stays out of the kept copy (the numbers stay whole). A refresh
 * that races the erasure (its print written, lib/person-erasure.ts, then the copy deleted, forgetHealthCopy) never
 * leaves the copy with them in it either. Synthetic data, the in-memory Redis and a stubbed Stripe.
 */
import { memberHealth, forgetHealthCopy } from "@/lib/member-health";
import { suppressCommand } from "@/lib/suppression";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const ERASED = "ana@example.com";
type Command = (string | number)[];

let subs: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.pathname === "/v1/subscriptions") return answer({ object: "list", data: subs, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The copy as kept, or null when there is none. */
function kept(store: Store): { members: { email: string }[]; counts: Record<string, number> } | null {
  const raw = redis.run(["GET", `nl:health:${store.statsId}`]);
  return typeof raw === "string" ? JSON.parse(raw) : null;
}

const emailsIn = (copy: { members: { email: string }[] } | null) => (copy ? copy.members.map((m) => m.email).sort() : null);

/** The person's erasure as lib/person-erasure.ts runs it for this copy: the print first, then the copy deleted. */
async function erase(store: Store, email: string): Promise<void> {
  await redis.pipeline([suppressCommand(store.listId as string, email)]);
  await forgetHealthCopy(store);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_health_only_a_stand_in";
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  console.error = () => {};
  redis.clear();
  const OWNER = "owner@example.com";
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const club = await addProduct(OWNER, "Weeknight Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const member = (id: string, email: string) => ({
    id,
    status: "active",
    currency: "usd",
    start_date: NOW - 90 * DAY,
    customer: { id: `cus_${id.slice(4)}`, email },
    metadata: { store: "harbor", product: club.product.id },
    items: { data: [{ quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
  });
  subs = [member("sub_Ana000000001", ERASED), member("sub_Ben000000001", "ben@example.com")];

  part("Control: nobody deleted, both members are in the copy");
  await memberHealth(store, true);
  is("the copy holds both", emailsIn(kept(store)), [ERASED, "ben@example.com"]);

  part("A person deleted while their membership runs on the creator's Stripe account stays out of the next copy");
  await erase(store, ERASED);
  is("the erasure deleted the copy", kept(store), null);
  const live = (await memberHealth(store, true))!;
  is("the next refresh keeps a copy", kept(store) !== null, true);
  is("without the deleted person's address", emailsIn(kept(store)), ["ben@example.com"]);
  is("the numbers stay whole: two running members counted", Object.values(kept(store)!.counts).reduce((a, b) => a + b, 0), 2);
  is("the copy's numbers are the refresh's", kept(store)!.counts, live.counts);
  is("a cached read later does not bring them back", emailsIn((await memberHealth(store, false)) as never), ["ben@example.com"]);

  part("A refresh racing the erasure: the print and the deletion land between its read and its write");
  redis.clear();
  // A fresh store and list, so nobody is deleted yet.
  const again = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!again.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const club2 = await addProduct(OWNER, "Weeknight Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club2.ok) throw new Error("no product");
  const store2 = (await storeForEmail(OWNER))!;
  subs = subs.map((s) => ({ ...s, metadata: { store: "harbor", product: club2.product.id } }));
  const original = redis.pipeline.bind(redis);
  let raced = false;
  redis.pipeline = (async (commands: Command[]) => {
    // Right before the copy is written, the erasure runs in full: its print, then the copy deleted.
    if (!raced && commands.some((c) => c[0] === "SET" && String(c[1]) === `nl:health:${store2.statsId}`)) {
      raced = true;
      redis.pipeline = original;
      await erase(store2, ERASED);
      redis.pipeline = (async (inner: Command[]) => original(inner)) as typeof redis.pipeline;
    }
    return original(commands);
  }) as typeof redis.pipeline;
  await memberHealth(store2, true);
  redis.pipeline = original;
  is("the race ran", raced, true);
  const copy = kept(store2);
  is("the copy written after the erasure does not hold the deleted person", copy === null || !emailsIn(copy)!.includes(ERASED), true);

  part("A refresh racing the erasure: the print lands after the copy is written, the deletion after that");
  redis.clear();
  const third = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!third.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const club3 = await addProduct(OWNER, "Weeknight Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club3.ok) throw new Error("no product");
  const store3 = (await storeForEmail(OWNER))!;
  subs = subs.map((s) => ({ ...s, metadata: { store: "harbor", product: club3.product.id } }));
  let printed = false;
  redis.pipeline = (async (commands: Command[]) => {
    const answers = await original(commands);
    // Right after the copy is written, only the erasure's print lands; its deletion of the copy has not run yet.
    if (!printed && commands.some((c) => c[0] === "SET" && String(c[1]) === `nl:health:${store3.statsId}`)) {
      printed = true;
      await original([suppressCommand(store3.listId as string, ERASED)]);
    }
    return answers;
  }) as typeof redis.pipeline;
  await memberHealth(store3, true);
  redis.pipeline = original;
  is("the print landed after the write", printed, true);
  const late = kept(store3);
  is("the refresh does not leave a copy holding the person it saw deleted", late === null || !emailsIn(late)!.includes(ERASED), true);

  part("A print that cannot be read keeps no copy");
  redis.clear();
  const fourth = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!fourth.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const club4 = await addProduct(OWNER, "Weeknight Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club4.ok) throw new Error("no product");
  const store4 = (await storeForEmail(OWNER))!;
  subs = subs.map((s) => ({ ...s, metadata: { store: "harbor", product: club4.product.id } }));
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.some((c) => c[0] === "HMGET" && String(c[1]).startsWith("nl:erased:"))) return [{ not: "a list" }];
    return original(commands);
  }) as typeof redis.pipeline;
  const shown = await memberHealth(store4, true);
  redis.pipeline = original;
  is("the refresh still answers the studio", shown !== null, true);
  is("but keeps no copy it could not check", kept(store4), null);

  done();
}

main().catch((e) => {
  console.error = globalThis.console.log;
  console.log(e);
  process.exit(1);
});
