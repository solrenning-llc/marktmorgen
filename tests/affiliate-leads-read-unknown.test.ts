/**
 * A program's leads, read only in their exact shape (CX-123 rules 24 and 30; audit r24 item M2). Synthetic only:
 * the in-memory Redis double, through lib/affiliate-leads.ts and the real route app/api/store/affiliates/route.ts.
 *
 * 1. (MEDIUM, money) The creator's approval (decideLeads "approve") judges a new lead against the month's budget,
 *    the day's cap and the hour's limit by summing the leads read with readLeads. A kept lead that did not read
 *    (broken JSON, or a field of another type, filled in with 0 or "open") silently dropped out of those sums, so a
 *    new lead was approved over the creator's monthly budget or daily cap: commission owed past the creator's own
 *    ceiling. Now readLeads throws UnknownReplyError, the route answers 503 "unavailable", and nothing is written.
 * 2. (privacy) The person's copy of their data (lib/person-copy.ts) read their leads the same way: a reply of another
 *    shape, or their own lead unreadable, gave a copy without it that looked complete. Now the copier throws, and
 *    copyPerson fails the whole copy (it never hands one over with a part missing).
 * 3. (rule 30, the sibling readers) Deleting a person (forgetLeadPerson) answered "nothing to forget" on a kept lead
 *    that did not read, though the address could still be in it: now it throws, and the erasure retries; and it
 *    wrote the lead back filled in with parseLead's defaults, turning an amount of another type into a readable 0
 *    that readLeads would then sum: now only the address changes. The
 *    contact credit (contactFor) never credits an affiliate from a lead that does not read exactly, such as a
 *    reversal whose state no longer reads.
 *
 * Controls: the exact empty list is no leads; healthy leads under the budget are approved; the budget and the daily
 * cap reached by healthy leads refuse the new one ("not_ready"); a person with no lead has nothing to forget.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { type LeadRecord, leadsKey } from "@/lib/affiliate-lead-rules";
import { contactFor, decideLeads, forgetLeadPerson, leadId, readLeads } from "@/lib/affiliate-leads";
import { COPIERS } from "@/lib/person-copy";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
type Break = "none" | "leads-object" | "leads-queued" | "leads-odd";
let breakWhat: Break = "none";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  const leads = one?.[0] === "HGETALL" && /^nl:aff:[^:]+:leads$/.test(String(one[1]));
  if (leads && breakWhat === "leads-object") return [{ a: "b" }];
  if (leads && breakWhat === "leads-queued") return ["QUEUED"];
  if (leads && breakWhat === "leads-odd") {
    const [list] = (await real(commands)) as unknown[][];
    return [[...list, "stray"]];
  }
  return real(commands);
}) as typeof redis.pipeline;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ANA = "aaaaaaaaaaaa";
// The 2nd of the UTC month two months back, at noon: past every hold below, and the day and month never cross a
// boundary whatever today's date (the date anchor of tests/affiliate-leads.test.ts, #3142).
const OLD = ((at: Date) => Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 2, 2, 12) / 1000)(new Date(NOW * 1000));
const id = (n: number) => n.toString(16).padStart(24, "0");

/** A lead as recordLead writes it: $5 each, a $10 month, ten a day, a week's hold, all on the same day. */
const lead = (n: number, over: Partial<LeadRecord> = {}): LeadRecord => ({
  id: id(n),
  aff: ANA,
  kind: "signup",
  at: OLD + n,
  end: 0,
  ref: "",
  pi: "",
  paid: 0,
  title: "",
  email: `p${n}@example.com`,
  cents: 500,
  currency: "usd",
  hold: 7,
  daily: 10,
  budget: 1_000,
  state: "open",
  d: 0,
  why: "",
  ...over,
});

async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    const value = await run();
    return `no error: ${JSON.stringify(value)}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "leads-read@example.com";
  await claimHandle(OWNER, "leadsread", "Leads Read", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, `acct_1${"leadsread".padEnd(15, "x")}`, true);
  await setSubscription(OWNER, { customerId: "cus_leadsread", subscriptionId: "sub_leadsread", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const statsId = store.statsId as string;
  const key = leadsKey(statsId);
  const session = await openSession(OWNER);
  const approve = async (ids: string[]) => {
    const response = await affiliatesRoute(
      new NextRequest("https://marktmorgen.com/api/store/affiliates", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ action: "leads", ids, decision: "approve" }),
      }),
    );
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; changed?: number } };
  };
  const put = async (rows: [string, string][]) => {
    await real([["DEL", key]]);
    if (rows.length) await real([["HSET", key, ...rows.flat()]]);
  };
  const stateOf = async (n: number) => (JSON.parse(String((await real([["HGET", key, id(n)]]))[0])) as LeadRecord).state;

  part("Controls: the exact empty list, healthy leads, and the budget and the cap reached by healthy leads");
  await put([]);
  is("no leads kept: the exact empty list is none", await readLeads(store), []);
  is("no leads kept: a decision on a lead that is not there is unknown", await decideLeads(store, [id(9)], "approve"), { ok: false, reason: "unknown" });
  await put([
    [id(1), JSON.stringify(lead(1, { state: "approved", d: OLD + DAY }))],
    [id(3), JSON.stringify(lead(3))],
  ]);
  is("healthy leads read whole", (await readLeads(store)).map((l) => [l.id, l.state]), [[id(1), "approved"], [id(3), "open"]]);
  is("one approved ($5 of $10): the new lead is approved", [await approve([id(3)]), await stateOf(3)], [{ status: 200, body: { ok: true, changed: 1 } }, "approved"]);
  await put([
    [id(1), JSON.stringify(lead(1, { state: "approved", d: OLD + DAY }))],
    [id(2), JSON.stringify(lead(2, { state: "approved", d: OLD + DAY }))],
    [id(3), JSON.stringify(lead(3))],
  ]);
  is("two approved reach the $10 budget: the new lead is refused", [await approve([id(3)]), await stateOf(3)], [{ status: 400, body: { ok: false, error: "lead_not_ready" } }, "open"]);
  // Two a day, so one an hour (hourlyLeads): each lead in its own hour of the same day, so only the day's cap counts.
  const capped = (n: number, over: Partial<LeadRecord> = {}) => lead(n, { daily: 2, budget: 100_000, at: OLD + n * 3_600, ...over });
  const euro = (n: number, over: Partial<LeadRecord> = {}) => lead(n, { currency: "eur", ...over });
  await put([
    [id(1), JSON.stringify(capped(1, { state: "approved", d: OLD + DAY }))],
    [id(2), JSON.stringify(capped(2, { state: "approved", d: OLD + DAY }))],
    [id(3), JSON.stringify(capped(3))],
  ]);
  is("two approved reach the cap of two a day: the new lead is refused", [await approve([id(3)]), await stateOf(3)], [{ status: 400, body: { ok: false, error: "lead_not_ready" } }, "open"]);

  part("1. An approved lead that does not read never drops out of the budget or the cap");
  const approvedJson = (over: Partial<LeadRecord>) => JSON.stringify(lead(2, { state: "approved", d: OLD + DAY, ...over }));
  const broken: [string, string, (base: (n: number, o?: Partial<LeadRecord>) => LeadRecord) => string][] = [
    ["broken JSON", "budget", () => `{"id":"${id(2)}","aff":"${ANA}","kind":"signup","cents":500,`],
    ["its amount as text", "budget", () => approvedJson({ cents: "500" as unknown as number })],
    ["its currency in capitals (a euro lead read as dollars)", "budget", (base) => JSON.stringify(base(2, { state: "approved", d: OLD + DAY, currency: "EUR" }))],
    // Filled in as "open", it is still counted here (it fits the caps); never filled in all the same.
    ["its state of another shape", "budget", () => approvedJson({ state: "APPROVED" as LeadRecord["state"] })],
    ["its time as text", "cap", (base) => JSON.stringify(base(2, { state: "approved", d: OLD + DAY, at: String(OLD + 2 * 3_600) as unknown as number }))],
  ];
  for (const [what, limit, json] of broken) {
    const base = limit === "cap" ? capped : what.startsWith("its currency") ? euro : lead;
    await put([
      [id(1), JSON.stringify(base(1, { state: "approved", d: OLD + DAY }))],
      [id(2), json(base)],
      [id(3), JSON.stringify(base(3))],
    ]);
    is(`${limit}, the second approved lead with ${what}: readLeads throws UnknownReplyError`, await thrown(() => readLeads(store)), "UnknownReplyError");
    is(`${limit}, ${what}: the approval answers 503 unavailable and the new lead stays open`, [await approve([id(3)]), await stateOf(3)], [{ status: 503, body: { ok: false, error: "unavailable" } }, "open"]);
  }

  part("1b. A HGETALL reply of another shape is never an empty or a partial list");
  await put([[id(1), JSON.stringify(lead(1, { state: "approved", d: OLD + DAY }))], [id(3), JSON.stringify(lead(3))]]);
  for (const shape of ["leads-object", "leads-queued", "leads-odd"] as const) {
    breakWhat = shape;
    is(`${shape}: readLeads throws UnknownReplyError`, await thrown(() => readLeads(store)), "UnknownReplyError");
    is(`${shape}: the approval answers 503 unavailable`, (await approve([id(3)])).status, 503);
    breakWhat = "none";
  }
  is("the new lead was never approved on a reply of another shape", await stateOf(3), "open");

  part("2. The person's copy never comes out complete with a lead missing");
  const copier = COPIERS["lib/affiliate-leads.ts"];
  const scope = { store, email: "p1@example.com" } as unknown as Parameters<typeof copier>[0];
  await put([[id(1), JSON.stringify(lead(1))], [id(2), JSON.stringify(lead(2))]]);
  is("healthy: the person's own lead is copied", ((await copier(scope)) as LeadRecord[]).map((l) => l.id), [id(1)]);
  await put([]);
  is("no leads kept: nothing to copy, exactly", await copier(scope), []);
  for (const shape of ["leads-object", "leads-queued"] as const) {
    await put([[id(1), JSON.stringify(lead(1))]]);
    breakWhat = shape;
    is(`${shape}: the copier throws, never an empty copy`, await thrown(() => copier(scope)), "UnknownReplyError");
    breakWhat = "none";
  }
  await put([[id(1), `{"id":"${id(1)}","email":"p1@example.com","aff":`]]);
  is("their own lead unreadable: the copier throws, never a copy without it", await thrown(() => copier(scope)), "UnknownReplyError");

  part("3. The sibling readers: deleting a person, and the contact credit");
  const email = "erase.me@example.com";
  const theirs = leadId(statsId, email);
  await put([]);
  is("no lead for the person: nothing to forget", await forgetLeadPerson(store, email), 0);
  await put([[theirs, `{"id":"${theirs}","aff":"${ANA}","email":"${email}","kind":`]]);
  is("their lead unreadable, the address maybe in it: the deletion throws and is tried again", await thrown(() => forgetLeadPerson(store, email)), "UnknownReplyError");
  is("and the record is left as it was", (await real([["HGET", key, theirs]]))[0], `{"id":"${theirs}","aff":"${ANA}","email":"${email}","kind":`);
  await put([[theirs, JSON.stringify({ ...lead(4), id: theirs, email })]]);
  is("a healthy lead: the address comes off", [await forgetLeadPerson(store, email), (JSON.parse(String((await real([["HGET", key, theirs]]))[0])) as LeadRecord).email], [1, ""]);
  const keptNow = async () => JSON.parse(String((await real([["HGET", key, theirs]]))[0])) as Record<string, unknown>;
  await put([[theirs, JSON.stringify({ ...lead(6, { state: "approved", d: OLD + DAY }), id: theirs, email, cents: "500" })]]);
  is(
    "an amount of another type: the address comes off, and the amount is written back as kept, never a readable 0",
    [await forgetLeadPerson(store, email), ...(await keptNow().then((v) => [v.email, v.cents]))],
    [1, "", "500"],
  );
  is("so the program's leads still do not read after the deletion", await thrown(() => readLeads(store)), "UnknownReplyError");
  await put([[theirs, JSON.stringify({ ...lead(6), id: theirs, email: [email] })]]);
  is("an address of another type: the deletion throws and is tried again", await thrown(() => forgetLeadPerson(store, email)), "UnknownReplyError");

  const buyer = "buyer.contact@example.com";
  const contact = leadId(statsId, buyer);
  const credited = { ...store, affiliates: { ...store.affiliates, enabled: true, contacts: true, lead: { kind: "signup" as const, cents: 500, hold: 7, daily: 10, budget: 1_000 } } } as Store;
  await put([[contact, JSON.stringify({ ...lead(5), id: contact, email: buyer })]]);
  is("control: a healthy lead before the checkout credits its affiliate", await contactFor(credited, buyer, NOW), ANA);
  await put([[contact, JSON.stringify({ ...lead(5, { state: "REVERSED" as LeadRecord["state"], d: OLD + DAY, why: "duplicate" }), id: contact, email: buyer })]]);
  is("a reversal whose state no longer reads never credits the affiliate", await contactFor(credited, buyer, NOW), "");

  done();
}

void main();
