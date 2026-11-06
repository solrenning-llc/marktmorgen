/**
 * Sweep APP2 proof (CX-123 rules 24 and 30), synthetic only: the member's page behind app/api/store/manage/*.
 *
 * Part 1, lib/membership-manage.ts:546-550 openCancel. The creator's offer to stay ("25% off the next payment") is
 * made once per membership: an SET NX of nl:save:<account>:<sub> claims it, and `withOffer = claimed !== null`. Any
 * reply that is not nil (a missing slot, 0, a stray word) reads as "claimed now", so a member who already saw the
 * offer, backed out and pressed Cancel again is given the coupon a second time.
 *
 * Part 2, the opens counter of one emailed link: `Number(count) > MAX_OPENS` in openPortal (membership-manage.ts:314),
 * openCancel (:531) and openCardUpdate (lib/card-update.ts:137). Number(undefined) and Number("x") are NaN and
 * Number(null) is 0, none of them greater than the limit: a link whose opens are used up opens Stripe again whenever
 * the INCR reply is unknown.
 */
import { createHash } from "node:crypto";
import { openCancel, openPortal } from "@/lib/membership-manage";
import { cardLink, openCardUpdate } from "@/lib/card-update";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const ACCOUNT = "acct_1TestHarbor0001";
const posts: { path: string; body: URLSearchParams }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (method === "POST") posts.push({ path, body: new URLSearchParams(String(init?.body ?? "")) });
  const member = {
    id: "sub_Member0000001",
    object: "subscription",
    status: "active",
    customer: "cus_Member000001",
    metadata: { store: "harbor", product: "club" },
    items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 20 * DAY, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  };
  if (path === "/subscriptions" && method === "GET") return answer({ object: "list", has_more: false, data: [member] });
  if (path === "/subscriptions/sub_Member0000001" && method === "GET") return answer(member);
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
const sessions = () => posts.filter((p) => p.path === "/billing_portal/sessions" || p.path === "/checkout/sessions").length;

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

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_sweep_app2_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_sweep_app2_only_a_stand_in";
  redis.clear();
  const OWNER = "owner@example.com";
  if (!(await claimHandle(OWNER, "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await addProduct(OWNER, "The Inner Circle", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  const store: Store = { ...(await storeForEmail(OWNER))!, save: { percent: 25, months: 1, coupon: "co_Save000001" } };

  part("Part 1, healthy control: the offer to stay is made the first time only");
  const first = "a".repeat(64);
  await grantLink(first);
  posts.length = 0;
  is("first press: Stripe's page opens with the offer", [(await openCancel(store, first, "sub_Member0000001", "https://marktmorgen.com")).ok, offered()], [true, true]);
  posts.length = 0;
  is("second press, nil from SET NX: no offer again (right)", [(await openCancel(store, first, "sub_Member0000001", "https://marktmorgen.com")).ok, offered()], [true, false]);

  part("Part 1, DEFECT: the SET NX of the offer mark answered in an unknown shape");
  for (const [label, bad] of [["a missing slot", undefined], ["0", 0], ["a stray word", "QUEUED"]] as const) {
    garble("nl:save:", "SET", bad);
    posts.length = 0;
    const opened = await openCancel(store, first, "sub_Member0000001", "https://marktmorgen.com");
    redis.pipeline = original;
    is(`DEFECT (${label}): the coupon is offered a second time on the same membership`, [opened.ok, offered()], [true, true]);
  }

  part("Part 2, healthy control: a link whose opens are used up opens nothing");
  const used = "b".repeat(64);
  await grantLink(used);
  await redis.pipeline([["SET", `nl:manage:opens:${sha(`nimbus-manage-opens:${used}`)}`, "10"]]);
  posts.length = 0;
  is("portal: used", await openPortal(store, used, "https://marktmorgen.com"), { ok: false, reason: "used" });
  is("cancel: used", await openCancel(store, used, "sub_Member0000001", "https://marktmorgen.com"), { ok: false, reason: "used" });
  const card = await cardLink(ACCOUNT, "cus_Member000001", "sub_Member0000001");
  await redis.pipeline([["SET", `nl:card:opens:${sha(`nimbus-card-opens:${card}`)}`, "20"]]);
  is("card: used", await openCardUpdate(store, card, "https://marktmorgen.com"), { ok: false, reason: "used" });
  is("and no Stripe page was made", sessions(), 0);

  part("Part 2, DEFECT: the INCR of the opens answered in an unknown shape");
  for (const [label, bad] of [["a missing slot", undefined], ["nil", null], ["a stray word", "x"]] as const) {
    posts.length = 0;
    garble("nl:manage:opens:", "INCR", bad);
    const portal = await openPortal(store, used, "https://marktmorgen.com");
    const cancel = await openCancel(store, used, "sub_Member0000001", "https://marktmorgen.com");
    garble("nl:card:opens:", "INCR", bad);
    const cardOpen = await openCardUpdate(store, card, "https://marktmorgen.com");
    redis.pipeline = original;
    is(`DEFECT (${label}): the used-up link opens the portal, the cancel page and the card page again`, [portal.ok, cancel.ok, cardOpen.ok, sessions()], [true, true, true, 3]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
