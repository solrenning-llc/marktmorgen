/**
 * #5010 row 150 (coordinators f0cb, de89; held for the owner's YES; audit ea4f and 729c): a sales file
 * (app/api/store/export, what=sales) reads every sale again, and at the ten essential requests a day it could take, it
 * cost more than a Store plan carries. It now takes one of SALES_FILES_PER_MONTH files a month, a count of its own
 * (lib/sales-files.ts), never from the studio's requests or any other figure. Checked through the real route:
 *   - the owner's SALES_FILES_PER_MONTH files go, then the next is refused with how many and when it opens again,
 *     and a refusal takes no place (ea4f 7);
 *   - the count is the store's: its owner and its team share it (the owner's decision, OWNER-20261123-1205-COST-HOLDS);
 *   - the studio's requests are never touched;
 *   - a file whose sales were read keeps its place even when it fails (ea4f 9, 729c 11);
 *   - a store with no statsId is refused with nothing read (729c 13);
 *   - the button says what the files hold before the click (ea4f 6);
 *   - the cost is priced: the store's files a month at the most a file costs, the file's bytes at
 *     their most, and twice that for a store that pays nothing (729c 14).
 * Synthetic: the in-memory Redis and a Stripe stand-in.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET as exportRoute } from "@/app/api/store/export/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { allowanceUsed } from "@/lib/store-allowance";
import { SALES_FILES_PER_MONTH, SALES_FILES_UNREAD_TRIES, SALES_FILES_WORDS } from "@/lib/studio-allowance-rules";
import { SALES_FILE_MAX_BYTES } from "@/lib/stats";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { TIERS } from "@/lib/plan";
import { COST_LINES, SALES_FILES_A_MONTH, SALES_FILE_COST, SALES_FILE_UNREAD_COST, exportCost } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** How Stripe answers: "up", "down" (its first page fails), "late" (a first page answers, the next list fails). */
let stripe: "up" | "down" | "late" = "up";
/** While set, Stripe waits this long, so two downloads overlap. */
let slow = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com") {
    if (slow) await new Promise((resolve) => setTimeout(resolve, slow));
    const fail = () => new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 500 });
    if (stripe === "down") return fail();
    if (stripe === "late" && url.pathname.includes("/payment_intents")) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return fail();
    }
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "sales-files-owner@example.com";
const ADMIN = "sales-files-admin@example.com";

async function shop(owner: string, handle: string, statsId = true) {
  await claimHandle(owner, handle, `${handle} store`, "");
  if (statsId) await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1${handle.slice(0, 10).padEnd(10, "0")}00001`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_sales_files_month_only";
  const store = await shop(OWNER, "salesfiles");
  if (!(await putMember(store, ADMIN, "admin"))) throw new Error("setup: admin");
  const owner = await openSession(OWNER);
  const admin = await openSession(ADMIN);
  const get = (session: string, sid = store.sid) => exportRoute(new NextRequest(`https://marktmorgen.com/api/store/export?what=sales&range=all&store=${sid}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  const count = async (part: string) => Number((await redis.pipeline([["GET", redis.keys().find((key) => key.startsWith(`nl:rl:export:${store.statsId}:${part}:`)) ?? "none"]]))[0] ?? 0);
  // The route's own ten-minute count of files (EXPORTS_PER_WINDOW) and the store's essential requests of the day are
  // not what these parts check: they start again, as on another day.
  const fresh = async () => { await redis.pipeline([["DEL", `nl:rl:export:${store.statsId}`], ...redis.keys().filter((key) => key.includes("studio-essential")).map((key) => ["DEL", key])]); };
  const studioBefore = await allowanceUsed(store, "studio");

  part("Stripe failing before anything was read: nothing counted, and said so (focal 3634, 4)");
  stripe = "down";
  const down = await get(owner);
  stripe = "up";
  const downWords = await down.text();
  is("502, nothing counted, all files left", [down.status, downWords.includes("Nothing was counted"), downWords.includes(`${SALES_FILES_PER_MONTH} sales files are left this month`), await count("sales")], [502, true, true, 0]);

  part("Two clicks at once: one file, the second waits with nothing counted (focal 3634, 5)");
  slow = 40;
  const [a, b] = await Promise.all([get(owner), get(owner)]);
  slow = 0;
  const busy = a.status === 429 ? a : b;
  is("one file, one refusal", [a.status, b.status].sort(), [200, 429]);
  is("the refusal says it is being made", (await busy.text()).startsWith("Your sales file is already being made."), true);
  is("one counted", await count("sales"), 1);

  part("Stripe failing after its first page: the try counts, and says how many are left");
  stripe = "late";
  const late = await get(owner);
  stripe = "up";
  const lateWords = await late.text();
  is("502, counted", [late.status, lateWords.includes("This try counted"), await count("sales")], [502, true, 2]);
  is("how many are left", lateWords.includes(`${SALES_FILES_PER_MONTH - 2 === 1 ? "1 sales file is" : `${SALES_FILES_PER_MONTH - 2} sales files are`} left this month`), true);

  part(`The owner's ${SALES_FILES_PER_MONTH} files, then a plain refusal that takes no place`);
  await fresh();
  for (let i = 2; i < SALES_FILES_PER_MONTH; i += 1) is("a file", (await get(owner)).status, 200);
  const refused = await get(owner);
  const words = await refused.text();
  is("the next is refused", refused.status, 429);
  is("saying they are used, that a read try counts, and when it opens again", [words.includes(`You have used all ${SALES_FILES_PER_MONTH} sales files this month`), words.includes("A try counts once your sales were read"), /opens again/.test(words)], [true, true, true]);
  await get(owner);
  is("a refusal takes no place", await count("sales"), SALES_FILES_PER_MONTH);

  part("The count is the store's: its owner and its team share it (the owner's decision, OWNER-20261123-1205-COST-HOLDS)");
  await fresh();
  // A new month for this part: the files the owner used above are cleared.
  await redis.pipeline(redis.keys().filter((key) => key.startsWith(`nl:rl:export:${store.statsId}:sales:`)).map((key) => ["DEL", key]));
  const shared: number[] = [];
  for (let i = 1; i < SALES_FILES_PER_MONTH; i += 1) shared.push((await get(owner)).status);
  shared.push((await get(admin)).status);
  const adminRefused = await get(admin);
  const ownerRefused = await get(owner);
  is(`the owner's and an Admin's files together come to ${SALES_FILES_PER_MONTH}, then both are refused`, [...shared, adminRefused.status, ownerRefused.status], [...Array.from({ length: SALES_FILES_PER_MONTH }, () => 200), 429, 429]);
  is("an Admin is told the store's files are used", (await adminRefused.text()).includes(`Your store has used all ${SALES_FILES_PER_MONTH} sales files this month`), true);
  is("one count, the store's", [await count("sales"), redis.keys().some((k) => k.includes(":sales-team:"))], [SALES_FILES_PER_MONTH, false]);
  is("the studio's requests were never touched", (await allowanceUsed(store, "studio")) - studioBefore, 0);

  part(`Only ${SALES_FILES_UNREAD_TRIES} tries a month that read nothing give their place back`);
  {
    const OTHER = "sales-files-unread@example.com";
    const other = await shop(OTHER, "salesunread");
    const session = await openSession(OTHER);
    stripe = "down";
    for (let i = 0; i <= SALES_FILES_UNREAD_TRIES; i += 1) await get(session, other.sid);
    stripe = "up";
    const key = redis.keys().find((k) => k.startsWith(`nl:rl:export:${other.statsId}:sales:`));
    is(`the try past them counts`, Number((await redis.pipeline([["GET", key ?? "none"]]))[0] ?? 0), 1);
  }

  part("A store with no statsId is refused with a lasting reason, nothing read (729c 13; focal 3634, 5)");
  {
    const { takeSalesFile, SALES_FILES_NO_STORE_ID } = await import("@/lib/sales-files");
    const answer = await takeSalesFile({ ...store, statsId: "" }, true);
    is("503, saying to write to us, not to try again in a minute", answer.ok ? [0, ""] : [answer.status, answer.message], [503, SALES_FILES_NO_STORE_ID]);
    is("the route makes one first (ensureStatsId)", /store\.statsId \|\| !isRedisConfigured\(\) \? store : \(\(await ensureStatsId\(storeRef\(store\)\)\)/.test(readFileSync("app/api/store/export/route.ts", "utf8")), true);
  }

  part("Said before the click, and in plain words");
  is("the button's note", SALES_FILES_WORDS, `Your store can download up to ${SALES_FILES_PER_MONTH} sales files a month (or in a trial), shared by its owner and team. A try counts once your sales are read. They never use up your monthly figures.`);
  is("the studio's button is described by it", /aria-describedby="sales-files-note"[\s\S]{0,200}id="sales-files-note"[^>]*>\{SALES_FILES_WORDS\}/.test(readFileSync("components/stats-panel.tsx", "utf8")), true);
  is("so is the paused page's", /aria-describedby="paused-sales-files-note"[\s\S]{0,200}id="paused-sales-files-note"[^>]*>\{SALES_FILES_WORDS\}/.test(readFileSync("app/studio/paused/page.tsx", "utf8")), true);
  is("the public page says how many", readFileSync("lib/site-pages.ts", "utf8").includes("up to ${SALES_FILES_PER_MONTH} times a month"), true);

  part("Its cost is priced, for a store that pays and one that pays nothing");
  const line = COST_LINES.find((l) => l.id === "sales-files");
  is("its line is in the registry", Boolean(line), true);
  is("the store's, one count", SALES_FILES_A_MONTH, SALES_FILES_PER_MONTH);
  for (const tier of TIERS) is(`${tier}: ${SALES_FILES_A_MONTH} files a month at the most a file costs, and the tries that read nothing`, line ? Math.abs(line.monthlyUsd(tier) - (SALES_FILES_A_MONTH * SALES_FILE_COST + SALES_FILES_UNREAD_TRIES * SALES_FILE_UNREAD_COST)) < 1e-12 : false, true);
  is("a file's cost carries its bytes sent, at their most", SALES_FILE_COST > exportCost(1) && SALES_FILE_MAX_BYTES > 0, true);
  is("a store that pays nothing carries a trial's files and the month's after it", /\+ 2 \* \(SALES_FILES_A_MONTH \* SALES_FILE_COST \+ SALES_FILES_UNREAD_TRIES \* SALES_FILE_UNREAD_COST\)/.test(readFileSync("tests/plan-cost-registry.ts", "utf8")), true);

  done();
}

void main().catch((error) => {
  console.log(error);
  process.exit(1);
});
