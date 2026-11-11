/**
 * 641 [WG1]: free days given to one member (lib/member-free-days.ts), with
 * Stripe and the email sender faked through fetch and Redis in memory. What is
 * checked:
 *
 *   - the next charge moves exactly the days given, by the subscription's
 *     trial_end with no proration, on the creator's own Stripe account;
 *   - only this store's running memberships of that address, and not one set
 *     to end, paused or behind on a payment;
 *   - an answer from Stripe or Redis that cannot be read records nothing as
 *     done: no log line, no email;
 *   - two presses at once move the date once and email once;
 *   - who gave it, when and how many days is in the store's activity log;
 *   - the member's email is counted in the store's emails and written in the
 *     store's language, in every language a membership speaks;
 *   - only a role that may touch payments sees it, and the route refuses the
 *     others.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setLanguage, setStripeAccount, storeForEmail } from "@/lib/store";
import { putMember, readLog } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { memberSubs } from "@/lib/member-discount";
import { FREE_DAYS_MAX, freeDaysState, movedCharge, parseFreeDays } from "@/lib/member-free-days-rules";
import { freeDaysSubs, giveFreeDays } from "@/lib/member-free-days";
import { FREE_DAYS_WORDS } from "@/lib/buyer-words/free-days";
import { MEMBERSHIP_WORDS } from "@/lib/buyer-words/membership";
import { speechFor } from "@/lib/buyer-words";
import { allowanceUsed } from "@/lib/store-allowance";
import { POST } from "@/app/api/store/member-free-days/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_member_free_days_only";
// One of the synthetic sender keys tests/resend-fixture-credentials.ts knows: never a live one.
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const PERIOD_END = NOW + 20 * DAY;
const TRIAL_END = NOW + 5 * DAY;

const subscription = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  status: "active",
  metadata: { store: "daysstore", product: "prod000001" },
  items: { data: [{ current_period_end: PERIOD_END, price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] },
  ...extra,
});
const subs: Record<string, unknown>[] = [
  subscription("sub_live000001"),
  subscription("sub_trial00001", { status: "trialing", trial_end: TRIAL_END }),
  subscription("sub_ending0001", { cancel_at_period_end: true }),
  subscription("sub_paused0001", { pause_collection: { behavior: "void", resumes_at: PERIOD_END + 30 * DAY } }),
  subscription("sub_behind0001", { status: "past_due" }),
  subscription("sub_else000001", { metadata: { store: "another" } }),
  subscription("sub_plan000001", { metadata: { store: "daysstore", kind: "plan" } }),
];
const byId = (id: string) => subs.find((s) => s.id === id)!;

type Mode = "ok" | "error" | "odd" | "refuse";
let mode: Mode = "ok";
let slow = 0;
const posted: { path: string; body: URLSearchParams; key: string | null; account: string | null }[] = [];
const emails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    if (init?.method === "POST" && url.pathname === "/emails") emails.push({ to: String([body.to].flat()[0]), subject: body.subject ?? "", text: body.text ?? "" });
    return answer({ id: `email_${emails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  // Stripe's lists carry has_more: an answer without it is not one this code reads (rule 24).
  // offrow@ has a customer row that is not one, offsub@ a subscription row that is not one (Codex S second review of #2912).
  const email = url.searchParams.get("email");
  if (path === "/customers") return answer({ object: "list", data: email === "member@example.com" ? [{ id: "cus_member0001" }] : email === "offrow@example.com" ? [{}] : email === "offsub@example.com" ? [{ id: "cus_offsub00001" }] : [], has_more: false });
  const customer = url.searchParams.get("customer");
  if (path === "/subscriptions" && (init?.method ?? "GET") === "GET") return answer({ object: "list", data: customer === "cus_member0001" ? subs : customer === "cus_offsub00001" ? [[]] : [], has_more: false });
  if (path.startsWith("/products")) return answer({ object: "list", data: [] });
  if (init?.method === "POST" && path.startsWith("/subscriptions/")) {
    const headers = new Headers(init.headers);
    const body = new URLSearchParams(String(init.body));
    posted.push({ path, body, key: headers.get("Idempotency-Key"), account: headers.get("Stripe-Account") });
    if (slow) await new Promise((resolve) => setTimeout(resolve, slow));
    if (mode === "error") return answer({ error: { message: "Something went wrong on Stripe's end." } }, 500);
    if (mode === "refuse") return answer({ error: { code: "resource_missing", message: "No such subscription." } }, 400);
    const sub = byId(path.split("/")[2]);
    if (mode === "odd") return answer({ id: sub.id });
    const end = Number(body.get("trial_end"));
    Object.assign(sub, { status: "trialing", trial_end: end });
    // Metadata merged as Stripe merges it: an empty value removes its key.
    const meta = { ...(sub.metadata as Record<string, string>) };
    for (const [key, value] of body) {
      const name = /^metadata\[(.+)\]$/.exec(key)?.[1];
      if (!name) continue;
      if (value === "") delete meta[name];
      else meta[name] = value;
    }
    sub.metadata = meta;
    return answer(sub);
  }
  return answer({ object: "list", data: [] });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "member-free-days@example.com";
  await claimHandle(owner, "daysstore", "Days Store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Freedaysxxxxxx", true);
  await setLanguage(owner, "es");
  const store = (await storeForEmail(owner))!;
  const by = { who: owner, role: "owner" as const };

  part("The days");
  is("a whole number from 1 to the cap, and nothing else", [0, 1, FREE_DAYS_MAX, FREE_DAYS_MAX + 1, "14", 1.5, -3, "x", null].map(parseFreeDays), [null, 1, FREE_DAYS_MAX, null, 14, null, null, null, null]);
  is("the cap is 90 days", FREE_DAYS_MAX, 90);
  is("the next charge moves exactly the days given", movedCharge(PERIOD_END, 14), PERIOD_END + 14 * DAY);
  is(
    "a running membership's next charge, and why another has none to move",
    [byId("sub_live000001"), byId("sub_trial00001"), byId("sub_ending0001"), byId("sub_paused0001"), byId("sub_behind0001")].map((s) => freeDaysState(s, NOW)),
    [
      { nextCharge: PERIOD_END, blocked: null },
      { nextCharge: TRIAL_END, blocked: null },
      { nextCharge: PERIOD_END, blocked: "ending" },
      { nextCharge: PERIOD_END, blocked: "paused" },
      { nextCharge: 0, blocked: "behind" },
    ],
  );
  is("a membership on a schedule of changes is left alone", freeDaysState(subscription("sub_sched00001", { schedule: "sub_sched_1" }), NOW).blocked, "scheduled");

  part("What the studio is shown");
  const found = await freeDaysSubs(store, "member@example.com");
  is(
    "only this store's running memberships of that address, each with its next charge",
    found?.map((s) => [s.id, s.nextCharge, s.blocked]),
    [
      ["sub_live000001", PERIOD_END, null],
      ["sub_trial00001", TRIAL_END, null],
      ["sub_ending0001", PERIOD_END, "ending"],
      ["sub_paused0001", PERIOD_END, "paused"],
      ["sub_behind0001", 0, "behind"],
    ],
  );
  is("the discount's own reading still reads the same memberships (healthy control)", (await memberSubs(store, "member@example.com"))?.map((s) => s.id), ["sub_live000001", "sub_trial00001", "sub_ending0001", "sub_paused0001", "sub_behind0001"]);

  part("Refused before Stripe is asked");
  is("another store's membership", await giveFreeDays(store, "member@example.com", "sub_else000001", 7, PERIOD_END, by), { ok: false, reason: "not_member" });
  is("a payment plan", await giveFreeDays(store, "member@example.com", "sub_plan000001", 7, PERIOD_END, by), { ok: false, reason: "not_member" });
  is("one set to end", await giveFreeDays(store, "member@example.com", "sub_ending0001", 7, PERIOD_END, by), { ok: false, reason: "blocked", blocked: "ending" });
  is("one behind on a payment", await giveFreeDays(store, "member@example.com", "sub_behind0001", 7, 0, by), { ok: false, reason: "blocked", blocked: "behind" });
  is("no days, or more than the cap", [(await giveFreeDays(store, "member@example.com", "sub_live000001", 0, PERIOD_END, by)).ok, (await giveFreeDays(store, "member@example.com", "sub_live000001", 91, PERIOD_END, by)).ok], [false, false]);
  is("a next charge that is not the one the creator saw", await giveFreeDays(store, "member@example.com", "sub_live000001", 7, PERIOD_END - DAY, by), { ok: false, reason: "changed" });
  // A row Stripe could not have sent is unknown: the studio says Stripe could not be read and the route answers 502, never "no running membership" (Codex S second review of #2912).
  is("a customer or subscription row that is not one: the studio is told Stripe could not be read", [await freeDaysSubs(store, "offrow@example.com"), await freeDaysSubs(store, "offsub@example.com")], [null, null]);
  is("and giving days says Stripe, never not a member", [await giveFreeDays(store, "offrow@example.com", "sub_live000001", 7, PERIOD_END, by), await giveFreeDays(store, "offsub@example.com", "sub_live000001", 7, PERIOD_END, by)], [{ ok: false, reason: "stripe" }, { ok: false, reason: "stripe" }]);
  is("nobody under that address is still none", await freeDaysSubs(store, "nobody@example.com"), []);
  is("nothing was sent to Stripe for any of them", posted.length, 0);

  part("An answer that cannot be read records nothing as done");
  // Rule 23 (Claude 4's LOW on #2912): a write sent and not confirmed keeps the membership's lock a full term
  // (tests/member-free-days-lock-kept.test.ts); each case here lets it run out, as that term passing would.
  const termOver = () => redis.run(["DEL", "nl:tier:sub_live000001:lock"]);
  mode = "error";
  is("Stripe failing: unknown", await giveFreeDays(store, "member@example.com", "sub_live000001", 14, PERIOD_END, by), { ok: false, reason: "unknown" });
  termOver();
  mode = "odd";
  is("Stripe answering without the date asked for: unknown", await giveFreeDays(store, "member@example.com", "sub_live000001", 14, PERIOD_END, by), { ok: false, reason: "unknown" });
  termOver();
  const realPipeline = redis.pipeline.bind(redis);
  // Regra 23: this bent every SET; since Codex V's review of #2912 the press first takes the membership's lock (a SET NX
  // of nl:tier:...:lock), so only the claim's own SET (nl:free-days:) is bent, as the check means.
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "SET" && String(commands[0]?.[1]).startsWith("nl:free-days:") ? [{ odd: true }] : realPipeline(commands))) as typeof redis.pipeline;
  mode = "ok";
  const before = posted.length;
  is("Redis answering the claim in an unknown shape: unknown", await giveFreeDays(store, "member@example.com", "sub_live000001", 14, PERIOD_END, by), { ok: false, reason: "unknown" });
  redis.pipeline = realPipeline;
  is("and Stripe was not asked then", posted.length, before);
  // readLog answers null for a log that does not read (main): null?.length is undefined, never the 0 asked for.
  is("no log line and no email for any of them", [(await readLog(store.sid))?.length, emails.length], [0, 0]);
  mode = "refuse";
  is("Stripe saying no: refused, nothing changed", await giveFreeDays(store, "member@example.com", "sub_live000001", 14, PERIOD_END, by), { ok: false, reason: "refused" });
  is("the membership still has its date", byId("sub_live000001").trial_end, undefined);

  part("Giving the days");
  mode = "ok";
  const emailsUsed = await allowanceUsed(store, "email");
  const given = await giveFreeDays(store, "member@example.com", "sub_live000001", 14, PERIOD_END, by);
  is("given, with the new next charge", given, { ok: true, nextCharge: PERIOD_END + 14 * DAY, emailed: true });
  const last = posted.at(-1)!;
  is(
    "on the creator's account, by trial_end with no proration, with an idempotency key",
    [last.path, last.account, last.body.get("trial_end"), last.body.get("proration_behavior"), last.key],
    ["/subscriptions/sub_live000001", "acct_1Freedaysxxxxxx", String(PERIOD_END + 14 * DAY), "none", `member-free-days:sub_live000001:${PERIOD_END}:14`],
  );
  is("the membership's next charge on Stripe moved exactly 14 days", byId("sub_live000001").trial_end, PERIOD_END + 14 * DAY);
  const log = (await readLog(store.sid)) ?? [];
  is("who gave it, when and how many days is in the activity log", [log.length, log[0]?.who, log[0]?.what.includes("14 free days"), typeof log[0]?.at === "string"], [1, owner, true, true]);
  is("the member is emailed once", [emails.length, emails[0]?.to], [1, "member@example.com"]);
  is("and the email was taken from the store's own emails first", (await allowanceUsed(store, "email")) - emailsUsed, 1);
  const es = FREE_DAYS_WORDS.es;
  const date = speechFor("es", "usd").date((PERIOD_END + 14 * DAY) * 1000);
  is("in the store's language, with the new date", [emails[0]?.subject === es.subject("Days Store"), emails[0]?.text.includes(date), emails[0]?.text.includes(es.days(14))], [true, true, true]);
  is("pressing again with the date seen before: the date already moved, nothing more", await giveFreeDays(store, "member@example.com", "sub_live000001", 14, PERIOD_END, by), { ok: false, reason: "changed" });

  part("Two presses at once");
  const postedBefore = posted.length;
  const emailsBefore = emails.length;
  slow = 30;
  const both = await Promise.all([
    giveFreeDays(store, "member@example.com", "sub_trial00001", 10, TRIAL_END, by),
    giveFreeDays(store, "member@example.com", "sub_trial00001", 10, TRIAL_END, by),
  ]);
  slow = 0;
  // Regra 23: this said ["busy", "ok"]. Since Codex V's review of #2912 both presses take the membership's lock: the
  // second waits for the first, reads the membership again and finds the date already moved, so it is "changed".
  is("one gives the days, the other finds them given and adds nothing", both.map((r) => (r.ok ? "ok" : r.reason)).sort(), ["changed", "ok"]);
  is("Stripe asked once, the member emailed once", [posted.length - postedBefore, emails.length - emailsBefore], [1, 1]);
  is("a trial's end moved exactly the days given", byId("sub_trial00001").trial_end, TRIAL_END + 10 * DAY);

  part("The member's words");
  const languages = Object.keys(MEMBERSHIP_WORDS).sort();
  is("in every language a membership speaks", Object.keys(FREE_DAYS_WORDS).sort(), languages);
  is("each its own, not English again", languages.filter((code) => code !== "en" && FREE_DAYS_WORDS[code as keyof typeof FREE_DAYS_WORDS].subject("X") === FREE_DAYS_WORDS.en.subject("X")), []);
  is("one day and many", [FREE_DAYS_WORDS.en.days(1), FREE_DAYS_WORDS.en.days(14)], ["1 free day", "14 free days"]);

  part("Who may give them");
  is("only a role that may touch payments", [can("owner", "payments"), can("admin", "payments"), can("editor", "payments"), can("support", "payments")], [true, false, false, false]);
  const page = readFileSync("app/studio/memberships/page.tsx", "utf8");
  is("the studio draws it only for that role", /can\(access\.role, "payments"\) \? \(\s*<section aria-labelledby="member-free-days-title"/.test(page) && page.includes("<MemberFreeDays"), true);
  const admin = "admin-days@example.com";
  await putMember(store, admin, "admin");
  const session = await openSession(admin);
  const postedRoute = posted.length;
  const response = await POST(
    new NextRequest(`https://marktmorgen.com/api/store/member-free-days?store=${store.sid}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" },
      body: JSON.stringify({ action: "give", email: "member@example.com", subscription: "sub_live000001", days: 5, expected: PERIOD_END + 14 * DAY }),
    }),
  );
  is("an admin is refused by the route, and Stripe is not asked", [response.status, posted.length - postedRoute], [403, 0]);
  const route = readFileSync("app/api/store/member-free-days/route.ts", "utf8");
  is("the route asks for the payments permission", route.includes('guardStoreWrite(request, "payments")'), true);

  part("The studio's form");
  const component = readFileSync("components/member-free-days.tsx", "utf8");
  is("a labeled whole number with its bounds and a hint", component.includes('type="number"') && component.includes("min={1}") && component.includes("max={FREE_DAYS_MAX}") && component.includes("aria-describedby"), true);
  is("a review step that shows the new date before anything changes", component.includes("Review") && component.includes("movedCharge(") && component.includes("Go back"), true);
  is("the result announced and errors said", component.includes('role="status"') && component.includes('role="alert"'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
