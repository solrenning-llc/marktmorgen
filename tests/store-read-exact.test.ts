/**
 * A store's record is read exactly (CX-123 rule 24, lib/store.ts parseStore,
 * storeForEmail, storeForId): Redis's nil is "no store"; any other reply that
 * is not a store's JSON (no reply, a number, a list, text that is not JSON,
 * JSON that is not a store) is unknown and throws UnknownReplyError. It is
 * never "the store does not exist", which callers act on:
 *
 *   - claimHandle would make a fresh first store over the one kept;
 *   - settleAllPayPal would take the store off the PayPal settle set;
 *   - sendDueReminders would drop the request's reminder;
 *   - checkMember would answer "gone" and the Discord pass forget to retry.
 *
 * Healthy reads and confirmed absence (nil, a deleted store) stay as before.
 */
import { createHash } from "node:crypto";
import { claimHandle, ensureStoreId, storeForEmail, storeForHandle, storeForId } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { settleAllPayPal } from "@/lib/paypal-payouts";
import { sendDueReminders } from "@/lib/payment-requests";
import { checkMember } from "@/lib/discord-access";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "readexact@example.com";
const ownerKey = (email: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;

/** The reply GETs of `target` get instead of the real one; "drop" leaves the reply out. */
let reply: unknown = undefined;
let target = "";
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const real = await pipeline(commands);
  if (reply === undefined) return real;
  const at = commands.findIndex((c) => c[0] === "GET" && c[1] === target);
  if (at < 0) return real;
  if (reply === "drop") return real.filter((_, i) => i !== at);
  return real.map((r, i) => (i === at ? reply : r));
}) as typeof redis.pipeline;

/** What a promise came to: "unknown" for an UnknownReplyError, "threw" for any other error. */
async function outcome<T>(work: () => Promise<T>): Promise<T | "unknown" | "threw"> {
  try {
    return await work();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  }
}

const MALFORMED: [string, unknown][] = [
  ["no reply", "drop"],
  ["a number", 42],
  ["a list", ["{}"]],
  ["an empty string", ""],
  ["text that is not JSON", "{cut sh"],
  ["JSON null", "null"],
  ["a JSON list", "[1,2]"],
  ["JSON without the store's handle, name and address", '{"bio":"x"}'],
];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "readexact", "Read Exact", "");
  const sid = (await ensureStoreId(OWNER))!.sid;
  const record = (await pipeline([["GET", ownerKey(OWNER)]]))[0];

  part("healthy: the store is read");
  is("storeForEmail", (await storeForEmail(OWNER))?.handle, "readexact");
  is("storeForId", (await storeForId(sid))?.handle, "readexact");
  is("storeForHandle", (await storeForHandle("readexact"))?.handle, "readexact");

  part("a store's record in an unknown shape throws, never null");
  target = ownerKey(OWNER);
  for (const [label, bad] of MALFORMED) {
    reply = bad;
    const got = [await outcome(() => storeForEmail(OWNER)), await outcome(() => storeForId(sid)), await outcome(() => storeForHandle("readexact"))];
    reply = undefined;
    is(`${label}: storeForEmail, storeForId and storeForHandle say unknown`, got, ["unknown", "unknown", "unknown"]);
  }

  part("the id's own key in an unknown shape throws");
  target = `nl:store:id:${sid}`;
  for (const [label, bad] of [["no reply", "drop"], ["a number", 7], ["an empty string", ""]] as const) {
    reply = bad;
    is(`${label}: storeForId says unknown`, await outcome(() => storeForId(sid)), "unknown");
    reply = undefined;
  }

  part("claimHandle never makes a store over one it could not read");
  target = ownerKey(OWNER);
  reply = "{cut sh";
  const claimed = await outcome(() => claimHandle(OWNER, "readexacttwo", "Another", ""));
  reply = undefined;
  is("it says unknown", claimed, "unknown");
  is("the kept record is as it was", (await pipeline([["GET", ownerKey(OWNER)]]))[0] === record, true);
  is("and the other handle was not taken", (await pipeline([["GET", "nl:store:handle:readexacttwo"]]))[0], null);

  part("jobs keep what they could not read");
  await pipeline([["SADD", "nl:pp:stores", sid]]);
  reply = "{cut sh";
  await outcome(() => settleAllPayPal(Date.now() + 10_000));
  reply = undefined;
  is("settleAllPayPal: the store stays in the settle set", (await pipeline([["SISMEMBER", "nl:pp:stores", sid]]))[0], 1);
  const member = `${sid}|${"a".repeat(32)}`;
  await pipeline([["ZADD", "nl:payreq:due", "1", member]]);
  reply = "{cut sh";
  const reminders = await outcome(() => sendDueReminders(Date.now() + 10_000));
  reply = undefined;
  is("sendDueReminders: says unknown", reminders, "unknown");
  is("and the reminder is kept", (await pipeline([["ZSCORE", "nl:payreq:due", member]]))[0] !== null, true);
  reply = "{cut sh";
  is("checkMember: unknown, not gone", await outcome(() => checkMember(sid, "123456789012345678")), "unknown");
  reply = undefined;

  part("confirmed absence stays absence");
  is("an address with no store: null", await storeForEmail("nobody@example.com"), null);
  is("an id with no store: null", await storeForId("0123456789abcdef01234567".slice(0, sid.length)), null);
  is("a free handle: null", await storeForHandle("nosuchhandle"), null);
  await pipeline([["DEL", ownerKey(OWNER)]]);
  is("an id whose record was deleted: null", await storeForId(sid), null);
  is("checkMember of a store that is gone: gone", await checkMember(sid, "123456789012345678"), "gone");
  is("settleAllPayPal: a store that is gone leaves the settle set", [await settleAllPayPal(Date.now() + 10_000), (await pipeline([["SISMEMBER", "nl:pp:stores", sid]]))[0]], [0, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
