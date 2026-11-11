/**
 * 630 [HN6](28): payments that did not go through, read from the creator's
 * own Stripe account, counted by Stripe's reason with what usually helps;
 * an answer that cannot be read whole is unknown, never "no declines".
 */
import { readFileSync } from "node:fs";
import { DECLINE_WORDS, declineGroup, declineSummary, reasonOf } from "@/lib/declines-rules";
import * as declines from "@/lib/declines";
import { done, is, part } from "./check";

const ACCOUNT = "acct_Declines01";
process.env.STRIPE_SECRET_KEY = "sk_test_declines_stand_in";
const { DECLINE_PAGES, declinesSince, readDeclines } = declines;
// Read from the module as a whole, so the test runs (and fails by name) where the limit is missing.
const DECLINE_WAIT_MS = (declines as { DECLINE_WAIT_MS?: number }).DECLINE_WAIT_MS ?? Number.NaN;
const HANG = Symbol("hang");
/** A call that throws is a failed check, by name, not a stopped test. */
const tryOr = <T,>(read: () => T): T | string => { try { return read(); } catch (error) { return `threw: ${String(error)}`; } };
let pages: unknown[] = [];
const asked: URL[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== "/v1/charges" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== ACCOUNT) throw new Error(`unexpected ${url}`);
  asked.push(url);
  const next = pages.shift();
  // A page that never answers, until the request is given up (or 3 s, so a test never hangs).
  if (next === HANG) return new Promise<Response>((_, reject) => { const stop = setTimeout(() => reject(new Error("hung")), 3_000); init.signal?.addEventListener("abort", () => { clearTimeout(stop); reject(new Error("aborted")); }); });
  return Response.json(next ?? { error: "none" });
}) as typeof fetch;

const charge = (id: string, extra: Record<string, unknown>) => ({ id, object: "charge", amount: 4900, currency: "usd", created: 1_790_000_000, status: "failed", ...extra });

async function main(): Promise<void> {
  part("Stripe's reasons, grouped");
  is("the outcome's reason first, else the failure code", [reasonOf({ outcome: { reason: "insufficient_funds" }, failure_code: "card_declined" }), reasonOf({ failure_code: "expired_card" }), reasonOf({}), reasonOf({ failure_code: "<b>" })], ["insufficient_funds", "expired_card", "", ""]);
  is("each reason in its group", ["insufficient_funds", "expired_card", "incorrect_cvc", "authentication_required", "do_not_honor", "stolen_card", "processing_error", "currency_not_supported", "something_new"].map(declineGroup), ["funds", "expired", "typo", "confirm", "bank", "fraud", "network", "unsupported", "other"]);
  is("every group has a title and what helps", Object.values(DECLINE_WORDS).every((w) => w.title.length > 5 && w.help.length > 20), true);
  is("fraud is never met with asking for the same card again", DECLINE_WORDS.fraud.help.includes("Do not ask for the same card again"), true);
  const summary = declineSummary([
    { reason: "insufficient_funds", cents: 4900, currency: "usd", created: 1 },
    { reason: "insufficient_funds", cents: 1000, currency: "eur", created: 2 },
    { reason: "card_velocity_exceeded", cents: 100, currency: "usd", created: 3 },
    { reason: "expired_card", cents: 2000, currency: "usd", created: 4 },
    { reason: "", cents: 500, currency: "usd", created: 5 },
  ]);
  is("most first, amounts per currency never added across, Stripe's words kept", summary, [
    { group: "funds", count: 3, amounts: [{ currency: "eur", cents: 1000 }, { currency: "usd", cents: 5000 }], unknown: 0, reasons: ["card_velocity_exceeded", "insufficient_funds"] },
    { group: "expired", count: 1, amounts: [{ currency: "usd", cents: 2000 }], unknown: 0, reasons: ["expired_card"] },
    { group: "other", count: 1, amounts: [{ currency: "usd", cents: 500 }], unknown: 0, reasons: [] },
  ]);

  part("Read from the creator's Stripe account");
  is("no account, nothing read", [await readDeclines({ stripeAccountId: null }, 0), asked.length], [null, 0]);
  const since = declinesSince(30, Date.UTC(2026, 10, 3) / 1000 * 1000);
  pages = [{ object: "list", has_more: false, data: [charge("ch_1", { outcome: { reason: "insufficient_funds" } }), charge("ch_2", { status: "succeeded" }), charge("ch_3", { failure_code: "expired_card" })] }];
  const read = await readDeclines({ stripeAccountId: ACCOUNT }, since);
  is("only the failed ones, with their reason, amount and currency", read, { rows: [{ reason: "insufficient_funds", cents: 4900, currency: "usd", created: 1_790_000_000 }, { reason: "expired_card", cents: 4900, currency: "usd", created: 1_790_000_000 }], partial: false, charges: 3, oldest: 1_790_000_000 });
  is("from 30 days back, a hundred at a time", [asked[0].searchParams.get("created[gte]"), asked[0].searchParams.get("limit")], [String(Date.UTC(2026, 10, 3) / 1000 - 30 * 86_400), "100"]);
  pages = Array.from({ length: DECLINE_PAGES }, (_, i) => ({ object: "list", has_more: true, data: [charge(`ch_p${i}`, {})] }));
  const many = await readDeclines({ stripeAccountId: ACCOUNT }, since);
  is(`at most ${DECLINE_PAGES} pages, then partial`, [many?.rows.length, many?.partial, asked.slice(-2)[1].searchParams.get("starting_after")], [DECLINE_PAGES, true, `ch_p${DECLINE_PAGES - 2}`]);
  for (const bad of [{ data: null, has_more: false }, { data: [], has_more: "no" }, { data: [charge("ch_x", {}), charge("ch_x", {})], has_more: false }, { data: [null], has_more: false }]) {
    pages = [bad];
    is(`unreadable, so unknown, never zero: ${JSON.stringify(bad).slice(0, 40)}`, await readDeclines({ stripeAccountId: ACCOUNT }, since), null);
  }

  part("A read cut short is said to be incomplete, with how far back it went (Codex H MEDIUM 2, Claude 5 LEVE 1)");
  pages = Array.from({ length: DECLINE_PAGES }, (_, i) => ({ object: "list", has_more: true, data: [charge(`ch_ok${i}a`, { status: "succeeded", created: 1_790_000_100 - i * 10 }), charge(`ch_ok${i}b`, { status: "succeeded", created: 1_790_000_095 - i * 10 })] }));
  is("three full pages of payments that went through: no decline found, partial, how many read and the oldest read", await readDeclines({ stripeAccountId: ACCOUNT }, since), { rows: [], partial: true, charges: DECLINE_PAGES * 2, oldest: 1_790_000_095 - (DECLINE_PAGES - 1) * 10 });
  pages = [{ object: "list", has_more: false, data: [charge("ch_c1", { created: 1_790_000_300 }), charge("ch_c2", { status: "succeeded", created: 1_790_000_200 })] }];
  is("a complete read says so, with the same counts", await readDeclines({ stripeAccountId: ACCOUNT }, since), { rows: [{ reason: "", cents: 4900, currency: "usd", created: 1_790_000_300 }], partial: false, charges: 2, oldest: 1_790_000_200 });
  pages = [{ object: "list", has_more: true, data: [] }];
  is("Stripe saying there is more with nothing on the page is unknown, never \"none\"", await readDeclines({ stripeAccountId: ACCOUNT }, since), null);

  part("An amount, currency, status or time Stripe did not give readably is unknown, never 0, USD or nothing (Codex H MEDIUM 1)");
  pages = [{ object: "list", has_more: false, data: [charge("ch_eur", { currency: "eur", failure_code: "expired_card" })] }];
  is("control: a whole charge keeps its amount and its own currency", (await readDeclines({ stripeAccountId: ACCOUNT }, since))?.rows, [{ reason: "expired_card", cents: 4900, currency: "eur", created: 1_790_000_000 }]);
  for (const [label, extra] of [["amount missing", { amount: undefined }], ["amount null", { amount: null }], ["amount as text", { amount: "4900" }], ["amount negative", { amount: -1 }], ["amount fractional", { amount: 1.5 }], ["amount unsafe", { amount: 2 ** 60 }], ["currency missing", { currency: undefined }], ["currency upper case", { currency: "EUR" }], ["currency not three letters", { currency: "eu" }], ["currency null", { currency: null }]] as const) {
    pages = [{ object: "list", has_more: false, data: [charge("ch_bad", { failure_code: "expired_card", ...extra })] }];
    is(`${label}: the decline is counted, its amount and currency unknown`, (await readDeclines({ stripeAccountId: ACCOUNT }, since))?.rows, [{ reason: "expired_card", cents: null, currency: null, created: 1_790_000_000 }]);
  }
  for (const [label, extra] of [["status missing", { status: undefined }], ["status null", { status: null }], ["status unknown", { status: "declined" }], ["time missing", { created: undefined }], ["time as text", { created: "1790000000" }], ["time negative", { created: -5 }], ["not a charge", { object: "refund" }], ["id empty", { id: "" }]] as const) {
    pages = [{ object: "list", has_more: false, data: [charge("ch_good", {}), charge("ch_odd", { ...extra })] }];
    is(`${label}: whether it was declined is unknown, so the whole read is unknown`, await readDeclines({ stripeAccountId: ACCOUNT }, since), null);
  }
  is("an unknown amount is never added as zero: counted apart", tryOr(() => declineSummary([{ reason: "expired_card", cents: 4900, currency: "eur", created: 1 }, { reason: "expired_card", cents: null, currency: null, created: 2 }])), [{ group: "expired", count: 2, amounts: [{ currency: "eur", cents: 4900 }], unknown: 1, reasons: ["expired_card"] }]);

  part("A reason outside the table is \"other\", never something an object inherits (Codex H LEVE 1)");
  const inherited = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];
  is("inherited names are other", tryOr(() => inherited.map(declineGroup)), inherited.map(() => "other"));
  is("and summed as other, with Stripe's word kept", tryOr(() => declineSummary(inherited.map((reason, i) => ({ reason, cents: 100, currency: "usd", created: i }))).map((g) => [g.group, g.count])), [["other", inherited.length]]);

  part("The whole read has one time limit, not one per page (Claude 5 LEVE 2)");
  is("the limit is a few seconds", DECLINE_WAIT_MS > 0 && DECLINE_WAIT_MS <= 10_000, true);
  pages = [{ object: "list", has_more: true, data: [charge("ch_t1", { created: 1_790_000_500 })] }, HANG, HANG];
  const started = Date.now();
  const cut = await readDeclines({ stripeAccountId: ACCOUNT }, since, DECLINE_PAGES, 600);
  is("a page that never answers ends the read inside the limit, as a partial read of what came back", [Date.now() - started < 1_500, cut], [true, { rows: [{ reason: "", cents: 4900, currency: "usd", created: 1_790_000_500 }], partial: true, charges: 1, oldest: 1_790_000_500 }]);
  pages = [HANG];
  is("the first page never answering is unknown, never \"none\"", await readDeclines({ stripeAccountId: ACCOUNT }, since, DECLINE_PAGES, 300), null);
  pages = [];

  part("The page");
  const page = readFileSync("app/studio/declines/page.tsx", "utf8");
  is("only for the owner, who connected the Stripe account it reads whole (Claude 5 MEDIUM)", [page.includes('"payments")'), page.includes('"stats")')], [true, false]);
  is("says it counts every declined payment on the Stripe account", page.includes("It counts every declined payment on that account, including any that were not for this store."), true);
  is("an unreadable Stripe shows nothing rather than a wrong number", page.includes("so nothing is shown rather than a number that may be wrong"), true);
  is("a real table: caption, column and row headers", page.includes("<caption") && page.includes('scope="col"') && page.includes('scope="row"'), true);
  is("reached from the page of disputed purchases", readFileSync("app/studio/disputes/page.tsx", "utf8").includes('studioPath(store, "", "declines")'), true);

  done();
}

void main();
