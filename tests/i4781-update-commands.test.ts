/**
 * #4781, the coordinator's review: a product update's Redis commands for each email, measured on the code as it runs,
 * every script's own commands counted (the in-memory Redis runs each through run()). A run whose one batch holds one
 * recipient pays the batch alone: it must stay at or under UPDATE_EMAIL_COMMANDS, which the line
 * product-update-commands (tests/plan-cost-registry.ts) prices on every monthly email. Each further recipient of a
 * batch costs less. Synthetic store; Stripe and the email service are stand-ins.
 */
import { advanceUpdate, startUpdate } from "@/lib/product-updates";
import { UPDATE_EMAIL_COMMANDS } from "@/lib/product-updates-rules";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

/** The store's monthly emails taken (lib/mail.ts reserve), from its window's count, read without counting a command. */
async function monthTaken(shop: { listId?: string | null }): Promise<number> {
  const keys = redis.keys().filter((k) => k.startsWith(`nl:mail:used:${shop.listId}:`));
  return keys.reduce((sum, k) => sum + Number(redis.run(["GET", k]) ?? 0), 0);
}

type Bend = { zscore?: "word" | "list" | "nothing"; sendFails?: boolean };
async function measure(n: number, erasedAt = -1, bend: Bend = {}): Promise<{ commands: number; sent: number; status?: string; stops: number; reserved: number; handed: number }> {
  let handed = 0;
  redis.clear();
  const owner = "update-owner@example.test";
  let productId = "";
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body));
      if (bend.sendFails) return Response.json({ message: "synthetic refusal" }, { status: 422 });
      handed += batch.length;
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    const data = url.pathname === "/v1/checkout/sessions" ? Array.from({ length: n }, (_, i) => ({
      id: `cs_update_${i}`, object: "checkout.session", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 86400, amount_total: 2700, currency: "usd",
      customer_details: { email: `buyer${i}@example.test` }, metadata: { store: "vupdatecount", product: productId },
    })) : [];
    return Response.json({ object: "list", data, has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "vupdatecount", "V Update Count", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_UpdateCount", subscriptionId: "sub_UpdateCount", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "V Update Count", address: "1 Example St, Example City" });
  const made = await addProduct(owner, "Update count", "", "27", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/update");
  const shop = (await storeForEmail(owner))!;
  const product = (await readListing(shop, productId))!;
  const started = await startUpdate(shop, product, "A verified update");
  if (!started.ok) throw new Error(JSON.stringify(started));
  const run = redis.run.bind(redis);
  let commands = 0;
  let noted = 0;
  const monthBefore = await monthTaken(shop);
  redis.run = ((c: (string | number)[]) => {
    commands += 1;
    const result = run(c);
    // The person at erasedAt is erased between their stop link's erasure note and its grant: the erasure deleted the
    // note (and found no grant yet), as lib/erasure-index.ts forgetNoted does.
    if (c[0] === "ZADD" && String(c[3] ?? "").startsWith("nl:upd:stop:") && noted++ === erasedAt) run(["DEL", String(c[1])]);
    // The stop link's note read again (stillNoted) answered in a shape not known.
    if (c[0] === "ZSCORE" && String(c[2] ?? "").startsWith("nl:upd:stop:") && (bend.zscore === "word" || bend.zscore === "list")) return bend.zscore === "word" ? "maybe" : ["1"];
    return result;
  }) as typeof redis.run;
  const pipeline = redis.pipeline;
  if (bend.zscore === "nothing") {
    redis.pipeline = (async (b: (string | number)[][]) => (b.length === 1 && b[0][0] === "ZSCORE" && String(b[0][2] ?? "").startsWith("nl:upd:stop:") ? [] : pipeline(b))) as typeof redis.pipeline;
  }
  try {
    const job = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 60_000);
    return { commands, sent: job?.sent ?? 0, status: job?.status, stops: redis.keys().filter((k) => k.startsWith("nl:upd:stop:")).length, reserved: (await monthTaken(shop)) - monthBefore, handed };
  } finally {
    redis.run = run;
    redis.pipeline = pipeline;
  }
}

async function main(): Promise<void> {
  part("One email in a batch of its own: the dearest way, at or under UPDATE_EMAIL_COMMANDS");
  const one = await measure(1);
  console.log(`  one recipient: ${one.commands} commands`);
  is("sent", one.sent, 1);
  is(`at most ${UPDATE_EMAIL_COMMANDS} commands`, one.commands <= UPDATE_EMAIL_COMMANDS, true);
  part("Each further recipient of a batch costs less than one alone");
  const fifty = await measure(50);
  console.log(`  fifty recipients: ${fifty.commands} commands, ${(fifty.commands / 50).toFixed(2)} each`);
  is("all sent", fifty.sent, 50);
  is("each under the price of one alone", fifty.commands / 50 <= UPDATE_EMAIL_COMMANDS, true);

  part("A person erased between their stop link's note and its grant (#4781): skipped, their email kept spent, the rest sent");
  const lone = await measure(1, 0);
  console.log(`  one recipient, erased meanwhile: ${lone.commands} commands, ${lone.reserved} email taken`);
  is("nothing sent, no grant kept", [lone.sent, lone.stops], [0, 0]);
  is("the email reserved for them stays taken, so the month's emails bound this path too", lone.reserved, 1);
  is(`and it costs at most ${UPDATE_EMAIL_COMMANDS} commands for that email`, lone.commands <= UPDATE_EMAIL_COMMANDS, true);
  const pair = await measure(2, 0);
  console.log(`  two recipients, the first erased meanwhile: ${pair.commands} commands, ${pair.reserved} emails taken`);
  is("the other is sent in the same run, the batch not thrown back", [pair.sent, pair.status, pair.stops], [1, "sent", 1]);
  is("two emails taken, one for each", pair.reserved, 2);
  is("each under UPDATE_EMAIL_COMMANDS", pair.commands / 2 <= UPDATE_EMAIL_COMMANDS, true);

  part("The note read again in a shape not known (7yUYU, MEDIUM): the batch waits, no grant kept with the address, nothing sent");
  for (const shape of ["word", "list", "nothing"] as const) {
    const odd = await measure(1, -1, { zscore: shape });
    is(`${shape}: the batch waits, nothing sent`, [odd.status, odd.sent, odd.handed], ["waiting", 0, 0]);
    is(`${shape}: the grant just written is taken back`, odd.stops, 0);
    is(`${shape}: the month's email given back`, odd.reserved, 0);
  }

  part("One recipient erased and the batch's send failing (7yUYU, LEVE): only what was to go out comes back");
  const failed = await measure(2, 0, { sendFails: true });
  is("nothing sent", [failed.sent, failed.handed], [0, 0]);
  is("the skipped person's email stays spent, the other's comes back", failed.reserved, 1);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
