/**
 * The unsubscribe link of an email to the list is made in lib/contacts.ts
 * tokensFor, read at the moment each batch goes (lib/mail.ts sendTo). Rule 24
 * (CX-123): an unknown or off-shape Redis reply is never read as success,
 * never as "nobody here" and never as "not written".
 *
 *   - The token's own record (nl:mail:unsub:<token>) is what makes the link
 *     work. Written with an unknown answer, it may not exist: the token must
 *     not be handed out, nor kept on the contact, where every later email to
 *     that person would carry a link and a one-click header leading nowhere.
 *   - The contacts read back in an unknown shape is unknown, never "everyone
 *     left the list".
 *   - A contact write whose answer was lost and whose read-back came back in
 *     an unknown shape is unknown, never "not written": the token record
 *     must not be deleted while the contact may already hold the token.
 *   - In a broadcast, a batch whose tokens could not be read is not counted
 *     as gone: nobody is skipped for good, nothing is written to anyone, and
 *     the next run sends it with working links.
 */
import { advanceBroadcast } from "@/lib/broadcasts";
import { windowId } from "@/lib/allowance-window";
import { usedThisMonth } from "@/lib/mail";
import { claimHandle, ensureListId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { leadsKey, readUnsubToken, tokenKey, tokensFor, upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
let trap: ((commands: Commands) => Promise<unknown[]> | null) | null = null;
(redis as { pipeline: (commands: Commands) => Promise<unknown[]> }).pipeline = (commands: Commands) => {
  const caught = trap?.(commands);
  return caught ?? real(commands);
};

async function contactToken(listId: string, email: string): Promise<string> {
  const [raw] = await real([["HGET", leadsKey(listId), email]]);
  return typeof raw === "string" ? (JSON.parse(raw) as { t?: string }).t ?? "" : "";
}
async function recordThere(token: string): Promise<boolean> {
  const [n] = await real([["EXISTS", tokenKey(token)]]);
  return n === 1;
}
async function outcome(run: () => Promise<Map<string, string>>): Promise<Map<string, string> | "threw"> {
  try {
    return await run();
  } catch {
    return "threw";
  }
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "tokens@example.com";
  await claimHandle(owner, "tokens", "Token Shop", "");
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_Tokens00001", subscriptionId: "sub_Tokens00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Token Shop", address: "4 Paper Lane, Boston, MA 02108" });
  const store = (await storeForEmail(owner))!;
  const listId = store.listId!;

  part("The token record's write answers in an unknown shape");
  await upsertContact(listId, "one@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  trap = (commands) => (commands.length > 0 && commands.every((c) => c[0] === "SET" && String(c[1]).startsWith("nl:mail:unsub:")) ? Promise.resolve([]) : null);
  const first = await outcome(() => tokensFor(listId, ["one@example.com"], store.handle));
  trap = null;
  const handed = first === "threw" ? "" : first.get("one@example.com") ?? "";
  is("no token is handed out whose record may not exist", handed === "" || (await readUnsubToken(handed)) !== null, true);
  const kept = await contactToken(listId, "one@example.com");
  is("the contact keeps no token whose link leads nowhere", kept === "" || (await recordThere(kept)), true);
  const again = await tokensFor(listId, ["one@example.com"], store.handle);
  is("once Redis answers, the address gets a working link", (await readUnsubToken(again.get("one@example.com") ?? ""))?.email, "one@example.com");

  part("The contacts are read back in an unknown shape");
  await upsertContact(listId, "two@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  for (const shape of [[null], ["not a list"], [[]]]) {
    trap = (commands) => (commands.length === 1 && commands[0][0] === "HMGET" && commands[0][1] === leadsKey(listId) ? Promise.resolve(shape) : null);
    const read = await outcome(() => tokensFor(listId, ["two@example.com"], store.handle));
    trap = null;
    is(`HMGET answering ${JSON.stringify(shape)} is unknown, never "everyone left"`, read, "threw");
  }

  part("A contact write whose answer was lost, read back in an unknown shape");
  await upsertContact(listId, "three@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  let evalRan = false;
  trap = (commands) => {
    if (commands.length === 1 && commands[0][0] === "EVAL") {
      // The script ran (its HSET landed: the in-memory Redis does not run this script, so the write is made here) and its answer was lost.
      evalRan = true;
      const [, , , hash, field, , value] = commands[0];
      return real([["HSET", hash, field, value]]).then(() => { throw new Error("Redis request failed with status 502"); });
    }
    if (evalRan && commands.length === 1 && commands[0][0] === "HMGET") return Promise.resolve([null]);
    return null;
  };
  await outcome(() => tokensFor(listId, ["three@example.com"], store.handle));
  trap = null;
  const landed = await contactToken(listId, "three@example.com");
  is("the write landed (the case under test)", landed.length, 40);
  is("its token record is not deleted on an unknown read-back", await recordThere(landed), true);

  part("A broadcast batch whose tokens cannot be read");
  const everyone = ["a@example.com", "b@example.com", "c@example.com"];
  for (const email of everyone) await upsertContact(listId, email, { agreed: true, explicit: true, source: "free" }, ROOM);
  process.env.RESEND_API_KEY = "re_test_contact_token_exact_only";
  const mail = installSesMailFixture();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  const id = "333333333333333333333333";
  const key = `nl:mail:bc:${id}`;
  const broadcast = { id, listId, handle: store.handle, subject: "New paper is in", body: "Fresh stock this week.", productId: null, notProductId: null, who: "all", narrow: null, status: "sending", createdAt: 100, sendAt: 100, finishedAt: 0, total: everyone.length, sent: 0, note: "", failures: 0, listed: true, tagged: true, test: null };
  await real([["SET", key, JSON.stringify(broadcast)], ["RPUSH", `${key}:to`, ...everyone], ["SADD", "nl:mail:queue", id]]);
  trap = (commands) => (commands.length === 1 && commands[0][0] === "HMGET" && commands[0][1] === leadsKey(listId) ? Promise.resolve([null]) : null);
  const cut = await advanceBroadcast(id, storeForHandle, Date.now() + 10_000).catch(() => null);
  trap = null;
  const [saved] = await real([["GET", key]]);
  const after = JSON.parse(String(saved)) as { status: string; sent: number };
  is("nothing was written to anyone", mail.ses.length, 0);
  is("no recipient is counted as gone, and it is not marked sent", [after.sent, after.status === "sent"], [0, false]);
  is("the run reports it as still going", cut === null || cut.status !== "sent", true);
  is("what was taken from the month for that batch is given back", await usedThisMonth(listId, windowId((await storeForHandle(store.handle))!)), 0);
  const next = await advanceBroadcast(id, storeForHandle, Date.now() + 10_000);
  is("the next run reaches everyone once", mail.ses.flatMap((m) => m.to).sort(), everyone);
  is("each with a working one-click link", mail.ses.every((m) => /\/api\/mail\/unsubscribe\?t=[0-9a-f]{40}>$/.test(m.headers?.["List-Unsubscribe"] ?? "")), true);
  is("and the broadcast completes", next?.status, "sent");

  mail.restore();
  done();
}

void main();
