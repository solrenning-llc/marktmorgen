/**
 * CX-123 rule 24 for the "already on an invoice?" check (lib/billing.ts
 * findInvoiceLine), read before lib/usage-billing.ts carryOut adds a line to
 * a creator's next invoice. A line begun on a run that timed out is looked
 * for again on the next day's run; Stripe's Idempotency-Key covers only 24
 * hours, so the check is all that stands between that run and a second
 * charge for the same use.
 *
 * "Not there" is read only from a complete answer: `object: "list"`, `data`
 * a list of lines each with an id and a metadata object, and
 * `has_more: false` on the last page read. Any other shape (data that is not
 * a list, `has_more` missing or not a boolean, a page that cannot be
 * continued, a line in an odd shape, the page ceiling reached) is unknown:
 * the check throws, carryOut reports "failed", nothing is added and the
 * line is looked for again tomorrow. Healthy answers read as before.
 * Stripe is a stand-in; synthetic data only.
 */
import { findInvoiceLine } from "@/lib/billing";
import { rememberFolderOwner } from "@/lib/delivery";
import { claimHandle, setSubscription, storeFolder } from "@/lib/store";
import { type Meter, settleUsage } from "@/lib/usage-billing";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_invoice_line_exact";
delete process.env.STRIPE_CONNECT_API_BASE;

const CUSTOMER = "cus_LineExact001";
const SUBSCRIPTION = "sub_LineExact0001";
const MARK_OF = (folder: string, month: string) => `probe:${folder}:${month}:0`;

let pages: unknown[] = [];
let asked = 0;
let added = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected ${url}`);
  const method = init?.method ?? "GET";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.pathname === "/v1/invoiceitems" && method === "GET") {
    const page = asked < pages.length ? pages[asked] : { object: "list", data: [], has_more: false };
    asked += 1;
    return json(page);
  }
  if (url.pathname === "/v1/invoiceitems" && method === "POST") {
    added += 1;
    return json({ id: `ii_LineExact${String(added).padStart(6, "0")}`, object: "invoiceitem" });
  }
  throw new Error(`unexpected ${method} ${url.pathname}`);
}) as typeof fetch;

const line = (id: string, mark?: string) => ({ id, object: "invoiceitem", metadata: mark === undefined ? {} : { mark } });
const full = (from: number) => Array.from({ length: 100 }, (_, i) => line(`ii_${String(from + i).padStart(8, "0")}`, "another:line"));
const list = (data: unknown, has_more: unknown = false) => ({ object: "list", url: "/v1/invoiceitems", data, has_more });

/** findInvoiceLine on the given pages: what it said ("rejected" when it threw) and how many pages it asked for. */
async function find(given: unknown[], mark: string, customer = CUSTOMER): Promise<{ found: boolean | "rejected"; asked: number }> {
  pages = given;
  asked = 0;
  try {
    return { found: await findInvoiceLine(customer, mark, 0), asked };
  } catch {
    return { found: "rejected", asked };
  }
}

/** Unknown answers: each must be refused, never read as "not there". Built per mark, since one of them carries it on page 2. */
const unknownAnswers = (mark: string): [string, unknown[]][] => [
  ["data that is not a list (null)", [list(null)]],
  ["data that is an object", [list({ 0: line("ii_00000001", mark) })]],
  ["no data at all", [{ object: "list", has_more: false }]],
  ["not a list object", [{ object: "invoiceitem", data: [], has_more: false }]],
  ["no object field", [{ data: [], has_more: false }]],
  ["has_more missing, the line on page 2", [{ object: "list", data: full(0) }, list([line("ii_00000999", mark)])]],
  ["has_more missing on an empty page", [{ object: "list", data: [] }]],
  ["has_more a string", [list([], "false")]],
  ["has_more null", [list([], null)]],
  ["has_more true, but the last line has no id to go on from", [list([{ object: "invoiceitem", metadata: {} }], true)]],
  ["has_more true on an empty page", [list([], true)]],
  ["a line that is null", [list([null])]],
  ["a line that is a string", [list(["ii_00000001"])]],
  ["a line without metadata", [list([{ id: "ii_00000001", object: "invoiceitem" }])]],
  ["a line whose metadata is null", [list([{ id: "ii_00000001", object: "invoiceitem", metadata: null }])]],
  ["a line without an id", [list([{ object: "invoiceitem", metadata: {} }])]],
  ["a body that is null", [null]],
  ["a body that is a list", [[line("ii_00000001")]]],
  ["the page ceiling reached, the line on page 4", [list(full(0), true), list(full(100), true), list(full(200), true), list([line("ii_00000999", mark)])]],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const error = console.error;
  console.error = () => {};

  const MARK = "probe:folder1:2026-11:0";

  part("findInvoiceLine: healthy answers read as before");
  is("the line on the first page: found, one page", await find([list([line("ii_00000001", MARK)])], MARK), { found: true, asked: 1 });
  is("a complete, empty answer: not there, one page", await find([list([])], MARK), { found: false, asked: 1 });
  is("other lines only (one without a mark): not there", await find([list([line("ii_00000001"), line("ii_00000002", "another:line")])], MARK), { found: false, asked: 1 });
  is("the line on page 2 of a complete walk: found, two pages", await find([list(full(0), true), list([line("ii_00000999", MARK)])], MARK), { found: true, asked: 2 });
  is("two complete pages without it: not there", await find([list(full(0), true), list(full(100))], MARK), { found: false, asked: 2 });
  is("the line on the third and last page: found", await find([list(full(0), true), list(full(100), true), list([line("ii_00000999", MARK)])], MARK), { found: true, asked: 3 });
  is("found on page 1 even with has_more true: not asked further", await find([list([line("ii_00000001", MARK)], true)], MARK), { found: true, asked: 1 });

  part("findInvoiceLine: an answer that is not complete is unknown, never 'not there'");
  for (const [label, given] of unknownAnswers(MARK)) {
    const got = await find(given, MARK);
    is(`${label}: refused`, got.found, "rejected");
  }
  is("a customer id that is not one of Stripe's: refused, Stripe not asked", await find([], MARK, "not-a-customer"), { found: "rejected", asked: 0 });

  // ------------------------------------------------- through carryOut
  const month = "2026-11";
  const now = Date.UTC(2026, 10, 20, 14);
  const PROBE: Meter = {
    name: "probe",
    measured: async () => 10,
    owed: () => 500,
    byPlan: false,
    covered: 0,
    describe: () => "Probe use",
    folders: async () => [],
  };
  await claimHandle("line-exact@example.com", "lineexact", "lineexact", "");
  const folder = await storeFolder("line-exact@example.com");
  await rememberFolderOwner(folder, "line-exact@example.com");
  await setSubscription("line-exact@example.com", { customerId: CUSTOMER, subscriptionId: SUBSCRIPTION, active: true, cycle: "month", period: paidPeriod(now) });
  const mark = MARK_OF(folder, month);
  const billedKey = `nl:probe:billed:${folder}:${month}`;
  const addingKey = `nl:probe:adding:${folder}:${month}`;

  /**
   * The next day's run for a line begun two days before on a run that timed
   * out (written down, never confirmed): the Idempotency-Key no longer
   * covers it. What the run reported, how many lines it added, and whether
   * the begun line is still written down to be looked for again.
   */
  async function nextDay(given: unknown[]): Promise<{ state: string; added: number; kept: boolean; billed: unknown }> {
    await redis.pipeline([["DEL", billedKey, addingKey]]);
    const begun = { from: 0, to: 500, at: now - 2 * 86_400_000, amount: 10, line: "Probe use", customerId: CUSTOMER, subscriptionId: SUBSCRIPTION };
    await redis.pipeline([["SET", addingKey, JSON.stringify(begun)]]);
    pages = given;
    asked = 0;
    added = 0;
    let state = "rejected";
    try {
      state = (await settleUsage(PROBE, folder, month, true, now)).state;
    } catch {
      state = "rejected";
    }
    const [held, billed] = await redis.pipeline([["GET", addingKey], ["GET", billedKey]]);
    return { state, added, kept: typeof held === "string", billed };
  }

  part("carryOut: healthy answers act as before");
  is("the begun line is there: billed, nothing added again", await nextDay([list([line("ii_00000001", mark)])]), { state: "billed", added: 0, kept: false, billed: "500" });
  is("a complete answer without it: added once, billed", await nextDay([list([line("ii_00000001")])]), { state: "billed", added: 1, kept: false, billed: "500" });

  part("carryOut: an unknown answer adds nothing and keeps the line to look for again");
  for (const [label, given] of unknownAnswers(mark)) {
    is(`${label}: failed, nothing added`, await nextDay(given), { state: "failed", added: 0, kept: true, billed: null });
  }

  console.error = error;
  done();
}

void main();
