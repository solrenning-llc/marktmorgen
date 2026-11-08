/**
 * Refunds beyond what was read are unverified, never zero (rule 24; R24
 * inventory, PR G: lib/payment-requests.ts, refreshRefunds).
 *
 * The studio's list of payment requests reads the creator's refunds on
 * Stripe, at most three pages. Before this, a list still marked has_more
 * after the third page, a page in another shape, a row in another shape or
 * a failed read all left the request at "Paid" with no refund, as if
 * Stripe had said so. Checked here, with Redis in memory and Stripe mocked:
 *
 *   - a list read in full is checked: no refund, part, in full (controls);
 *   - a list cut off after the pages read, a page or a row in another shape,
 *     the same refund twice, a failed read, a payment that cannot be looked
 *     up or a store with no Stripe account: refunds not checked, never a
 *     confident "Paid" with nothing refunded;
 *   - what was read is still true: a refund read is counted once, a full
 *     refund read is "refunded" (checked), and nothing is lowered;
 *   - a request paid outside Stripe has no refund on Stripe to read: checked;
 *   - the studio says so, in words, never only by color: "Paid, refunds not
 *     checked", "at least $X refunded", and one notice above the list.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft, type PaymentRequest } from "@/lib/payment-request-rules";
import { createRequest, markPaid, readRequest } from "@/lib/payment-request-store";
import { refreshRefunds } from "@/lib/payment-requests";
import { PaymentRequestsStudio } from "@/components/payment-requests-studio";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Page = { status?: number; body: unknown };
/** Stripe's refund list, page by page: the n-th GET /refunds of a run answers pages[n]. */
let pages: Page[] = [];
let refundReads = 0;
const asked: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/refunds" && (init?.method ?? "GET") === "GET") {
    asked.push(url.search);
    const page = pages[refundReads] ?? { body: { object: "list", data: [], has_more: false } };
    refundReads += 1;
    return answer(page.body, page.status ?? 200);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const INTENT = "pi_RefundsUnverified01";
const PAID = 48_000;
/** A succeeded refund of some other payment on the same Stripe account. */
const other = (n: number) => ({ id: `re_other_${n}`, object: "refund", payment_intent: `pi_SomethingElse${String(n).padStart(6, "0")}`, status: "succeeded", amount: 500 });
const ours = (id: string, amount: number) => ({ id, object: "refund", payment_intent: INTENT, status: "succeeded", amount });
const list = (data: unknown, more: unknown) => ({ body: { object: "list", data, has_more: more } });
const hundred = (from: number) => Array.from({ length: 100 }, (_, i) => other(from + i));

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Refund Check Studio", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Ref${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

type Shown = PaymentRequest & { refundsChecked?: boolean; refundsRetry?: boolean };

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_refunds_unverified_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_refunds_unverified_only_a_stand_in";
  const now = Date.now();
  const store = await paidStore("refund-check@example.com", "refundcheck");
  const draft = (readDraft({ email: "client@example.com", name: "Dana", lines: [{ text: "Coaching", quantity: 1, amount: "480" }], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft;
  const made = await createRequest(store, draft, now);
  if (!made.ok) throw new Error("the request was not made");
  const id = made.request.id;
  await markPaid(store, id, { id: "cs_test_refundsunverified000000001", amount_total: PAID, payment_intent: INTENT, created: Math.floor(now / 1000) }, now);
  const paidNow = async () => (await readRequest(id))!;
  is("the request is paid on Stripe, nothing refunded yet", [(await paidNow()).state, (await paidNow()).refunded, (await paidNow()).payment], ["paid", 0, INTENT]);

  /** One studio reading with these pages; what it shows, what is kept, and how many pages it asked for. */
  const reading = async (given: Page[], request?: PaymentRequest) => {
    pages = given;
    refundReads = 0;
    asked.length = 0;
    const shown = (await refreshRefunds(store, [request ?? (await paidNow())], now)) as Shown[];
    const kept = await paidNow();
    return { shown: shown[0], kept, reads: refundReads };
  };

  part("Controls: a refund list read in full is checked");
  let r = await reading([list([other(1), other(2)], false)]);
  is("none of ours: paid, nothing refunded, checked", [r.shown.state, r.shown.refunded, r.shown.refundsChecked, r.reads], ["paid", 0, true, 1]);
  r = await reading([list(hundred(0), true), list([other(500)], false)]);
  is("two pages, the second the last: paid, checked, two reads", [r.shown.state, r.shown.refundsChecked, r.reads], ["paid", true, 2]);
  is("the second page starts after the first one's last row", asked[1]?.includes("starting_after=re_other_99"), true);

  part("A list cut off after the pages read is not checked");
  r = await reading([list(hundred(0), true), list(hundred(100), true), list(hundred(200), true), list([ours("re_ours_late", 10_000)], false)]);
  is("three pages read, more on Stripe: not checked, nothing made up", [r.shown.state, r.shown.refunded, r.shown.refundsChecked, r.reads], ["paid", 0, false, 3]);
  is("and nothing kept changed", [r.kept.state, r.kept.refunded], ["paid", 0]);

  part("A page or a row in another shape is not checked");
  r = await reading([list([other(1)], undefined)]);
  is("has_more missing: not checked", [r.shown.state, r.shown.refundsChecked], ["paid", false]);
  r = await reading([list([other(1)], "false")]);
  is("has_more a string: not checked", [r.shown.state, r.shown.refundsChecked], ["paid", false]);
  r = await reading([{ body: { object: "list", data: "none", has_more: false } }]);
  is("data not a list: not checked", [r.shown.state, r.shown.refundsChecked], ["paid", false]);
  r = await reading([list([other(1), { object: "refund", payment_intent: INTENT, status: "succeeded", amount: 10_000 }], true)]);
  is("more to read, but the last row has no id to go on from: not checked", [r.shown.refundsChecked, r.reads], [false, 1]);
  r = await reading([list([{ id: "re_odd", object: "refund", payment_intent: INTENT, status: "succeeded", amount: "10000" }], false)]);
  is("a refund of ours whose amount is not a number: not checked", [r.shown.state, r.shown.refunded, r.shown.refundsChecked], ["paid", 0, false]);
  r = await reading([list([{ id: "re_odd2", object: "refund", payment_intent: INTENT, amount: 10_000 }], false)]);
  is("a refund with no status: not checked", [r.shown.state, r.shown.refundsChecked], ["paid", false]);
  r = await reading([list([null, other(1)], false)]);
  is("a row that is not a refund at all: not checked", [r.shown.state, r.shown.refundsChecked], ["paid", false]);

  part("A refund of ours still under way, or in a status Stripe does not list, is not checked (rule 24)");
  for (const status of ["pending", "requires_action", "some_new_status"]) {
    r = await reading([list([{ id: `re_${status}`, object: "refund", payment_intent: INTENT, status, amount: PAID }], false)]);
    is(`a full refund with status ${status}: never a checked Paid with nothing refunded`, [r.shown.state, r.shown.refunded, r.shown.refundsChecked, r.kept.refunded], ["paid", 0, false, 0]);
  }
  r = await reading([list([{ id: "re_noint", object: "refund", payment_intent: "", status: "succeeded", amount: PAID }], false)]);
  is("a refund whose payment_intent is an empty string (off-shape): not checked", [r.shown.state, r.shown.refundsChecked], ["paid", false]);
  r = await reading([list([{ id: "re_pending_other", object: "refund", payment_intent: "pi_SomethingElse000777", status: "pending", amount: 500 }, { ...ours("re_failed", PAID), status: "failed" }, { ...ours("re_canceled", PAID), status: "canceled" }], false)]);
  is("control: another payment's pending refund, and a failed or canceled one of ours, leave ours checked and not refunded", [r.shown.state, r.shown.refunded, r.shown.refundsChecked], ["paid", 0, true]);

  part("A failed read is not checked");
  r = await reading([{ status: 500, body: { error: { message: "Stripe is having trouble" } } }]);
  is("Stripe answers 500: not checked, nothing changed", [r.shown.state, r.shown.refunded, r.shown.refundsChecked, r.kept.state], ["paid", 0, false, "paid"]);

  part("A reload is promised only where reading again can change the answer (Claude 3's LOW A, Claude 6's LOW 2)");
  r = await reading([{ status: 500, body: {} }]);
  is("Stripe not answering: not checked, and reading again may help", [r.shown.refundsChecked, r.shown.refundsRetry], [false, true]);
  r = await reading([list([{ id: "re_pending_retry", object: "refund", payment_intent: INTENT, status: "pending", amount: PAID }], false)]);
  is("a refund of ours still pending: not checked, and reading again once it ends may help", [r.shown.refundsChecked, r.shown.refundsRetry], [false, true]);
  r = await reading([list(hundred(0), true), list(hundred(100), true), list(hundred(200), true)]);
  is("more refunds on the account than the pages read: not checked, and a reload reads the same pages, so none is promised", [r.shown.refundsChecked, r.shown.refundsRetry], [false, false]);
  r = await reading([list([{ id: "re_odd_retry", object: "refund", payment_intent: INTENT, status: "some_new_status", amount: PAID }], false)]);
  is("a refund in a status Stripe does not list: not checked, and no reload promised", [r.shown.refundsChecked, r.shown.refundsRetry], [false, false]);
  r = await reading([list([other(1)], false)]);
  is("control: a checked request has nothing to retry", [r.shown.refundsChecked, r.shown.refundsRetry], [true, false]);

  part("The same refund twice is counted once, and the reading is not checked");
  r = await reading([list([ours("re_twice", 30_000)], true), list([ours("re_twice", 30_000)], true), list([ours("re_twice", 30_000)], false)]);
  is("30,000 of 48,000 once, never 90,000 and never refunded in full", [r.shown.state, r.shown.refunded, r.kept.state, r.kept.refunded], ["paid", 30_000, "paid", 30_000]);
  is("and a list that repeats itself is not checked", r.shown.refundsChecked, false);

  part("A whole list that gives back less than the record holds is not checked (Claude 3's LOW B)");
  r = await reading([list([ours("re_twice", 30_000)], false)]);
  is("control: Stripe's whole list says 30,000, the record says 30,000: checked", [r.shown.state, r.shown.refunded, r.shown.refundsChecked], ["paid", 30_000, true]);
  r = await reading([list([{ ...ours("re_twice", 30_000), status: "failed" }], false)]);
  is("Stripe's whole list now says the 30,000 refund failed, the record says 30,000: never a checked \"$300 refunded\", and nothing lowered", [r.shown.state, r.shown.refunded, r.shown.refundsChecked, r.kept.refunded], ["paid", 30_000, false, 30_000]);
  is("and a reload reads the same list, so none is promised", r.shown.refundsRetry, false);

  part("What was read is still true");
  redis.clear();
  const store2 = await paidStore("refund-check-2@example.com", "refundchk2");
  const made2 = await createRequest(store2, draft, now);
  if (!made2.ok) throw new Error("the second request was not made");
  await markPaid(store2, made2.request.id, { id: "cs_test_refundsunverified000000002", amount_total: PAID, payment_intent: INTENT, created: Math.floor(now / 1000) }, now);
  const second = async () => (await readRequest(made2.request.id))!;
  const reading2 = async (given: Page[]) => {
    pages = given;
    refundReads = 0;
    const shown = (await refreshRefunds(store2, [await second()], now)) as Shown[];
    return { shown: shown[0], kept: await second() };
  };
  let s = await reading2([list([ours("re_part", 10_000), ...hundred(0).slice(1)], true), list(hundred(100), true), list(hundred(200), true)]);
  is("a part refund read before the list was cut off: at least that much, kept, not checked", [s.shown.state, s.shown.refunded, s.kept.refunded, s.shown.refundsChecked], ["paid", 10_000, 10_000, false]);
  s = await reading2([list([ours("re_part", 10_000), ours("re_rest", 38_000), ...hundred(0).slice(2)], true), list(hundred(100), true), list(hundred(200), true)]);
  is("refunded in full among what was read: refunded, kept, checked (nothing more can come back)", [s.shown.state, s.shown.refunded, s.kept.state, s.shown.refundsChecked], ["refunded", 48_000, "refunded", true]);
  s = await reading2([{ status: 500, body: {} }]);
  is("a refunded request stays refunded and checked when Stripe cannot be read", [s.shown.state, s.shown.refundsChecked], ["refunded", true]);

  part("Requests with nothing on Stripe to read, and a payment that cannot be looked up");
  const outside: PaymentRequest = { ...(await second()), id: "a".repeat(32), state: "paid", payment: "", refunded: 0, outside: { method: "cash", note: "" } };
  pages = [{ status: 500, body: {} }];
  refundReads = 0;
  let one = ((await refreshRefunds(store2, [outside], now)) as Shown[])[0];
  is("paid outside Stripe: checked, Stripe never asked", [one.state, one.refundsChecked, refundReads], ["paid", true, 0]);
  const open: PaymentRequest = { ...outside, id: "b".repeat(32), state: "open", outside: undefined };
  one = ((await refreshRefunds(store2, [open], now)) as Shown[])[0];
  is("an open request: checked (nothing paid to refund)", [one.state, one.refundsChecked, refundReads], ["open", true, 0]);
  const noIntent: PaymentRequest = { ...outside, id: "c".repeat(32), outside: undefined, payment: "" };
  one = ((await refreshRefunds(store2, [noIntent], now)) as Shown[])[0];
  is("paid on Stripe with no payment to look its refunds up by: not checked, no reload promised", [one.state, one.refundsChecked, one.refundsRetry], ["paid", false, false]);
  const noAccount = ((await refreshRefunds({ ...store2, stripeAccountId: "" } as Store, [{ ...(await second()), state: "paid", refunded: 0, id: "d".repeat(32) }], now)) as Shown[])[0];
  is("a store with no Stripe account to read: not checked, no reload promised", [noAccount.state, noAccount.refundsChecked, noAccount.refundsRetry], ["paid", false, false]);

  part("The studio says so, in words");
  const base = await second();
  const row = (over: Partial<Shown>) => ({ ...base, id: "e".repeat(32), state: "paid" as const, refunded: 0, link: "https://marktmorgen.com/pay/x", ...over });
  const draw = (rows: ReturnType<typeof row>[]) =>
    renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: {} as never },
        createElement(PaymentRequestsStudio, {
          rows: rows as never,
          now,
          currency: "usd",
          canSend: false,
          open: true,
          closedWhy: "",
          limits: { open: 10, kept: 50 },
          openNow: 0,
          emails: { used: 0, limit: 100 },
          shareWords: "",
          taxOn: false,
          prefill: { email: "", name: "", text: "", amount: "" },
          dueFirst: "2026-11-08",
          dueLast: "2026-12-08",
        }),
      ),
    );
  const unchecked = draw([row({ refundsChecked: false, refunded: 10_000 })]);
  is("an unchecked request is never shown as plainly paid", [unchecked.includes(">Paid, refunds not checked<"), unchecked.includes(">Paid<")], [true, false]);
  is("what was read is said as a floor, never as the total", [unchecked.includes("at least $100 refunded"), /(?<!at least )\$100 refunded/.test(unchecked)], [true, false]);
  is("one notice above the list says why and what to do", /role="status"[^>]*>Refunds on Stripe could not all be checked/.test(unchecked), true);
  is("where reading again cannot help, the notice sends the creator to Stripe and promises no reload", [unchecked.includes("Reload this page"), unchecked.includes("Stripe dashboard")], [false, true]);
  const retry = draw([row({ refundsChecked: false, refundsRetry: true, refunded: 10_000 })]);
  is("where reading again may help, the notice says to reload, and still names the dashboard", [retry.includes("Reload this page to check again"), retry.includes("Stripe dashboard")], [true, true]);
  const checked = draw([row({ refundsChecked: true, refunded: 10_000 })]);
  is("a checked request: Paid, the refund as Stripe says, no notice", [checked.includes(">Paid<"), checked.includes("$100 refunded"), checked.includes("at least"), checked.includes("could not all be checked")], [true, true, false, false]);

  done();
}

void main();
