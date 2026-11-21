/**
 * PROOF (MEDIUM, CX-123 rule 24), outside the CI run: lib/mail.ts usedThisMonth
 * reads the month's list-email count as `Number(raw) || 0`, so a GET reply that
 * is missing, an error string or of another shape reads as "no emails used".
 * createBroadcast (lib/broadcasts.ts) decides from it whether an email that
 * starts now fits what is left of the plan's month: with ten left for thirty
 * readers it is refused ("allowance"), but with the count's reply unknown it is
 * written down and started. The studio's email page shows the same 0 as used.
 *
 * Each check states the exact behaviour (unknown is not 0); every one fails on
 * main today. Synthetic data only; no email is sent (fetch answers 404).
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { createBroadcast } from "@/lib/broadcasts";
import { monthlyAllowance, usedThisMonth } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "sweep-mail-used@example.test";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "sweepmailused", "Sweep Mail Used", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_SweepMail01", subscriptionId: "sub_SweepMail01", active: true, tier: "scale", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Sweep Mail Used", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  for (let i = 0; i < 30; i += 1) await upsertContact(store.listId as string, `reader${i}@example.test`, { agreed: true, explicit: true, source: "free" }, ROOM);
  const window = windowId(store)!;
  const used = `nl:mail:used:${store.listId}:${window}`;
  // What is really kept: ten emails left in the plan's month.
  redis.run(["SET", used, String(monthlyAllowance(store) - 10)]);
  const send = () => createBroadcast(store, { subject: "The plan is here", body: "It is ready.", productId: "", notProductId: "", sendAt: undefined });

  part("Control: the count read as it is kept");
  const refused = await send();
  is("thirty readers, ten emails left: refused", refused.ok ? "made" : refused.reason, "allowance");

  const pipe = redis.pipeline.bind(redis);
  for (const [name, reply] of [
    ["no reply for the GET", []],
    ["an error string", ["ERR wrong kind of value"]],
    ["an object", [{ used: 990 }]],
  ] as const) {
    part(`The count's reply is ${name}`);
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === used ? (reply as unknown as unknown[]) : pipe(commands)) as typeof redis.pipeline;
    let read: unknown;
    try { read = await usedThisMonth(store.listId, window); } catch (error) { read = `threw ${(error as Error).name}`; }
    is("usedThisMonth says it cannot tell, never 0", read === 0 ? 0 : "not 0", "not 0");
    const made = await send().catch(() => ({ ok: false as const, reason: "threw" }));
    is("the email is not written down and started past the month", made.ok ? "made" : "not made", "not made");
    redis.pipeline = pipe as typeof redis.pipeline;
  }
  done();
}

void main();
