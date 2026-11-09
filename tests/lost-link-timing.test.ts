/**
 * Asking for a way back in, or for a course link, takes the same time whoever
 * the address is (Claude 5's authentication audit, L1).
 *
 * /api/auth/lost answers the same page for every address, but it waited for
 * two emails only when the address had an account with a recovery address:
 * with a provider taking 300 ms a send, the answer came ~600 ms later, and the
 * time told who is a customer. Its sibling (rule 30): a course's "email me a
 * link" waited for the email only when the address had bought the course.
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
import { addProduct, claimHandle, ensureStatsId, setPastBuyers, setProductCourse, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const SLOW_MS = 300;
const mail = installSesMailFixture({ onSes: async () => (await new Promise((r) => setTimeout(r, SLOW_MS)), undefined) });
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
  await grantImported(stored.statsId!, "b".repeat(24), [{ email: "buyer@lost-timing.example", productId: product.id, items: null }], 1793293200, stored.sid);
  const paidStore = { ...stored, subscriptionActive: true, subscriptionId: null, trialEnds: 0, planEndedAt: "", tier: "pro" as const };
  const bought = await timed(() => requestCourseLink({ store: paidStore, product, email: "buyer@lost-timing.example", ip: "192.0.2.21", origin: ORIGIN }));
  const notBought = await timed(() => requestCourseLink({ store: paidStore, product, email: "stranger@lost-timing.example", ip: "192.0.2.22", origin: ORIGIN }));
  console.log(`  (bought: ${bought.ms.toFixed(0)} ms; not bought: ${notBought.ms.toFixed(0)} ms)`);
  is("the same answer", [bought.value, notBought.value], ["sent", "sent"]);
  is("the time does not depend on the address having bought it (under 150 ms apart)", Math.abs(bought.ms - notBought.ms) < 150, true);
  const beforeCourse = mail.sent.length;
  await runAfter();
  is("once the answer is sent, only the buyer gets the link", mail.sent.slice(beforeCourse).map((m) => m.to[0]), ["buyer@lost-timing.example"]);
  done();
}

void main();
