/**
 * Counting who an email would reach reads the whole list, so it is paid by
 * what it reads (C5 audit of 09/11/2026, MEDIUM 2; the auditor's proof is
 * aud-mkt-proof-count-scan). One studio request is priced at twenty-odd
 * commands and fifty kilobytes (UNIT_COST.studio), and a list of 5,000
 * people moves 3.7 MB: the composer's "count" and a broadcast written down
 * read it for ONE request. Now the list's size is read exactly first (HLEN),
 * the requests for the most it can weigh are held BEFORE any page is read
 * (refused with nothing read when they are not there), and once it is read
 * the held ones are given back down to what it moved, or counted past when a
 * record weighed more than the most expected: a megabyte a request, as the
 * buyers' ledger is counted.
 *
 * Synthetic records only; no email is sent.
 */
import { readFileSync } from "node:fs";
import { createBroadcast } from "@/lib/broadcasts";
import { leadsKey } from "@/lib/contacts";
import { holdStudio } from "@/lib/studio-route";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { type Store, addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "count-owner@example.com";
const studioKey = () => redis.keys().find((key) => key.startsWith("nl:allow:studio:") && !key.includes(":day:"));
const used = async () => Number((await redis.pipeline([["GET", studioKey()!]]))[0] ?? 0);
const setUsed = (n: number) => redis.pipeline([["SET", studioKey()!, String(n)]]);

function record(titles: string[], i: number): string {
  return JSON.stringify({ agreed: true, agreedAt: "2026-10-01T00:00:00.000Z", firstAt: "2026-10-01T00:00:00.000Z", lastAt: "2026-11-01T00:00:00.000Z", titles, ids: ["prod00000001"], source: "free", unsub: false, unsubAt: "", t: "a".repeat(40), name: `Reader ${i}`, tags: ["watercolor"], importedAt: "" });
}

async function fill(listId: string, people: number, titles: string[]): Promise<void> {
  await redis.pipeline([["DEL", leadsKey(listId)]]);
  const rows: (string | number)[] = [];
  for (let i = 0; i < people; i += 1) rows.push(`reader${i}@example.com`, record(titles, i));
  await redis.pipeline([["HSET", leadsKey(listId), ...rows]]);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_count_only_a_stand_in";
  await claimHandle(OWNER, "countshop", "Count Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestCount0001", true);
  await setSubscription(OWNER, { customerId: "cus_CountTest0001", subscriptionId: "sub_CountTest0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Lee at Count", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(OWNER, "Count Guide", "", "27", null);
  if (!made.ok) throw new Error("no product");
  const load = async (): Promise<Store> => (await storeForEmail(OWNER))!;
  const shop = await load();
  const listId = shop.listId as string;
  const input = { subject: "Hello", body: "News for everyone on the list.", productId: "", notProductId: "", sendAt: undefined, who: "all" };
  const hold = (store: Store) => (units: number) => holdStudio(store, units);

  // What the database was asked, in order, so "before anything is read" is a fact and not a hope.
  const real = redis.pipeline.bind(redis);
  const seen: string[] = [];
  (redis as unknown as { pipeline: typeof real }).pipeline = async (commands) => {
    for (const c of commands) seen.push(String(c[0]));
    return real(commands);
  };
  const scans = () => seen.filter((c) => c === "HSCAN").length;

  part("A list of 5,000 people: the held requests are taken before any page is read, then settled at what was moved");
  const titles = Array.from({ length: 6 }, (_, i) => `The Complete Watercolor Course, part ${i + 1}`);
  await fill(listId, 5_000, titles);
  // Count the studio's own counter in the window running now.
  await holdStudio(shop, 1);
  const before = await used();
  seen.length = 0;
  let scansWhenHeld = -1;
  const asked: number[] = [];
  const spy = (units: number) => {
    asked.push(units);
    scansWhenHeld = scans();
    return holdStudio(shop, units);
  };
  const made1 = await createBroadcast(shop, input, undefined, spy);
  is("it is written down", made1.ok, true);
  is("the requests were asked for once, before the first page was read", [asked.length, scansWhenHeld], [1, 0]);
  // What the list weighs as it is read: every address and record, a megabyte a request after the request's own fifty kilobytes.
  const weight = 5_000 * (Buffer.byteLength("reader4999@example.com") + Buffer.byteLength(record(titles, 4_999)));
  const owed = Math.ceil(weight / 1_000_000);
  is("what stays taken is what the list moved, a megabyte a request, not what was held", [(await used()) - before, asked[0] > owed], [owed, true]);

  part("Too few requests left: refused with the sentence, nothing read, nothing written");
  const figure = allowanceFor(shop, "studio");
  await setUsed(figure - 2);
  seen.length = 0;
  const written = redis.keys().filter((k) => k.startsWith("nl:mail:bc:")).length;
  const refused = await createBroadcast(shop, input, undefined, hold(shop));
  is("refused as the studio's requests used", refused.ok ? "written" : refused.reason, "studio_used");
  is("no page of the list was read", scans(), 0);
  is("nothing was written", redis.keys().filter((k) => k.startsWith("nl:mail:bc:")).length, written);
  is("and nothing stays taken", await used(), figure - 2);

  part("A reply for the list's size that is not a whole number: unknown, so nothing is read");
  await setUsed(before);
  (redis as unknown as { pipeline: typeof real }).pipeline = async (commands) => {
    for (const c of commands) seen.push(String(c[0]));
    const out = await real(commands);
    return commands.map((c, i) => (c[0] === "HLEN" && String(c[1]) === leadsKey(listId) ? null : out[i])) as typeof out;
  };
  seen.length = 0;
  const unknown = await createBroadcast(shop, input, undefined, hold(shop)).then(() => "went on", () => "refused");
  is("it is refused and no page is read", [unknown, scans()], ["refused", 0]);
  (redis as unknown as { pipeline: typeof real }).pipeline = async (commands) => {
    for (const c of commands) seen.push(String(c[0]));
    return real(commands);
  };

  part("A few people: within the request's own fifty kilobytes, nothing more is taken");
  await fill(listId, 3, ["Guide"]);
  await setUsed(before);
  const small = await createBroadcast(shop, input, undefined, hold(shop));
  is("written and no extra request taken", [small.ok, (await used()) - before], [true, 0]);

  part("Records far heavier than the most expected: counted past what was held");
  // 100 people with 20 titles of 4,000 characters: about 8 MB, where 100 records were held at the most expected.
  const heavyTitles = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(4_000, "t"));
  await fill(listId, 100, heavyTitles);
  await setUsed(before);
  const heavy = await createBroadcast(shop, input, undefined, hold(shop));
  const heavyOwed = Math.ceil((100 * (Buffer.byteLength("reader99@example.com") + Buffer.byteLength(record(heavyTitles, 99)))) / 1_000_000);
  is("written, and what stays taken is what it really moved, not what was held", [heavy.ok, (await used()) - before], [true, heavyOwed]);

  part("Ten such records: the most expected fits the request's own fifty kilobytes, so nothing is held first, and what they moved is counted after");
  await fill(listId, 10, heavyTitles);
  await setUsed(before);
  const asks: number[] = [];
  const ten = await createBroadcast(shop, input, undefined, (units) => {
    asks.push(units);
    return holdStudio(shop, units);
  });
  const tenOwed = Math.ceil((10 * (Buffer.byteLength("reader9@example.com") + Buffer.byteLength(record(heavyTitles, 9)))) / 1_000_000);
  is("written; the figure was asked for only once the pages were read, at what they moved", [ten.ok, asks, (await used()) - before], [true, [tenOwed], tenOwed]);

  part("The studio's route reads the audience only through the counted read");
  const route = readFileSync("app/api/store/mail/route.ts", "utf8").replace(/\s+/g, " ");
  is("no bare read of the whole list in the route", /[^a-zA-Z]audience\(store\.listId/.test(route), false);
  is("the studio's requests are taken through holdStudio", route.includes("holdStudio(studio, units)"), true);
  is("the broadcast is given that hold", route.includes("}, counting.count, hold)"), true);
  is("the count reads through the counted read, narrowed or not", (route.match(/countedAudience\(hold, store\.listId/g) ?? []).length, 2);
  done();
}

void main();
