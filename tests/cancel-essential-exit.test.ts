/**
 * A member's way out of a membership is essential (ALTO 2 of the audit of the
 * subscriptions creators sell, 9 November 2026; MÉDIO 4 and LEVE 5 with it).
 *
 *   - Cancel, Open (Stripe's billing page) and Pause read the emailed link
 *     before anything of the store's is spent: an invented token is "expired"
 *     and leaves the store's month of requests where it was.
 *   - With the store's month of requests used, Cancel and Open still reach
 *     Stripe, and Pause is not refused by the window: counted on their own
 *     figures (lib/essential-exit.ts), never by the store's month.
 *   - With the store's access-email figure used, the link to manage a
 *     membership is still sent, and counted.
 *   - What they do past the store's month is bounded per connection, per
 *     member and per store, and the refusal says what is true ("daily"), in
 *     every language, never "Try again in an hour".
 *   - The member's pages are counted as a buyer's request (MÉDIO 4).
 *   - A card link is deleted with the person (LEVE 5).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST as cancelRoute } from "@/app/api/store/manage/cancel/route";
import { POST as openRoute } from "@/app/api/store/manage/open/route";
import { POST as pauseRoute } from "@/app/api/store/manage/pause/route";
import { requestManageLink } from "@/lib/membership-manage";
import { requestsIn, takePublicRequest } from "@/lib/traffic";
import { takeAllowance } from "@/lib/store-allowance";
import { allowanceWindow } from "@/lib/allowance-window";
import { MEMBERSHIP_WORDS } from "@/lib/buyer-words/membership";
import { cardGrant, cardLink } from "@/lib/card-update";
import { forgetNoted } from "@/lib/erasure-index";
import { PERSON_DATA } from "@/lib/person-data";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { COST_LINES, SCOPES } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const PERIOD_END = Math.floor(Date.now() / 1000) + 20 * 86_400;
const sub = {
  id: "sub_Member0000001",
  status: "active",
  customer: "cus_Member000001",
  metadata: { store: "club", product: "x" },
  items: { data: [{ current_period_end: PERIOD_END, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
};
const stripeCalls: string[] = [];
const emails: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emails.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return json({ id: `email_${emails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  stripeCalls.push(`${method} ${path}`);
  if (path === "/customers" && method === "GET") return json({ object: "list", data: [{ id: "cus_Member000001", email: "member@example.com" }], has_more: false });
  if (path === "/subscriptions" && method === "GET") return json({ object: "list", data: [sub], has_more: false });
  if (path === "/billing_portal/configurations") return json({ id: "bpc_Test000001" });
  if (path === "/billing_portal/sessions") return json({ id: "bps_1", url: "https://billing.stripe.com/p/session/x" });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const form = (path: string, fields: Record<string, string>, from = "203.0.113.9") =>
  new NextRequest(`https://marktmorgen.com/api/store/manage/${path}`, {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: "https://marktmorgen.com", "Content-Type": "application/x-www-form-urlencoded", "x-forwarded-for": from },
    body: new URLSearchParams(fields).toString(),
  });
const press = (token: string, from?: string) => cancelRoute(form("cancel", { handle: "club", token, subscription: sub.id }, from));
const open = (token: string, from?: string) => openRoute(form("open", { handle: "club", token }, from));
const pause = (token: string, from?: string) => pauseRoute(form("pause", { handle: "club", token, subscription: sub.id, action: "pause", months: "1" }, from));
const statusOf = (response: Response) => new URL(response.headers.get("location") ?? "https://x.invalid/").searchParams.get("status");
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_audit_only";
  process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
  const OWNER = "club@example.com";
  await claimHandle(OWNER, "club", "Supper Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestClub000001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Inner Circle", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  sub.metadata.product = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const folder = await storeFolder(storeRef(store));
  const windowId = allowanceWindow(store)!.id;
  const requests = () => requestsIn(folder, windowId);
  const token = "b".repeat(64);
  const hash = createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0, 40);
  await redis.pipeline([["SET", `nl:manage:link:${hash}`, JSON.stringify({ a: "acct_1TestClub000001", c: "cus_Member000001", h: "club" }), "EX", 3600]]);

  part("An invented link spends nothing of the store's month: read before anything is counted");
  const invented = "c".repeat(64);
  const before = await requests();
  is("Cancel with an invented link: expired", statusOf(await press(invented, "198.51.100.1")), "expired");
  is("Open with an invented link: expired", statusOf(await open(invented, "198.51.100.1")), "expired");
  is("Pause with an invented link: expired", statusOf(await pause(invented, "198.51.100.1")), "expired");
  is("the store's month of requests did not move", await requests(), before);

  part("Control: with room in the window, Cancel opens Stripe's cancellation page, counted in the window");
  const first = await press(token);
  is("to Stripe", first.headers.get("location"), "https://billing.stripe.com/p/session/x");
  is("counted as one of the store's requests", await requests(), before + 1);

  part("The store's month of buyer requests used: the way out still opens");
  let taken = 0;
  while (taken < 500_000 && (await takePublicRequest(store, "buyer"))) taken += 1;
  is("the window is used", taken > 0 && !(await takePublicRequest(store, "buyer")), true);
  const calls = stripeCalls.length;
  is("Cancel still opens Stripe's cancellation page", (await press(token, "203.0.113.20")).headers.get("location"), "https://billing.stripe.com/p/session/x");
  is("Stripe was asked", stripeCalls.length > calls, true);
  is("Open still opens Stripe's billing page", (await open(token, "203.0.113.21")).headers.get("location"), "https://billing.stripe.com/p/session/x");
  is("Pause is not refused by the window (this store offers no pause)", statusOf(await pause(token, "203.0.113.22")), "cannot-pause");

  part("Past the store's month it is bounded per member, and the refusal says what is true");
  let refused: string | null = null;
  let presses = 0;
  while (presses < 200) {
    presses += 1;
    const answer = await press(token, `203.0.113.${30 + (presses % 50)}`);
    if (answer.headers.get("location")?.startsWith("https://billing.stripe.com/")) continue;
    refused = statusOf(answer);
    break;
  }
  is("refused after a bounded number of presses", presses < 200, true);
  is("as \"daily\", never as the hourly \"limited\"", refused, "daily");
  for (const [language, words] of Object.entries(MEMBERSHIP_WORDS)) {
    const daily = words.manageNotices.daily;
    is(`${language}: the "daily" notice is written`, Boolean(daily?.title && daily.body), true);
    is(`${language}: and never says an hour`, /hour|hora|heure|Stunde|ora\b|uur/i.test(daily?.body ?? ""), false);
  }
  for (const route of ["cancel", "open", "pause"]) {
    is(`${route}: the window never answers "limited" here`, read(`app/api/store/manage/${route}/route.ts`).includes('back("limited")'), false);
  }

  part("The store's access-email figure used: the link to manage is still sent, and counted");
  let mails = 0;
  while (mails < 10_000 && (await takeAllowance(store, "transactional")).ok) mails += 1;
  is("figure used", mails > 0, true);
  const sentBefore = emails.length;
  const countKey = redis.keys().find((k) => k.startsWith("nl:allow:transactional:"));
  const countBefore = Number(await redis.pipeline([["GET", countKey ?? "none"]]).then((r) => r[0]));
  is("the link is sent", await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.10", origin: "https://marktmorgen.com" }), "sent");
  is("one email went", emails.length - sentBefore, 1);
  is("and it holds the link to the member's page", emails.at(-1)?.includes("/@club/manage?token="), true);
  is("counted on the store's figure, past it", Number(await redis.pipeline([["GET", countKey ?? "none"]]).then((r) => r[0])), countBefore + 1);

  part("The member's pages are counted as a buyer's request (MÉDIO 4)");
  for (const page of ["app/[handle]/manage/page.tsx", "app/[handle]/manage/leave/page.tsx"]) {
    const text = read(page);
    is(`${page}: admitted as a way out before the memberships are read`, text.includes("admitManage(") && text.indexOf("admitManage(") < text.indexOf("membershipsFor("), true);
  }
  // What a buyer has never rests (tests/traffic.test.ts), so the member's card and switch pages are counted as the way
  // out is, before Stripe is read; the come-back page, outside it, rests with the store's month.
  for (const [page, counter, reading] of [
    ["app/[handle]/manage/card/page.tsx", "admitMemberPage(", "cardView(store, grant)"],
    ["app/[handle]/manage/switch/page.tsx", "admitManage(", "previewSwitch(store"],
    ["app/[handle]/renew/[product]/page.tsx", 'isResting(store, undefined, "buyer")', "readListing("],
  ] as const) {
    const text = read(page);
    is(`${page}: counted as a buyer's request before it reads`, text.includes(counter) && text.indexOf(counter) < text.indexOf(reading), true);
  }

  part("The cost of the way out is priced, and its counters classified");
  is("a line prices it", COST_LINES.some((line) => line.id === "member-exit"), true);
  for (const scope of ["exit-ip", "exit-member", "exit-store"]) is(`${scope} is classified`, Object.hasOwn(SCOPES, scope), true);

  part("A card link is deleted with the person (LEVE 5)");
  const card = await (cardLink as (a: string, c: string, s: string, note?: { statsId: string | null; email: string }) => Promise<string>)(
    "acct_1TestClub000001", "cus_Member000001", sub.id, { statsId: store.statsId, email: "member@example.com" },
  );
  is("the link works", (await cardGrant(store, card)) !== null, true);
  await forgetNoted(store.statsId, "member@example.com");
  is("deleting the person deletes it", await cardGrant(store, card), null);
  is("the registry says so", PERSON_DATA.some((d) => d.file === "lib/card-update.ts" && d.how === "erased"), true);
  is("and says what the payment reminders' marks are", PERSON_DATA.some((d) => d.file === "lib/payment-recovery.ts"), true);
  done();
}

void main();
