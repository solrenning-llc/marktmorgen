/**
 * The affiliate's page across every store (app/affiliate/page.tsx) never
 * tells a person something false when a read fails (rule 24; nothing false
 * shown to a person):
 *   - a store, or the affiliate's record at it, that could not be read is not
 *     silently dropped, and the page never says "Nothing is listed for this
 *     address any more" because of it;
 *   - a cut the creator announced is never left out because the product
 *     names could not be read.
 * A store that is truly gone still leaves the page without a word, and with
 * none left the page still says nothing is listed.
 */
import { renderToStaticMarkup } from "react-dom/server";
import AffiliateHubPage from "@/app/affiliate/page";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { joinAsBuyer } from "@/lib/affiliates";
import { requestHubLink } from "@/lib/affiliate-hub";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

const NOTHING = "Nothing is listed for this address any more";
const UNREAD = "could not be read just now";

const sent: { to: string; text: string }[] = [];
const sessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    sent.push({ to: [body.to].flat()[0], text: body.text });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  const m = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  const found = m ? sessions.get(m[1]) : undefined;
  return new Response(JSON.stringify(found ?? { error: { message: "No such checkout.session" } }), { status: found ? 200 : 404 });
}) as typeof fetch;

/** Runs `work` with every pipeline that touches a key `failing` picks thrown, as a lost connection would be. */
async function failing<T>(fails: (key: string) => boolean, work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.some((command) => fails(String(command[1] ?? "")))) throw new Error("connection reset");
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** Runs `work` with every pipeline whose commands `matches` picks answered by `reply` (a short, odd or broken answer). */
async function answering<T>(matches: (commands: Commands) => boolean, reply: (commands: Commands) => unknown[], work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => (matches(commands) ? reply(commands) : original.call(redis, commands))) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const EXPIRED = "That link has expired or was already replaced";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_hub_only_a_stand_in";
  process.env.STRIPE_SECRET_KEY = "sk_test_hub_only_a_stand_in";
  for (const [email, handle, name, account] of [
    ["one@example.com", "harbor", "Harbor Kitchen", "acct_1TestHarbor0001"],
    ["two@example.com", "lantern", "Lantern Press", "acct_1TestLantern001"],
  ] as const) {
    if (!(await claimHandle(email, handle, name, "")).ok) throw new Error("no store");
    await ensureStoreId(email);
    await ensureStatsId(email);
    await setStripeAccount(email, account, true);
    await setAffiliateSetting(email, { ...NO_AFFILIATES, enabled: true, buyers: true, rates: {} });
  }
  // More products than the store's first page before it, so this one's name is read from its own record.
  for (let i = 0; i < 25; i += 1) await addProduct("one@example.com", `Filler ${i}`, "", "5");
  const made = await addProduct("one@example.com", "Knife Skills", "", "40");
  const product = made.ok ? made.product.id : "";
  const harbor = (await storeForEmail("one@example.com"))!;
  const lantern = (await storeForEmail("two@example.com"))!;
  for (const [id, handle] of [["cs_test_hubharbor0001", "harbor"], ["cs_test_hublantern001", "lantern"]] as const) {
    sessions.set(id, {
      id,
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      amount_total: 2700,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
      customer_details: { email: "dana@example.com" },
      metadata: { store: handle, product: "p8w2m4q9zz" },
    });
  }
  if (!(await joinAsBuyer(harbor, "cs_test_hubharbor0001")).ok || !(await joinAsBuyer(lantern, "cs_test_hublantern001")).ok) throw new Error("not joined");
  await requestHubLink({ email: "dana@example.com", ip: "203.0.113.9", origin: "https://marktmorgen.com" });
  const token = sent.at(-1)?.text.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
  const page = async () => renderToStaticMarkup(await AffiliateHubPage({ searchParams: Promise.resolve({ token }) }));
  // A page that throws is shown as the generic error page, never this one: kept as text so every check still runs.
  const safe = async () => {
    try {
      return await page();
    } catch (error) {
      return `the page threw: ${String(error)}`;
    }
  };
  const shown = (html: string) => [...html.matchAll(/data-hub-store="([a-z]+)"/g)].map((m) => m[1]).sort();

  part("Healthy control");
  const healthy = await page();
  is("both stores are listed", shown(healthy), ["harbor", "lantern"]);
  is("and nothing is said to be unread", healthy.includes(UNREAD), false);

  part("A store that could not be read is never silently gone");
  const lanternId = `nl:store:id:${lantern.sid}`;
  const one = await failing((key) => key === lanternId, page);
  is("the store that was read is listed", shown(one), ["harbor"]);
  is("the page says one could not be read just now", one.includes(UNREAD), true);
  const both = await failing((key) => key.startsWith("nl:store:id:"), page);
  is("none read: never 'nothing is listed'", both.includes(NOTHING), false);
  is("none read: said as not read just now", both.includes(UNREAD), true);

  part("An affiliate record that could not be read is never silently gone");
  const record = await failing((key) => key === `nl:aff:${lantern.statsId}:emails`, page);
  is("the store that was read is listed", shown(record), ["harbor"]);
  is("the page says one could not be read just now", record.includes(UNREAD), true);
  const records = await failing((key) => /^nl:aff:.*:emails$/.test(key), page);
  is("none read: never 'nothing is listed'", records.includes(NOTHING), false);
  is("none read: said as not read just now", records.includes(UNREAD), true);

  part("A cut the creator announced is never left out for an unread product name");
  const from = Math.floor(Date.now() / 1000) + 14 * 86_400;
  await setAffiliateSetting("one@example.com", { ...NO_AFFILIATES, enabled: true, buyers: true, rates: { [product]: 40 }, pending: { ...NO_AFFILIATES, rates: { [product]: 0 }, from } } as typeof NO_AFFILIATES);
  is("the product's name is read from its own record, not the first page", (await storeForEmail("one@example.com"))!.catalog.head.some((l) => l.id === product), false);
  const cut = await page();
  is("healthy: the cut is shown, with the product's name", [cut.includes("data-hub-cut"), cut.includes("Knife Skills: leaves the program (was 40%).")], [true, true]);
  const unnamed = await failing((key) => key.startsWith("nl:catalog:") && key.includes(":l:"), page);
  is("names unread: the notice is still shown", unnamed.includes("data-hub-cut"), true);
  is("names unread: said as not read just now", unnamed.includes(UNREAD), true);

  part("The link's own read, answered in an unknown shape or failing, is never 'expired' (Claude 5 MEDIUM 1a, LEVE 1)");
  const isLink = (commands: Commands) => commands.some((command) => command[0] === "GET" && String(command[1]).startsWith("nl:affhub:link:"));
  for (const [name, reply] of [["no reply", []], ["a number", [42]], ["a list", [["x"]]]] as const) {
    const html = await answering(isLink, () => [...reply], safe);
    is(`${name}: never 'expired'`, html.includes(EXPIRED), false);
    is(`${name}: said as not read just now`, html.includes(UNREAD), true);
  }
  const lost = await failing((key) => key.startsWith("nl:affhub:link:"), safe);
  is("a failed read: never 'expired'", lost.includes(EXPIRED), false);
  is("a failed read: said as not read just now, not a broken page", lost.includes(UNREAD), true);

  part("The list of stores, answered short or failing, is never 'nothing is listed' (Codex P MEDIUM, Claude 5 LEVE 1)");
  const isUnion = (commands: Commands) => commands.some((command) => command[0] === "SUNION");
  for (const [name, reply] of [["no reply", []], ["not a list", ["x"]]] as const) {
    const html = await answering(isUnion, () => [...reply], safe);
    is(`${name}: never 'nothing is listed'`, html.includes(NOTHING), false);
    is(`${name}: said as not read just now`, html.includes(UNREAD), true);
  }
  const unionLost = await failing((key) => key.startsWith("nl:affhub:") && !key.startsWith("nl:affhub:link:"), safe);
  is("a failed read: never 'nothing is listed'", unionLost.includes(NOTHING), false);
  is("a failed read: said as not read just now, not a broken page", unionLost.includes(UNREAD), true);

  part("A store, or its affiliate record, answered in an unknown shape is never silently gone (Codex P MEDIUM, Claude 5 MEDIUM 1b)");
  const getOf = (key: string) => (commands: Commands) => commands.some((command) => command[1] === key);
  for (const [name, key, reply] of [
    ["the store's id, no reply", `nl:store:id:${lantern.sid}`, []],
    ["the store's id, a number", `nl:store:id:${lantern.sid}`, [7]],
    ["the affiliate's index, no reply", `nl:aff:${lantern.statsId}:emails`, []],
    ["the affiliate's index, a number", `nl:aff:${lantern.statsId}:emails`, [7]],
    ["the affiliate's record, not readable", `nl:aff:${lantern.statsId}:people`, ["{not json"]],
    ["the affiliate's record, no reply", `nl:aff:${lantern.statsId}:people`, []],
  ] as const) {
    const html = await answering(getOf(key), () => [...reply], safe);
    is(`${name}: the store that was read is listed`, shown(html), ["harbor"]);
    is(`${name}: said as not read just now`, html.includes(UNREAD), true);
  }

  part("A cut the creator announced is never left out for a product name answered short (Codex P MEDIUM)");
  await setAffiliateSetting("one@example.com", { ...NO_AFFILIATES, enabled: true, buyers: true, rates: { [product]: 40 }, pending: { ...NO_AFFILIATES, rates: { [product]: 0 }, from: Math.floor(Date.now() / 1000) + 14 * 86_400 } } as typeof NO_AFFILIATES);
  const isListing = (commands: Commands) => commands.some((command) => command[0] === "GET" && String(command[1]).startsWith("nl:catalog:") && String(command[1]).includes(":l:"));
  for (const [name, reply] of [["no reply", () => []], ["a number", (commands: Commands) => commands.map(() => 7)], ["not a listing", (commands: Commands) => commands.map(() => "{not json")]] as const) {
    const html = await answering(isListing, reply, safe);
    is(`${name}: the notice is still shown`, html.includes("data-hub-cut"), true);
    is(`${name}: said as not read just now`, html.includes(UNREAD), true);
  }
  const named = await safe();
  is("control: healthy, the cut is shown with the product's name and nothing unread", [named.includes("Knife Skills: leaves the program (was 40%)."), named.includes(UNREAD)], [true, false]);
  await setAffiliateSetting("one@example.com", { ...NO_AFFILIATES, enabled: true, buyers: true, rates: {} });

  part("Confirmed absence stays as it was");
  await redis.pipeline([["DEL", lanternId]]);
  const gone = await page();
  is("a store that is gone leaves the page without a word", [shown(gone), gone.includes(UNREAD)], [["harbor"], false]);
  await redis.pipeline([["DEL", `nl:store:id:${harbor.sid}`]]);
  const none = await page();
  is("none left: nothing is listed, and nothing said to be unread", [none.includes(NOTHING), none.includes(UNREAD)], [true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
