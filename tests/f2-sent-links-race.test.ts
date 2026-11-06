/**
 * Two changes to one sent email's links at the same moment (124
 * [F2-EDIT-SENT-LINKS]; Codex P, review 5808315232, and Codex J, review
 * 5808324331, on #3034): a change the creator was told was saved is never
 * lost.
 *
 * Both reviews found changeLink reading the whole history (GET), adding to
 * it in memory and writing it back over whatever was there (SET): two
 * requests that read the same history both answered "saved", and the
 * second write left only its own change. Here two (and three) real
 * changeLink calls read the same history, held at a barrier on the read,
 * against the in-memory Redis double, with synthetic stores only (no email,
 * no provider, no account):
 *
 *   - every change answered "saved" is in the history kept, and the history
 *     holds no change that was not answered "saved";
 *   - a change that is not saved says so (a refusal with words), never a
 *     success;
 *   - where each link goes now is the last change kept for it;
 *   - the data room counts at least what the history keeps.
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { SITE_URL } from "@/lib/site-url";
import { currentOf, linksOf } from "@/lib/sent-link-rules";
import { type SentEmail, changeLink, readSentLinks, sentLinkKey } from "@/lib/sent-links";
import { dataUsed } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const home = `${SITE_URL}/@harbor`;

type Outcome = { ok: true; n: number; to: string } | { ok: false; n: number; to: string; why: string };

/**
 * Holds the next `count` reads of `key` (a pipeline that is exactly one GET of it) until all of them have
 * arrived, so each request reads the same history before any writes. Later reads pass straight through.
 */
function barrierOnRead(key: string, count: number): () => void {
  const original = redis.pipeline.bind(redis);
  let waiting: (() => void)[] = [];
  let left = count;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const isRead = commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key;
    if (isRead && left > 0) {
      left -= 1;
      const answer = await original(commands);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === count) {
          const all = waiting;
          waiting = [];
          for (const go of all) go();
        }
      });
      return answer;
    }
    return original(commands);
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = original as typeof redis.pipeline;
  };
}

async function attempt(store: NonNullable<Awaited<ReturnType<typeof storeForEmail>>>, email: SentEmail, n: number, to: string): Promise<Outcome> {
  try {
    const answer = await changeLink(store, email, n, to);
    if (answer.ok) return { ok: true, n, to };
    return { ok: false, n, to, why: `${answer.reason}:${answer.message.length > 10 ? "said" : "silent"}` };
  } catch (error) {
    return { ok: false, n, to, why: `threw:${error instanceof Error ? error.name : "unknown"}` };
  }
}

/** Every change answered "saved" is kept, nothing unanswered is, and what is not saved says so in words. */
async function check(what: string, email: SentEmail, before: number, outcomes: Outcome[]): Promise<void> {
  const kept = await readSentLinks(email.id);
  const changes = kept?.changes ?? [];
  const added = changes.slice(before);
  const saved = outcomes.filter((o) => o.ok);
  is(`${what}: every change answered "saved" is in the history kept`, saved.map((o) => added.some((c) => c.n === o.n && c.to === o.to)), saved.map(() => true));
  is(`${what}: the history holds only changes answered "saved"`, added.length, saved.length);
  is(`${what}: at least one of them is saved`, saved.length > 0, true);
  const refused = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
  is(`${what}: a change not saved says so in words, never as a success`, refused.map((o) => /^[a-z]+:said$/.test(o.why) && !o.why.startsWith("threw")), refused.map(() => true));
  for (const o of saved) {
    const last = [...added].reverse().find((c) => c.n === o.n);
    is(`${what}: link ${o.n} goes where its last kept change says`, currentOf(changes, o.n), last?.to ?? null);
  }
  const used = await dataUsed(store());
  is(`${what}: the data room counts at least what the history keeps`, used !== null && used.used >= dataBytes(JSON.stringify(kept), 1), true);
}

let harbor: NonNullable<Awaited<ReturnType<typeof storeForEmail>>> | null = null;
const store = () => harbor!;

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Race000001", subscriptionId: "sub_Race000001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  harbor = (await storeForEmail(OWNER))!;

  const body = [`Our plan: ${home}/p/plan`, "Watch: https://youtube.com/watch?v=1", "[Join the call](https://zoom.us/j/1)"].join("\n\n");
  is("the email has three links that can be changed", linksOf(body).length, 3);
  const email = (id: string): SentEmail => ({ id, listId: harbor!.listId!, handle: harbor!.handle, body, sent: 2, links: true });

  part("Two changes to different links of an email never changed before, read at the same moment");
  {
    const e = email("a".repeat(24));
    const release = barrierOnRead(sentLinkKey(e.id), 2);
    const outcomes = await Promise.all([attempt(harbor, e, 1, "https://youtube.com/watch?v=2"), attempt(harbor, e, 2, "https://zoom.us/j/2")]);
    release();
    await check("first record", e, 0, outcomes);
  }

  part("Two changes to one link of an email already changed, read at the same moment");
  {
    const e = email("b".repeat(24));
    is("one change made before", (await changeLink(harbor, e, 1, "https://youtube.com/watch?v=5")).ok, true);
    const release = barrierOnRead(sentLinkKey(e.id), 2);
    const outcomes = await Promise.all([attempt(harbor, e, 1, "https://youtube.com/watch?v=6"), attempt(harbor, e, 1, "https://youtube.com/watch?v=7")]);
    release();
    await check("kept record", e, 1, outcomes);
  }

  part("Three changes at the same moment");
  {
    const e = email("c".repeat(24));
    is("one change made before", (await changeLink(harbor, e, 2, "https://zoom.us/j/5")).ok, true);
    const release = barrierOnRead(sentLinkKey(e.id), 3);
    const outcomes = await Promise.all([
      attempt(harbor, e, 0, `${home}/p/other`),
      attempt(harbor, e, 1, "https://youtube.com/watch?v=8"),
      attempt(harbor, e, 2, "https://zoom.us/j/6"),
    ]);
    release();
    await check("three at once", e, 1, outcomes);
  }

  done();
}

void main();
