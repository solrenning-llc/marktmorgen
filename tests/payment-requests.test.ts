/**
 * Payment requests and invoices (HighLevel audit H26, H27; lib/payment-request-rules.ts,
 * lib/payment-request-store.ts, lib/payment-requests.ts; added 18 October 2026).
 *
 * Checked, in the in-memory Redis with Stripe and the email sender mocked:
 *
 *   - what the studio sends is held to every rule (address, lines, amount
 *     bounds, due date, reminders, the creator's word that the person agreed);
 *   - the counts are enforced in code: open and kept per store by plan, per
 *     person, and a refused request leaves nothing behind; each request
 *     takes its room in the store's data room before it is written;
 *   - the email is one of the store's own emails for the month, taken
 *     before it goes, and says who asks, for what, how much, and that
 *     nothing is charged unless they pay; with the figure used, it does not go;
 *   - the payment is the same checkout as any sale: the creator's account,
 *     its lines, the order admitted before Stripe's page opens (and refused
 *     past the figure), tax where the creator collects it, the plan's share;
 *     never two checkouts side by side;
 *   - back from paying it is paid once, its receipt goes once and its order
 *     is counted once; a refund on Stripe shows as refunded;
 *   - reminders go on their day, at most as many as asked, never after it is
 *     paid, canceled or expired, and wait a day when they cannot go;
 *   - cancel, delete and deleting the person do what they say.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { DRAFT_PROBLEMS, MAX_PER_PERSON, MAX_SENDS, OPEN_DAYS, REMIND_EVERY_DAYS, REQUEST_LIMITS, canSendAgain, nextReminderAt, readDraft, requestBounds, statusOf } from "@/lib/payment-request-rules";
import { createRequest, forgetRequestsPerson, listRequests, readRequest, requestOf, cancelRequest, deleteRequest, openCount, requestRoomBytes } from "@/lib/payment-request-store";
import { createRequestCheckout, openRequestCheckout, refreshRefunds, sendDueReminders, sendRequestEmail, settleFromReturn, remindNow } from "@/lib/payment-requests";
import { confirmPurchase } from "@/lib/purchase-email";
import { storeOrdersThisMonth } from "@/lib/orders";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { allowanceUsed } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { dataUsed } from "@/lib/store-data";
import { applyShare, shareOf } from "@/lib/platform-share";
import { COMMISSION_BPS } from "@/lib/plan";
import { PERSON_DATA } from "@/lib/person-data";
import { ERASERS } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

type Mail = { to: string; subject: string; text: string };
const mails: Mail[] = [];
const checkouts: URLSearchParams[] = [];
const checkoutHeaders: Headers[] = [];
const sessions = new Map<string, Record<string, unknown>>();
let refunds: Record<string, unknown>[] = [];
let mailDown = false;
let mailFailureStatus = 429;
let mailPosts = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mailPosts++;
    if (mailDown) return answer({ message: "known rate-limit refusal" }, mailFailureStatus);
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
    mails.push({ to: body.to[0], subject: body.subject, text: body.text });
    return answer({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    checkouts.push(body);
    checkoutHeaders.push(new Headers(init?.headers));
    const id = `cs_test_${String(checkouts.length).padStart(24, "r")}`;
    const meta: Record<string, string> = {};
    for (const [key, value] of body) {
      const m = /^metadata\[(.+)\]$/.exec(key);
      if (m) meta[m[1]] = value;
    }
    sessions.set(id, { id, status: "open", payment_status: "unpaid", url: `https://checkout.stripe.com/c/pay/${id}`, metadata: meta, created: Math.floor(Date.now() / 1000) });
    return answer(sessions.get(id));
  }
  if (path.startsWith("/checkout/sessions/") && method === "GET") {
    const found = sessions.get(decodeURIComponent(path.slice("/checkout/sessions/".length)));
    return found ? answer(found) : answer({ error: { code: "resource_missing", message: "No such checkout" } }, 404);
  }
  if (path === "/checkout/sessions" && method === "GET") return answer({ object: "list", data: [...sessions.values()], has_more: false });
  if (path === "/refunds") return answer({ object: "list", data: refunds, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const LINE = { text: "Coaching, October (4 sessions)", quantity: 1, amount: "480" };
const draftBody = (over: Record<string, unknown> = {}) => ({ email: "client@example.com", name: "Dana", lines: [LINE], note: "Thank you for a good month.", dueDate: "", autoReminders: 2, consent: true, ...over });

async function paidStore(owner: string, handle: string, tier: "creator" | "pro" | "scale" = "creator"): Promise<Store> {
  await claimHandle(owner, handle, "Dana's Studio Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Req${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier, period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_payment_requests_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_payment_requests_only_a_stand_in";
  const now = Date.now();

  part("What the studio sends is held to the rules");
  const ok = readDraft(draftBody(), "usd", now);
  is("a plain request is read, the amount in cents and the total worked out", ok.ok ? [ok.draft.email, ok.draft.lines[0].cents, ok.draft.total, ok.draft.autoReminders] : null, ["client@example.com", 48_000, 48_000, 2]);
  const several = readDraft(draftBody({ lines: [LINE, { text: "Workbook", quantity: 2, amount: "19,50" }] }), "eur", now);
  is("several lines, an amount typed the European way, quantities multiplied", several.ok ? several.draft.total : null, 48_000 + 3_900);
  const problem = (over: Record<string, unknown>) => {
    const r = readDraft(draftBody(over), "usd", now);
    return r.ok ? "ok" : r.problem;
  };
  is("refused: no address, no line, an empty line, a bad amount", [problem({ email: "dana" }), problem({ lines: [] }), problem({ lines: [{ text: "", quantity: 1, amount: "5" }] }), problem({ lines: [{ text: "x", quantity: 1, amount: "$5" }] })], ["email", "lines", "line", "amount"]);
  const { min, max } = requestBounds("usd");
  is("the total is held to a product's own price bounds", [min, max, problem({ lines: [{ text: "x", quantity: 1, amount: "0.50" }] }), problem({ lines: [{ text: "x", quantity: 2, amount: "4000" }] })], [100, 500_000, "total", "total"]);
  is("a due date only from today to the last day the link works", [problem({ dueDate: new Date(now - 86_400_000).toISOString().slice(0, 10) }), problem({ dueDate: new Date(now + (OPEN_DAYS + 2) * 86_400_000).toISOString().slice(0, 10) }), problem({ dueDate: "2026-02-30" }), problem({ dueDate: new Date(now + 7 * 86_400_000).toISOString().slice(0, 10) })], ["due", "due", "due", "ok"]);
  is("at most three reminders, and never without the creator's word that the person agreed", [problem({ autoReminders: 4 }), problem({ consent: false }), problem({ consent: "yes" })], ["reminders", "consent", "consent"]);
  is("every problem has a sentence, in US English, with no urgency", Object.values(DRAFT_PROBLEMS).every((s) => s.length > 10 && !/hurry|last chance|urgent|now or never|unlimited/i.test(s)), true);

  part("The counts are enforced in code");
  const owner = "requests@example.com";
  let store = await paidStore(owner, "danacoach");
  const before = (await dataUsed(store))!.used;
  const first = await createRequest(store, (readDraft(draftBody(), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now);
  is("a request is kept, open, for 45 days", first.ok ? [first.request.state, statusOf(first.request, now), first.request.expiresAt - now] : null, ["open", "open", OPEN_DAYS * 86_400_000]);
  const request = first.ok ? first.request : null!;
  const after = (await dataUsed(store))!.used;
  is("its room in the data room was taken before it was written", after - before >= requestRoomBytes(request), true);
  is("one of the store's requests, found only under its store", [(await requestOf(store, request.id))?.id, await requestOf({ sid: "another" }, request.id)], [request.id, null]);
  // Fill the store's open requests with other people.
  const limit = REQUEST_LIMITS.creator.open;
  for (let i = 1; i < limit; i += 1) {
    const r = await createRequest(store, { ...(readDraft(draftBody({ email: `p${i}@example.com` }), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft }, now);
    if (!r.ok) throw new Error(`could not fill: ${r.message}`);
  }
  is("the plan's open requests are all in use", await openCount(store.sid, now), limit);
  const over = await createRequest(store, (readDraft(draftBody({ email: "late@example.com" }), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now);
  is("one more is refused, with a sentence, and leaves nothing behind", [over.ok, over.ok ? "" : over.reason, await openCount(store.sid, now), (await listRequests(store, now))!.length], [false, "open", limit, limit]);
  // A person's own cap, on a larger plan where the store's is far away.
  const big = await paidStore("requests-big@example.com", "bigcoach", "pro");
  const one = (readDraft(draftBody({ email: "same@example.com" }), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft;
  for (let i = 0; i < MAX_PER_PERSON; i += 1) await createRequest(big, one, now);
  const tooMany = await createRequest(big, one, now);
  is("one person keeps at most MAX_PER_PERSON requests in a store", [tooMany.ok, tooMany.ok ? "" : tooMany.reason], [false, "person"]);
  is("a store with no plan cannot keep any", (await createRequest({ ...store, subscriptionActive: false, subscriptionId: null, planEndedAt: "" }, one, now)).ok, false);

  part("The email: from the store's own emails for the month, and plain");
  const usedBefore = await allowanceUsed(store, "email", now);
  const sent = await sendRequestEmail(store, request, now);
  const mail = mails.at(-1)!;
  is("it goes, and takes one of the store's emails", [sent.sent, (await allowanceUsed(store, "email", now)) - usedBefore], [true, 1]);
  is("to the person, saying who asks and how much", [mail.to, mail.subject], ["client@example.com", "Dana's Studio Coaching: payment request for $480"]);
  is("with the lines, the link, that nothing is charged unless they pay, and who sends it", [mail.text.includes("- Coaching, October (4 sessions): $480"), mail.text.includes(`/@danacoach/pay/${request.id}`), mail.text.includes("nothing is charged unless you pay"), mail.text.includes("Sent by Marktmorgen on behalf of Dana's Studio Coaching.")], [true, true, true, true]);
  is("and no urgency, no late fee", /hurry|last chance|late fee|interest|act now|expires soon/i.test(mail.text), false);
  is("written down as sent, with its first reminder on its day", [sent.request.sent.length, nextReminderAt(sent.request, now)], [1, now + REMIND_EVERY_DAYS * 86_400_000]);
  is("not again within a day by hand", canSendAgain(sent.request, now + 3_600_000).ok, false);
  // The store's emails for the month, all used: the next one does not go.
  const window = allowanceWindow(store, now)!;
  const keys = [...redis.keys()].filter((k) => k.startsWith("nl:allow:email:") && k.endsWith(window.id));
  for (const k of keys) redis.run(["SET", k, String(STORE_ALLOWANCES.creator.email)]);
  const refused = await sendRequestEmail(store, (await readRequest(request.id))!, now + 2 * 86_400_000);
  is("with the store's emails used, it does not go, and the creator is told why", [refused.sent, refused.request.sent.length, refused.request.failed.length > 0, mails.at(-1) === mail], [false, 1, true, true]);
  for (const k of keys) redis.run(["SET", k, "1"]);

  part("Paid through the same checkout as any sale");
  store = (await storeForEmail(owner))!;
  const opened = await openRequestCheckout(store, request.id, "https://marktmorgen.com", now);
  const body = checkouts.at(-1)!;
  is("payment request is charged on this creator's connected account", checkoutHeaders.at(-1)!.get("Stripe-Account"), store.stripeAccountId);
  is("the platform test credential acts on this connected account", checkoutHeaders.at(-1)!.get("Authorization"), "Bearer sk_test_payment_requests_only_a_stand_in");
  is("payment request has no platform destination or transfer routing", [...body.keys()].filter((key) => /transfer_data|on_behalf_of|destination/.test(key)), []);
  is("Stripe's page on the creator's account", opened.ok ? opened.url.startsWith("https://checkout.stripe.com/") : false, true);
  is("one payment of its lines, to the person it was sent to", [body.get("mode"), body.get("customer_email"), body.get("line_items[0][price_data][unit_amount]"), body.get("line_items[0][quantity]"), body.get("line_items[0][price_data][product_data][name]"), body.get("line_items[0][price_data][currency]")], ["payment", "client@example.com", "48000", "1", "Coaching, October (4 sessions)", "usd"]);
  is("marked as this request, for the sales list, the sweep and the receipt", [body.get("metadata[kind]"), body.get("metadata[request]"), body.get("metadata[store]"), body.get("payment_intent_data[metadata][kind]"), body.get("metadata[title]")], ["request", request.id, "danacoach", "request", "Payment request: Coaching, October (4 sessions)"]);
  is("its order admitted before Stripe's page opened", body.has("metadata[mm_admit]"), true);
  is("nothing that adds to the buyer's amount: no shipping, no code box, no fee on them", [...body.keys()].filter((k) => /shipping|promotion|discounts|surcharge/.test(k)), []);
  is("back to the request's own page", body.get("success_url"), `https://marktmorgen.com/@danacoach/pay/${request.id}?session_id={CHECKOUT_SESSION_ID}`);
  is("never open past the request's own time", Number(body.get("expires_at")) <= Math.floor(request.expiresAt / 1000), true);
  const again = await openRequestCheckout(store, request.id, "https://marktmorgen.com", now + 60_000);
  is("a second press opens the same checkout, never a second beside it", [again.ok && opened.ok ? again.url === opened.url : false, checkouts.length], [true, 1]);
  is("the plan's share is set on it the way it is on any sale", /applyShare\(body, store, \{ recurring: false, least: request\.total \}/.test(read("lib/payment-requests.ts")), true);
  const probe = new URLSearchParams();
  is("and with the share on, a Store plan's 6.25% of the total would be the fee", applyShare(probe, { shared: true, subscriptionActive: true, trialEnds: 0, tier: "creator" }, { recurring: false, least: request.total }, now / 1000, true), shareOf(COMMISSION_BPS.creator, 48_000));
  // Sales tax, where the creator collects it.
  const taxed = await createRequestCheckout({ ...store, tax: { enabled: true, included: false, ids: false, invoices: true } }, request, "https://marktmorgen.com", now);
  const taxBody = checkouts.at(-1)!;
  is("sales tax and Stripe's invoice where the creator switched them on", [Boolean(taxed.id), taxBody.get("automatic_tax[enabled]"), taxBody.get("line_items[0][price_data][tax_behavior]"), taxBody.get("invoice_creation[enabled]")], [true, "true", "exclusive", "true"]);
  checkouts.pop();
  // The month's orders at the figure: a request's checkout is refused before Stripe's page, like any.
  // One open place made free by canceling another person's request.
  const filler = (await listRequests(store, now))!.find((r) => r.email === "p1@example.com")!;
  await cancelRequest(store, filler.id, now);
  const other = await createRequest(store, (readDraft(draftBody({ email: "other@example.com", lines: [{ text: "Workshop", quantity: 1, amount: "90" }] }), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now + 1);
  const otherId = other.ok ? other.request.id : "";
  const folderKey = `nl:orders:n:${await storeFolder(storeRef(store))}:${window.id}`;
  redis.run(["SET", folderKey, String(ORDERS_INCLUDED.creator)]);
  is("past the plan's orders, it says the store is not taking new payments, and nothing opens", [await openRequestCheckout(store, otherId, "https://marktmorgen.com", now), checkouts.length], [{ ok: false, reason: "paused" }, 1]);
  redis.run(["SET", folderKey, "0"]);

  part("Back from paying: paid once, a receipt once, one order");
  const sessionId = opened.ok ? opened.url.split("/").at(-1)! : "";
  const unpaid = await settleFromReturn(store, (await readRequest(request.id))!, sessionId, now);
  is("not paid yet: still open", unpaid.state, "open");
  sessions.set(sessionId, { ...sessions.get(sessionId)!, status: "complete", payment_status: "paid", amount_total: 48_000, currency: "usd", payment_intent: "pi_ReqPaid000001", created: Math.floor(now / 1000) });
  const paid = await settleFromReturn(store, (await readRequest(request.id))!, sessionId, now);
  is("paid, with what Stripe took and its payment", [paid.state, paid.amountPaid, paid.payment, statusOf(paid, now)], ["paid", 48_000, "pi_ReqPaid000001", "paid"]);
  const ordersBefore = await storeOrdersThisMonth(store, now);
  const mailsBefore = mails.length;
  const confirmed = await confirmPurchase(store, sessionId);
  const receipt = mails.at(-1)!;
  is("the receipt goes, to the person, and the order is counted", [confirmed, mails.length - mailsBefore, receipt.to, receipt.subject, (await storeOrdersThisMonth(store, now)) - ordersBefore], ["sent", 1, "client@example.com", "Receipt from Dana's Studio Coaching: $480", 1]);
  is("the receipt names the payment and links to its printable page", [receipt.text.includes("pi_ReqPaid000001"), receipt.text.includes(`/pay/${request.id}`)], [true, true]);
  is("never twice", [await confirmPurchase(store, sessionId), mails.length - mailsBefore, (await storeOrdersThisMonth(store, now)) - ordersBefore], ["already", 1, 1]);
  is("a paid request is no longer open, and sends no reminder", [await openCount(store.sid, now), nextReminderAt(paid, now + 30 * 86_400_000)], [limit - 1, null]);
  is("and its page takes no second payment", await openRequestCheckout(store, request.id, "https://marktmorgen.com", now), { ok: false, reason: "gone" });

  part("A refund on Stripe shows");
  refunds = [{ id: "re_1", payment_intent: "pi_ReqPaid000001", status: "succeeded", amount: 10_000 }];
  let shown = await refreshRefunds(store, (await listRequests(store, now))!, now);
  is("in part: still paid, with what was refunded", [shown.find((r) => r.id === request.id)?.state, shown.find((r) => r.id === request.id)?.refunded], ["paid", 10_000]);
  refunds = [...refunds, { id: "re_2", payment_intent: "pi_ReqPaid000001", status: "succeeded", amount: 38_000 }];
  shown = await refreshRefunds(store, (await listRequests(store, now))!, now);
  is("in full: refunded, kept so", [shown.find((r) => r.id === request.id)?.state, (await readRequest(request.id))?.state], ["refunded", "refunded"]);

  part("Reminders: on their day, as many as asked, never after it closes");
  const remindee = await createRequest(big, (readDraft(draftBody({ email: "remind@example.com", autoReminders: 2 }), "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now);
  const rid = remindee.ok ? remindee.request.id : "";
  await sendRequestEmail(big, remindee.ok ? remindee.request : null!, now);
  const count = () => mails.filter((m) => m.to === "remind@example.com").length;
  await sendDueReminders(Date.now() + 10_000, now + 86_400_000);
  is("nothing before its day", count(), 1);
  await sendDueReminders(Date.now() + 10_000, now + REMIND_EVERY_DAYS * 86_400_000 + 1);
  is("the first reminder on its day, saying it is a reminder", [count(), mails.at(-1)!.subject.startsWith("Reminder from")], [2, true]);
  await sendDueReminders(Date.now() + 10_000, now + REMIND_EVERY_DAYS * 86_400_000 + 2);
  is("once", count(), 2);
  mailDown = true;
  await sendDueReminders(Date.now() + 10_000, now + 2 * REMIND_EVERY_DAYS * 86_400_000 + 1);
  is("one that cannot go is not sent and waits a day", [count(), (await readRequest(rid))!.sent.length], [2, 2]);
  mailDown = false;
  await sendDueReminders(Date.now() + 10_000, now + 2 * REMIND_EVERY_DAYS * 86_400_000 + 3_600_000);
  is("not within that day", count(), 2);
  await sendDueReminders(Date.now() + 10_000, now + (2 * REMIND_EVERY_DAYS + 1) * 86_400_000 + 2);
  is("then it goes", count(), 3);
  await sendDueReminders(Date.now() + 10_000, now + (3 * REMIND_EVERY_DAYS + 1) * 86_400_000 + 2);
  is("no more than the two asked for", count(), 3);
  is(`and at most ${MAX_SENDS} emails in all, by hand too`, [(await remindNow(big, rid, now + 40 * 86_400_000)).ok, (await remindNow(big, rid, now + 41 * 86_400_000)).ok], [true, false]);
  is("an expired request takes no payment and no reminder", [statusOf((await readRequest(rid))!, now + (OPEN_DAYS + 1) * 86_400_000), (await remindNow(big, rid, now + (OPEN_DAYS + 1) * 86_400_000)).ok], ["expired", false]);
  part("An uncertain provider response keeps its source without another send");
  const unknownDraft = readDraft(draftBody({ email: "uncertain@example.com" }), "usd", now);
  if (!unknownDraft.ok) throw Error("Synthetic uncertainty draft was refused");
  const unknownRequest = await createRequest(big, unknownDraft.draft, now);
  if (!unknownRequest.ok) throw Error("Synthetic uncertainty source was refused");
  const beforeUnknown = mailPosts;
  mailFailureStatus = 500; mailDown = true;
  const unknown = await sendRequestEmail(big, unknownRequest.request, now);
  mailDown = false;
  const unknownAgain = await sendRequestEmail(big, (await readRequest(unknownRequest.request.id))!, now);
  is("HTTP500 is not confirmed non-acceptance or permission to repeat", [unknown.sent, unknownAgain.sent, mailPosts - beforeUnknown], [false, false, 1]);
  is("the payment request source is retained for reconciliation", (await readRequest(unknownRequest.request.id))?.email, "uncertain@example.com");

  part("Cancel, delete, and deleting the person");
  is("an open request cannot be deleted before it is canceled", await deleteRequest(store, otherId, now), "open");
  const canceled = await cancelRequest(store, otherId, now);
  is("canceled: its link takes no payment", [canceled && typeof canceled === "object" ? canceled.state : canceled, await openRequestCheckout(store, otherId, "https://marktmorgen.com", now)], ["canceled", { ok: false, reason: "gone" }]);
  is("then deleted", [await deleteRequest(store, otherId, now), await readRequest(otherId)], ["deleted", null]);
  const gone = await forgetRequestsPerson(store.sid, "client@example.com");
  is("deleting the person deletes every request of theirs in that store", [gone, await readRequest(request.id)], [1, null]);
  is("and the person register and the erasure say so", [PERSON_DATA.some((d) => d.file === "lib/payment-request-store.ts" && d.how === "erased"), ERASERS.some((e) => e.module === "lib/payment-request-store.ts")], [true, true]);

  part("Said where creators and buyers read it");
  const privacy = read("app/privacy/page.tsx");
  is("the privacy policy says what is kept about the person and how it is deleted", [privacy.includes('id="payment-requests"'), /payment request/i.test(privacy)], [true, true]);
  is("the terms say a request goes only to someone who agreed to pay", /payment request/i.test(read("app/terms/page.tsx")), true);
  is("the help center and the feature page say what it does", [/payment request/i.test(read("lib/help-content.ts")), /payment request/i.test(read("lib/feature-pages.ts"))], [true, true]);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
