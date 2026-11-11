/**
 * 623 [SZ7], unit 5a: the creator is told when a limited product falls to
 * their low-stock number (lib/low-stock-alert.ts, tellLowStock, on unit 4's
 * noteUnitsLeft). One email to the creator (and the phone alert, event
 * "alert") per crossing, and at most one a day per product, claimed exactly
 * before anything is sent; never when the numbers emails are stopped; never
 * on a count, a record or a claim that cannot be read. Nothing calls it yet
 * (unit 5b wires it where the units change).
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { setLowStock } from "@/lib/low-stock";
import { LOW_STOCK_EMAILS_A_DAY, tellLowStock } from "@/lib/low-stock-alert";
import { setWeeklyOff } from "@/lib/stats-report";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

// The same synthetic key as tests/store-alerts.test.ts: the Resend fixture takes only listed literals.
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "kiln.owner@example.com";
const DAY = 86_400_000;
const emails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: `email_${emails.length}` }), { status: 200 });
  }
  throw new Error(`Only synthetic email: ${url.hostname}`);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnlow", "Kiln Goods", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestKilnLow0001", true);
  await setSubscription(OWNER, { customerId: "cus_kilnlow", subscriptionId: "sub_kilnlow", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Glazed Mug", "", "30", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const product = made.product;
  const now = Date.UTC(2026, 10, 12, 15);

  part("Told once when the units fall to the number");
  is("set at 5 with 10 left", await setLowStock(store, product.id, 5, 10), "saved");
  is("10 to 7: nothing", await tellLowStock(store, product, 7, now), "no");
  is("no email yet", emails.length, 0);
  is("7 to 5: told", await tellLowStock(store, product, 5, now), "told");
  is("one email, to the creator", emails.map((e) => e.to), [OWNER]);
  is("its subject names the product and the units left", emails[0]?.subject, "Glazed Mug: 5 left");
  is("it says the number they set and where to restock", [/your low-stock number \(5\)/.test(emails[0]?.text ?? ""), /\/studio/.test(emails[0]?.text ?? "")], [true, true]);
  is("no urgency words, no buyer", /hurry|only|now!|@example\.com/i.test(emails[0]?.text.replace(OWNER, "") ?? ""), false);
  is("5 to 3: still under it, not again", await tellLowStock(store, product, 3, now), "no");
  is("still one email", emails.length, 1);

  part(`At most ${LOW_STOCK_EMAILS_A_DAY} a day per product, whatever the restocks`);
  await tellLowStock(store, product, 20, now);
  is("restocked, then down again the same day: the crossing is not said twice", await tellLowStock(store, product, 4, now), "no");
  is("still one email", emails.length, 1);
  await tellLowStock(store, product, 20, now + DAY);
  is("the next day it is told again", await tellLowStock(store, product, 4, now + DAY), "told");
  is("two emails", emails.length, 2);

  part("Stopped with the numbers emails: no email");
  await setWeeklyOff(store.handle, true);
  await tellLowStock(store, product, 20, now + 2 * DAY);
  is("crossed, with the emails stopped", await tellLowStock(store, product, 4, now + 2 * DAY), "told");
  is("no email", emails.length, 2);
  await setWeeklyOff(store.handle, false);

  part("Unknown never sends");
  is("a count that cannot be read", await tellLowStock(store, product, "4", now + 3 * DAY), "unknown");
  await tellLowStock(store, product, 20, now + 3 * DAY);
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:alert:")) ? [] : pipeline(commands));
  is("a day's claim that cannot be read: nothing sent", await tellLowStock(store, product, 4, now + 3 * DAY), "unknown");
  redis.pipeline = pipeline;
  is("no email", emails.length, 2);
  is("a product with no number", await tellLowStock(store, { ...product, id: "other00001" }, 1, now), "off");
  done();
}

void main();
