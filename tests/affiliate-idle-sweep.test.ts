/**
 * Removing affiliates who bring nothing, end to end (630 [HN6](3), unit 2:
 * lib/affiliates.ts idleSweep, the setting and the daily schedule), with the
 * real code, a stubbed Redis and the email provider intercepted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { MAX_IDLE_STEPS, decide, idleSweep, readAffiliate } from "@/lib/affiliates";
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
const at = (days: number) => (T0 + days * DAY) * 1000;

const sent: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    sent.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to), subject: String(body.subject), text: String(body.text) });
    return answer({ id: `email_${sent.length}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const ids = { quiet: "a1a1a1a1a1a1", seller: "b2b2b2b2b2b2", leader: "c3c3c3c3c3c3", pending: "d4d4d4d4d4d4" };
const person = (id: string, email: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code: id.slice(0, 4), status: "approved", appliedAt: at(0), decidedAt: at(0), note: "", ...over });
const sale = (ref: string, aff: string, seconds: number, self = false) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff, at: seconds, product: "prod01", title: "Bread course", base: 1000, total: 1000, currency: "usd", rate: 20, self, how: "click" });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestIdle00001", true);
  const LEADS = { kind: "signup", cents: 500, hold: 30, daily: 10, budget: 50_000 };
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, lead: LEADS }));
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ids.quiet, person(ids.quiet, "quiet@example.com")],
    ["HSET", `nl:aff:${statsId}:people`, ids.seller, person(ids.seller, "seller@example.com")],
    ["HSET", `nl:aff:${statsId}:people`, ids.leader, person(ids.leader, "leader@example.com")],
    ["HSET", `nl:aff:${statsId}:people`, ids.pending, person(ids.pending, "pending@example.com", { status: "pending" })],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_s1", sale("cs_s1", ids.seller, T0 + 350 * DAY)],
    // Their own purchase is not a sale they brought.
    ["HSET", `nl:aff:${statsId}:sales`, "cs_q1", sale("cs_q1", ids.quiet, T0 + 300 * DAY, true)],
  ]);
  await recordLead(store, { aff: ids.leader, kind: "signup", email: "fan@example.com", at: T0 + 340 * DAY });

  part("Off: nothing happens");
  is("no choice made: nobody warned, nobody removed", await idleSweep(store, at(400)), { warned: 0, removed: 0 });
  is("and no email", sent.length, 0);

  part("Switched on: the quiet one is warned first, with the date");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, idle: 90, idleOn: T0 + 399 * DAY }));
  store = (await storeForEmail(OWNER))!;
  is("the choice is kept", [store.affiliates.idle, store.affiliates.idleOn], [90, T0 + 399 * DAY]);
  is("one warning, no removal", await idleSweep(store, at(400)), { warned: 1, removed: 0 });
  is("to the affiliate who brought nothing, their own purchase not counted", sent.map((m) => m.to), ["quiet@example.com"]);
  const date = new Date((T0 + 414 * DAY) * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  is("the subject names the store and the date", sent[0].subject, `Your affiliate link with Harbor Kitchen ends on ${date}`);
  is("the email says why, when, and how to stay", sent[0].text.startsWith(AFFILIATES_WORDS.en.idleBody("Harbor Kitchen", 90, date)), true);
  is("and links to their page", sent[0].text.includes("/@harbor/affiliates"), true);
  is("the warning is written on their record", (await readAffiliate(store, ids.quiet))?.warned, T0 + 400 * DAY);
  is("a sale 50 days ago keeps the seller in", (await readAffiliate(store, ids.seller))?.warned ?? 0, 0);
  is("a lead 60 days ago keeps its affiliate in", (await readAffiliate(store, ids.leader))?.warned ?? 0, 0);

  part("The next days: no second warning, and no removal before the date");
  is("the day after: nothing", await idleSweep(store, at(401)), { warned: 0, removed: 0 });
  is("the day before the date: nothing", await idleSweep(store, at(413)), { warned: 0, removed: 0 });
  is("still one email in all", sent.length, 1);

  part("On the date, still nothing: removed, as the creator's Remove");
  is("removed", await idleSweep(store, at(414)), { warned: 0, removed: 1 });
  const gone = await readAffiliate(store, ids.quiet);
  is("their record stays, removed", gone?.status, "removed");
  is("nobody else touched", [(await readAffiliate(store, ids.seller))?.status, (await readAffiliate(store, ids.leader))?.status, (await readAffiliate(store, ids.pending))?.status], ["approved", "approved", "pending"]);

  part("A decision by the creator in the meantime is never undone");
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, ids.seller, person(ids.seller, "seller@example.com", { decidedAt: at(100) })]]);
  await redis.pipeline([["HDEL", `nl:aff:${statsId}:sales`, "cs_s1"]]);
  await idleSweep(store, at(420));
  is("the seller, quiet since day 100, is warned", (await readAffiliate(store, ids.seller))?.warned, T0 + 420 * DAY);
  await decide(store, ids.seller, "restore");
  const restored = await readAffiliate(store, ids.seller);
  await idleSweep(store, at(440));
  is("restored by the creator: counted again from the restore, not removed on the old date", (await readAffiliate(store, ids.seller))?.status, "approved");
  is("restored means approved", restored?.status, "approved");

  part("A sale after the warning keeps them in");
  sent.length = 0;
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, ids.leader, person(ids.leader, "leader@example.com", { warned: T0 + 450 * DAY })]]);
  await redis.pipeline([["HSET", `nl:aff:${statsId}:sales`, "cs_l2", sale("cs_l2", ids.leader, T0 + 455 * DAY)]]);
  is("the date has come, but a sale came first: nothing", await idleSweep(store, at(470)), { warned: 0, removed: 0 });
  is("no email", sent.length, 0);

  part("Changing the number of days asks for a fresh warning");
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, ids.leader, person(ids.leader, "leader@example.com", { warned: T0 + 600 * DAY })]]);
  await redis.pipeline([["HDEL", `nl:aff:${statsId}:sales`, "cs_l2"]]);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, idle: 120, idleOn: T0 + 601 * DAY }));
  store = (await storeForEmail(OWNER))!;
  is("a warning given under the old choice is set aside: nobody removed", (await idleSweep(store, at(602))).removed, 0);
  is("the affiliate warned before is warned again, with the new date", (await readAffiliate(store, ids.leader))?.warned, T0 + 602 * DAY);

  part("Bounded");
  const many: (string | number)[][] = [];
  for (let i = 0; i < MAX_IDLE_STEPS + 5; i += 1) {
    const id = `e${String(i).padStart(11, "0")}`;
    many.push(["HSET", `nl:aff:${statsId}:people`, id, person(id, `quiet${i}@example.com`)]);
  }
  await redis.pipeline(many);
  sent.length = 0;
  const run = await idleSweep(store, at(700));
  is(`at most ${MAX_IDLE_STEPS} warnings and removals a run`, run.warned + run.removed <= MAX_IDLE_STEPS, true);
  is("and as many emails at most", sent.length <= MAX_IDLE_STEPS, true);

  part("Words and wiring");
  const words = Object.entries(AFFILIATES_WORDS);
  is("every language has the warning", words.every(([, w]) => w.idleSubject("S", "D").includes("D") && w.idleBody("S", 90, "D").includes("90")), true);
  is("no language promises money in the warning", words.filter(([, w]) => /\$|€|paid out|garant/i.test(w.idleBody("S", 90, "D"))).length, 0);
  const cron = readFileSync(join(process.cwd(), "app/api/cron/affiliates/route.ts"), "utf8");
  is("the daily schedule runs it only after the payday finished", /counts\.complete \? await idleAll/.test(cron), true);
  const route = readFileSync(join(process.cwd(), "app/api/store/affiliates/route.ts"), "utf8");
  is("the studio route refuses a number out of range", /idleProblem\(body\.idle\)/.test(route), true);
  is("and keeps the choice when it is not sent", /body\.idle === undefined \? \(before\?\.idle \?\? 0\)/.test(route), true);

  is("every language says the rule before anyone applies", words.every(([, w]) => w.termIdle(90, 14).includes("90") && w.termIdle(90, 14).includes("14")), true);
  const page = readFileSync(join(process.cwd(), "app/[handle]/affiliates/page.tsx"), "utf8");
  is("the affiliate page says it only when the program has it", /readIdleDays\(terms\.idle\) > 0 \? \[a\.termIdle/.test(page), true);
  const studio = readFileSync(join(process.cwd(), "components/affiliate-studio.tsx"), "utf8");
  is("the studio offers it, never by default", /useState\(String\(setting\.idle \?\? 0\)\)/.test(studio) && /n === 0 \? "Never"/.test(studio), true);
  is("and sends the choice with the settings", /idle: Number\(idle\),/.test(studio), true);

  done();
}

void main();
