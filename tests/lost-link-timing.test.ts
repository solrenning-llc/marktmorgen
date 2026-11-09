/**
 * Asking for a way back in, or for a course link, takes the same time and
 * gets the same answer whoever the address is (Claude 5's authentication
 * audit, L1).
 *
 * /api/auth/lost answers the same page for every address, but it waited for
 * two emails only when the address had an account with a recovery address:
 * with a provider taking 300 ms a send, the answer came ~600 ms later, and the
 * time told who is a customer. Its sibling (rule 30): a course's "email me a
 * link" waited for the email only when the address had bought the course, and
 * answered "error" only to a buyer whose link could not be sent. The owner's
 * decision (Claude 1, 9 November 2026, 15h42, option A): the same quick
 * answer for buyer and stranger, on a sent link, a failed send or an unknown
 * read alike, which says to try again if nothing arrives; the read and the
 * send come after the answer, tried again on the server, and logged without
 * the address. What does not depend on the address (no Redis, mail known
 * down, a mistyped address, the limits) is still answered as it is.
 *
 * Now the work that depends on the address runs after the answer is sent
 * (next/server after(), held here by tests/next-server-after-world.ts), and is
 * checked to still be done once it runs.
 */
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { POST as lostRoute } from "@/app/api/auth/lost/route";
import { keepRecoveryAddress } from "@/lib/recovery-address";
import { requestCourseLink } from "@/lib/learn";
import { readProduct } from "@/lib/catalog";
import { grantImported } from "@/lib/imported-purchases";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import { addProduct, claimHandle, ensureStatsId, setPastBuyers, setProductCourse, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const SLOW_MS = 300;
/** Sends the provider refuses next (a 500 each), before it accepts again. */
let refuseNext = 0;
// A provider that takes SLOW_MS to accept each email, then accepts it as SES does.
const mail = installSesMailFixture({
  onSes: async () => {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    if (refuseNext > 0) {
      refuseNext -= 1;
      return new Response("unavailable", { status: 500 });
    }
    return Response.json({ MessageId: "slow-provider" });
  },
});
/** While true, the courses written down for an address answer in a shape that is not theirs (an unknown read). */
let brokenLedger = false;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await pipeline(commands);
  if (!brokenLedger) return replies;
  return replies.map((reply, i) => (commands[i]?.[0] === "HGETALL" && String(commands[i]?.[1]).startsWith("nl:learn:enr:") ? ["odd"] : reply));
}) as typeof redis.pipeline;
mail.configure();
const ORIGIN = "https://marktmorgen.com";
let net = 1;
const ask = (email: string) =>
  new NextRequest(`${ORIGIN}/api/auth/lost`, {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${net++}` },
    body: new URLSearchParams({ email }),
  });
async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t = performance.now();
  const value = await work();
  return { ms: performance.now() - t, value };
}
/** Runs what the routes left for after their answer, as Next does once the answer is sent. */
async function runAfter(): Promise<void> {
  const tasks = afterTasks.splice(0);
  for (const task of tasks) if (typeof task === "function") await (task as () => Promise<unknown>)();
}

async function main(): Promise<void> {
  redis.clear();

  part("A link to the recovery address: the same answer, in the same time");
  await keepRecoveryAddress("has@lost-timing.example", "backup@lost-timing.example");
  const known = await timed(() => lostRoute(ask("has@lost-timing.example")));
  const unknown = await timed(() => lostRoute(ask("nobody@lost-timing.example")));
  console.log(`  (with a recovery address: ${known.ms.toFixed(0)} ms; no account: ${unknown.ms.toFixed(0)} ms)`);
  is("the same page", known.value.headers.get("location"), unknown.value.headers.get("location"));
  is("the time does not depend on the address having an account (under 150 ms apart)", Math.abs(known.ms - unknown.ms) < 150, true);
  const before = mail.sent.length;
  await runAfter();
  const sent = mail.sent.slice(before).map((m) => m.to[0]);
  is("once the answer is sent, the link goes to the recovery address and the notice to the account", [sent.includes("backup@lost-timing.example"), sent.includes("has@lost-timing.example"), sent.length], [true, true, 2]);

  part("A course link (rule 30): the same answer, in the same time, whether or not the address bought it");
  const owner = "school@lost-timing.example";
  await claimHandle(owner, "lost-timing-school", "Timing School", "");
  await ensureStatsId(owner);
  await setPastBuyers(owner);
  const made = await addProduct(owner, "Original course", "Original summary", "49", null);
  if (!made.ok) throw new Error("product");
  await setProductCourse(owner, made.product.id, { id: "c".repeat(32), lessons: 1 });
  const stored = (await storeForEmail(owner))!;
  const product = (await readProduct(stored, made.product.id))!;
  const buyer = "buyer@lost-timing.example";
  await grantImported(stored.statsId!, "b".repeat(24), [{ email: buyer, productId: product.id, items: null }], 1793293200, stored.sid);
  const paidStore = { ...stored, subscriptionActive: true, subscriptionId: null, trialEnds: 0, planEndedAt: "", tier: "pro" as const };
  let ip = 20;
  const asked = (email: string) => timed(() => requestCourseLink({ store: paidStore, product, email, ip: `192.0.2.${ip++}`, origin: ORIGIN }).catch(() => "thrown"));
  /** Runs what was left for after the answer, with what it logged. */
  const runLogged = async (): Promise<string> => {
    const lines: string[] = [];
    const error = console.error;
    console.error = (...parts: unknown[]) => void lines.push(parts.map((p) => (p instanceof Error ? `${p.name}: ${p.message}` : String(p))).join(" "));
    try {
      await runAfter();
    } finally {
      console.error = error;
    }
    return lines.join("\n");
  };
  const cases: [string, () => void, () => void][] = [
    ["a link that is sent", () => undefined, () => undefined],
    ["a send the provider refuses, every time", () => void (refuseNext = 1_000), () => void (refuseNext = 0)],
    ["purchases that cannot be read", () => void (brokenLedger = true), () => void (brokenLedger = false)],
  ];
  for (const [label, on, off] of cases) {
    on();
    const bought = await asked(buyer);
    const notBought = await asked(`stranger${ip}@lost-timing.example`);
    const logged = await runLogged();
    off();
    console.log(`  (${label}: bought ${bought.ms.toFixed(0)} ms, ${bought.value}; not bought ${notBought.ms.toFixed(0)} ms, ${notBought.value})`);
    is(`${label}: the same answer for a buyer and a stranger, "sent"`, [bought.value, notBought.value], ["sent", "sent"]);
    is(`${label}: in the same time (under 150 ms apart)`, Math.abs(bought.ms - notBought.ms) < 150, true);
    is(`${label}: what was logged after it never names an address`, /@/.test(logged), false);
  }
  is("the page says to try again if nothing arrives", /try again/i.test(COURSES_WORDS.en.linkNotices.sent.body), true);

  part("A course link is sent after the answer, tried again on the server when the first send fails");
  const beforeCourse = mail.sent.length;
  await asked(buyer);
  await asked("nobody-bought@lost-timing.example");
  refuseNext = 1;
  await runLogged();
  refuseNext = 0;
  is("only the buyer gets the link, on the second try", mail.sent.slice(beforeCourse).filter((m) => /course/i.test(m.subject ?? "")).map((m) => m.to[0]), [buyer]);
  is("what does not depend on the address is still said: a mistyped address", (await asked("not-an-address")).value, "email");

  done();
}

void main();
