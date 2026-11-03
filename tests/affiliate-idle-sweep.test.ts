/**
 * Removing affiliates who bring nothing, end to end (630 [HN6](3), units 2-3:
 * lib/affiliates.ts idleSweep, the setting, the studio and the daily
 * schedule), with the real code, a stubbed Redis and the email provider
 * intercepted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { MAX_IDLE_STEPS, decide, idleRemovalAllowed, idleSweep, readAffiliate } from "@/lib/affiliates";
import { recordLead } from "@/lib/affiliate-leads";
import { AFFILIATES_WORDS } from "@/lib/buyer-words/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_idle_only";
process.env.RESEND_API_KEY = "re_test_affiliate_idle_only";

const OWNER = "chef@example.com";
const DAY = 86_400;
const T0 = Math.floor(Date.now() / 1000) - 400 * DAY;
const ms = (days: number) => (T0 + days * DAY) * 1000;

const sent: { to: string; subject: string; text: string }[] = [];
let providerDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    if (providerDown) return answer({ message: "down" }, 500);
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    sent.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to), subject: String(body.subject), text: String(body.text) });
    return answer({ id: `email_${sent.length}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const ids = {
  quiet: "a1a1a1a1a1a1",
  quiet2: "a2a2a2a2a2a2",
  seller: "b2b2b2b2b2b2",
  owed: "c3c3c3c3c3c3",
  partner: "d4d4d4d4d4d4",
  recruiter: "e5e5e5e5e5e5",
  recruit: "f6f6f6f6f6f6",
  leader: "abababababab",
  pending: "cdcdcdcdcdcd",
};
const person = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email: `${id}@example.com`, code: id.slice(0, 5), status: "approved", appliedAt: ms(0), decidedAt: ms(0), note: "", ...over });
const sale = (ref: string, aff: string, day: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff, at: T0 + day * DAY, product: "prod01", title: "Bread course", base: 1000, total: 1000, currency: "usd", rate: 20, self: false, how: "click", ...over });
const payout = (id: string, aff: string, cents: number) => JSON.stringify({ id, aff, cents, currency: "usd", date: "2026-10-01", reference: "cash", at: 1 });
const LEADS = { kind: "signup", cents: 500, hold: 30, daily: 10, budget: 50_000 };

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestIdle00001", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, lead: LEADS }));
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const people = `nl:aff:${statsId}:people`;
  const sales = `nl:aff:${statsId}:sales`;
  const payouts = `nl:aff:${statsId}:payouts`;
  await redis.pipeline([
    ["HSET", people, ids.quiet, person(ids.quiet)],
    ["HSET", people, ids.quiet2, person(ids.quiet2)],
    ["HSET", people, ids.seller, person(ids.seller)],
    ["HSET", people, ids.owed, person(ids.owed)],
    ["HSET", people, ids.partner, person(ids.partner, { share: { percent: 10, products: ["prod01"] } })],
    ["HSET", people, ids.recruiter, person(ids.recruiter)],
    ["HSET", people, ids.recruit, person(ids.recruit, { by: { id: ids.recruiter, percent: 10 } })],
    ["HSET", people, ids.leader, person(ids.leader)],
    ["HSET", people, ids.pending, person(ids.pending, { status: "pending" })],
    // Paid in full: only their activity keeps them in.
    ["HSET", sales, "cs_s1", sale("cs_s1", ids.seller, 350)],
    ["HSET", payouts, "po_s1", payout("po_s1", ids.seller, 200)],
    ["HSET", sales, "cs_r1", sale("cs_r1", ids.recruit, 360)],
    ["HSET", payouts, "po_r1", payout("po_r1", ids.recruit, 200)],
    ["HSET", payouts, "po_r2", payout("po_r2", ids.recruiter, 100)],
    ["HSET", payouts, "po_l1", payout("po_l1", ids.leader, 500)],
    // An old sale, never paid: they may still be owed.
    ["HSET", sales, "cs_o1", sale("cs_o1", ids.owed, 10)],
    // Their own purchase is not a sale they brought, and earns nothing.
    ["HSET", sales, "cs_q1", sale("cs_q1", ids.quiet, 380, { self: true })],
  ]);
  await recordLead(store, { aff: ids.leader, kind: "signup", email: "fan@example.com", at: T0 + 340 * DAY });

  part("Off: nothing happens");
  is("no choice made: nobody warned, nobody removed", await idleSweep(store, ms(400)), { warned: 0, removed: 0 });
  is("and no email", sent.length, 0);

  part("Switched on: counted from that day, never back before it");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, idle: 90, idleOn: T0 + 300 * DAY }));
  store = (await storeForEmail(OWNER))!;
  is("the choice is kept", [store.affiliates.idle, store.affiliates.idleOn], [90, T0 + 300 * DAY]);
  is("75 days after switching it on: nobody yet", await idleSweep(store, ms(375)), { warned: 0, removed: 0 });

  part("The warning first, and only when it went out");
  providerDown = true;
  is("the provider refuses: nobody is warned", await idleSweep(store, ms(400)), { warned: 0, removed: 0 });
  is("so nothing is written down, and nobody can be removed for it", (await readAffiliate(store, ids.quiet))?.warned ?? 0, 0);
  providerDown = false;
  is("the provider answers: the two who brought nothing are warned", await idleSweep(store, ms(400)), { warned: 2, removed: 0 });
  is("to them alone", sent.map((m) => m.to).sort(), [`${ids.quiet}@example.com`, `${ids.quiet2}@example.com`]);
  const date = new Date((T0 + 414 * DAY) * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  is("the subject names the store and the date", sent[0].subject, `Your affiliate link with Harbor Kitchen ends on ${date}`);
  is("the email says what happens, when, and how to stay", sent[0].text.startsWith(AFFILIATES_WORDS.en.idleBody("Harbor Kitchen", 90, date, true)), true);
  is("and says it as a condition, not as a fact about the past", /If yours brings neither before/.test(sent[0].text), true);
  is("and links to their page", sent[0].text.includes("/@harbor/affiliates"), true);
  is("the warning is written on their record", (await readAffiliate(store, ids.quiet))?.warned, T0 + 400 * DAY);
  for (const [who, id] of [
    ["a sale 50 days ago (paid) keeps the seller in", ids.seller],
    ["a sale by somebody they invited keeps the recruiter in", ids.recruiter],
    ["a lead 60 days ago keeps its affiliate in", ids.leader],
    ["somebody who may still be owed is never warned", ids.owed],
    ["a partner with a standing share is never warned", ids.partner],
    ["nor somebody still pending", ids.pending],
  ] as const) {
    is(who, (await readAffiliate(store, id))?.warned ?? 0, 0);
  }

  part("No second warning, and no removal before the date");
  is("the day after: nothing", await idleSweep(store, ms(401)), { warned: 0, removed: 0 });
  is("the day before the date: nothing", await idleSweep(store, ms(413)), { warned: 0, removed: 0 });
  is("still two emails in all", sent.length, 2);

  part("On the date: removed if still nothing, kept if a sale came");
  await redis.pipeline([
    ["HSET", sales, "cs_q2", sale("cs_q2", ids.quiet2, 405)],
    ["HSET", payouts, "po_q2", payout("po_q2", ids.quiet2, 200)],
  ]);
  is("one removed", await idleSweep(store, ms(414)), { warned: 0, removed: 1 });
  is("the one who still brought nothing; their record stays", (await readAffiliate(store, ids.quiet))?.status, "removed");
  is("the one whose sale came in time stays", (await readAffiliate(store, ids.quiet2))?.status, "approved");
  const statuses = await Promise.all([ids.seller, ids.owed, ids.partner, ids.recruiter, ids.leader, ids.pending].map(async (id) => (await readAffiliate(store, id))?.status));
  is("nobody else touched", statuses, ["approved", "approved", "approved", "approved", "approved", "pending"]);

  part("Restored by the creator: counted again from then");
  await decide(store, ids.quiet, "restore");
  await idleSweep(store, ms(430));
  is("not warned again on the old dates", (await readAffiliate(store, ids.quiet))?.warned, T0 + 400 * DAY);
  is("approved again", (await readAffiliate(store, ids.quiet))?.status, "approved");

  part("Never while memberships earn commission");
  is("a program crediting memberships cannot use it", idleRemovalAllowed({ recurring: 1 }), false);
  is("one crediting none can", idleRemovalAllowed({ recurring: 0 }), true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, recurring: 1 }));
  const members = (await storeForEmail(OWNER))!;
  is("its sweep does nothing, however long anybody was quiet", await idleSweep(members, ms(700)), { warned: 0, removed: 0 });
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...members.affiliates, recurring: 0 }));
  store = (await storeForEmail(OWNER))!;

  part("Bounded, and within the run's time");
  const many: (string | number)[][] = [];
  for (let i = 0; i < MAX_IDLE_STEPS + 5; i += 1) {
    const id = `f${String(i).padStart(11, "0")}`;
    many.push(["HSET", people, id, person(id)]);
  }
  await redis.pipeline(many);
  sent.length = 0;
  const run = await idleSweep(store, ms(700));
  is(`at most ${MAX_IDLE_STEPS} warnings and removals a run`, run.warned + run.removed <= MAX_IDLE_STEPS, true);
  is("and as many emails at most", sent.length <= MAX_IDLE_STEPS, true);
  sent.length = 0;
  is("past its deadline, a store's run does nothing", await idleSweep(store, ms(700), Date.now() - 1), { warned: 0, removed: 0 });
  is("and sends nothing", sent.length, 0);

  part("Words and wiring");
  const words = Object.entries(AFFILIATES_WORDS);
  is(
    "every language has the warning, with and without leads",
    words.every(([, w]) => w.idleSubject("S", "D").includes("D") && w.idleBody("S", 90, "D", true).includes("90") && w.idleBody("S", 90, "D", false) !== w.idleBody("S", 90, "D", true)),
    true,
  );
  is("without leads, no language speaks of leads", words.filter(([, w]) => /lead/i.test(w.idleBody("S", 90, "D", false)) || /lead/i.test(w.termIdle(90, 14, false))).length, 0);
  is("no language promises money in the warning", words.filter(([, w]) => /\$|€|paid out|garant/i.test(w.idleBody("S", 90, "D", true))).length, 0);
  is("every language says the rule before anyone applies", words.every(([, w]) => w.termIdle(90, 14, true).includes("90") && w.termIdle(90, 14, true).includes("14")), true);
  const cron = readFileSync(join(process.cwd(), "app/api/cron/affiliates/route.ts"), "utf8");
  is("the daily schedule runs it only after the payday finished", /counts\.complete \? await idleAll/.test(cron), true);
  is("and gives each store the run's deadline", /idleSweep\(store, Date\.now\(\), deadline\)/.test(cron), true);
  const route = readFileSync(join(process.cwd(), "app/api/store/affiliates/route.ts"), "utf8");
  is("the studio route refuses a number out of range", /idleProblem\(body\.idle\)/.test(route), true);
  is("keeps the choice when it is not sent", /body\.idle === undefined \? \(before\?\.idle \?\? 0\)/.test(route), true);
  is("never with memberships credited", /!idleRemovalAllowed\(setting\) \? 0/.test(route), true);
  is("and restarts the count when the program is switched back on", /setting\.enabled && before\?\.enabled === false/.test(route), true);
  const page = readFileSync(join(process.cwd(), "app/[handle]/affiliates/page.tsx"), "utf8");
  is("the affiliate page says it only when the program has it", /readIdleDays\(terms\.idle\) > 0 \? \[a\.termIdle/.test(page), true);
  const studio = readFileSync(join(process.cwd(), "components/affiliate-studio.tsx"), "utf8");
  is("the studio offers it, never by default", /useState\(String\(setting\.idle \?\? 0\)\)/.test(studio) && /n === 0 \? "Never"/.test(studio), true);
  is("and never with memberships credited", /idle: recurringOn \? 0 : Number\(idle\),/.test(studio), true);

  done();
}

void main();
