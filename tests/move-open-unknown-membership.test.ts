/**
 * Rule 24 (Codex CX1's MEDIUM on #3598, proof codex/cx1-review-3598@bfec68f3): a subscription row whose status Stripe
 * has no name for, or whose metadata is missing, null or holds a product that is not a string, is unknown: the
 * invitation opens no checkout (no POST) and the reminder's keptAlready throws. A whole list with a canceled row,
 * a live row of another product or no row at all still reads as "not kept". Stripe is a stand-in; nothing real is charged.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { inviteMembers, openMove, readInvite, keptAlready } from "@/lib/move-members";
import { store as redis, advance } from "./redis-stub";
import { done, is, part } from "./check";
import { moveWords } from "@/lib/buyer-words/move";
import { LANGUAGE_CODES as LANGUAGES } from "@/lib/store-language";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "move-open-mark@example.com";
const checkouts: URLSearchParams[] = [];
/** expires_at Stripe gave each session, by id; a session with none closes in 24 hours. */
const closes = new Map<string, number>();
let lostAnswer = false;
let refusedByStripe = false;
let sessionUnreadable = false;
/** Stripe answers the creation with the checkout's own expires_at, as the API does; off to play an answer without it. */
let postSaysCloses = true;
/** GET /checkout/sessions/:id reads, to show none is needed when the creation said when it closes. */
let sessionReads = 0;
/** The emails Stripe shows a live membership to this product for. */
const paid = new Set<string>();
let membershipsUnreadable = false;
let overrideSubscriptions: unknown = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    if (refusedByStripe) {
      refusedByStripe = false;
      return json({ error: { type: "invalid_request_error", message: "No such price." } }, 400);
    }
    const body = new URLSearchParams(String(init?.body));
    checkouts.push(body);
    const id = `cs_test_${"m".repeat(20)}${checkouts.length}`;
    closes.set(id, Number(body.get("expires_at")) || Math.floor(Date.now() / 1000) + 86_400);
    // Stripe made the session, then its answer was lost on the way back.
    if (lostAnswer) {
      lostAnswer = false;
      throw new TypeError("fetch failed: socket hang up");
    }
    return json({ id, url: `https://checkout.stripe.com/c/pay/test${checkouts.length}`, ...(postSaysCloses ? { expires_at: closes.get(id) } : {}) });
  }
  const session = /^\/checkout\/sessions\/(cs_test_\w+)$/.exec(path);
  if (session && method === "GET") {
    sessionReads += 1;
    if (sessionUnreadable) return json({ id: session[1], object: "checkout.session" });
    const at = closes.get(session[1]);
    return at ? json({ id: session[1], object: "checkout.session", expires_at: at, status: at > Date.now() / 1000 ? "open" : "expired" }) : json({ error: { message: "No such session" } }, 404);
  }
  if (path === "/customers" && method === "GET") {
    if (membershipsUnreadable) return json({ object: "list" });
    const email = url.searchParams.get("email") ?? "";
    return json({ object: "list", data: paid.has(email) ? [{ id: `cus_${email.split("@")[0]}Paid0` }] : [], has_more: false });
  }
  if (path === "/subscriptions" && method === "GET" && overrideSubscriptions !== null) return json(overrideSubscriptions);
  if (path === "/subscriptions" && method === "GET") {
    const customer = url.searchParams.get("customer") ?? "";
    const email = [...paid].find((e) => customer === `cus_${e.split("@")[0]}Paid0`);
    return json({ object: "list", data: email ? [{ id: "sub_Paid0001", status: "active", metadata: { product: productId, moved: "yes" } }] : [], has_more: false });
  }
  if (method === "GET") return json({ object: "list", data: [], has_more: false });
  return json({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

let productId = "";

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_open_mark_only";
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_a_stand_in_key_for_tests_only";
  redis.clear();
  const nowS = Math.floor(Date.now() / 1000);
  const made = await claimHandle(OWNER, "moveopenmark", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMvMark01", true);
  await setSubscription(OWNER, { customerId: "cus_MvMark01", subscriptionId: "sub_MvMark01", active: true, period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Austin, TX 78701", asks: true });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  productId = club.product.id;
  await addOption(OWNER, productId, "Basic", "19");
  let store = (await storeForEmail(OWNER))!;
  const [basic] = (await readProduct(store, productId))!.options.map((o) => o.id);
  await setProductLink(OWNER, basic, "https://example.com/basic");
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const people = ["ada", "ben", "cy", "dee", "eve", "fay", "gus", "hal", "ivy"];
  const fields = await inviteMembers(store, "job_moveopenmark", people.map((name) => ({ email: `${name}@example.com`, productId, option: basic, renews: nowS + 20 * 86_400 })));
  // inviteMembers answers false for an address deleted from the store (main, 573513b4): none is here.
  if (!fields.every((field): field is string => typeof field === "string")) throw new Error("not invited");
  const invites = Object.fromEntries(await Promise.all(people.map(async (name, i) => [name, (await readInvite(statsId, fields[i]!))!] as const)));
  const press = (name: string) => openMove(store, productId, invites[name].t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  const mark = (name: string) => `nl:mv:open:${statsId}:${fields[people.indexOf(name)]}`;

  part('Unknown membership rows must not become proof that no membership exists');
  const rows: [string, string, unknown, boolean | null][] = [
    ['ada','unknown status',{status:'not-a-stripe-status',metadata:{product:productId}},null],
    ['ben','active with omitted metadata',{status:'active'},null],
    ['cy','active with null metadata',{status:'active',metadata:null},null],
    ['dee','active with a numeric product',{status:'active',metadata:{product:17}},null],
    ['eve','active matching control',{status:'active',metadata:{product:productId}},true],
    ['fay','ended matching control',{status:'canceled',metadata:{product:productId}},false],
    ['gus','active other product control',{status:'active',metadata:{product:'anotherproduct'}},false],
  ];
  for(const [name,label,row,exists] of rows){
    paid.add(`${name}@example.com`);
    overrideSubscriptions={object:'list',data:[row],has_more:false};
    const before=checkouts.length;
    const response=await press(name);
    const expected=exists===null?'refused':exists?'done':'opened';
    is(`${label}: public opening and provider POST`,[response.ok?'opened':response.reason,checkouts.length-before],[expected,exists===false?1:0]);
    const kept=await keptAlready(store,`${name}@example.com`,productId).catch(()=> 'unknown');
    is(`${label}: reminder knowledge`,kept,exists===null?'unknown':exists);
  }
  overrideSubscriptions={object:'list',data:[],has_more:false};
  paid.add('hal@example.com');
  const emptyBefore=checkouts.length;
  const empty=await press('hal');
  is('whole empty subscription list opens one checkout (control)',[empty.ok,checkouts.length-emptyBefore],[true,1]);
  done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
