/**
 * Pay per lead (lib/affiliate-lead-rules.ts, lib/affiliate-leads.ts; added
 * 18 October 2026, HighLevel audit H29). Checked:
 *
 *   - the terms as kept, and refused out of range rather than replaced;
 *   - a sign-up credited only once confirmed and only for an address new to
 *     the list; a free product the first time; a booking carried on its
 *     checkout, never from a package;
 *   - one lead per person per program, written any way; never the
 *     affiliate's own address, their pay address or the creator's; never for
 *     an affiliate not approved, or a kind the program does not pay;
 *   - the daily cap, the hourly limit and the monthly budget, each lead
 *     judged by its own day's terms; a reversal frees its place;
 *   - the hold, then the creator's approval, before a lead is payable; a
 *     booking only after its call and never when refunded; reversals with a
 *     reason, and undone;
 *   - the book: leads beside sales, never a sale, a bonus or a second tier;
 *     held with everything else; in the spreadsheet;
 *   - erasure takes the address off the lead and keeps the fingerprint;
 *   - what it costs: a sign-up takes one of the store's public requests, and
 *     a lead's write stays inside a later page's commands.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureListId, ensureStatsId, setAffiliateSetting, setJoin, setSubscription, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import {
  type LeadRecord,
  MIN_LEAD_HOLD_DAYS,
  NO_LEADS,
  hourlyLeads,
  leadProblem,
  leadsKey,
  maskEmail,
  parseLeadSetting,
  settleLeads,
} from "@/lib/affiliate-lead-rules";
import { decideLeads, forgetLeadPerson, leadAffiliate, leadId, readLeads, recordLead } from "@/lib/affiliate-leads";
import { bookCsv, readBook } from "@/lib/affiliates";
import { askToJoin, confirmJoin, readJoinToken } from "@/lib/store-join";
import { callCheckoutBody } from "@/lib/calls";
import { LEAD_WORDS } from "@/lib/buyer-words/affiliate-leads";
import { PERSON_DATA } from "@/lib/person-data";
import { ERASERS } from "@/lib/person-erasure";
import { COMMANDS } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_leads_only";
const mails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    mails.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const OWNER = "chef@example.com";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";
const CAL = "cccccccccccc";
const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * DAY) * 1000, decidedAt: 1, note: "", ...over });

/** A lead as kept, for the pure rules. */
const lead = (over: Partial<LeadRecord>): LeadRecord => ({
  id: "0123456789abcdef01234567",
  aff: ANA,
  kind: "signup",
  at: NOW - 40 * DAY,
  end: 0,
  ref: "",
  pi: "",
  paid: 0,
  title: "",
  email: "x@example.com",
  cents: 500,
  currency: "usd",
  hold: 30,
  daily: 10,
  budget: 50_000,
  state: "open",
  d: 0,
  why: "",
  ...over,
});
const ids = (n: number) => n.toString(16).padStart(24, "0");

async function main(): Promise<void> {
  redis.clear();

  part("The terms");
  is("none until a creator chooses, on every program saved before", [parseAffiliateSetting({}).lead, NO_AFFILIATES.lead.kind], [NO_LEADS, "none"]);
  is("a choice is kept", parseLeadSetting({ kind: "free", cents: 250, hold: 14, daily: 5, budget: 10_000 }), { kind: "free", cents: 250, hold: 14, daily: 5, budget: 10_000 });
  is("a hold shorter than a week is not kept", parseLeadSetting({ kind: "signup", hold: 1 }).hold, NO_LEADS.hold);
  is(
    "out of range is refused, with the reason, not replaced",
    [
      leadProblem({ kind: "everything", cents: 500, hold: 30, daily: 10, budget: 5_000 }),
      leadProblem({ kind: "signup", cents: 10, hold: 30, daily: 10, budget: 5_000 }),
      leadProblem({ kind: "signup", cents: 500, hold: MIN_LEAD_HOLD_DAYS - 1, daily: 10, budget: 5_000 }),
      leadProblem({ kind: "signup", cents: 500, hold: 30, daily: 0, budget: 5_000 }),
      leadProblem({ kind: "signup", cents: 5_000, hold: 30, daily: 10, budget: 1_000 }),
      leadProblem({ kind: "none", cents: 500, hold: 30, daily: 10, budget: 5_000 }),
      leadProblem(undefined),
    ],
    ["lead_kind", "lead_amount", "lead_hold", "lead_daily", "lead_budget", null, null],
  );
  is("an hour holds a quarter of the day, at least one", [hourlyLeads(10), hourlyLeads(1), hourlyLeads(500)], [3, 1, 125]);

  part("How each lead stands");
  // The start of the 2nd day of the UTC month two months back: always past every hold below (at least
  // 32 days old), and the three days the monthly-budget leads use (2nd to 4th) never cross into another
  // month, whatever today's date. "40 days ago" crossed a month end on some dates (on 8 November it put
  // the third lead on 1 October), so the monthly budget was never reached and the test failed by date.
  const old = ((at: Date) => Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 2, 2) / 1000)(new Date(NOW * 1000));
  const settled = settleLeads([lead({ at: NOW - DAY })], NOW);
  is("inside its hold it earns and waits", [settled[0].status, settled[0].commission, settled[0].readyAt], ["in hold", 500, NOW - DAY + 30 * DAY]);
  is("after it, it needs the creator's approval", settleLeads([lead({})], NOW)[0].status, "needs approval");
  is("approved, it is payable", settleLeads([lead({ state: "approved", d: NOW })], NOW)[0].status, "approved");
  is("reversed, it earns nothing", settleLeads([lead({ state: "reversed", why: "fake" })], NOW).map((s) => [s.status, s.commission]), [["not genuine", 0]]);
  const day = Array.from({ length: 4 }, (_, i) => lead({ id: ids(i + 1), at: old + i * 4_000, daily: 3 }));
  is("past the daily cap a lead is listed and earns nothing", settleLeads(day, NOW).map((s) => s.status), ["needs approval", "needs approval", "needs approval", "over daily cap"]);
  const burst = Array.from({ length: 4 }, (_, i) => lead({ id: ids(i + 1), at: old + i, daily: 8 }));
  is("and past the hour's share of it, even under the day's", settleLeads(burst, NOW).map((s) => s.status), ["needs approval", "needs approval", "over hourly limit", "over hourly limit"]);
  is("another affiliate's leads use their own day", settleLeads([...day, lead({ id: ids(9), aff: BEN, at: old + 3 * 4_000, daily: 3 })], NOW).at(-1)?.status, "needs approval");
  const month = Array.from({ length: 3 }, (_, i) => lead({ id: ids(i + 1), aff: [ANA, BEN, CAL][i], at: old + i * DAY, budget: 1_000 }));
  is("the monthly budget is the whole program's", settleLeads(month, NOW).map((s) => s.status), ["needs approval", "needs approval", "over monthly budget"]);
  const terms = [lead({ id: ids(1), at: old, budget: 500 }), lead({ id: ids(2), at: old + 10, budget: 2_000 })];
  is("each lead is judged by the budget of its own day", settleLeads(terms, NOW).map((s) => s.status), ["needs approval", "needs approval"]);
  is("a lead reversed frees its place for the next", settleLeads([{ ...day[0], state: "reversed", why: "fake" }, ...day.slice(1)], NOW).map((s) => s.status), ["not genuine", "needs approval", "needs approval", "needs approval"]);
  const call = lead({ kind: "booking", at: NOW - 2 * DAY, end: NOW + DAY, ref: "cs_test_aaaaaaaaaaaa", pi: "pi_call", paid: 9_900, hold: 7 });
  is("a booking waits for its call, and its hold counts from the call's end", [settleLeads([call], NOW)[0].status, settleLeads([call], NOW)[0].readyAt], ["waiting for the call", NOW + DAY + 7 * DAY]);
  const early = { ...call, at: NOW - 40 * DAY };
  is("a move is read: a call its buyer moved earlier holds from its new end", settleLeads([early], NOW, () => 0, new Map([[call.ref, NOW - 20 * DAY]]))[0].status, "needs approval");
  is("refunded in full, it is reversed whatever it was", settleLeads([{ ...call, state: "approved" }], NOW, () => 9_900).map((s) => [s.status, s.commission]), [["refunded", 0]]);
  is("a partial refund leaves it", settleLeads([call], NOW, () => 100)[0].status, "waiting for the call");
  is("an affiliate sees the address as its first letter and its domain", [maskEmail(("jane.doe" + "@" + "gmail.com")), maskEmail("")], ["j•••@gmail.com", ""]);

  part("A program that pays per sign-up");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Leads00001", subscriptionId: "sub_Leads00001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  await setJoin(OWNER, { on: true, heading: "Recipes", line: "" });
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, lead: { kind: "signup", cents: 300, hold: 14, daily: 5, budget: 10_000 } });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, ("ana.lopez" + "@" + "gmail.com"), "ana", { paypal: "pay@ana.example" })],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:people`, CAL, person(CAL, "cal@example.com", "cal", { status: "pending" })],
    ["HSET", `nl:aff:${statsId}:codes`, "cal", CAL],
  ]);
  const cookies = (code: string) => ({ via: `${code}.${NOW - 60}`, session: undefined });
  is("the visit through Ana's link credits Ana", await leadAffiliate(store, "signup", cookies("ana"), "dana@example.com"), ANA);
  is("not a pending affiliate", await leadAffiliate(store, "signup", cookies("cal"), "dana@example.com"), null);
  is("not her own address, written another way, nor the creator's", [await leadAffiliate(store, "signup", cookies("ana"), ("AnaLopez+x" + "@" + "googlemail.com")), await leadAffiliate(store, "signup", cookies("ana"), OWNER)], [null, null]);
  is("not a kind the program does not pay", await leadAffiliate(store, "free", cookies("ana"), "dana@example.com"), null);
  is("not a click past the window", await leadAffiliate(store, "signup", { via: `ana.${NOW - 400 * DAY}`, session: undefined }, "dana@example.com"), null);

  // The address types; the affiliate travels in the emailed link; nothing is credited yet.
  is("asked to join", await askToJoin({ store, email: "dana@example.com", ip: "1.1.1.1", origin: "https://marktmorgen.com", lead: ANA }), "sent");
  const token = /join\?token=([0-9a-f]{48})/.exec(mails.at(-1) ?? "")?.[1] ?? "";
  is("the link carries Ana, and nothing is recorded before it is pressed", [(await readJoinToken(token))?.a, (await readLeads(store)).length], [ANA, 0]);
  const confirmed = await confirmJoin(token, store);
  if (!confirmed.ok) throw new Error("not confirmed");
  is("confirmed, new to the list", [confirmed.grant.a, confirmed.added.joined], [ANA, true]);
  is("the route credits only a confirmed address new to the list, counted as a request first", /if \(result\.grant\.a && result\.added\.joined\)[\s\S]{0,200}count: true/.test(readFileSync("app/api/store/join/confirm/route.ts", "utf8")), true);
  const counted = { n: 0 };
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    counted.n += commands.length;
    return pipe(commands);
  }) as typeof redis.pipeline;
  is("credited", await recordLead(store, { aff: ANA, kind: "signup", email: confirmed.grant.e, count: true }), "recorded");
  redis.pipeline = pipe;
  is("its write, with the request it takes, stays inside a later page's commands", counted.n <= COMMANDS.laterPage + COMMANDS.laterCount, true);
  is("and the store's request was counted", counted.n >= 3, true);
  const kept = await readLeads(store);
  is("kept with the terms of its day and the person's address", kept.map((l) => [l.aff, l.kind, l.email, l.cents, l.hold, l.daily, l.budget, l.state]), [[ANA, "signup", "dana@example.com", 300, 14, 5, 10_000, "open"]]);
  is("its id is a fingerprint of the address in this program", kept[0].id, leadId(statsId, "dana@example.com"));

  part("One lead per person, never their own");
  is("the same person, written another way, is not a second lead", await recordLead(store, { aff: ANA, kind: "signup", email: "DANA@example.com" }), "duplicate");
  is("Ana's own address is refused", await recordLead(store, { aff: ANA, kind: "signup", email: ("ana.lopez+2" + "@" + "gmail.com") }), "self");
  is("so is the PayPal address she is paid at", await recordLead(store, { aff: ANA, kind: "signup", email: "pay@ana.example" }), "self");
  is("and the creator's own", await recordLead(store, { aff: ANA, kind: "signup", email: OWNER }), "self");
  is("an affiliate not approved earns no lead", await recordLead(store, { aff: CAL, kind: "signup", email: "eve@example.com" }), "off");
  is("a kind the program does not pay is not recorded", await recordLead(store, { aff: ANA, kind: "booking", email: "eve@example.com" }), "off");
  is("still one lead", (await readLeads(store)).length, 1);

  part("The book");
  let book = await readBook(store);
  const row = () => book.rows.find((r) => r.affiliate.id === ANA)!;
  const leadLine = () => book.lines.find((l) => l.how === "lead")!;
  is("a lead line beside the sales, with its amount", [leadLine().status, leadLine().commission, leadLine().lead?.email], ["in hold", 300, "dana@example.com"]);
  is("earned and owed, but waiting and not payable, and not a sale", [row().earned, row().owed, row().waiting, row().payable, row().sales], [300, 300, 300, 0, 0]);
  is("approving inside the hold is refused", await decideLeads(store, [kept[0].id], "approve"), { ok: false, reason: "not_ready" });
  // The hold passes.
  await redis.pipeline([["HSET", leadsKey(statsId), kept[0].id, JSON.stringify({ ...kept[0], at: NOW - 20 * DAY })]]);
  book = await readBook(store);
  is("past its hold it needs the creator", [leadLine().status, row().payable], ["needs approval", 0]);
  is("approved, it is payable", [await decideLeads(store, [kept[0].id], "approve"), (book = await readBook(store), row().payable), leadLine().status], [{ ok: true, changed: 1 }, 300, "approved"]);
  is("a reversal needs a reason", await decideLeads(store, [kept[0].id], "reverse", "because"), { ok: false, reason: "reason" });
  await decideLeads(store, [kept[0].id], "reverse", "duplicate");
  book = await readBook(store);
  is("reversed: nothing owed, and the affiliate sees why", [leadLine().status, leadLine().lead?.why, row().owed], ["not genuine", "duplicate", 0]);
  is("undone, it waits for approval again", [await decideLeads(store, [kept[0].id], "reopen"), (book = await readBook(store), leadLine().status)], [{ ok: true, changed: 1 }, "needs approval"]);
  is("in the spreadsheet as a lead", bookCsv(book, book.rows.map((r) => r.affiliate)).split("\r\n").some((line) => line.startsWith("lead,") && line.includes("Lead: email sign-up") && line.includes("needs approval")), true);
  const own = await readBook(store, ANA);
  is("Ana's own page has her lead", own.lines.filter((l) => l.how === "lead").length, 1);
  // A second affiliate sharing Ana's inbox holds what she is owed, leads included.
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, BEN, person(BEN, ("analopez" + "@" + "gmail.com"), "ben")]]);
  book = await readBook(store);
  await decideLeads(store, [kept[0].id], "approve");
  book = await readBook(store);
  is("held with everything else when flagged", [row().flags, row().held, row().payable], [["same-address"], 300, 0]);
  await redis.pipeline([["HDEL", `nl:aff:${statsId}:people`, BEN]]);

  part("A free product, and a booking");
  await setAffiliateSetting(OWNER, { ...store.affiliates, lead: { kind: "free", cents: 200, hold: 7, daily: 5, budget: 10_000 } });
  store = (await storeForEmail(OWNER))!;
  is("credited for a free product claimed", await recordLead(store, { aff: ANA, kind: "free", email: "gil@example.com", ref: "prod01", title: "Starter guide" }), "recorded");
  is("the free download credits only the first time that address got the product", /if \(claim\.a && listed\?\.gotProduct\)/.test(readFileSync("app/api/store/free/download/route.ts", "utf8")), true);
  const product = { id: "call01", title: "Intro call", summary: "", priceCents: 9_900, fields: [] } as unknown as Parameters<typeof callCheckoutBody>[0]["product"];
  const body = (lead: string | null, pkg: boolean) =>
    callCheckoutBody({ store, product, start: Date.now() + DAY * 1000, end: Date.now() + DAY * 1000 + 1_800_000, buyerTz: "UTC", origin: "https://marktmorgen.com", via: null, lead, fromPackage: pkg ? { id: "pkg1", coupon: "co1", email: "x@example.com", back: "https://marktmorgen.com" } : null });
  is("a booking's checkout carries the lead whatever the share, never from a package", [body(ANA, false).get("metadata[lead_via]"), body(ANA, true).get("metadata[lead_via]"), body(null, false).get("metadata[lead_via]")], [ANA, null, null]);
  is("the booking route carries it only where the store pays per booking", /lead: store\.affiliates\.lead\.kind === "booking" \? via\?\.aff \?\? null : null/.test(readFileSync("app/api/store/book/route.ts", "utf8")), true);

  part("Deleting a person");
  is("their address comes off the lead", [await forgetLeadPerson(store, "Dana@example.com"), (await readLeads(store)).find((l) => l.id === kept[0].id)?.email], [1, ""]);
  is("the lead stays, as the affiliate's record", (await readBook(store)).lines.filter((l) => l.how === "lead").length, 2);
  await setAffiliateSetting(OWNER, { ...store.affiliates, lead: { kind: "signup", cents: 300, hold: 14, daily: 5, budget: 10_000 } });
  store = (await storeForEmail(OWNER))!;
  is("and the same person joining again is not a new lead", await recordLead(store, { aff: ANA, kind: "signup", email: "dana@example.com" }), "duplicate");
  is("the erasure runs it, and says so", [ERASERS.some((e) => e.module === "lib/affiliate-leads.ts"), PERSON_DATA.filter((d) => d.file === "lib/affiliate-leads.ts").map((d) => d.how)], [true, ["erased", "suppression"]]);

  part("What affiliates are told, in every language");
  for (const [code, words] of Object.entries(LEAD_WORDS)) {
    is(`${code}: the terms name the amount, the hold, the cap and the budget, and the disclosure is there`, [words.term("signup", "$3.00", "Harbor").includes("$3.00"), words.termRules(14, 5, "$100.00", "Harbor").includes("14") && words.termRules(14, 5, "$100.00", "Harbor").includes("$100.00"), words.disclose.length > 40], [true, true, true]);
  }
  is("no word the owner forbids", Object.values(LEAD_WORDS).some((w) => /unlimited|\bsmall\b/i.test(JSON.stringify(w) + w.termRules(1, 1, "", "") + w.term("free", "", ""))), false);

  done();
}

void main();
