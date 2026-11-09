/**
 * Asking for a way back in takes the same time whoever the address is
 * (Claude 5's authentication audit, L1).
 *
 * /api/auth/lost answers the same page for every address, but it waited for
 * two emails only when the address had an account with a recovery address:
 * with a provider taking 300 ms a send, the answer came ~600 ms later, and the
 * time told who is a customer. (Its sibling, a course's "email me a link",
 * is left for a decision: #3376 answers "error" to a buyer whose link was
 * not sent, which an answer before the send cannot do.)
 *
 * Now the work that depends on the address runs after the answer is sent
 * (next/server after(), held here by tests/next-server-after-world.ts), and is
 * checked to still be done once it runs.
 */
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { POST as lostRoute } from "@/app/api/auth/lost/route";
import { keepRecoveryAddress } from "@/lib/recovery-address";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const SLOW_MS = 300;
// A provider that takes SLOW_MS to accept each email, then accepts it as SES does.
const mail = installSesMailFixture({
  onSes: async () => {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    return Response.json({ MessageId: "slow-provider" });
  },
});
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

  done();
}

void main();
