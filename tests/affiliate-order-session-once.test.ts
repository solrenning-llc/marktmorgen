/**
 * An order id opens an affiliate's page once, for the affiliate it made (the security audit of 14 November 2026,
 * MEDIUM). The order id travels in the purchase email and on the thanks page (`/affiliates?order=cs_...`), so whoever
 * holds it later (a forwarded receipt, a browser history, a log) could press "Get my link" again and be signed in as
 * that address's affiliate for 30 days, as many times as Stripe still answers for the order, and change where its
 * commissions are paid (payto). Now the order signs in only the affiliate it has just made; every later press, and
 * an address that was already on the program, gets the store's ordinary emailed sign-in link instead, sent to the
 * affiliate's own address, so only who reads that inbox gets in.
 */
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { affiliateForSession, joinAsBuyer } from "@/lib/affiliates";
import { NextRequest } from "next/server";
import { POST as joinRoute } from "@/app/api/store/affiliates/join/route";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_order_session_once";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const sessions = new Map<string, Record<string, unknown>>();
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to), text: String(body.text) });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  const m = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  const found = m ? sessions.get(m[1]) : undefined;
  return new Response(JSON.stringify(found ?? { error: { message: "No such checkout.session" } }), { status: found ? 200 : 404 });
}) as typeof fetch;

const paid = (id: string, email: string) =>
  sessions.set(id, {
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 2700, currency: "usd",
    created: Math.floor(Date.now() / 1000), customer_details: { email }, metadata: { store: "harbor", product: "p8w2m4q9zz" },
  });

const press = async (order: string) => {
  const form = new FormData();
  form.set("handle", "harbor");
  form.set("order", order);
  const response = await joinRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/join", { method: "POST", headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: form }));
  return { location: response.headers.get("location") ?? `status ${response.status}`, cookie: response.headers.get("set-cookie") };
};

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, buyers: true, rates: {} });
  const store = await storeForEmail("owner@example.com");
  if (!store) throw new Error("no store");
  paid("cs_test_dana000000001", "dana@example.com");
  paid("cs_test_ivy0000000001", "ivy@example.com");

  part("The order signs in the affiliate it has just made, once");
  const first = await joinAsBuyer(store, "cs_test_dana000000001");
  if (!first.ok) throw new Error(`Dana could not join: ${first.reason}`);
  is("made now", first.created, true);
  is("and this browser is signed in as them", first.session ? (await affiliateForSession(store, first.session))?.id : null, first.affiliate.id);
  const again = await joinAsBuyer(store, "cs_test_dana000000001");
  is("the same order again is still the same affiliate", again.ok && again.affiliate.id, first.affiliate.id);
  is("but signs nobody in", again.ok && again.session, null);

  part("An address already on the program is not signed in by an order");
  const statsId = store.statsId as string;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, "0123456789ab", JSON.stringify({ id: "0123456789ab", email: "ivy@example.com", code: "ivy", status: "approved", appliedAt: 1, decidedAt: 2, note: "", rate: null, paypal: "ivy-pay@example.com", share: null, cleared: null, by: null })],
    ["HSET", `nl:aff:${statsId}:emails`, "ivy@example.com", "0123456789ab"],
  ]);
  const ivy = await joinAsBuyer(store, "cs_test_ivy0000000001");
  is("the order is read, as Ivy", ivy.ok && ivy.affiliate.id, "0123456789ab");
  is("and no session is made from it", ivy.ok && ivy.session, null);

  part("Through the button: a later press emails the ordinary sign-in link to the affiliate's own address");
  const before = mails.length;
  const later = await press("cs_test_dana000000001");
  is("no cookie is set", later.cookie, null);
  is("the page says to check the inbox", later.location, "https://marktmorgen.com/@harbor/affiliates?status=sent");
  is("one email, to Dana's address", mails.slice(before).map((m) => m.to), ["dana@example.com"]);
  is("carrying a one-off sign-in link", /\/@harbor\/affiliates\?token=[0-9a-f]{64}/.test(mails[mails.length - 1]?.text ?? ""), true);
  const known = await press("cs_test_ivy0000000001");
  is("Ivy's order sets no cookie either", [known.cookie, known.location], [null, "https://marktmorgen.com/@harbor/affiliates?status=sent"]);
  is("and her link goes to her own address", mails[mails.length - 1]?.to, "ivy@example.com");

  part("A buyer joining for the first time is signed in as before");
  paid("cs_test_kim0000000001", "kim@example.com");
  const kim = await press("cs_test_kim0000000001");
  is("joined, with the affiliate cookie", [kim.location, /^nl_aff_harbor=[0-9a-f]{64};/.test(kim.cookie ?? "")], ["https://marktmorgen.com/@harbor/affiliates?status=joined", true]);

  done();
}

void main();
