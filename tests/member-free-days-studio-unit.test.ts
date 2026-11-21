/**
 * A press of "Give free days" (app/api/store/member-free-days, lib/member-free-days.ts) is one studio request, and
 * every Redis command it sends, its lock's tries at their most included, fits the studio unit the store pays
 * (UNIT_COST.studio in tests/plan-cost-registry.ts: 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS commands). Claude
 * 7's MEDIUM 1 on #2912 (6894146239, 6896484096): waiting MEMBERSHIP_LOCK_WAIT_MS = 5 s on the membership's lock, the
 * press polled it with one SET NX each 20 to 250 ms, 23 tries, so a press that found the lock held sent 34 commands
 * and one that got it at its last try more still. Measured here through the route, on a store's first studio request
 * of the month (its month's registration counted), with every case's lock waited for at its most tries. The one email
 * to the member counts its own take in the email unit (TAKE_COMMANDS); the rest of what it sends is counted here.
 * Synthetic only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, storeForEmail } from "@/lib/store";
import { POST } from "@/app/api/store/member-free-days/route";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_member_free_days_only";
// One of the synthetic sender keys tests/resend-fixture-credentials.ts knows: never a live one.
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const PERIOD_END = NOW + 20 * DAY;
const SUB = "sub_live000001";
const LOCK = `nl:tier:${SUB}:lock`;
/** The studio unit, in commands (UNIT_COST.studio). */
const STUDIO_UNIT_COMMANDS = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;

let stripeWrite: "ok" | "error" = "ok";
const subscription: Record<string, unknown> = {
  id: SUB,
  status: "active",
  discounts: [],
  metadata: { store: "unitstore", product: "prod000001" },
  items: { data: [{ current_period_end: PERIOD_END, price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] },
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/customers") return answer({ object: "list", data: url.searchParams.get("email") === "member@example.com" ? [{ id: "cus_member0001" }] : [], has_more: false });
  if (path === "/subscriptions" && (init?.method ?? "GET") === "GET") return answer({ object: "list", data: url.searchParams.get("customer") === "cus_member0001" ? [subscription] : [], has_more: false });
  if (path.startsWith("/products")) return answer({ object: "list", data: [] });
  if (init?.method === "POST" && path === `/subscriptions/${SUB}`) {
    if (stripeWrite === "error") return answer({ error: { message: "Something went wrong on Stripe's end." } }, 500);
    const body = new URLSearchParams(String(init.body));
    const meta = { ...(subscription.metadata as Record<string, string>) };
    for (const [key, value] of body) {
      const name = /^metadata\[(.+)\]$/.exec(key)?.[1];
      if (!name) continue;
      if (value === "") delete meta[name];
      else meta[name] = value;
    }
    return answer({ ...subscription, status: "trialing", trial_end: Number(body.get("trial_end")), metadata: meta });
  }
  return answer({ object: "list", data: [] });
}) as typeof fetch;

/** lib/redis-lock.ts takeLock: one SET NX a try, waits of 20 ms doubling up to 250 ms, while they fit in `waitMs`. */
function lockTries(waitMs: number): number {
  let tries = 1;
  for (let wait = 20, waited = 0; waited + wait <= waitMs; wait = Math.min(wait * 2, 250)) {
    waited += wait;
    tries += 1;
  }
  return tries;
}

const sent: (string | number)[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(...commands);
  return pipeline(commands);
}) as typeof redis.pipeline;

/** A fresh store whose owner has not yet made a studio request this month, and one press of "give" by the owner. */
async function press(lockHeld: boolean): Promise<{ status: number; error: string; commands: (string | number)[][] }> {
  redis.clear();
  const owner = "unit-free-days@example.com";
  await claimHandle(owner, "unitstore", "Unit Store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Unitdaysxxxxxx", true);
  const store = (await storeForEmail(owner))!;
  const session = await openSession(owner);
  if (lockHeld) await pipeline([["SET", LOCK, "a-switch-holds-it", "EX", 120]]);
  sent.length = 0;
  const response = await POST(
    new NextRequest(`https://marktmorgen.com/api/store/member-free-days?store=${store.sid}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" },
      body: JSON.stringify({ action: "give", email: "member@example.com", subscription: SUB, days: 5, expected: PERIOD_END }),
    }),
  );
  const body = (await response.json()) as { error?: string };
  return { status: response.status, error: body.error ?? "ok", commands: [...sent] };
}

const tries = (commands: (string | number)[][]) => commands.filter((c) => String(c[0]).toUpperCase() === "SET" && c[1] === LOCK).length;

async function main(): Promise<void> {
  const real = console.error;
  console.error = () => {};
  const source = readFileSync("lib/member-free-days.ts", "utf8");
  const waitMs = Number((source.match(/const MEMBERSHIP_LOCK_WAIT_MS = ([\d_]+);/)?.[1] ?? "NaN").replace(/_/g, ""));
  const most = lockTries(waitMs);

  part("A press that finds the membership's lock held fits one studio request");
  const busy = await press(true);
  is("answered busy", [busy.status, busy.error], [409, "busy"]);
  // takeLock adds up to 19 ms at random to each wait, so a press may make fewer tries than the most; never more.
  is("the lock was tried, never more than its most tries in MEMBERSHIP_LOCK_WAIT_MS", tries(busy.commands) >= 1 && tries(busy.commands) <= most, true);
  const busyWorst = busy.commands.length - tries(busy.commands) + most;
  is(`at its most (${busyWorst}) its commands fit the studio unit (${STUDIO_UNIT_COMMANDS})`, busyWorst <= STUDIO_UNIT_COMMANDS, true);

  part("A press that gets the lock at its last try and gives the days fits one studio request");
  const given = await press(false);
  is("given", [given.status, given.error], [200, "ok"]);
  is("one try at the lock, it being free", tries(given.commands), 1);
  // The same press, its lock got only at its last try: every try before it added; the email's own take is the email unit's.
  const givenWorst = given.commands.length - 1 + most - TAKE_COMMANDS;
  is(`at its most (${givenWorst}) its commands fit the studio unit (${STUDIO_UNIT_COMMANDS})`, givenWorst <= STUDIO_UNIT_COMMANDS, true);

  part("A press whose write Stripe does not confirm keeps the lock a full term and fits one studio request");
  stripeWrite = "error";
  const unknown = await press(false);
  stripeWrite = "ok";
  is("not known", [unknown.status, unknown.error], [502, "unknown"]);
  const unknownWorst = unknown.commands.length - 1 + most;
  is(`at its most (${unknownWorst}) its commands fit the studio unit (${STUDIO_UNIT_COMMANDS})`, unknownWorst <= STUDIO_UNIT_COMMANDS, true);

  part("The file's cost note names the lock's tries");
  is("the header says the lock's tries are inside the studio request", /MEMBERSHIP_LOCK_WAIT_MS/.test(source.slice(0, source.indexOf("import "))), true);

  console.error = real;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
