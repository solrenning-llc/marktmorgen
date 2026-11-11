/**
 * The two once-only marks in lib/usage-billing.ts are read exactly
 * (audit SG2 L8, CX-123 rule 24).
 *
 *   nl:watch:monthly:<subscription>   guards a write to Stripe: a yearly plan
 *                                     set to bill added lines monthly
 *   nl:<meter>:told:<folder>:<month>  guards an email: the creator written to
 *                                     about a month
 *
 * Each was taken with SET NX and only a nil reply counted as taken, so a
 * reply cut short, padded, "QUEUED" or missing went ahead as ours: the
 * Stripe write or the email again, or on a mark nobody could read. Now only
 * "OK" (one reply for one command) is ours and nil is taken; any other
 * answer is read back, and only our own value there makes the mark ours.
 * And the monthly mark, let go when Stripe failed, was deleted whoever held
 * it by then; now it is let go only while it still holds our own value.
 */
import { rememberFolderOwner } from "@/lib/delivery";
import { claimHandle, setSubscription, storeFolder } from "@/lib/store";
import { type Meter, firstWordOf, settleUsage } from "@/lib/usage-billing";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Commands = (string | number)[][];
/** A stand-in for one kind of command: its own reply, "throw", or "pass" (carried out, then answered with `after`). */
type Rule = { when: (commands: Commands) => boolean; reply: unknown; pass?: boolean };
let rules: Rule[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Commands) => {
  const rule = rules.find((r) => r.when(commands));
  if (!rule) return pipeline(commands);
  if (rule.pass) await pipeline(commands);
  if (rule.reply === "throw") throw new Error("the database did not answer");
  return rule.reply as unknown[];
}) as typeof redis.pipeline;

// ------------------------------------------------------------------ Stripe

const monthly: string[] = [];
/** "up"; "fails", the switch to monthly is refused; "fails-after-taken", another run takes the mark first and then it is refused. */
let subscriptions: "up" | "fails" | "fails-after-taken" = "up";
let lineCount = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin !== "https://api.stripe.com") return json({}, 404);
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/invoiceitems" && method === "GET") return json({ data: [], has_more: false });
  if (path === "/invoiceitems" && method === "POST") {
    lineCount += 1;
    return json({ id: `ii_${String(lineCount).padStart(14, "0")}` });
  }
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub && method === "POST") {
    monthly.push(sub[1]);
    if (subscriptions === "fails-after-taken") await pipeline([["SET", monthlyKey, "another-run"]]);
    if (subscriptions !== "up") return json({ error: { code: "api_error" } }, 500);
    return json({ id: sub[1] });
  }
  return json({ error: { code: "resource_missing" } }, 404);
}) as typeof fetch;

const SUBSCRIPTION = "sub_Year0001";
const monthlyKey = `nl:watch:monthly:${SUBSCRIPTION}`;
const month = "2026-11";
const now = Date.UTC(2026, 10, 20, 14);

/** A meter that still owes something, so a line is added and the monthly switch is reached. */
const PROBE: Meter = {
  name: "probe",
  measured: async () => 10,
  owed: () => 500,
  byPlan: false,
  covered: 0,
  describe: () => "Probe use",
  folders: async () => [],
};

const settingMonthly = (commands: Commands) => commands[0]?.[0] === "SET" && commands[0]?.[1] === monthlyKey && commands[0]?.includes("NX");
const readingMonthly = (commands: Commands) => commands.length === 1 && commands[0]?.[0] === "GET" && commands[0]?.[1] === monthlyKey;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  const error = console.error;
  console.error = () => {};

  await claimHandle("yara@example.com", "yara", "yara", "");
  const folder = await storeFolder("yara@example.com");
  await rememberFolderOwner(folder, "yara@example.com");
  await setSubscription("yara@example.com", { customerId: "cus_Year0001", subscriptionId: SUBSCRIPTION, active: true, cycle: "year", period: paidPeriod() });

  /** One settle from a clean month, with the monthly mark as given; how many times Stripe was asked to switch, and what the mark holds after. */
  async function settleWith(mark: string | null, rule: Rule[]): Promise<{ switched: number; mark: unknown; state: string }> {
    rules = [];
    await pipeline([["DEL", `nl:probe:billed:${folder}:${month}`, `nl:probe:adding:${folder}:${month}`, monthlyKey]]);
    if (mark !== null) await pipeline([["SET", monthlyKey, mark]]);
    monthly.length = 0;
    rules = rule;
    let state = "rejected";
    try {
      state = (await settleUsage(PROBE, folder, month, true, now)).state;
    } catch {
      state = "rejected";
    }
    rules = [];
    const [held] = await pipeline([["GET", monthlyKey]]);
    return { switched: monthly.length, mark: held, state };
  }

  part("the monthly switch (a write to Stripe): a plain answer");
  const plain = await settleWith(null, []);
  is("free: the switch is asked for once, and the line billed", [plain.switched, plain.state], [1, "billed"]);
  is("free: the mark is kept, holding a value of its own (time and a random part), not a bare 1", typeof plain.mark === "string" && /^\d+\.\d{9}$/.test(plain.mark), true);
  const twice = await settleWith(null, []);
  is("two attempts write two different values", twice.mark !== plain.mark, true);
  is("taken by another run (nil): Stripe is not asked again", await settleWith("1", []), { switched: 0, mark: "1", state: "billed" });

  const odd: [string, unknown][] = [
    ["no reply at all", []],
    ["a reply of another shape", ["QUEUED"]],
    ["a reply with one too many", ["OK", "OK"]],
    ["a reply of the wrong type", [1]],
    ["a database that does not answer", "throw"],
  ];

  part("the monthly switch: an odd answer, the mark another run's");
  for (const [label, reply] of odd) {
    const row = await settleWith("1", [{ when: settingMonthly, reply }]);
    is(`${label}: read back as another's, Stripe is not asked again`, [row.switched, row.mark], [0, "1"]);
  }

  part("the monthly switch: an odd answer, and nothing readable after");
  for (const [label, reply] of odd) {
    for (const [readLabel, readReply] of [["no reply", []], ["a number", [7]], ["no answer", "throw"]] as [string, unknown][]) {
      const row = await settleWith(null, [{ when: settingMonthly, reply }, { when: readingMonthly, reply: readReply }]);
      is(`${label}, read back as ${readLabel}: unknown, Stripe is not asked`, [row.switched, row.mark], [0, null]);
    }
  }

  part("the monthly switch: an odd answer, but our write landed");
  for (const [label, reply] of odd) {
    const row = await settleWith(null, [{ when: settingMonthly, reply, pass: true }]);
    is(`${label}: read back as our own value, the switch is asked for once`, [row.switched, typeof row.mark === "string" && row.mark !== "1"], [1, true]);
  }

  part("the monthly switch: let go only while it is still ours");
  subscriptions = "fails";
  is("Stripe refuses: our mark is let go, so the next line tries again", await settleWith(null, []), { switched: 1, mark: null, state: "billed" });
  subscriptions = "fails-after-taken";
  is("Stripe refuses after another run took the mark: the other run's mark stays", await settleWith(null, []), { switched: 1, mark: "another-run", state: "billed" });
  subscriptions = "up";

  part("the word to the creator (an email): firstWordOf");
  const told = `nl:probe:told:${folder}:${month}`;
  const settingTold = (commands: Commands) => commands[0]?.[0] === "SET" && commands[0]?.[1] === told && commands[0]?.includes("NX");
  const readingTold = (commands: Commands) => commands.length === 1 && commands[0]?.[0] === "GET" && commands[0]?.[1] === told;
  /** firstWordOf with the told mark as given; "rejected" when it throws. */
  async function wordWith(mark: string | null, rule: Rule[]): Promise<boolean | "rejected"> {
    rules = [];
    await pipeline([["DEL", told]]);
    if (mark !== null) await pipeline([["SET", told, mark]]);
    rules = rule;
    try {
      return await firstWordOf(PROBE, folder, month);
    } catch {
      return "rejected";
    } finally {
      rules = [];
    }
  }
  is("free, then taken: written to once", [await wordWith(null, []), await firstWordOf(PROBE, folder, month)], [true, false]);
  for (const [label, reply] of odd) {
    is(`${label}, the mark another run's: not written to again`, await wordWith("1", [{ when: settingTold, reply }]), false);
    is(`${label}, nothing readable after: unknown, not written to`, await wordWith(null, [{ when: settingTold, reply }, { when: readingTold, reply: [] }]), false);
    is(`${label}, our write landed: written to once`, await wordWith(null, [{ when: settingTold, reply, pass: true }]), true);
  }

  part("the common path: one round trip");
  let asked = 0;
  rules = [];
  await pipeline([["DEL", told]]);
  rules = [{ when: () => { asked += 1; return false; }, reply: null }];
  const first = await firstWordOf(PROBE, folder, month);
  const again = await firstWordOf(PROBE, folder, month);
  rules = [];
  is("free and taken each take one command to Redis", [first, again, asked], [true, false, 2]);

  console.error = error;
  done();
}

void main();
