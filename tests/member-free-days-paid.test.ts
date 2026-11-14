/**
 * 641 [WG1], second look (Claude 4 team review of #2912, A1, M1 and M2; fixed
 * by Claude 4 on Claude 5's behalf). Free days are given with Stripe's
 * trial_end, so Stripe answers the membership "trialing" while they run and
 * keeps that trial_end on it after. A member who PAID and was given free days
 * is still a paying member: every reader that takes "trialing" or trial_end
 * for a free trial must read it as paid. Checked, on what giving free days
 * really leaves on the subscription (Stripe faked through fetch, metadata
 * merged the way Stripe merges it):
 *
 *   - membership numbers and MRR keep the member paying and their paid
 *     history whole, while the days run and after they end, and never count
 *     the days as a trial, nor as a trial that converted;
 *   - an earlier real trial on that membership is still counted as one;
 *   - free days given inside a real trial leave it a trial (it was never paid);
 *   - the yearly offer is not made while paid free days run, and the email
 *     that offers it counts the payments from the real start;
 *   - an answer from Stripe out of shape, or with more than one page, is "not
 *     known", never "no running membership" (rule 24).
 *
 * Synthetic data only; no request leaves the process.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, storeForEmail } from "@/lib/store";
import { freeDaysSubs, giveFreeDays } from "@/lib/member-free-days";
import { numbersFrom, readSub } from "@/lib/membership-numbers";
import { movementsFrom } from "@/lib/mrr-movements";
import { askFits, yearlyChoice } from "@/lib/yearly-switch-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_member_free_days_paid_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const PERIOD_END = NOW + 20 * DAY;
const TRIAL_END = NOW + 5 * DAY;
const HANDLES = new Set(["paiddays"]);

type Sub = Record<string, unknown> & { id: string; metadata: Record<string, string> };
const subscription = (id: string, extra: Record<string, unknown> = {}): Sub => ({
  id,
  status: "active",
  currency: "usd",
  customer: "cus_member0001",
  start_date: NOW - 200 * DAY,
  trial_end: null,
  metadata: { store: "paiddays", product: "prod000001" },
  items: { data: [{ quantity: 1, current_period_end: PERIOD_END, price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  ...extra,
}) as Sub;

let subs: Sub[] = [];
type Mode = "healthy" | "customers out of shape" | "subscriptions out of shape" | "no has_more" | "more pages";
let mode: Mode = "healthy";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "synthetic_email" });
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected request to ${url.hostname}`);
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (method === "GET" && path === "/customers") {
    if (mode === "customers out of shape") return json({ object: "list" });
    return json({ object: "list", data: url.searchParams.get("email") === "member@example.com" ? [{ id: "cus_member0001" }] : [], has_more: false });
  }
  if (method === "GET" && path === "/subscriptions") {
    if (mode === "subscriptions out of shape") return json({ object: "list", data: "unreadable", has_more: false });
    if (mode === "no has_more") return json({ object: "list", data: subs });
    // 20 of another store's on this page; the member's own would be on the next one.
    if (mode === "more pages") return json({ object: "list", data: Array.from({ length: 20 }, (_, i) => subscription(`sub_other${String(i).padStart(5, "0")}`, { metadata: { store: "another", product: "x" } })), has_more: true });
    return json({ object: "list", data: subs, has_more: false });
  }
  if (method === "GET" && path.startsWith("/products")) return json({ object: "list", data: [], has_more: false });
  if (method === "POST" && path.startsWith("/subscriptions/")) {
    const body = new URLSearchParams(String(init?.body ?? ""));
    const sub = subs.find((s) => s.id === path.split("/")[2]);
    if (!sub) return json({ error: { code: "resource_missing", message: "No such subscription." } }, 404);
    // As Stripe applies it: the trial ends at trial_end, and metadata is merged, an empty value removing its key.
    sub.status = "trialing";
    sub.trial_end = Number(body.get("trial_end"));
    for (const [key, value] of body) {
      const name = /^metadata\[(.+)\]$/.exec(key)?.[1];
      if (!name) continue;
      if (value === "") delete sub.metadata[name];
      else sub.metadata[name] = value;
    }
    return json(sub);
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The membership as Stripe holds it after the free days ended and the next charge was paid: running, its trial_end kept. */
const renewed = (sub: Sub): Sub => ({ ...structuredClone(sub), status: "active" });

async function main(): Promise<void> {
  redis.clear();
  const owner = "paid-free-days@example.com";
  await claimHandle(owner, "paiddays", "Paid Days", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Paiddaysxxxxxx", true);
  const store = (await storeForEmail(owner))!;
  const by = { who: owner, role: "owner" as const };

  part("A paying member given free days is still a paying member");
  subs = [subscription("sub_paid000001")];
  const before = readSub(structuredClone(subs[0]) as never, HANDLES)!;
  const n0 = numbersFrom([before], "usd", NOW);
  const m0 = movementsFrom([before], new Map(), "usd", NOW);
  is("control, before: paying, at $29 a month, nobody in a trial", [n0.paying, n0.mrr, n0.trialing], [1, 2900, 0]);
  const given = await giveFreeDays(store, "member@example.com", "sub_paid000001", 7, PERIOD_END, by, NOW);
  is("the free days are given", given.ok, true);
  is("Stripe now says trialing, to the next charge plus the days", [subs[0].status, subs[0].trial_end], ["trialing", PERIOD_END + 7 * DAY]);
  const during = readSub(structuredClone(subs[0]) as never, HANDLES)!;
  const n1 = numbersFrom([during], "usd", NOW);
  is("while the days run: still counted paying, MRR whole, nobody in a free trial", [n1.paying, n1.mrr, n1.trialing], [1, 2900, 0]);
  is("while the days run: their product row says the same", n1.byProduct.map((p) => [p.members, p.trialing, p.mrr]), [[1, 0, 2900]]);
  const m1 = movementsFrom([during], new Map(), "usd", NOW);
  is("while the days run: the months they paid are not erased", [m1.months.length, m1.months.at(-1)?.end], [m0.months.length, m0.months.at(-1)?.end]);
  is("while the days run: the same months, the same MRR each", m1.months.map((m) => m.end), m0.months.map((m) => m.end));

  const later = PERIOD_END + 9 * DAY;
  const after = readSub(renewed(subs[0]) as never, HANDLES)!;
  const n2 = numbersFrom([after], "usd", later);
  is("after the days end and the next charge is paid: no trial ended, none converted", [n2.trialsEnded, n2.trialsConverted], [0, 0]);
  is("after: paying, MRR whole", [n2.paying, n2.mrr], [1, 2900]);

  part("Given again while they run: still paid");
  const again = await giveFreeDays(store, "member@example.com", "sub_paid000001", 3, PERIOD_END + 7 * DAY, by, NOW);
  is("more days are given", again.ok, true);
  const n3 = numbersFrom([readSub(structuredClone(subs[0]) as never, HANDLES)!], "usd", NOW);
  is("still counted paying, nobody in a free trial", [n3.paying, n3.trialing], [1, 0]);

  part("An earlier real trial on the same membership is still one");
  const trialEnded = NOW - 30 * DAY;
  subs = [subscription("sub_trialed0001", { start_date: NOW - 44 * DAY, trial_end: trialEnded })];
  const t0 = numbersFrom([readSub(structuredClone(subs[0]) as never, HANDLES)!], "usd", NOW);
  is("control, before: the trial that ended 30 days ago converted", [t0.trialsEnded, t0.trialsConverted], [1, 1]);
  is("free days are given on it", (await giveFreeDays(store, "member@example.com", "sub_trialed0001", 7, PERIOD_END, by, NOW)).ok, true);
  const t1 = numbersFrom([readSub(structuredClone(subs[0]) as never, HANDLES)!], "usd", NOW);
  is("while the days run: that trial still ended and converted, and the member is paying", [t1.trialsEnded, t1.trialsConverted, t1.paying, t1.trialing], [1, 1, 1, 0]);
  // Seventy days on, the real trial is more than 90 days back: only the free days could still be counted, and they never are.
  const t2 = numbersFrom([readSub(renewed(subs[0]) as never, HANDLES)!], "usd", PERIOD_END + 50 * DAY);
  is("after: the free days are never a second trial", [t2.trialsEnded, t2.trialsConverted, t2.paying], [0, 0, 1]);

  part("Free days inside a real trial leave it a trial");
  subs = [subscription("sub_trial00001", { status: "trialing", start_date: NOW - 2 * DAY, trial_end: TRIAL_END })];
  is("free days are given on a trial", (await giveFreeDays(store, "member@example.com", "sub_trial00001", 3, TRIAL_END, by, NOW)).ok, true);
  const r1 = numbersFrom([readSub(structuredClone(subs[0]) as never, HANDLES)!], "usd", NOW);
  is("never paid: still in a free trial, not paying", [r1.paying, r1.trialing, r1.mrr], [0, 1, 0]);

  part("The yearly offer");
  const club = { id: "prod000001", priceCents: 2900, recurring: { interval: "month", trialDays: 0, payments: 0 }, options: [], pwyw: null, yearly: { cents: 29000 } };
  subs = [subscription("sub_yearly0001")];
  is("control: a paying monthly member is offered yearly", yearlyChoice(structuredClone(subs[0]) as never, club as never, [], "usd", NOW)?.cents, 29000);
  is("control: a member in a real trial is offered yearly", yearlyChoice(subscription("sub_trial00002", { status: "trialing", trial_end: TRIAL_END }) as never, club as never, [], "usd", NOW)?.cents, 29000);
  await giveFreeDays(store, "member@example.com", "sub_yearly0001", 7, PERIOD_END, by, NOW);
  is("while paid free days run: not offered (Stripe would charge nothing for the switch)", yearlyChoice(structuredClone(subs[0]) as never, club as never, [], "usd", NOW), null);
  is("after they end: the email that offers it counts the payments from the real start", askFits(renewed(subs[0]) as never, PERIOD_END + 9 * DAY), true);
  is("control: a real trial that ended a week ago is too recent for the email", askFits(subscription("sub_trial00003", { start_date: NOW - 21 * DAY, trial_end: NOW - 7 * DAY }) as never, NOW), false);

  part("An answer from Stripe that cannot be read is not 'no membership' (rule 24)");
  subs = [subscription("sub_live000001")];
  mode = "healthy";
  is("control: the member's running membership is found", (await freeDaysSubs(store, "member@example.com", NOW))?.map((s) => s.id), ["sub_live000001"]);
  for (const m of ["customers out of shape", "subscriptions out of shape", "no has_more", "more pages"] as const) {
    mode = m;
    is(`${m}: not known, never "has no running membership"`, await freeDaysSubs(store, "member@example.com", NOW), null);
    is(`${m}: giving says Stripe could not be read, never "not a membership of this member"`, await giveFreeDays(store, "member@example.com", "sub_live000001", 7, PERIOD_END, by, NOW), { ok: false, reason: "stripe" });
  }
  mode = "healthy";
  is("control: an address with no customer is a confirmed none", await freeDaysSubs(store, "nobody@example.com", NOW), []);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
