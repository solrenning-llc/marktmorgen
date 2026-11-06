/**
 * The member's own page (app/api/store/manage/*) when Redis or Stripe answers in a shape it does not know
 * (CX-123 rules 24 and 30; Claude 5, sweep APP2 findings 1, 2 and the findMember sibling of 4). Synthetic only:
 * the in-memory Redis double and stand-ins for Stripe and the email provider through `fetch`.
 *
 * 1. openCancel claims the creator's offer to stay with an SET NX: only an exact "OK" makes the offer, nil means it
 *    was already made, and any other reply is unknown and the cancellation page opens without the coupon (the
 *    member can still cancel; the creator's coupon is never given twice).
 * 2. The opens counter of an emailed link (openPortal, openCancel, openCardUpdate): an INCR reply that is not a
 *    whole count refuses the press as "error" and makes no Stripe page; a link whose opens are spent stays "used".
 * 3. findMember: a customers or subscriptions list in another shape is not "no membership". The request throws,
 *    the route answers status=error ("Something went wrong on our side"), never "sent", and no link is written.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { openCancel, openPortal, requestManageLink } from "@/lib/membership-manage";
import { cardLink, openCardUpdate } from "@/lib/card-update";
import { POST as manageRoute } from "@/app/api/store/manage/route";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const ACCOUNT = "acct_1TestHarbor0001";
const posts: { path: string; body: URLSearchParams }[] = [];
let emails = 0;
/** How the next customers / subscriptions list is answered: as Stripe does, or in a shape it never gives. */
let customersShape: "ok" | "no-data" | "no-has-more" | "row-without-id" = "ok";
let subsShape: "ok" | "no-data" | "data-as-object" | "row-without-status" = "ok";

const member = () => ({
  id: "sub_Member0000001",
  object: "subscription",
  status: "active",
  customer: "cus_Member000001",
  created: 1,
  metadata: { store: "harbor", product: "club" },
  items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 20 * DAY, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emails += 1;
    return answer({ id: "email_1" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (method === "POST") posts.push({ path, body: new URLSearchParams(String(init?.body ?? "")) });
  if (path === "/customers" && method === "GET") {
    if (customersShape === "no-data") return answer({ object: "list", has_more: false });
    if (customersShape === "no-has-more") return answer({ object: "list", data: [] });
    if (customersShape === "row-without-id") return answer({ object: "list", has_more: false, data: [{ created: 1 }] });
    return answer({ object: "list", has_more: false, data: (url.searchParams.get("email") ?? "").startsWith("member") ? [{ id: "cus_Member000001", created: 1 }] : [] });
  }
  if (path === "/subscriptions" && method === "GET") {
    if (subsShape === "no-data") return answer({ object: "list", has_more: false });
    if (subsShape === "data-as-object") return answer({ object: "list", has_more: false, data: { 0: member() } });
    if (subsShape === "row-without-status") return answer({ object: "list", has_more: false, data: [{ ...member(), status: undefined }] });
    return answer({ object: "list", has_more: false, data: [member()] });
  }
  if (path === "/subscriptions/sub_Member0000001" && method === "GET") return answer(member());
  if (path.startsWith("/subscriptions/") && method === "POST") return answer({ id: path.split("/")[2] });
  if (path === "/billing_portal/configurations") return answer({ id: `bpc_Config${posts.length}0000` });
  if (path === "/billing_portal/sessions") return answer({ id: "bps_1", url: "https://billing.stripe.com/p/session/test" });
  if (path === "/checkout/sessions" && method === "POST") return answer({ id: "cs_test_card0000000001", url: "https://checkout.stripe.com/c/pay/cs_test_card0000000001" });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
async function grantLink(token: string): Promise<void> {
  await redis.pipeline([["SET", `nl:manage:link:${sha(`nimbus-manage:${token}`)}`, JSON.stringify({ a: ACCOUNT, c: "cus_Member000001", h: "harbor" })]]);
}
const offered = () => posts.some((p) => p.path === "/billing_portal/sessions" && p.body.get("flow_data[subscription_cancel][retention][coupon_offer][coupon]") === "co_Save000001");
const cancelPages = () => posts.filter((p) => p.path === "/billing_portal/sessions" && p.body.get("flow_data[type]") === "subscription_cancel").length;
const sessions = () => posts.filter((p) => p.path === "/billing_portal/sessions" || p.path === "/checkout/sessions").length;
const links = async () => redis.keys().filter((k) => k.startsWith("nl:manage:link:"));

const original = redis.pipeline.bind(redis);
/** Answers the pipeline whose commands name `marker` as Redis would, then puts `bad` in the slot of the command that names it. */
function garble(marker: string, command: string, bad: unknown): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    const text = JSON.stringify(commands);
    if (!text.includes(marker)) return replies;
    if (String(commands[0][0]).toUpperCase() === "EVAL") {
      // An order's records written by the script (lib/order-data.ts): [charged, ...replies] in one slot.
      const inner = [...(replies[0] as unknown[])];
      inner[1] = bad;
      return [inner];
    }
    const at = commands.findIndex((c) => String(c[0]).toUpperCase() === command && JSON.stringify(c).includes(marker));
    const out = [...replies];
    out[at] = bad;
    return out;
  }) as typeof redis.pipeline;
}
/** A whole pipeline answer of the wrong length for the commands that name `marker`. */
function shorten(marker: string): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    return JSON.stringify(commands).includes(marker) ? replies.slice(0, -1) : replies;
  }) as typeof redis.pipeline;
}

function ask(email: string, ip: string) {
  const form = new URLSearchParams({ handle: "harbor", email });
  return manageRoute(new NextRequest("https://marktmorgen.com/api/store/manage", {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: "https://marktmorgen.com", "Content-Type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: form.toString(),
  }));
}
const statusOf = (response: Response) => new URL(response.headers.get("location") ?? "https://x.invalid/").searchParams.get("status");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_manage_links_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();
  const OWNER = "owner@example.com";
  if (!(await claimHandle(OWNER, "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  await addProduct(OWNER, "The Inner Circle", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  const store: Store = { ...(await storeForEmail(OWNER))!, save: { percent: 25, months: 1, coupon: "co_Save000001" } };
  const origin = "https://marktmorgen.com";

  part("1. The offer to stay: control, made the first time only");
  const first = "a".repeat(64);
  await grantLink(first);
  posts.length = 0;
  is("first press: Stripe's cancellation page opens with the offer", [(await openCancel(store, first, "sub_Member0000001", origin)).ok, offered()], [true, true]);
  posts.length = 0;
  is("second press, nil from SET NX: the page opens, without the offer", [(await openCancel(store, first, "sub_Member0000001", origin)).ok, offered()], [true, false]);

  part("1. The offer to stay: an SET NX reply in an unknown shape never offers it again");
  const fresh = "c".repeat(64);
  for (const [label, bad] of [["a missing slot", undefined], ["0", 0], ["a stray word", "QUEUED"], ["an object", { ok: true }]] as const) {
    await redis.pipeline([["DEL", `nl:save:${ACCOUNT}:sub_Member0000001`]]);
    await grantLink(fresh);
    garble("nl:save:", "SET", bad);
    posts.length = 0;
    const opened = await openCancel(store, fresh, "sub_Member0000001", origin);
    redis.pipeline = original;
    // Even on a membership never offered before: whether the mark was written is not known, so the coupon is
    // left out (the creator's money), and the member can still cancel (one cancellation page, no offer).
    is(`${label}: the member can still cancel, and the coupon is not offered`, [opened.ok, cancelPages(), offered()], [true, 1, false]);
  }

  part("2. The opens counter: control, a spent link opens nothing");
  const used = "b".repeat(64);
  await grantLink(used);
  await redis.pipeline([["SET", `nl:manage:opens:${sha(`nimbus-manage-opens:${used}`)}`, "10"]]);
  posts.length = 0;
  is("portal: used", await openPortal(store, used, origin), { ok: false, reason: "used" });
  is("cancel: used", await openCancel(store, used, "sub_Member0000001", origin), { ok: false, reason: "used" });
  const card = await cardLink(ACCOUNT, "cus_Member000001", "sub_Member0000001");
  await redis.pipeline([["SET", `nl:card:opens:${sha(`nimbus-card-opens:${card}`)}`, "20"]]);
  is("card: used", await openCardUpdate(store, card, origin), { ok: false, reason: "used" });
  is("and no Stripe page was made", sessions(), 0);

  part("2. The opens counter: control, a fresh link opens Stripe");
  const live = "d".repeat(64);
  await grantLink(live);
  const liveCard = await cardLink(ACCOUNT, "cus_Member000001", "sub_Member0000001");
  posts.length = 0;
  is("portal, cancel and card each open their Stripe page", [(await openPortal(store, live, origin)).ok, (await openCancel(store, live, "sub_Member0000001", origin)).ok, (await openCardUpdate(store, liveCard, origin)).ok, sessions()], [true, true, true, 3]);

  part("2. The opens counter: an INCR reply in an unknown shape refuses the press and opens nothing");
  for (const [label, bad] of [["a missing slot", undefined], ["nil", null], ["a stray word", "x"], ["a count in text", "3"], ["zero", 0], ["a fraction", 1.5]] as const) {
    posts.length = 0;
    garble("nl:manage:opens:", "INCR", bad);
    const portal = await openPortal(store, live, origin);
    const cancel = await openCancel(store, live, "sub_Member0000001", origin);
    garble("nl:card:opens:", "INCR", bad);
    const cardOpen = await openCardUpdate(store, liveCard, origin);
    redis.pipeline = original;
    is(`${label}: portal, cancel and card answer "error", no Stripe page made`, [portal, cancel, cardOpen, sessions()], [{ ok: false, reason: "error" }, { ok: false, reason: "error" }, { ok: false, reason: "error" }, 0]);
  }
  for (const [label, marker] of [["the manage link's", "nl:manage:opens:"], ["the card link's", "nl:card:opens:"]] as const) {
    posts.length = 0;
    shorten(marker);
    const answers = marker === "nl:card:opens:"
      ? [await openCardUpdate(store, liveCard, origin)]
      : [await openPortal(store, live, origin), await openCancel(store, live, "sub_Member0000001", origin)];
    redis.pipeline = original;
    is(`${label} counter answered with one reply short: "error", no Stripe page made`, [answers.every((a) => !a.ok && a.reason === "error"), sessions()], [true, 0]);
  }

  part("3. Asking for the link: control");
  emails = 0;
  is("a member's address: sent, one email, one link written", [await requestManageLink({ store, email: "member@example.com", ip: "198.51.100.1", origin }), emails, (await links()).length > 0], ["sent", 1, true]);
  const before = (await links()).length;
  emails = 0;
  is("an address with no membership: the same \"sent\", and no email", [await requestManageLink({ store, email: "nobody@example.com", ip: "198.51.100.2", origin }), emails], ["sent", 0]);

  part("3. Asking for the link: a list in an unknown shape is not \"no membership\"");
  const cases = [
    ["customers without data", () => { customersShape = "no-data"; }],
    ["customers without has_more", () => { customersShape = "no-has-more"; }],
    ["a customer row without an id", () => { customersShape = "row-without-id"; }],
    ["subscriptions without data", () => { subsShape = "no-data"; }],
    ["subscriptions with data as an object", () => { subsShape = "data-as-object"; }],
    ["a subscription row without a status", () => { subsShape = "row-without-status"; }],
  ] as const;
  let n = 10;
  for (const [label, set] of cases) {
    set();
    emails = 0;
    n += 1;
    const response = await ask(`member${n}@example.com`, `198.51.100.${n}`);
    customersShape = "ok";
    subsShape = "ok";
    is(`${label}: the form says something went wrong (never "sent"), no email, no new link`, [response.status, statusOf(response), emails, (await links()).length], [303, "error", 0, before]);
  }
  emails = 0;
  is("and the healthy route still answers sent", [statusOf(await ask("member99@example.com", "198.51.100.99")), emails], ["sent", 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
