/**
 * A PayPal payout is never sent to a cut address. PayPal's receiver field holds at most 127 characters, while an
 * affiliate's PayPal address (or the inbox they joined with) may be up to MAX_EMAIL_LENGTH (254). The batch used to
 * send `payAddress(...).slice(0, 127)`: an address of 130 characters ending in ".store.com.br" went out as one
 * ending in ".store.com", another domain's inbox, and once PayPal reported it paid the book said "paid" although the
 * affiliate never got the money. An address too long for PayPal is left out of the batch: it stays owed, never on
 * its way, for the creator to pay another way (the payout file carries it whole). The others are paid as before.
 * Synthetic records, PayPal and Redis stood in for.
 */
import { readFileSync } from "node:fs";
import { MAX_BATCH_ROWS, batchTotal } from "@/lib/affiliate-payouts";
import { autoPayEmail } from "@/lib/affiliate-payday";
import { PAYPAL_RECEIVER_MAX, connectPayPal, onTheirWay, payWithPayPal, paypalLeftOut, paypalLeftOutText, paypalPayableLines } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { markLive } from "./live-store";
import { done, is, part } from "./check";

const STATS = "statsidlong1";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const LONG = `joe@${"a".repeat(113)}.store.com.br`;
const created: { items: { receiver: string; sender_item_id: string }[] }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { items: { receiver: string; sender_item_id: string }[]; sender_batch_header: unknown };
    created.push({ items: body.items });
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const store = {
  sid: "sidlong0001",
  handle: "harborlong",
  name: "Harbor Long",
  previousHandles: [],
  releasedHandles: [],
  statsId: STATS,
  stripeAccountId: "acct_1TestHarbor",
  currency: "usd",
  affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
} as unknown as Store;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_receiver_length";
  process.env.RESEND_API_KEY = "re_test_only";
  redis.clear();
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, paypal: string) => JSON.stringify({ id, email, code: id.slice(0, 6), status: "approved", appliedAt: 1, decidedAt: 2, note: "", paypal });
  const sale = (ref: string, aff: string) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "joe@example.com", LONG)],
    ["HSET", `nl:aff:${STATS}:people`, "bbbbbbbbbbbb", person("bbbbbbbbbbbb", "tom@example.com", "")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", "bbbbbbbbbbbb")],
  ]);
  await markLive(store);
  is("the app is connected", (await connectPayPal(store, CLIENT, SECRET)).ok, true);
  is("the long address is a real 130-character address, longer than PayPal takes", LONG.length, 130);

  part("The studio's PayPal panel counts only whom the batch can pay (Codex X5 on #4318)");
  {
    const lines = paypalPayableLines(await readBook(store), await onTheirWay(store));
    is("one person and $30 can go in a PayPal batch, not the affiliate with the long address", [lines.length, batchTotal(lines)], [1, 3000]);
    const page = readFileSync("app/studio/affiliates/page.tsx", "utf8");
    const panel = page.slice(page.indexOf("<PayPalPayouts"), page.indexOf("/>", page.indexOf("<PayPalPayouts")));
    is("the panel's people and amount come from paypalPayableLines, the lines the batch sends", [/people=\{paypalPayableLines\(/.test(panel), /cents=\{batchTotal\(paypalPayableLines\(/.test(panel)], [true, true]);
  }

  part("PayPal's eligibility comes before the 5,000-row ceiling (Codex X5's MEDIUM on #4318)");
  {
    const book = await readBook(store);
    const template = book.rows.find((r) => r.affiliate.id === "bbbbbbbbbbbb");
    if (!template) throw new Error("fixture row missing");
    const tooLong = `${"x".repeat(PAYPAL_RECEIVER_MAX + 1)}@example.test`;
    const blocked = Array.from({ length: MAX_BATCH_ROWS }, (_, index) => ({
      ...template,
      affiliate: { ...template.affiliate, id: `blocked-${index}`, email: tooLong, paypal: tooLong },
      payable: 20_000 - index,
    }));
    const eligible = { ...template, affiliate: { ...template.affiliate, id: "eligible", email: "paid@example.test", paypal: "" }, payable: 1 };
    const big = { ...book, rows: [...blocked, eligible] };
    is("the next affiliate PayPal can pay fills the batch", paypalPayableLines(big, new Set()).map((l) => l.affiliate.id), ["eligible"]);
    is("and every one of the 5,000 is counted as owed outside PayPal", paypalLeftOut(big, new Set()), MAX_BATCH_ROWS);
    const sent = { ...book, rows: [...blocked.map((r) => ({ ...r, affiliate: { ...r.affiliate, email: "x@example.test", paypal: "" } })), eligible] };
    const away = new Set(blocked.map((r) => r.affiliate.id));
    is("5,000 already on their way do not keep the next one out either", paypalPayableLines(sent, away).map((l) => l.affiliate.id), ["eligible"]);
  }

  part("The creator is told who PayPal cannot pay, never \"nobody is owed\" (Claude 7's MEDIUM on #4318)");
  {
    is("the affiliate with the long address is counted as owed outside PayPal", paypalLeftOut(await readBook(store), await onTheirWay(store)), 1);
    const nothing = autoPayEmail({ ok: false, reason: "nothing" }, "usd", 1).text;
    is("the payday email does not say nobody is owed", /nobody is owed/i.test(nothing), false);
    is("it says one affiliate is owed and PayPal cannot take their address", nothing.includes(paypalLeftOutText(1)), true);
    const sentEmail = autoPayEmail({ ok: true, batch: "BATCH1ABC", people: 1, cents: 3000 }, "usd", 1).text;
    is("the email for a batch sent names the one left out too", sentEmail.includes(paypalLeftOutText(1)), true);
    is("with nobody left out, the emails are as before", autoPayEmail({ ok: false, reason: "nothing" }, "usd").text.includes("nobody is owed anything that has cleared"), true);
    is("the note says how to pay them", /batch download on your affiliate page/.test(paypalLeftOutText(2)) && /2 affiliates/.test(paypalLeftOutText(2)), true);
    const page = readFileSync("app/studio/affiliates/page.tsx", "utf8");
    const panel = page.slice(page.indexOf("<PayPalPayouts"), page.indexOf("/>", page.indexOf("<PayPalPayouts")));
    is("the studio panel is given the note when someone is left out", /leftOutNote=\{paypalLeftOut\(book, away\) > 0 \? paypalLeftOutText\(paypalLeftOut\(book, away\)\) : ""\}/.test(panel), true);
    const component = readFileSync("components/paypal-payouts.tsx", "utf8");
    is("and shows it instead of \"nobody is owed\"", [/\) : leftOutNote \? null : \(\s*<p[^>]*>Nobody is owed/.test(component), /\{leftOutNote \? <p[^>]*>\{leftOutNote\}<\/p> : null\}/.test(component)], [true, true]);
    const payday = readFileSync("lib/affiliate-payday.ts", "utf8");
    is("the payday run passes the count left out to the email", /autoPayEmail\(paid, book\.currency, paypalLeftOut\(book, away\)\)/.test(payday), true);
  }

  part("Paying with PayPal");
  const paid = await payWithPayPal(store);
  is("a batch is sent for the affiliate PayPal can pay", paid.ok ? paid.people : paid.reason, 1);
  const receivers = created.flatMap((c) => c.items.map((i) => i.receiver));
  is("no receiver is a cut address", receivers.filter((r) => r !== "tom@example.com"), []);
  is("the address that ends in another domain once cut is never sent", receivers.some((r) => r.endsWith(".store.com")), false);
  const away = await onTheirWay(store);
  is("only the affiliate who was sent is on their way", [away.has("bbbbbbbbbbbb"), away.has("aaaaaaaaaaaa")], [true, false]);
  const row = (await readBook(store)).rows.find((r) => r.affiliate.id === "aaaaaaaaaaaa");
  is("the affiliate with the long address is still owed in full", row?.payable, 3000);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
