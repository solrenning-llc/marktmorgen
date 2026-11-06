/**
 * Disputes on "Something not working?" (491 [PP2], unit 4; lib/checkup.ts
 * readDisputes, lib/checkup-rules.ts disputesCheck; added 1 November 2026).
 * Checked, with Stripe stubbed:
 *
 *   - read only, on the creator's own account, from the last 180 days, at
 *     most three pages of a hundred;
 *   - a dispute waiting for an answer is a problem, with the first due date
 *     and Stripe's own words for what happens unanswered;
 *   - none waiting is fine, saying how many are with the bank;
 *   - Stripe failing, slow or answering an odd shape is "not checked";
 *     more than three pages with none waiting is "not checked", and with
 *     some waiting says "at least";
 *   - with no Stripe account, the line is left out.
 */
import { CHECK_WAIT_MS, DISPUTE_DAYS, DISPUTE_PAGES, readDisputes, runCheckup } from "@/lib/checkup";
import { disputesCheck } from "@/lib/checkup-rules";
import { can } from "@/lib/team-roles";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 1, 12);
process.env.STRIPE_SECRET_KEY = "sk_test_checkup";
const DUE = Math.floor(Date.UTC(2026, 10, 8, 23, 59) / 1000);

type Page = { data: unknown; has_more: unknown } | "down" | "slow";
let pages: Page[] = [];
const asked: { method: string; url: string; account: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push({ method: init?.method ?? "GET", url, account: new Headers(init?.headers).get("Stripe-Account") });
  if (url.includes("/v1/disputes")) {
    const page = pages.shift() ?? { data: [], has_more: false };
    if (page === "down") return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
    if (page === "slow") return new Promise<Response>(() => {});
    return new Response(JSON.stringify(page), { status: 200 });
  }
  return new Response(JSON.stringify({ configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } }, requirements: { summary: { minimum_deadline: { status: "eventually_due" } } } }), { status: 200 });
}) as typeof fetch;

const ACCOUNT = "acct_1Disputesxxxxxx";
const d = (id: string, status: string, due: number | null = null, pastDue = false) => ({ id, status, evidence_details: { due_by: due, past_due: pastDue } });

async function main(): Promise<void> {
  part("Read only, on the creator's account");
  pages = [{ data: [d("du_1", "needs_response", DUE + 86_400), d("du_2", "warning_needs_response", DUE), d("du_3", "under_review"), d("du_4", "won")], has_more: false }];
  const read = await readDisputes(ACCOUNT, NOW);
  const call = asked.find((a) => a.url.includes("/v1/disputes"))!;
  is("a GET on the creator's own account, from the last 180 days", [call.method, call.account, call.url.includes(`created[gte]=${Math.floor(NOW / 1000) - DISPUTE_DAYS * 86_400}`), call.url.includes("limit=100")], ["GET", ACCOUNT, true, true]);
  const problem = disputesCheck(read);
  is("two waiting: a problem, with the next due date", [problem.state, problem.found], ["problem", "2 disputes are waiting for your answer on your Stripe account. The next is due on November 8 (UTC)."]);
  is("in Stripe's own words for an unanswered one", problem.ifLeft, "A dispute not answered by its due date is lost, and the disputed money cannot be won back.");
  is("where to answer, and the studio's page to look first", problem.fix?.kind === "outside" && problem.fix.where.includes("Disputes page of your Stripe Dashboard") && problem.fix.where.includes('the "Review one disputed purchase" page in your studio'), true);
  is("one waiting is said as one", disputesCheck({ disputes: [{ status: "needs_response", dueBy: DUE, pastDue: false }], complete: true }, NOW).found.startsWith("One dispute is waiting for your answer"), true);
  is("an appeal waiting for an answer is one too", disputesCheck({ disputes: [{ status: "appeal_needs_response", dueBy: DUE, pastDue: false }], complete: true }, NOW).state, "problem");
  const late = disputesCheck({ disputes: [{ status: "needs_response", dueBy: Math.floor(NOW / 1000) - 86_400, pastDue: true }, { status: "needs_response", dueBy: DUE, pastDue: false }], complete: true }, NOW);
  is("one past its due date: said, and never given as the next date", late.found, "2 disputes are waiting for your answer on your Stripe account. The next is due on November 8 (UTC). One is past its due date.");
  is("all past: no next date at all", disputesCheck({ disputes: [{ status: "needs_response", dueBy: Math.floor(NOW / 1000) - 60, pastDue: false }], complete: true }, NOW).found, "One dispute is waiting for your answer on your Stripe account. One is past its due date.");

  part("None waiting");
  const none = (status: string) => ({ status, dueBy: null, pastDue: false });
  is("some with the bank, an appeal among them: fine, counted", disputesCheck({ disputes: [none("under_review"), none("appeal_under_review"), none("lost"), none("warning_closed"), none("prevented")], complete: true }, NOW), { id: "disputes", title: "Disputes", state: "ok", found: "No dispute is waiting for your answer. 2 are with the buyer's bank for a decision." });
  is("none at all: fine", disputesCheck({ disputes: [], complete: true }, NOW).found, "No dispute is waiting for your answer on your Stripe account.");
  is("a status Stripe adds that this does not know: not checked, never fine", disputesCheck({ disputes: [none("something_new")], complete: true }, NOW).state, "not-checked");

  part("Unknown is never fine");
  pages = ["down"];
  is("Stripe failing: not checked", (await runCheckup({ sid: "a".repeat(32), listId: "b".repeat(32), statsId: "c".repeat(32), stripeAccountId: ACCOUNT, domain: null, subscriptionActive: true, tier: "pro", renewalUnpaidSince: 0, planDisputes: [] } as never, (p) => can("owner", p), NOW)).find((c) => c.id === "disputes")?.state, "not-checked");
  pages = ["slow"];
  const started = Date.now();
  is("Stripe not answering: not checked, on time", [disputesCheck(await readDisputes(ACCOUNT, NOW, 80).catch(() => null)).state, Date.now() - started < 2_000], ["not-checked", true]);
  pages = [{ data: "nope", has_more: false }];
  is("an odd answer: not checked", disputesCheck(await readDisputes(ACCOUNT, NOW).catch(() => null)).state, "not-checked");
  is("could not be read at all: not checked", disputesCheck(null).state, "not-checked");
  pages = [{ data: [null], has_more: false }];
  is("a row that is not a dispute: not checked", disputesCheck(await readDisputes(ACCOUNT, NOW).catch(() => null)).state, "not-checked");
  pages = [{ data: [{ status: "needs_response" }], has_more: false }];
  is("a dispute with no id: not checked", disputesCheck(await readDisputes(ACCOUNT, NOW).catch(() => null)).state, "not-checked");
  pages = [{ data: [d("du_a", "won")], has_more: true }, { data: [d("du_a", "won")], has_more: false }];
  is("the same dispute twice (a stuck cursor): not checked", disputesCheck(await readDisputes(ACCOUNT, NOW).catch(() => null)).state, "not-checked");
  pages = [{ data: [d("du_w", "needs_response", DUE)], has_more: true }, "slow"];
  const halfStart = Date.now();
  const half = await readDisputes(ACCOUNT, NOW, 400);
  is("the first page read, the second out of time: what was read is kept, said as at least", [half.complete, disputesCheck(half, NOW).found.startsWith("At least one dispute is waiting"), Date.now() - halfStart < 2_000], [false, true, true]);
  pages = [{ data: [d("du_x", "won")], has_more: true }, "down"];
  is("the second page failing, none waiting: not checked", disputesCheck(await readDisputes(ACCOUNT, NOW)).state, "not-checked");

  part("At most three pages");
  pages = Array.from({ length: DISPUTE_PAGES }, (_, i) => ({ data: [d(`du_p${i}`, "won")], has_more: true }));
  const many = await readDisputes(ACCOUNT, NOW);
  is("three pages read, then it stops", [DISPUTE_PAGES, many.complete, many.disputes.length], [3, false, 3]);
  is("more than it reads, none waiting: not checked, never fine", disputesCheck(many).state, "not-checked");
  is("more than it reads, some waiting: at least", disputesCheck({ disputes: [{ status: "needs_response", dueBy: DUE, pastDue: false }], complete: false }, NOW).found.startsWith("At least one dispute is waiting"), true);
  is("the next page starts after the last one read", asked.some((a) => a.url.includes("starting_after=du_p1")), true);

  part("No Stripe account");
  pages = [];
  is("left out: the payments line already says nothing can be sold", (await runCheckup({ sid: "a".repeat(32), listId: "b".repeat(32), statsId: "c".repeat(32), stripeAccountId: null, domain: null, subscriptionActive: true, tier: "pro", renewalUnpaidSince: 0, planDisputes: [] } as never, (p) => can("owner", p), NOW)).some((c) => c.id === "disputes"), false);
  is("each reader waits at most CHECK_WAIT_MS", CHECK_WAIT_MS, 8_000);
  done();
}

void main();
