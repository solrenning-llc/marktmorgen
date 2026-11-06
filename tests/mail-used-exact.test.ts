/**
 * The month's list-email count read in its exact shape (CX-123 rule 24; proof
 * 058e19e8, tests/sweep-m-r-mail-used.proof.ts on PR #2949).
 *
 * lib/mail.ts usedThisMonth read the count as `Number(raw) || 0`, so a GET
 * reply that was missing, an error string or of another shape read as "no
 * emails used": createBroadcast (lib/broadcasts.ts) then wrote down and started
 * an email past what was left of the plan's month, and the studio's email page
 * showed 0 used. Only a confirmed absent key (null) is 0 used; a whole-number
 * string is its value; anything else throws UnknownReplyError, createBroadcast
 * writes nothing, and the studio says the count could not be read.
 *
 * Synthetic data only; no email is sent (fetch answers 404).
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { createBroadcast, listBroadcastsStrict } from "@/lib/broadcasts";
import { monthlyAllowance, usedThisMonth } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "mail-used-exact@example.test";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "mailusedexact", "Mail Used Exact", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_MailUsedExact01", subscriptionId: "sub_MailUsedExact01", active: true, tier: "scale", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Mail Used Exact", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  for (let i = 0; i < 30; i += 1) await upsertContact(listId, `reader${i}@example.test`, { agreed: true, explicit: true, source: "free" }, ROOM);
  const window = windowId(store)!;
  const used = `nl:mail:used:${listId}:${window}`;
  const allowance = monthlyAllowance(store);
  const send = () => createBroadcast(store, { subject: "The plan is here", body: "It is ready.", productId: "", notProductId: "", sendAt: undefined });
  const written = async () => (await listBroadcastsStrict(listId)).length;
  const readUsed = async (): Promise<unknown> => {
    try { return await usedThisMonth(listId, window); } catch (error) { return `threw ${(error as Error).name}`; }
  };

  part("Control: the count read as it is kept");
  redis.run(["SET", used, String(allowance - 10)]);
  is("a kept count is its value", await readUsed(), allowance - 10);
  const refused = await send();
  is("thirty readers, ten emails left: refused", refused.ok ? "made" : refused.reason, "allowance");
  is("nothing written down", await written(), 0);
  redis.run(["SET", used, "0"]);
  is("a kept 0 is 0", await readUsed(), 0);

  const pipe = redis.pipeline.bind(redis);
  const hole: unknown[] = [];
  hole.length = 1;
  const shapes: [string, unknown][] = [
    ["no reply for the GET", []],
    ["two replies for one GET", [null, null]],
    ["a hole where the reply goes", hole],
    ["a Proxy of [null]", new Proxy([null], {})],
    ["not a list", { 0: null, length: 1 }],
    ["an error string", ["ERR wrong kind of value"]],
    ["an object", [{ used: 990 }]],
    ["a number, not a string", [990]],
    ["an empty string", [""]],
    ["a negative count", ["-3"]],
    ["a fraction", ["1.5"]],
    ["digits with a tail", ["12abc"]],
    ["a leading zero", ["007"]],
    ["past a safe integer", ["9007199254740993"]],
  ];
  redis.run(["SET", used, String(allowance - 10)]);
  for (const [name, reply] of shapes) {
    part(`The count's reply is ${name}`);
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === used ? (reply as unknown[]) : pipe(commands)) as typeof redis.pipeline;
    is("usedThisMonth throws UnknownReplyError, never 0", await readUsed(), "threw UnknownReplyError");
    const made = await send().catch((error: Error) => ({ ok: false as const, reason: `threw ${error.name}` }));
    is("the email is refused", made.ok ? "made" : made.reason, "threw UnknownReplyError");
    redis.pipeline = pipe as typeof redis.pipeline;
    is("nothing written down past the month", await written(), 0);
  }

  part("Control: a confirmed absent count is none used");
  redis.run(["DEL", used]);
  is("an absent key is 0", await readUsed(), 0);
  const made = await send();
  is("thirty readers fit a fresh month: written down", made.ok, true);
  is("one email written down", await written(), 1);

  part("The studio's email page");
  const page = readFileSync("app/studio/email/page.tsx", "utf8");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the page takes an unknown count as unknown (null), never 0", page.includes("usedThisMonth(store.listId, windowId(store)).catch(() => null),"), true);
  is("the studio's prop is a count or null", studio.includes("  used: number | null;"), true);
  is("the This month card says the count could not be read", studio.includes("This month's count could not be read"), true);
  is("no count before sending is said from an unknown count", studio.includes("month={props.monthKnown && props.used !== null ? { used: props.used, allowance: props.allowance } : null}"), true);
  done();
}

void main();
