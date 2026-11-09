/**
 * The email when sales stop (lib/quiet-sales.ts) read a store's last 60 days of
 * Checkout Sessions of every status, three pages of a hundred at most, and gave
 * up when they did not fit: no email, and nothing said. So it never came to
 * the stores it was written for. A store that sold ten a day has 600 sessions
 * in 60 days, and a store with a handful of sales has hundreds of checkouts
 * that were opened and never paid (expired, or still open): their sales could
 * stop for weeks and the creator never heard (found beside the checkout sweep's
 * audit A2, 9 November 2026).
 *
 * Now only completed checkouts are listed (Stripe's own `status` filter), and
 * when a store has more of them than three pages, its usual pace is read over
 * the stretch those pages cover, which holds every completed checkout of it,
 * so the verdict and the figure in the email are exact for what was read.
 * Nothing changes for a store whose 60 days fit. What the read cannot decide
 * is said in the log, not passed over.
 *
 * The stand-in for Stripe is the one the sweep's test uses
 * (tests/stripe-sessions-stand-in.ts): newest first, `limit`, `created[gte]`,
 * `status` and `starting_after` honored.
 */
import * as quiet from "@/lib/quiet-sales";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { listCheckoutSessions, type StandInSession } from "./stripe-sessions-stand-in";

process.env.STRIPE_SECRET_KEY = "sk_test_quiet_complete_only_a_stand_in";
process.env.RESEND_API_KEY = "re_test_quiet_coverage";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const NOW = Date.UTC(2026, 10, 9, 12);
const DAY = 86_400_000;
const { checkQuiet } = quiet;
/** The pages a store's check reads at most, a named constant held in the cost registry (NOT_A_COST.QUIET_PAGES_PER_STORE). */
const QUIET_PAGES_PER_STORE = Number((quiet as Record<string, unknown>).QUIET_PAGES_PER_STORE ?? 3);
const store = { handle: "harbor", previousHandles: [], name: "Harbor", email: "owner@example.com", stripeAccountId: "acct_test", subscriptionActive: true } as unknown as Store;

let sessions: StandInSession[] = [];
const lists: string[] = [];
const emails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(String(init?.body ?? ""));
    return new Response('{"id":"test"}');
  }
  if (url.pathname === "/v1/checkout/sessions") {
    lists.push(url.search);
    return listCheckoutSessions(sessions, url);
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const sid = (prefix: string, n: number) => `cs_test_${prefix}${String(n).padStart(12, "0")}`;
const at = (ms: number) => Math.floor(ms / 1000);
const paid = (id: string, ms: number, handle = "harbor"): StandInSession => ({ id, created: at(ms), status: "complete", payment_status: "paid", metadata: { store: handle } });
const expired = (id: string, ms: number): StandInSession => ({ id, created: at(ms), status: "expired", payment_status: "unpaid", metadata: { store: "harbor" } });
const open = (id: string, ms: number): StandInSession => ({ id, created: at(ms), status: "open", payment_status: "unpaid", metadata: { store: "harbor" } });

/** Ten sales a day, evenly, from `stopped` days ago back to the start of the 60 days. */
const tenADay = (stopped: number) => Array.from({ length: Math.floor((60 - stopped) * 10) }, (_, i) => paid(sid("busy", i), NOW - stopped * DAY - i * (DAY / 10)));

async function check(rows: StandInSession[]): Promise<{ outcome: string; errors: string }> {
  redis.clear();
  sessions = rows;
  lists.length = 0;
  emails.length = 0;
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  try {
    return { outcome: await checkQuiet(store, NOW), errors: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

async function main(): Promise<void> {
  is("the pages a store's check reads are a named constant in the cost registry", (quiet as Record<string, unknown>).QUIET_PAGES_PER_STORE, 3);

  part("A store with a few sales and many unpaid checkouts hears when its sales stop");
  const few = Array.from({ length: 30 }, (_, i) => paid(sid("few", i), NOW - (20 + i) * DAY));
  const unpaid = [
    ...Array.from({ length: 250 }, (_, i) => expired(sid("gone", i), NOW - DAY - i * 3_600_000)),
    ...Array.from({ length: 100 }, (_, i) => open(sid("open", i), NOW - i * 60_000)),
  ];
  const fewChecked = await check([...few, ...unpaid]);
  is("its sales stopped twenty days ago behind 350 unpaid checkouts: the email goes", fewChecked.outcome, "sent");
  is("one email", emails.length, 1);
  is("only completed checkouts are listed, never the open or expired ones", lists.length > 0 && lists.every((q) => q.includes("status=complete")), true);
  is("and one page holds them all", lists.length, 1);

  part("A store that sold ten a day hears after its quiet days");
  const busy = tenADay(3);
  const busyChecked = await check(busy);
  is("ten a day, three days without one: the email goes", busyChecked.outcome, "sent");
  is("one email", emails.length, 1);
  is("at most QUIET_PAGES_PER_STORE pages read", lists.length, QUIET_PAGES_PER_STORE);
  // The pace is read over the stretch the pages hold: every completed checkout newer than the oldest one read.
  const read = busy.slice(0, QUIET_PAGES_PER_STORE * 100);
  const oldest = read[read.length - 1].created * 1000;
  const counted = read.filter((row) => row.created * 1000 > oldest).length;
  const perWeek = Math.round((counted / ((NOW - oldest) / DAY)) * 7 * 10) / 10;
  is("the email gives the pace of the stretch read, not a guess", JSON.parse(emails[0] ?? "{}").text?.includes(`about ${perWeek} sales a week`), true);
  is("and the days without a sale", JSON.parse(emails[0] ?? "{}").subject, "Harbor: no sales in 3 days");

  part("A store that still sells is fine, not passed over");
  const selling = tenADay(0.05);
  is("ten a day, the last an hour ago: fine", (await check(selling)).outcome, "fine");
  is("no email", emails.length, 0);

  part("What the pages cannot decide is said, and sends nothing");
  // 300 newer completed checkouts on the same Stripe account, another store's: this store's pace is not in them.
  const shared = [
    ...Array.from({ length: 300 }, (_, i) => paid(sid("other", i), NOW - i * 3_600_000, "elsewhere")),
    ...Array.from({ length: 30 }, (_, i) => paid(sid("mine", i), NOW - (20 + i) * DAY)),
  ];
  const sharedChecked = await check(shared);
  is("this store's sales are past the pages read: no email this day", [sharedChecked.outcome, emails.length], ["skipped", 0]);
  is("and the log says the sales could not be read", /quiet: .*sales could not be read/.test(sharedChecked.errors), true);

  part("A stretch cut short by other checkouts never makes a few sales the store's usual pace");
  // Pre-review of 9 November 2026: 300 completed checkouts on the creator's own Stripe account that are not this
  // store's sales (Payment Links, another shop) set a stretch of three days; ten sales at its start, then 2.5 quiet
  // days, read as "about 21.7 sales a week" and "no sales in 2 days", though the store made twelve sales in its 60 days
  // (1.4 a week), at which 2.5 quiet days are its usual ones.
  const elsewhere = Array.from({ length: 300 }, (_, i) => ({ id: sid("link", i), created: at(NOW - i * (3 * DAY / 300)), status: "complete", payment_status: "paid", metadata: {} }) as StandInSession);
  const burst = Array.from({ length: 10 }, (_, i) => paid(sid("burst", i), NOW - 2.5 * DAY - i * (0.045 * DAY)));
  const older = [paid(sid("older", 0), NOW - 40 * DAY), paid(sid("older", 1), NOW - 45 * DAY)];
  is("control: at the store's 60-day pace, 2.5 quiet days are not out of the ordinary", quiet.isQuiet([...burst, ...older].map((r) => r.created * 1000), NOW).quiet, false);
  const cut = await check([...elsewhere, ...burst, ...older]);
  is("ten sales in a three-day stretch of other checkouts: no email", [cut.outcome, emails.length], ["skipped", 0]);
  is("and the log says the sales could not be read", /quiet: .*sales could not be read/.test(cut.errors), true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
