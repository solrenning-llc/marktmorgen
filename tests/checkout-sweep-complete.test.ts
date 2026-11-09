/**
 * The five-minute checkout sweep (lib/checkout-sweep.ts) is the only net, besides
 * the thanks page, that confirms a paid order whose buyer closed the tab: there is
 * no incoming Stripe webhook. It must read every paid checkout of the last day,
 * not only the newest few hundred sessions of every kind. Found by the Stripe list
 * audit of 9 November 2026 (A2): 300 expired checkouts in the last hour pushed a
 * paid order of two hours ago off the pages the sweep read, run after run, so its
 * buyer got no confirmation, was never put on the creator's list, and no affiliate
 * or ad platform heard of the sale. The same pages fed the abandoned-checkout
 * reminders, which a crowd of open checkouts (a launch, or bots) hid the same way.
 *
 * The stand-in for Stripe (tests/stripe-sessions-stand-in.ts) answers GET /v1/checkout/sessions as Stripe does:
 * newest first, `limit`, `created[gte]`, `status` and `starting_after` honored,
 * and an unknown `starting_after` refused.
 *
 * What the walks cost is held here too (tests/plan-cost-registry.ts,
 * NOT_A_COST.MAX_PAGES_PER_STORE): at most MAX_PAGES_PER_STORE list calls a walk
 * and two walks a store a run, never of open checkouts; on the walk keys one GET
 * a walk and at most one SET or DEL, nothing written for a store whose day fits
 * in one run.
 */
import { MAX_PAGES_PER_STORE, sweepCheckouts } from "@/lib/checkout-sweep";
import { confirmationKey } from "@/lib/purchase-email";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";
import { listCheckoutSessions, type StandInSession } from "./stripe-sessions-stand-in";

type Session = StandInSession;
let sessions: Session[] = [];
const listCalls: string[] = [];

function listSessions(url: URL): Response {
  listCalls.push(url.search);
  return listCheckoutSessions(sessions, url);
}

const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return listSessions(url);
    if (url.pathname === "/v1/account") return new Response(JSON.stringify({ id: "acct_1TestCompSwp1", country: "US" }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

const OWNER = "complete-sweep@example.com";
const HANDLE = "completesweep";
let product = "";

async function freshStore(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  sessions = [];
  listCalls.length = 0;
  await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestCompSwp1", true);
  await setSubscription(OWNER, { customerId: "cus_CompSweep1", subscriptionId: "sub_CompSweep1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const course = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!course.ok) throw new Error("no product");
  product = course.product.id;
  await setProductLink(OWNER, product, "https://example.com/course");
  await storeForEmail(OWNER);
}

const now = () => Math.floor(Date.now() / 1000);
const sid = (prefix: string, n: number) => `cs_test_${prefix}${String(n).padStart(12, "0")}`;
const paid = (id: string, email: string, created: number, store = HANDLE): Session => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
  created, amount_total: 4900, currency: "usd",
  customer_details: { email }, metadata: { store, product },
});
const expired = (id: string, created: number, over: Record<string, unknown> = {}): Session => ({
  id, object: "checkout.session", status: "expired", payment_status: "unpaid", mode: "payment",
  created, expires_at: created + 1800, metadata: { store: HANDLE, product }, ...over,
});
const open = (id: string, created: number): Session => ({
  id, object: "checkout.session", status: "open", payment_status: "unpaid", mode: "payment",
  created, expires_at: created + 86_400, metadata: { store: HANDLE, product },
});
const confirmations = (to: string) => mail.ses.filter((m) => m.to.includes(to)).length;

async function passes(n: number): Promise<{ confirmed: number; reminded: number }> {
  const total = { confirmed: 0, reminded: 0 };
  for (let i = 0; i < n; i += 1) {
    const counts = await sweepCheckouts(Date.now() + 20_000);
    total.confirmed += counts.confirmed;
    total.reminded += counts.reminded;
  }
  return total;
}

/** The commands each run sends on the walks' keys, and the list calls it makes. */
async function measured(run: () => Promise<unknown>): Promise<{ walk: string[]; lists: string[] }> {
  const real = redis.pipeline.bind(redis);
  const walk: string[] = [];
  const from = listCalls.length;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const command of commands) if (String(command[1] ?? "").startsWith("nl:sweep:walk:")) walk.push(String(command[0]));
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = real;
  }
  // The walks' own list calls; a store's first sale is read apart once (lib/yearly-offer.ts), not a walk's.
  return { walk, lists: listCalls.slice(from).filter((q) => q.startsWith("?limit=100&status=") && q.includes("created[gte]=")) };
}

/** Runs `run` and gives back what it wrote to the error log. */
async function logged(run: () => Promise<unknown>): Promise<string> {
  const errors = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  try {
    await run();
  } finally {
    console.error = errors;
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_complete_sweep_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_complete_sweep_only_a_stand_in";

  part("A paid order behind 300 newer expired checkouts is still confirmed (audit A2)");
  await freshStore();
  sessions = [
    ...Array.from({ length: 300 }, (_, i) => expired(sid("lateexp", i), now() - 60 - i * 10)),
    paid(sid("latepaid", 1), "tab-closed@example.com", now() - 7200),
  ];
  let said = await passes(3);
  is("after three runs its buyer has had the confirmation, once", [confirmations("tab-closed@example.com"), said.confirmed], [1, 1]);

  part("The control: 299 newer expired checkouts");
  await freshStore();
  sessions = [
    ...Array.from({ length: 299 }, (_, i) => expired(sid("ctrlexp", i), now() - 60 - i * 10)),
    paid(sid("ctrlpaid", 1), "control@example.com", now() - 7200),
  ];
  said = await passes(3);
  is("confirmed once", [confirmations("control@example.com"), said.confirmed], [1, 1]);

  part("A paid order behind 300 newer open checkouts (a launch, or bots) is confirmed");
  await freshStore();
  sessions = [
    ...Array.from({ length: 300 }, (_, i) => open(sid("botopen", i), now() - 30 - i * 5)),
    paid(sid("botpaid", 1), "behind-bots@example.com", now() - 3600),
  ];
  said = await passes(3);
  is("confirmed once", [confirmations("behind-bots@example.com"), said.confirmed], [1, 1]);

  part("A paid order behind 300 newer paid orders already confirmed is confirmed too, within a few runs");
  await freshStore();
  const newer = Array.from({ length: 300 }, (_, i) => paid(sid("donepaid", i), `done${i}@example.com`, now() - 60 - i * 20, "elsewhere"));
  for (const row of newer) await redis.pipeline([["SET", confirmationKey(row.id), "1"]]);
  sessions = [...newer, paid(sid("oldpaid", 1), "oldest-of-the-day@example.com", now() - 20 * 3600)];
  said = await passes(3);
  is("confirmed once", [confirmations("oldest-of-the-day@example.com"), said.confirmed], [1, 1]);
  said = await passes(3);
  is("and never again on later runs", [confirmations("oldest-of-the-day@example.com"), said.confirmed], [1, 0]);

  part("An abandoned checkout's reminder is not hidden by 300 newer open checkouts (the same pages)");
  await freshStore();
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Portland, OR 97201", asks: true });
  sessions = [
    ...Array.from({ length: 300 }, (_, i) => open(sid("remopen", i), now() - 30 - i * 5)),
    expired(sid("remleft", 1), now() - 5400, { consent: { promotions: "opt_in" }, customer_details: { email: "left-it@example.com" }, expires_at: now() - 3600 }),
  ];
  said = await passes(3);
  is("the buyer who agreed gets the one reminder", [confirmations("left-it@example.com"), said.reminded], [1, 1]);

  part("Nor by 300 newer expired checkouts of buyers who did not agree");
  await freshStore();
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Portland, OR 97201", asks: true });
  sessions = [
    ...Array.from({ length: 300 }, (_, i) => expired(sid("remexp", i), now() - 60 - i * 10)),
    expired(sid("remleft", 2), now() - 9000, { consent: { promotions: "opt_in" }, customer_details: { email: "left-too@example.com" }, expires_at: now() - 7200 }),
  ];
  said = await passes(3);
  is("the buyer who agreed gets the one reminder", [confirmations("left-too@example.com"), said.reminded], [1, 1]);

  part("What a run costs: the cost registry's figures, held by the real sweep");
  await freshStore();
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Portland, OR 97201", asks: true });
  sessions = [
    ...Array.from({ length: 700 }, (_, i) => expired(sid("costexp", i), now() - 60 - i * 10)),
    ...Array.from({ length: 700 }, (_, i) => open(sid("costopen", i), now() - 30 - i * 5)),
    ...Array.from({ length: 700 }, (_, i) => paid(sid("costpaid", i), `cost${i}@example.com`, now() - 60 - i * 30, "elsewhere")),
  ];
  for (const row of sessions) if (row.status === "complete") await redis.pipeline([["SET", confirmationKey(row.id), "1"]]);
  let cost = await measured(() => sweepCheckouts(Date.now() + 20_000));
  is("a run makes at most MAX_PAGES_PER_STORE list calls a walk, two walks", cost.lists.length, 2 * MAX_PAGES_PER_STORE);
  is("each asks for completed or expired checkouts, never open ones",
    cost.lists.every((q) => /[?&]status=(complete|expired)(&|$)/.test(q)) && !cost.lists.some((q) => q.includes("status=open")), true);
  is("on the walks' keys: one GET and one SET a walk", cost.walk, ["GET", "SET", "GET", "SET"]);
  cost = await measured(() => sweepCheckouts(Date.now() + 20_000));
  is("the next run carries on from there, at the same cost", [cost.lists.length, cost.walk.length, cost.lists.every((q) => q.includes("starting_after="))], [6, 4, true]);
  cost = await measured(() => sweepCheckouts(Date.now() + 20_000));
  is("the third run reads the last hundred of each (700 = 300 + 300 + 100), and at the end of the day's sessions the place is let go",
    [cost.walk, cost.lists.length, cost.lists.filter((q) => !q.includes("starting_after=")).length], [["GET", "DEL", "GET", "DEL"], 2, 0]);
  cost = await measured(() => sweepCheckouts(Date.now() + 20_000));
  is("the run after starts from the newest", cost.lists.filter((q) => !q.includes("starting_after=")).length, 2);

  await freshStore();
  sessions = [paid(sid("smallpaid", 1), "small@example.com", now() - 600)];
  cost = await measured(() => sweepCheckouts(Date.now() + 20_000));
  is("a store whose day fits in one run writes no place: one GET a walk", [cost.walk, confirmations("small@example.com")], [["GET", "GET"], 1]);

  part("Said truly: a walk that takes over an hour, a place Stripe no longer knows, a place that does not read");
  await freshStore();
  sessions = [
    ...Array.from({ length: 300 }, (_, i) => expired(sid("lateexp", i), now() - 60 - i * 10)),
    paid(sid("latepaid", 2), "late-walk@example.com", now() - 7200),
  ];
  const walkOf = `nl:sweep:walk:complete:acct_1TestCompSwp1:${(await storeForEmail(OWNER))!.sid}`;
  await redis.pipeline([["SET", walkOf, `${now() - 2 * 3600}|${sid("lateexp", 0)}`]]);
  const said1 = await logged(() => sweepCheckouts(Date.now() + 20_000));
  is("a walk begun two hours ago says so in the log", said1.includes("has not reached the end of a store's checkouts of the day for over an hour"), true);
  is("and it still reads on", confirmations("late-walk@example.com"), 1);

  await freshStore();
  sessions = [paid(sid("gonepaid", 1), "gone-place@example.com", now() - 600)];
  const goneKey = `nl:sweep:walk:complete:acct_1TestCompSwp1:${(await storeForEmail(OWNER))!.sid}`;
  await redis.pipeline([["SET", goneKey, `${now() - 600}|cs_test_nolongerknown000001`]]);
  const refused = await logged(() => sweepCheckouts(Date.now() + 20_000));
  const [left] = await redis.pipeline([["GET", goneKey]]);
  is("a place Stripe refuses fails the store's run in the log, as any refused page did, and is let go",
    [refused.includes("reading a store's checkouts failed"), confirmations("gone-place@example.com"), left], [true, 0, null]);
  await sweepCheckouts(Date.now() + 20_000);
  is("so the next run starts from the newest and confirms", confirmations("gone-place@example.com"), 1);

  await freshStore();
  sessions = [paid(sid("oddpaid", 1), "odd-place@example.com", now() - 600)];
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await real(commands);
    return commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:sweep:walk:complete:") ? [7] : answer;
  }) as typeof redis.pipeline;
  let odd = { failed: 0, confirmed: 0 };
  try {
    await logged(async () => (odd = await sweepCheckouts(Date.now() + 20_000)));
  } finally {
    redis.pipeline = real;
  }
  is("a place read in an unknown shape: the run starts from the newest, confirms, and says it failed", [odd.confirmed, odd.failed, confirmations("odd-place@example.com")], [1, 1, 1]);

  done();
}

void main();
