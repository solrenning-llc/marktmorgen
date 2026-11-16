/**
 * A person's agreements are erased exactly (CX-123 rules 24 and 30;
 * lib/agreement-store.ts, forgetAgreementsPerson).
 *
 * The person's set (nl:agree:p:<sid>:<person>) is the only way to find their
 * agreements (name, email, every version's text, signatures). On a reply of
 * another shape to that set, the erasure used to read "no agreements",
 * delete the set and answer 0: the agreements stayed, orphaned, and a retried
 * erasure could no longer find them. Now:
 *
 *   - the set's read must be exact, or the erasure throws before anything is
 *     deleted (lib/person-erasure.ts then says it is not finished, and the
 *     person can press again);
 *   - the agreements are deleted first, and every count is checked; only then
 *     is the person's set deleted, so a retry still finds everything;
 *   - only an exact empty set means nothing to erase.
 *
 * Rule 30: the person's data copy (lib/person-copy.ts) reads a version's text
 * exactly too: a reply of another shape fails the copy instead of handing it
 * over with the text silently missing.
 *
 * Synthetic only: the Redis stand-in, with one reply at a time made
 * malformed, and a fetch stub.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft, type AgreementDraft } from "@/lib/agreement-rules";
import { agreementKeys, createAgreement, forgetAgreementsPerson, listAgreements, readAgreement, reviseAgreement } from "@/lib/agreement-store";
import { ERASERS, erasureScope } from "@/lib/person-erasure";
import { COPIERS } from "@/lib/person-copy";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Commands = (string | number)[][];
type Pipeline = (commands: Commands) => Promise<unknown[]>;
const realPipeline: Pipeline = redis.pipeline.bind(redis);
const setPipeline = (next: Pipeline) => {
  (redis as unknown as { pipeline: Pipeline }).pipeline = next;
};

const CLIENT = "client@example.com";
const OTHER = "other@example.com";

function draftFor(email: string, name: string, title: string): AgreementDraft {
  const read = readDraft({ kind: "agreement", email, name, title, body: "Twelve calls.", lines: [], consent: true }, "usd");
  if (!("draft" in read)) throw new Error("draft did not read");
  return read.draft;
}

async function freshStore(): Promise<Store> {
  redis.clear();
  const owner = "agree-erase@example.com";
  await claimHandle(owner, "agreeerase", "Erase Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1AgrErasexxxx", true);
  await setSubscription(owner, { customerId: "cus_agreeerase", subscriptionId: "sub_agreeerase", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function make(store: Store, email: string, name: string, title: string, now: number): Promise<string> {
  const made = await createAgreement(store, draftFor(email, name, title), now);
  if (!made.ok) throw new Error(made.message);
  return made.agreement.id;
}

const personKeys = () => [...redis.keys()].filter((k) => k.startsWith("nl:agree:p:"));
const storeIndexIds = async (store: Store) => ((await redis.pipeline([["ZREVRANGE", `nl:agree:s:${store.sid}`, 0, -1]]))[0] as string[]).slice().sort();
const keysOf = (id: string) => agreementKeys(id).filter((k) => redis.keys().includes(k));

async function outcome(run: () => Promise<number>): Promise<string> {
  try {
    return `answered ${await run()}`;
  } catch {
    return "threw";
  }
}

/** Answers the first SMEMBERS of a person's set with `reply`, without running anything. */
function oddMembers(reply: unknown[]): void {
  let odd = true;
  setPipeline(async (commands) => {
    if (odd && commands.length === 1 && commands[0][0] === "SMEMBERS" && String(commands[0][1]).startsWith("nl:agree:p:")) {
      odd = false;
      return reply;
    }
    return realPipeline(commands);
  });
}

async function main(): Promise<void> {
  const now = Date.now();

  for (const [label, reply] of [
    ["undefined", [undefined]],
    ["a string", ["0123456789abcdef0123456789abcdef"]],
    ["a list holding a number", [[42]]],
    ["no reply at all", []],
  ] as const) {
    part(`forgetAgreementsPerson: the person's set answers in another shape (${label})`);
    const store = await freshStore();
    const id = await make(store, CLIENT, "Dana Reyes", "Coaching", now);
    oddMembers(reply as unknown as unknown[]);
    const said = await outcome(() => forgetAgreementsPerson(store.sid!, CLIENT));
    setPipeline(realPipeline);
    is("an unknown reply is never 'no agreements': the erasure throws (not done)", said, "threw");
    is("the person's set is kept, so a retry finds the agreement", personKeys().length, 1);
    is("nothing was deleted: the record and its version stay", [(await readAgreement(id)) !== null, keysOf(id).length], [true, 2]);
    const retry = await forgetAgreementsPerson(store.sid!, CLIENT);
    is("a retry with Redis answering normally erases the agreement, its version and the person's set", [retry, (await readAgreement(id)) === null, keysOf(id).length, personKeys().length], [1, true, 0, 0]);
  }

  part("forgetAgreementsPerson: the deletes' replies are lost (nothing ran)");
  {
    const store = await freshStore();
    const id = await make(store, CLIENT, "Dana Reyes", "Coaching", now);
    let lost = true;
    setPipeline(async (commands) => {
      if (lost && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:fenced-del:v1") && c.some((x) => String(x).startsWith("nl:agree:r:")))) {
        lost = false;
        return [undefined];
      }
      return realPipeline(commands);
    });
    const said = await outcome(() => forgetAgreementsPerson(store.sid!, CLIENT));
    setPipeline(realPipeline);
    is("deletes that may not have happened are never 'done': the erasure throws", said, "threw");
    is("the person's set and the agreement are kept for the retry", [personKeys().length, (await readAgreement(id)) !== null], [1, true]);
    const retry = await forgetAgreementsPerson(store.sid!, CLIENT);
    is("the retry erases everything", [retry, (await readAgreement(id)) === null, personKeys().length], [1, true, 0]);
  }

  part("forgetAgreementsPerson: the deletes ran but a reply came back in another shape");
  {
    const store = await freshStore();
    const id = await make(store, CLIENT, "Dana Reyes", "Coaching", now);
    let cut = true;
    setPipeline(async (commands) => {
      const replies = await realPipeline(commands);
      if (cut && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:fenced-del:v1") && c.some((x) => String(x).startsWith("nl:agree:r:")))) {
        cut = false;
        return replies.map((r, i) => (i === 0 ? "OK" : r));
      }
      return replies;
    });
    const said = await outcome(() => forgetAgreementsPerson(store.sid!, CLIENT));
    setPipeline(realPipeline);
    is("a count that does not read is never 'done': the erasure throws", said, "threw");
    is("the person's set is not deleted on an unconfirmed delete, so a retry still finds the id", personKeys().length, 1);
    is("the agreement itself is gone (the delete ran)", (await readAgreement(id)) === null, true);
    const retry = await forgetAgreementsPerson(store.sid!, CLIENT);
    is("the retry confirms the counts and deletes the person's set", [retry, personKeys().length], [1, 0]);
  }

  part("forgetAgreementsPerson: the person's set's own delete answers in another shape");
  {
    const store = await freshStore();
    await make(store, CLIENT, "Dana Reyes", "Coaching", now);
    let odd = true;
    setPipeline(async (commands) => {
      if (odd && commands.length === 1 && commands[0][0] === "DEL" && String(commands[0][1]).startsWith("nl:agree:p:")) {
        odd = false;
        return [null];
      }
      return realPipeline(commands);
    });
    const said = await outcome(() => forgetAgreementsPerson(store.sid!, CLIENT));
    setPipeline(realPipeline);
    is("an unknown reply to the set's delete is never 'done': the erasure throws", said, "threw");
    is("the retry still finds the id the set lists, and finishes", await forgetAgreementsPerson(store.sid!, CLIENT), 1);
    is("and nothing of the person is left", personKeys().length, 0);
  }

  part("Control: an exact empty set is the only 'nothing to erase'");
  {
    const store = await freshStore();
    const other = await make(store, OTHER, "Sam Lee", "Other", now);
    is("a person with no agreements: answered 0, no throw", await outcome(() => forgetAgreementsPerson(store.sid!, CLIENT)), "answered 0");
    is("someone else's agreement is untouched", [(await readAgreement(other)) !== null, personKeys().length], [true, 1]);
  }

  part("Control: healthy agreements are fully erased, someone else's stay");
  {
    const store = await freshStore();
    const first = await make(store, CLIENT, "Dana Reyes", "Coaching", now);
    const second = await make(store, CLIENT, "Dana Reyes", "Workshop", now + 1_000);
    const other = await make(store, OTHER, "Sam Lee", "Other", now + 2_000);
    const revised = await reviseAgreement(store, first, draftFor(CLIENT, "Dana Reyes", "Coaching, second version"), now + 3_000);
    if (!revised.ok) throw new Error(revised.message);
    is("before: the first agreement has two versions", keysOf(first).length, 3);
    is("the erasure answers both of the person's agreements", await forgetAgreementsPerson(store.sid!, CLIENT), 2);
    is("their records and every version are gone", [(await readAgreement(first)) === null, (await readAgreement(second)) === null, keysOf(first).length, keysOf(second).length], [true, true, 0, 0]);
    is("the store's index keeps only the other person's", await storeIndexIds(store), [other]);
    is("the person's set is gone, the other person's stays", personKeys().length, 1);
    is("the other person's agreement is untouched", [(await readAgreement(other)) !== null, keysOf(other).length], [true, 2]);
    is("a second erasure finds nothing and answers 0", await forgetAgreementsPerson(store.sid!, CLIENT), 0);
  }

  part("lib/person-erasure.ts runs it, and a throw is not finished");
  {
    const store = await freshStore();
    const id = await make(store, CLIENT, "Dana Reyes", "Coaching", now);
    const eraser = ERASERS.find((e) => e.module === "lib/agreement-store.ts");
    is("the erasure has an agreement step", Boolean(eraser), true);
    const scope = (await erasureScope(store, CLIENT))!;
    oddMembers([undefined]);
    const said = await outcome(async () => (await eraser!.run(scope, [], new Set())) as number);
    setPipeline(realPipeline);
    is("the step throws, which erasePerson records as failed (incomplete)", said, "threw");
    is("and the retry erases", [await eraser!.run(scope, [], new Set()), (await readAgreement(id)) === null], [1, true]);
  }

  part("Rule 30: the person's data copy reads each version's text exactly");
  {
    const store = await freshStore();
    const id = await make(store, CLIENT, "Dana Reyes", "Coaching", now);
    const scope = (await erasureScope(store, CLIENT))!;
    const copier = COPIERS["lib/agreement-store.ts"];
    const healthy = (await copier(scope)) as { versions: { text?: string }[] }[];
    is("healthy: the copy holds the version's text", [healthy.length, typeof healthy[0]?.versions[0]?.text], [1, "string"]);
    let odd = true;
    setPipeline(async (commands) => {
      if (odd && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith(`nl:agree:v:${id}:`)) {
        odd = false;
        return [42];
      }
      return realPipeline(commands);
    });
    let copied: string;
    try {
      const records = (await copier(scope)) as { versions: { text?: string }[] }[];
      copied = typeof records[0]?.versions[0]?.text === "string" ? "with text" : "without text";
    } catch {
      copied = "threw";
    }
    setPipeline(realPipeline);
    is("a version's text that reads in another shape fails the copy, never drops the text", copied, "threw");
    is("the studio's list still reads", (await listAgreements(store))?.length, 1);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
