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
import { LOW_STOCK_ALERTS_A_STORE_DAY, LOW_STOCK_EMAILS_A_DAY, tellLowStock } from "@/lib/low-stock-alert";
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
let refuseEmails = false;
/** Every call to the email provider, refused or not. */
let posts = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    posts += 1;
    if (refuseEmails) return new Response(JSON.stringify({ message: "synthetic refusal" }), { status: 422 });
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
  await setStripeAccount(OWNER, "acct_1TestKilnLw1", true);
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
  // No phone answered and the emails are stopped: nobody was told, so never "told" (cloud J's LOW on #3725); the
  // crossing stays spent, since the stop is the creator's own choice.
  is("crossed, with the emails stopped and no phone: not said as told", await tellLowStock(store, product, 4, now + 2 * DAY), "no");
  is("no email", emails.length, 2);
  is("and the crossing is spent: not again the same day", await tellLowStock(store, product, 4, now + 2 * DAY), "no");
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

  part(`At most ${LOW_STOCK_ALERTS_A_STORE_DAY} a day for the whole store, however many products cross (Claude 1 and Claude 3 on #3725)`);
  emails.length = 0;
  const many: { id: string; title: string }[] = [];
  for (let i = 0; i < LOW_STOCK_ALERTS_A_STORE_DAY + 2; i += 1) {
    const extra = await addProduct(OWNER, `Bowl ${i}`, "", "30", null);
    if (!extra.ok) throw new Error("no product");
    await setLowStock(store, extra.product.id, 5, 10);
    many.push(extra.product);
  }
  const results = [];
  for (const p of many) results.push(await tellLowStock(store, p, 4, now + 5 * DAY));
  is("only the first ones are told", results.filter((r) => r === "told").length, LOW_STOCK_ALERTS_A_STORE_DAY);
  is("and only as many emails", emails.length, LOW_STOCK_ALERTS_A_STORE_DAY);
  // Past the bound nothing of the crossing is spent: the product is told the next day (Claude 3 and Revisor 1 on #3725, MEDIUM 2).
  const late = many[many.length - 1];
  is("past the bound, the same units the next day: told then", await tellLowStock(store, late, 4, now + 6 * DAY), "told");
  is("and only once", await tellLowStock(store, late, 4, now + 6 * DAY), "no");
  is("the rest are not, never unknown", results.slice(LOW_STOCK_ALERTS_A_STORE_DAY), ["no", "no"]);
  const pipe = redis.pipeline.bind(redis);
  const another = await addProduct(OWNER, "Cup", "", "30", null);
  if (!another.ok) throw new Error("no product");
  await setLowStock(store, another.product.id, 5, 10);
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "INCR" && String(c[1]).includes(":lowday:")) ? [["QUEUED"], [1]] : pipe(commands));
  is("a store count that cannot be read: nothing sent", await tellLowStock(store, another.product, 4, now + 6 * DAY), "unknown");
  redis.pipeline = pipe;
  is("and nothing of it was spent: told the next day", await tellLowStock(store, another.product, 4, now + 7 * DAY), "told");

  part("Nothing delivered, nothing spent (Revisor 1 and Claude 3 on #3725)");
  const quiet = await addProduct(OWNER, "Plate", "", "30", null);
  if (!quiet.ok) throw new Error("no product");
  await setLowStock(store, quiet.product.id, 5, 10);
  const sentBefore = emails.length;
  refuseEmails = true;
  is("the email refused and no phone to tell: unknown, never told", await tellLowStock(store, quiet.product, 4, now + 8 * DAY), "unknown");
  refuseEmails = false;
  is("so the same day, the email back: told then", await tellLowStock(store, quiet.product, 4, now + 8 * DAY), "told");
  is("one email in all", emails.length - sentBefore, 1);

  part("Whether the emails are stopped, unread: nothing spent (Claude 5 on #3725, MEDIUM 1)");
  for (const [label, odd] of [["a reply in another shape", "odd"], ["a read that throws", "throw"]] as const) {
    const item = await addProduct(OWNER, `Jug ${label}`, "", "30", null);
    if (!item.ok) throw new Error("no product");
    await setLowStock(store, item.product.id, 5, 10);
    const healthy = redis.pipeline.bind(redis);
    redis.pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "SISMEMBER")) {
        if (odd === "throw") throw new Error("Redis request failed with status 503");
        return [];
      }
      return healthy(commands);
    };
    const first = await tellLowStock(store, item.product, 4, now + 10 * DAY).catch(() => "threw");
    redis.pipeline = healthy;
    is(`${label}: unknown, never "no" and never a throw`, first, "unknown");
    is(`${label}: the crossing was not spent, so the next check tells it`, await tellLowStock(store, item.product, 4, now + 10 * DAY), "told");
  }

  part(`A send that keeps failing is tried at most ${LOW_STOCK_ALERTS_A_STORE_DAY} times a day for the store (Claude 5 on #3725, MEDIUM 2)`);
  const stuck = await addProduct(OWNER, "Saucer", "", "30", null);
  if (!stuck.ok) throw new Error("no product");
  await setLowStock(store, stuck.product.id, 5, 10);
  refuseEmails = true;
  const postsBefore = posts;
  const tries = [];
  for (let i = 0; i < 8; i += 1) tries.push(await tellLowStock(store, stuck.product, 4, now + 12 * DAY));
  refuseEmails = false;
  is(`eight checks of a refused send: at most ${LOW_STOCK_ALERTS_A_STORE_DAY} calls to the provider`, posts - postsBefore <= LOW_STOCK_ALERTS_A_STORE_DAY, true);
  is("each one unknown or no, never told", tries.every((r) => r === "unknown" || r === "no"), true);
  is("the next day it is told", await tellLowStock(store, stuck.product, 4, now + 13 * DAY), "told");

  // Codex X6 on #3725 (7059359246), MEDIUM: a crossing that cannot send (its product already told today, a record
  // changed under it, a claim taken or unknown) never takes one of the store's places for the day.
  part("Crossings that cannot send do not take the store's places for the day (Codex X6 on #3725)");
  const told = await addProduct(OWNER, "Teapot", "", "30", null);
  const next = await addProduct(OWNER, "Kettle", "", "30", null);
  if (!told.ok || !next.ok) throw new Error("no product");
  await setLowStock(store, told.product.id, 5, 10);
  await setLowStock(store, next.product.id, 5, 10);
  const day20 = now + 20 * DAY;
  is("the teapot is told", await tellLowStock(store, told.product, 4, day20), "told");
  for (let i = 0; i < LOW_STOCK_ALERTS_A_STORE_DAY + 1; i += 1) {
    await tellLowStock(store, told.product, 20, day20);
    is(`restocked and down again (${i + 1}): already told today`, await tellLowStock(store, told.product, 4, day20), "no");
  }
  is("another product's first crossing that day is still told", await tellLowStock(store, next.product, 4, day20), "told");

  // Codex X6 on #3725 (7059359246): giving back a crossing that reached nobody is one step: the day's mark and the
  // count seen are put back together, or neither is, whatever fails in between.
  part("Giving back is whole or nothing (Codex X6 on #3725)");
  const day30 = new Date(now + 30 * DAY).toISOString().slice(0, 10);
  const markOf = (id: string) => `nl:alert:${store.statsId}:low:${id}:${day30}`;
  const seenOf = async (id: string) => (JSON.parse(String((await redis.pipeline([["HGET", `nl:ls:${store.statsId}`, id]]))[0])) as { seen: number }).seen;
  for (const [label, failing] of [
    ["the count seen fails to go back", (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]).includes("contact-cas-hset") && String(c[4]) !== ""],
    ["the day's mark fails to go back", (c: (string | number)[]) => c[0] === "EVAL" && !String(c[1]).includes("contact-cas-hset") && !String(c[1]).includes("store-data")],
    ["the one step fails", (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]).includes("low-stock-give-back")],
  ] as const) {
    const item = await addProduct(OWNER, `Pitcher ${label}`, "", "30", null);
    if (!item.ok) throw new Error("no product");
    await setLowStock(store, item.product.id, 5, 10);
    refuseEmails = true;
    const healthy = redis.pipeline.bind(redis);
    let armed = false;
    redis.pipeline = async (commands) => {
      if (armed && commands.some(failing)) throw new Error("Redis request failed with status 503");
      return healthy(commands);
    };
    // Armed once the email was tried: only the give-back's own steps fail.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      armed = true;
      return realFetch(input, init);
    }) as typeof fetch;
    const result = await tellLowStock(store, item.product, 4, now + 30 * DAY).catch(() => "threw");
    globalThis.fetch = realFetch;
    redis.pipeline = healthy;
    refuseEmails = false;
    is(`${label}: unknown, never told`, result, "unknown");
    const marked = (await redis.pipeline([["GET", markOf(item.product.id)]]))[0] !== null;
    const seen = await seenOf(item.product.id);
    is(`${label}: both put back or neither (mark held: ${marked}, seen: ${seen})`, (marked && seen === 4) || (!marked && seen === 10), true);
  }
  done();
}

void main();
