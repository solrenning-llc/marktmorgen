/**
 * 767 [STN14], unit 4: bulk actions on the studio's sales list (lib/sales-bulk-rules.ts, lib/sales-bulk.ts,
 * app/api/store/sales-bulk/route.ts, components/sales-bulk-actions.tsx). Only actions that already exist one at a
 * time: a label on or off (the contact-labels route, with its review and undo), the purchase email again
 * (resendPurchase) and a file of the rows chosen. No action moves money.
 *
 *   - One request touches at most MAX_BULK_SALES orders: an internal bound, a whole page of the list, never a plan
 *     limit. More is refused whole, never cut.
 *   - The emails are counted before any is sent: when the store's email figure cannot be read, or has fewer left
 *     than the orders chosen, nothing is sent. Each email then still takes its own count, as one sent alone does,
 *     and keeps the per-sale and per-store limits of the single resend.
 *   - Rule 24: a row whose outcome is not the exact "sent" (an error, an unknown answer, a limit) is counted as
 *     "could not", never as sent; a label answer whose counts are not whole numbers is not read as a result.
 *   - The confirmation says what will happen and to how many people; the undo exists where the action can be taken
 *     back, and the words say so where it cannot.
 */
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesBulkActions } from "@/components/sales-bulk-actions";
import { POST } from "@/app/api/store/sales-bulk/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { ORDERS_PAGE_SIZE } from "@/lib/store-checkout";
import { RESEND_PER_SALE_PER_DAY, RESEND_PER_STORE_PER_HOUR } from "@/lib/resend-limits";
import {
  BULK_SALES_REFUSALS,
  type BulkSaleRow,
  MAX_BULK_SALES,
  NO_UNDO,
  bulkRowOf,
  canResend,
  exportConfirmWords,
  labelConfirmWords,
  readLabelOutcome,
  readLabelReview,
  readReferences,
  resendConfirmWords,
  resendResultWords,
  selectedSalesCsv,
} from "@/lib/sales-bulk-rules";
import { type BulkResendDeps, bulkResend } from "@/lib/sales-bulk";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const ref = (n: number) => `cs_test_${String(n).padStart(24, "a")}`;
const row = (over: Partial<BulkSaleRow> = {}): BulkSaleRow => ({
  reference: ref(1),
  title: "Course",
  email: "jane@example.com",
  paidAt: Date.UTC(2026, 10, 2, 15) / 1000,
  amount: 2700,
  currency: "usd",
  isCall: false,
  isTip: false,
  trial: false,
  ...over,
});

type Reply = { ok?: boolean; error?: string; message?: string; asked?: number; sent?: string[]; couldNot?: { reference: string; why: string }[]; skipped?: number; left?: number };

async function main(): Promise<void> {
  part("The bound: one request, one page of the list, never a plan limit");
  is("a whole page of the sales list fits in one action", MAX_BULK_SALES, ORDERS_PAGE_SIZE);
  is("the single resend's limits are the bulk's too", [RESEND_PER_SALE_PER_DAY, RESEND_PER_STORE_PER_HOUR], [3, 30]);
  is("no refusal talks about plans", Object.values(BULK_SALES_REFUSALS).some((words) => /plan/i.test(words)), false);

  part("Which orders can be sent again: those the list itself offers it for");
  is("a product with an address", canResend(row()), true);
  is("a booked call, a tip, no address, a one-click extra: not", [canResend(row({ isCall: true })), canResend(row({ isTip: true })), canResend(row({ email: null })), canResend(row({ reference: "pi_123" }))], [false, false, false, false]);
  is("a row keeps only what the bulk actions read", bulkRowOf({ ...row(), answers: [{ label: "Size", value: "M" }], stillDownloadable: true } as BulkSaleRow), row());

  part("The orders asked for, read exactly");
  is("not a list: none", readReferences("cs_test_x"), { ok: false, error: "none" });
  is("an empty list: none", readReferences([]), { ok: false, error: "none" });
  is("more than one request takes: refused whole, never cut", readReferences(Array.from({ length: MAX_BULK_SALES + 1 }, (_, i) => ref(i))), { ok: false, error: "many" });
  is("each order once; what is not an order is counted, never sent", readReferences([ref(1), ref(1), 42, "pi_1", ref(2)]), { ok: true, references: [ref(1), ref(2)], skipped: 2 });

  part("The confirmation says what will happen, and to how many people");
  is(
    "the purchase email again",
    resendConfirmWords(3, 2),
    "Send the purchase email again for 3 orders, to 2 people. Each email goes only to the address the buyer paid with, and each one uses one of your store's emails. An email cannot be taken back once it is sent.",
  );
  is("one order, one person", resendConfirmWords(1, 1).startsWith("Send the purchase email again for 1 order, to 1 person."), true);
  is(
    "the file",
    exportConfirmWords(4, 3),
    "Download a file of 4 orders, with the email addresses of 3 buyers. It holds people's details, so keep it safe. Nothing in your store changes.",
  );
  const review = { changes: 2, already: 1, notOnList: 3, full: 0, skipped: 0 };
  const adding = labelConfirmWords("VIP", "add", review, 1);
  is("a label: how many contacts change, and why the rest do not", [adding.startsWith('Add the label "VIP" to 2 contacts on your list.'), adding.includes("3 not on your list"), adding.includes("1 with no email address"), adding.includes("You can undo it right after.")], [true, true, true, true]);
  is("taking a label off", labelConfirmWords("VIP", "remove", review, 0).startsWith('Take the label "VIP" off 2 contacts on your list.'), true);
  is("no undo where nothing can be taken back, said in words", [NO_UNDO.resend, NO_UNDO.export], ["An email cannot be taken back once it is sent, so this has no undo.", "A download changes nothing in your store, so there is nothing to undo."]);

  part("The result: only an exact 'sent' is sent");
  const result = resendResultWords({ asked: 4, sent: [ref(1)], couldNot: [{ reference: ref(2), why: "refunded" }, { reference: ref(3), why: "failed" }], skipped: 1 });
  is("short", result.short, "Sent 1 email. 3 orders could not be sent.");
  is("each reason, and no undo", [result.words.includes("1 refunded"), result.words.includes("1 not confirmed as sent"), result.words.includes("1 not an order whose email can be sent again"), result.words.endsWith(NO_UNDO.resend)], [true, true, true, true]);
  is("none sent", resendResultWords({ asked: 1, sent: [], couldNot: [{ reference: ref(2), why: "limited" }], skipped: 0 }).short, "Sent 0 emails. 1 order could not be sent.");

  part("A label answer is read exactly (rule 24)");
  const good = { ok: true, changed: ["a@example.com"], removed: [{ email: "a@example.com", label: "VIP", at: 0 }], already: 1, full: 0, notOnList: 2 };
  is("a whole answer", readLabelOutcome(good, "remove"), { changed: ["a@example.com"], taken: [{ email: "a@example.com", label: "VIP", at: 0 }], already: 1, full: 0, notOnList: 2, noRoom: 0, failed: 0 });
  for (const [what, bad] of [
    ["a count as text", { ...good, already: "1" }],
    ["a count missing", { ...good, notOnList: undefined }],
    ["a negative count", { ...good, full: -1 }],
    ["changed not a list", { ...good, changed: "a@example.com" }],
    ["a changed address not text", { ...good, changed: [1] }],
    ["a failure count that is not whole", { ...good, failed: 0.5 }],
  ] as const) {
    is(`never a result: ${what}`, readLabelOutcome(bad, "remove"), null);
  }
  is("a review read exactly", readLabelReview(review), review);
  is("a review with a count as text is unknown", readLabelReview({ ...review, changes: "2" }), null);

  part("The file of the rows chosen: the list's own columns, never a formula, never an unknown amount as 0");
  const csv = selectedSalesCsv([row(), row({ reference: ref(2), title: "=SUM(1)", amount: 1.5, trial: true, email: null })]);
  const lines = csv.split("\r\n");
  is("a header and one line a row, ended", [lines[0], lines.length], ['"paid_at_utc","stripe_id","product","kind","amount","currency","buyer_email"', 4]);
  is("a row", lines[1], `"2026-11-02T15:00:00.000Z","${ref(1)}","Course","product","27.00","USD","jane@example.com"`);
  is("a formula kept as text, an unknown amount left blank", lines[2], `"2026-11-02T15:00:00.000Z","${ref(2)}","'=SUM(1)","trial","","USD",""`);

  part("The screen: a table to choose in, a live count, only the actions the role allows, none that moves money");
  const screen = (canLabel: boolean, canExport: boolean) => renderToStaticMarkup(createElement(SalesBulkActions, { sales: [row(), row({ reference: ref(2), email: null })], canLabel, canExport }));
  const full = screen(true, true);
  is("a table with a caption, column and row headers, a box per order with its own name", [full.includes("<caption"), full.includes('scope="col"'), full.includes('scope="row"'), full.includes("Choose Course, jane@example.com,"), full.includes("Choose Course, no email address,")], [true, true, true, true, true]);
  is("the count of chosen orders, live", full.includes('role="status" class="mt-2 text-sm font-semibold text-ink">0 of 2 orders chosen'), true);
  is("every action the role allows", ["Send their purchase email again", "Add a label to their contacts", "Take a label off their contacts", "Download these orders as a file"].map((w) => full.includes(w)), [true, true, true, true]);
  const support = screen(false, false);
  is("support: only the email again, no label, no file", ["Send their purchase email again", "Add a label", "Download these orders"].map((w) => support.includes(w)), [true, false, false]);
  is("no refund, no charge", /refund it|charge it|Refund these|Charge these/i.test(full), false);
  is("nothing happens before a confirmation", [full.includes("Check what will happen"), full.includes(">Confirm<")], [true, false]);

  part("Sending again: counted first, then each one as alone (lib/sales-bulk.ts)");
  const store = { sid: "s1", handle: "shop", statsId: "st1", tier: "creator", period: paidPeriod() } as unknown as Parameters<typeof bulkResend>[0];
  const calls: string[] = [];
  const deps = (over: Partial<BulkResendDeps> = {}): BulkResendDeps => ({
    used: async () => 0,
    figure: () => 100,
    within: async () => true,
    resend: async (_store, reference) => {
      calls.push(reference);
      return "sent";
    },
    ...over,
  });
  calls.length = 0;
  const uncounted = await bulkResend(store, { references: [ref(1)], skipped: 0 }, deps({ used: async () => null }));
  is("emails that cannot be counted: nothing sent", [uncounted.ok, !uncounted.ok && uncounted.error, calls.length], [false, "uncounted", 0]);
  const failingRead = await bulkResend(store, { references: [ref(1)], skipped: 0 }, deps({ used: async () => { throw new Error("lost"); } }));
  is("a count that throws: nothing sent", [failingRead.ok, !failingRead.ok && failingRead.error, calls.length], [false, "uncounted", 0]);
  const short = await bulkResend(store, { references: [ref(1), ref(2), ref(3)], skipped: 0 }, deps({ used: async () => 98 }));
  is("fewer emails left than orders chosen: nothing sent, the room said", [short.ok, !short.ok && short.error, !short.ok && short.left, calls.length], [false, "emails", 2, 0]);
  is("its words say how many are left and what to do", !short.ok && short.message, "Your store has 2 emails left before its email count starts again, fewer than the 3 this would send. Choose 2 orders or fewer, or wait until the count starts again.");
  const outcomes: Record<string, unknown> = { [ref(1)]: "sent", [ref(2)]: "refunded", [ref(4)]: "OK", [ref(5)]: "unknown" };
  const mixed = await bulkResend(
    store,
    { references: [ref(1), ref(2), ref(3), ref(4), ref(5)], skipped: 1 },
    deps({
      resend: async (_store, reference) => {
        calls.push(reference);
        if (reference === ref(3)) throw new Error("Stripe timed out");
        return outcomes[reference] as "sent";
      },
    }),
  );
  is(
    "each row counted by its exact answer: an error or a strange answer is 'not confirmed', never sent",
    mixed.ok && mixed.tally,
    { asked: 6, sent: [ref(1)], couldNot: [{ reference: ref(2), why: "refunded" }, { reference: ref(3), why: "failed" }, { reference: ref(4), why: "failed" }, { reference: ref(5), why: "unknown" }], skipped: 1 },
  );
  calls.length = 0;
  const asked: string[] = [];
  const limited = await bulkResend(
    store,
    { references: [ref(1), ref(2)], skipped: 0 },
    deps({
      within: async (scope, who, limit, seconds) => {
        asked.push(`${scope}:${limit}:${seconds}`);
        return !(scope === "resend-store" && who === "s1" && asked.length > 2);
      },
    }),
  );
  is("the single resend's limits, per sale then per store, for each row", asked, ["resend-sale:3:86400", "resend-store:30:3600", "resend-sale:3:86400", "resend-store:30:3600"]);
  is("a row past a limit is not sent and says so", [limited.ok && limited.tally.sent, limited.ok && limited.tally.couldNot, calls], [[ref(1)], [{ reference: ref(2), why: "limited" }], [ref(1)]]);

  part("The studio's route (app/api/store/sales-bulk), through the real session, store and purchase email");
  redis.clear();
  const owner = "bulk@example.com";
  await claimHandle(owner, "bulkshop", "Bulk Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_bulk", subscriptionId: "sub_bulk", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const url = "https://marktmorgen.com/api/store/sales-bulk";
  const post = async (body: Record<string, unknown>, as = cookie, extra: Record<string, string> = {}) => {
    const response = await POST(new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": shop.sid, cookie: as, ...extra }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  // This store has no payments account, so its sales cannot be found: each order is "could not", never "sent".
  const unfound = await post({ action: "resend", references: [ref(1), ref(2), "nope"] });
  is("orders that are not found: none sent, each counted", [unfound.status, unfound.body.sent, unfound.body.couldNot?.map((c) => c.why), unfound.body.skipped, unfound.body.asked], [200, [], ["unknown", "unknown"], 1, 3]);
  is("too many: refused whole, in words", [(await post({ action: "resend", references: Array.from({ length: MAX_BULK_SALES + 1 }, (_, i) => ref(i)) })).body.message], [BULK_SALES_REFUSALS.many]);
  is("nothing chosen", (await post({ action: "resend", references: [] })).body.error, "none");
  is("an action that is not one (no refund, no charge)", [(await post({ action: "refund", references: [ref(1)] })).status, (await post({ action: "charge", references: [ref(1)] })).body.error], [400, "unknown"]);
  is("from another site: refused", (await post({ action: "resend", references: [ref(1)] }, cookie, { origin: "https://evil.example" })).status, 403);
  is("no session: refused", (await post({ action: "resend", references: [ref(1)] }, "")).status, 401);
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:allow:email:")) ? ["12abc"] : original.call(redis, commands)) as typeof redis.pipeline;
  try {
    const blind = await post({ action: "resend", references: [ref(1)] });
    is("the store's emails could not be counted: 503, nothing sent", [blind.status, blind.body.error, blind.body.sent, blind.body.message], [503, "uncounted", undefined, BULK_SALES_REFUSALS.uncounted]);
  } finally {
    redis.pipeline = original;
  }

  part("Team roles: those who may send a purchase email again, and no one else");
  await putMember(shop, "support@example.com", "support");
  await putMember(shop, "editor@example.com", "editor");
  const helper = `${SESSION_COOKIE}=${await openSession("support@example.com")}`;
  const writer = `${SESSION_COOKIE}=${await openSession("editor@example.com")}`;
  is("support may, an editor may not", [(await post({ action: "resend", references: [ref(1)] }, helper)).status, (await post({ action: "resend", references: [ref(1)] }, writer)).status], [200, 403]);

  done();
}

void main();
