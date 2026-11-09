/**
 * Audit R43, follow-up to #3371: the checkout a come-back link opens (lib/winback-send.ts, openWinBack) is opened only
 * for somebody with no membership of that product that has not ended. Each store checkout makes a new Stripe customer
 * and keeps the address as it was typed, so the person's customers are read by the address as the link holds it and
 * by Stripe's customer search, compared in small letters. A membership found under any of them refuses with words the
 * page shows, and so does a reading that cannot be made whole (CX-123 rule 24): no checkout is opened on either, so no
 * second membership is ever charged to the same person. Synthetic Stripe only; the search stand-in matches addresses
 * in any letters, which real Stripe was not checked for.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { openWinBack } from "@/lib/winback-send";
import { membershipWords } from "@/lib/buyer-words/membership";
import RenewPage from "@/app/[handle]/renew/[product]/page";
import { redisPipeline, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const OWNER = "r43-no-second@example.com";
const HANDLE = "rnosecond";
let product = "";

/** Each customer's own email as Stripe holds it, as typed at its checkout. */
const customerEmail = new Map<string, string>();
/** What /customers?email= answers, per exact email, instead of the customers above: a body, or 500. */
const listBody = new Map<string, unknown>();
/** What /customers/search answers, per address searched in small letters, instead of the customers above. */
const searchBody = new Map<string, unknown>();
/** What /subscriptions?customer= answers, per customer. */
const subsBody = new Map<string, unknown>();
const checkouts: URLSearchParams[] = [];
let stripeReads = 0;

const list = (data: unknown[], hasMore = false) => ({ object: "list", data, has_more: hasMore });
const sub = (id: string, status: string) => list([{ id, status, metadata: { store: HANDLE, product } }]);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) =>
    body === 500 ? new Response(JSON.stringify({ error: { message: "synthetic provider error" } }), { status: 500 }) : new Response(JSON.stringify(body));
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"n".repeat(20)}${checkouts.length}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  if (method === "GET") stripeReads += 1;
  if (path === "/customers") {
    const email = url.searchParams.get("email") ?? "";
    if (listBody.has(email)) return answer(listBody.get(email));
    // Stripe's list filter: the text exactly as written.
    return answer(list([...customerEmail].filter(([, e]) => e === email).map(([id, e]) => ({ id, object: "customer", email: e }))));
  }
  if (path === "/customers/search") {
    const query = url.searchParams.get("query") ?? "";
    const email = (query.match(/^email:"([^"]*)"$/)?.[1] ?? "").toLowerCase();
    if (searchBody.has(email)) return answer(searchBody.get(email));
    const rows = [...customerEmail].filter(([, e]) => e.toLowerCase() === email).map(([id, e]) => ({ id, object: "customer", email: e }));
    return answer({ object: "search_result", data: rows, has_more: false, next_page: null });
  }
  if (path === "/subscriptions") return answer(subsBody.get(url.searchParams.get("customer") ?? "") ?? list([]));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

/** A come-back link as the daily run keeps it (lib/winback-send.ts, sweepStore): the address in small letters. */
async function comeBackLink(statsId: string, email: string): Promise<string> {
  const token = Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40);
  await redisPipeline([["SET", `nl:wb:link:${token}`, JSON.stringify({ s: statsId, e: email, p: product, o: "", c: "co_Back0001", pc: 25, m: 2 }), "EX", 14 * DAY]]);
  return token;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_r43_no_second_only_a_stand_in";
  redis.clear();
  const made = await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRnoSecond", true);
  await setSubscription(OWNER, { customerId: "cus_RnoSecOwner1", subscriptionId: "sub_RnoSecOwner1", active: true, tier: "pro", period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  product = club.product.id;
  await setProductLink(OWNER, product, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId as string;
  const open = async (email: string) => {
    const before = checkouts.length;
    const opened = await openWinBack(store, product, await comeBackLink(statsId, email), "https://marktmorgen.com", TEST_CONSENT);
    return [opened.ok ? "opened" : opened.reason, checkouts.length - before];
  };

  part("Control: a member whose membership ended and who has not come back");
  customerEmail.set("cus_IvyOld000001", "ivy@example.com");
  subsBody.set("cus_IvyOld000001", sub("sub_IvyEnded0001", "canceled"));
  is("Ivy: the offer's checkout opens, once", await open("ivy@example.com"), ["opened", 1]);
  const ivy = checkouts.at(-1);
  is("Ivy: with the offer's coupon and her address, and no second trial", [ivy?.get("discounts[0][coupon]"), ivy?.get("customer_email")], ["co_Back0001", "ivy@example.com"]);
  // Uma ended under two customers of the address, both ended: still not a member.
  customerEmail.set("cus_UmaOld000001", "uma@example.com");
  customerEmail.set("cus_UmaOld000002", "Uma@Example.com");
  subsBody.set("cus_UmaOld000001", sub("sub_UmaEnded0001", "canceled"));
  subsBody.set("cus_UmaOld000002", sub("sub_UmaEnded0002", "incomplete_expired"));
  is("Uma: memberships that all ended, under the address in any letters, open the checkout", await open("uma@example.com"), ["opened", 1]);

  part("A membership that has not ended, under any customer of the address: refused, nothing opened");
  // Sam ended as sam@example.com and has a live membership under Sam@Example.com (the review's first probe).
  customerEmail.set("cus_SamOld000001", "sam@example.com");
  customerEmail.set("cus_SamNew000001", "Sam@Example.com");
  subsBody.set("cus_SamOld000001", sub("sub_SamEnded0001", "canceled"));
  subsBody.set("cus_SamNew000001", sub("sub_SamLive00001", "active"));
  is("Sam: live under the address in other letters, the checkout is refused as a member's", await open("sam@example.com"), ["member", 0]);
  // Tess ended as Tess@Example.com and is back as TESS@example.com (the review's second probe): the link holds small letters.
  customerEmail.set("cus_TessOld00001", "Tess@Example.com");
  customerEmail.set("cus_TessNew00001", "TESS@example.com");
  subsBody.set("cus_TessOld00001", sub("sub_TessEnded001", "canceled"));
  subsBody.set("cus_TessNew00001", sub("sub_TessLive0001", "active"));
  is("Tess: back in letters neither customer was listed under, refused", await open("tess@example.com"), ["member", 0]);
  // Hal is back under the very same address.
  customerEmail.set("cus_HalOld000001", "hal@example.com");
  customerEmail.set("cus_HalNew000001", "hal@example.com");
  subsBody.set("cus_HalOld000001", sub("sub_HalEnded0001", "canceled"));
  subsBody.set("cus_HalNew000001", sub("sub_HalLive00001", "trialing"));
  is("Hal: back under the same address, refused", await open("hal@example.com"), ["member", 0]);
  for (const status of ["incomplete", "past_due", "unpaid", "paused", "a_status_not_known_here"]) {
    const id = `cus_Vic${status.replace(/_/g, "").slice(0, 10).padEnd(10, "0")}`;
    const email = `vic.${status}@example.com`;
    customerEmail.set(id, email);
    subsBody.set(id, sub(`sub_Vic${id.slice(7)}`, status));
    is(`a membership "${status}" has not ended: refused`, await open(email), ["member", 0]);
  }

  part("A reading that cannot be made whole: refused, nothing opened (CX-123 rule 24)");
  const unknown = async (name: string, set: () => void) => {
    const email = `${name}@example.com`;
    customerEmail.set(`cus_${name[0].toUpperCase()}${name.slice(1)}Old0000001`.slice(0, 20), email);
    set();
    is(`${name}: refused, no checkout`, await open(email), ["refused", 0]);
  };
  await unknown("kim", () => listBody.set("kim@example.com", 500));
  await unknown("lee", () => listBody.set("lee@example.com", list([{ id: "cus_LeeOld0000001", object: "customer" }], true)));
  await unknown("mia", () => listBody.set("mia@example.com", { object: "list" }));
  await unknown("ned", () => searchBody.set("ned@example.com", 500));
  await unknown("ola", () => searchBody.set("ola@example.com", { object: "search_result", data: [{ id: "cus_OlaOther00001", object: "customer", email: "OLA@example.com" }], has_more: true }));
  await unknown("pat", () => searchBody.set("pat@example.com", { object: "search_result", data: [{ id: "cus_PatOther00001", object: "customer" }], has_more: false }));
  await unknown("ray", () => subsBody.set("cus_RayOld0000001", { object: "list", data: "none" }));
  // Rex: more customers under the address than one opening reads memberships for.
  customerEmail.set("cus_RexOld0000001", "rex@example.com");
  for (let i = 0; i < 12; i += 1) customerEmail.set(`cus_RexMore0000${String(i).padStart(2, "0")}`, "Rex@example.com");
  const readsBefore = stripeReads;
  is("Rex: past the reads one opening makes, refused", await open("rex@example.com"), ["refused", 0]);
  is("Rex: one opening reads Stripe at most 12 times", stripeReads - readsBefore <= 12, true);

  part("The page says why, and that nothing was charged");
  const m = membershipWords("en");
  is("the words say there is a running membership and nothing was charged", /already have a membership[^.]*still running/.test(m.offerNotices.member ?? "") && /Nothing was charged\./.test(m.offerNotices.member ?? ""), true);
  const html = renderToStaticMarkup(
    await RenewPage({ params: Promise.resolve({ handle: `@${HANDLE}`, product }), searchParams: Promise.resolve({ back: await comeBackLink(statsId, "sam@example.com"), status: "member" }) }),
  );
  is("the renew page shows them in its status note, with no come-back button", [html.includes(m.offerNotices.member ?? "\u0000"), html.includes('action="/api/store/come-back/open"')], [true, false]);
  for (const language of ["es", "fr", "de", "it", "nl", "pt"]) is(`the words exist in ${language}`, typeof membershipWords(language).offerNotices.member === "string", true);
  done();
}

void main();
