/**
 * The affiliate book names a membership's or plan's payment from the product's
 * card (nl:catalog:<id>:t, one HMGET of the products asked), not from its whole
 * listing record (lib/affiliates.ts recurringReferrals; lib/catalog.ts
 * readCardsFor). Measured in the sibling-routes cost study of 7 November 2026
 * (A2): at 1,000 products the book read up to 16 KB a product only for a title.
 * Checked on the real code path, synthetic data only:
 *
 *   - no listing record is read for a product past the head that has its card;
 *     the cards come in one HMGET of the products the invoices name;
 *   - the titles, the lines and the spreadsheet are byte for byte the ones the
 *     listings give (healthy control: with no card at all, read from listings);
 *   - a product written before the cards existed is read from its listing once,
 *     and its card is left behind, so the next reading reads no listing;
 *   - a card in an older shape is never taken for a title: read from its listing;
 *   - the cards' reply in any shape other than one string or nil per product is
 *     unknown (rule 24): readCardsFor throws, and the book keeps every line, as
 *     when the listings could not be read.
 */
import { readBook, bookCsv, listAffiliates } from "@/lib/affiliates";
import * as catalog from "@/lib/catalog";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_book_titles_stand_in";

const OWNER = "owner@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const SARA = "0123456789ab";
const PRODUCTS = 40;

let invoices: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/invoices") return answer({ object: "list", data: invoices, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Seen = { command: (string | number)[]; reply: unknown };
let seen: Seen[] = [];
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await original(commands);
  commands.forEach((command, i) => seen.push({ command, reply: replies[i] }));
  return replies;
}) as typeof redis.pipeline;

const listingGets = (cat: string) => seen.filter((s) => s.command[0] === "GET" && String(s.command[1]).startsWith(`nl:catalog:${cat}:l:`));
const listingBytes = (cat: string) => listingGets(cat).reduce((sum, s) => sum + (typeof s.reply === "string" ? Buffer.byteLength(s.reply) : 0), 0);
const cardReads = (cat: string) => seen.filter((s) => String(s.command[1]) === `nl:catalog:${cat}:t` && (s.command[0] === "HMGET" || s.command[0] === "HGETALL"));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const ids: string[] = [];
  const titles = new Map<string, string>();
  for (let i = 0; i < PRODUCTS; i += 1) {
    // Titles with what a CSV has to quote, and letters past ASCII.
    const title = i % 3 === 0 ? `Supper Club, "Table ${i}"` : i % 3 === 1 ? `Café ${i} — monthly` : `Plan ${i}`;
    const made = await addProduct(OWNER, title, "", "20", { interval: "month", trialDays: 0, payments: 0 });
    if (!made.ok) throw new Error("no product");
    ids.push(made.product.id);
    titles.set(made.product.id, title);
  }
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, recurring: 12 });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const cat = store.catalog.id!;
  const head = new Set(store.catalog.head.map((l) => l.id));
  const pastHead = ids.filter((id) => !head.has(id));
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, SARA, JSON.stringify({ id: SARA, email: "sara@example.com", code: "sara", status: "approved", appliedAt: (NOW - 400 * DAY) * 1000, decidedAt: 1, note: "" })],
  ]);
  invoices = ids.map((product, i) => ({
    id: `in_Title${String(i).padStart(7, "0")}`,
    status: "paid",
    amount_paid: 2000,
    currency: "usd",
    customer_email: "member@example.com",
    created: NOW - DAY - i,
    status_transitions: { paid_at: NOW - DAY - i },
    total_taxes: [],
    parent: { subscription_details: { metadata: { store: "harbor", product, via: SARA, via_rate: "30", via_months: "12", via_at: String(NOW - 30 * DAY) } } },
    payments: { data: [{ payment: { type: "payment_intent", payment_intent: `pi_title_${i}` } }] },
  }));
  const csvOf = async () => bookCsv(await readBook(store), await listAffiliates(store));
  const titleOf = (book: Awaited<ReturnType<typeof readBook>>) => new Map(book.lines.filter((l) => l.how === "recurring").map((l) => [l.product, l.title]));

  part("Healthy control: no card at all, every title from its listing");
  const cards = (await redis.pipeline([["HGETALL", `nl:catalog:${cat}:t`]]))[0] as string[];
  await redis.pipeline([["DEL", `nl:catalog:${cat}:t`]]);
  seen = [];
  const fromListings = await csvOf();
  const byListings = titleOf(await readBook(store));
  is("every payment named after its product", ids.map((id) => byListings.get(id)), ids.map((id) => titles.get(id)));
  is("a store with no cards heals: each product past the head read from its listing once, its card left behind", (await redis.pipeline([["HLEN", `nl:catalog:${cat}:t`]]))[0], pastHead.length);
  // Put the cards back exactly as the products wrote them.
  await redis.pipeline([["DEL", `nl:catalog:${cat}:t`], ["HSET", `nl:catalog:${cat}:t`, ...cards]]);

  part("With its cards, the book reads no listing record");
  seen = [];
  const book = await readBook(store);
  is("no listing record GET for a product past the head", listingGets(cat).length, 0);
  is("no listing byte read for a title", listingBytes(cat), 0);
  is("the cards read in one HMGET of the products the invoices name", cardReads(cat).map((s) => [s.command[0], s.command.length - 2]), [["HMGET", pastHead.length]]);
  is("the same titles", ids.map((id) => titleOf(book).get(id)), ids.map((id) => titles.get(id)));
  is("the same spreadsheet, byte for byte", await csvOf(), fromListings);
  is("invoices still checked", book.invoicesChecked, true);

  part("A product written before the cards existed, and one in an older shape");
  const legacy = pastHead.slice(0, 3);
  const older = pastHead[3];
  await redis.pipeline([["HDEL", `nl:catalog:${cat}:t`, ...legacy], ["HSET", `nl:catalog:${cat}:t`, older, JSON.stringify("Wrong title")]]);
  seen = [];
  const healed = await readBook(store);
  is("only those four read from their listings", listingGets(cat).map((s) => String(s.command[1]).split(":l:")[1]).sort(), [...legacy, older].sort());
  is("their titles from the listings, never the older card's", [...legacy, older].map((id) => titleOf(healed).get(id)), [...legacy, older].map((id) => titles.get(id)));
  is("their cards left behind", ((await redis.pipeline([["HMGET", `nl:catalog:${cat}:t`, ...legacy, older]]))[0] as unknown[]).map((raw) => (typeof raw === "string" ? (JSON.parse(raw) as unknown[])[0] : raw)), [...legacy, older].map((id) => titles.get(id)));
  seen = [];
  await readBook(store);
  is("so the next reading reads no listing", listingGets(cat).length, 0);
  is("and the spreadsheet is still the same", await csvOf(), fromListings);

  part("A product taken off the store keeps its line, without a title, as before");
  store = (await storeForEmail(OWNER))!;
  const gone = { ...store, catalog: { ...store.catalog, items: store.catalog.items.filter((item) => item.id !== pastHead[5]) } };
  seen = [];
  const without = await readBook(gone);
  is("its line kept, its title empty, nothing read for it", [titleOf(without).get(pastHead[5]), cardReads(cat)[0]?.command.includes(pastHead[5]) ?? false, listingGets(cat).length], ["", false, 0]);

  part("The cards' reply in another shape is unknown (rule 24)");
  const readCardsFor = (catalog as unknown as Record<string, unknown>).readCardsFor as ((s: typeof store, ids: string[]) => Promise<Map<string, { title: string }>>) | undefined;
  is("readCardsFor is built", typeof readCardsFor, "function");
  const shapes: [string, (cmds: (string | number)[][]) => unknown[]][] = [
    ["no reply", () => []],
    ["not a list", () => ["x"]],
    ["one slot short", (cmds) => [new Array(cmds[0].length - 3).fill(null)]],
    ["a number in a slot", (cmds) => [new Array(cmds[0].length - 2).fill(7)]],
  ];
  for (const [name, reply] of shapes) {
    const healthy = redis.pipeline;
    redis.pipeline = (async (cmds: (string | number)[][]) => (cmds[0]?.[0] === "HMGET" && String(cmds[0][1]) === `nl:catalog:${cat}:t` ? reply(cmds) : healthy(cmds))) as typeof redis.pipeline;
    try {
      let thrown: unknown = null;
      try {
        if (readCardsFor) await readCardsFor(store, pastHead);
      } catch (error) {
        thrown = error;
      }
      is(`${name}: UnknownReplyError, never a title`, thrown instanceof UnknownReplyError, true);
      const kept = await readBook(store);
      is(`${name}: the book keeps every line, its invoices checked, as when the listings could not be read`, [kept.lines.filter((l) => l.how === "recurring").length, kept.invoicesChecked], [PRODUCTS, true]);
    } finally {
      redis.pipeline = healthy;
    }
  }

  part("Confirmed absence: a product with neither card nor listing");
  await redis.pipeline([["HDEL", `nl:catalog:${cat}:t`, pastHead[6]], ["DEL", `nl:catalog:${cat}:l:${pastHead[6]}`]]);
  const absent = await readBook(store);
  is("its line kept, without a title", titleOf(absent).get(pastHead[6]), "");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
