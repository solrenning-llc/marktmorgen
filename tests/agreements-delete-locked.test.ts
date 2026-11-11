/**
 * Deleting an agreement from the studio (lib/agreement-store.ts, deleteAgreement) under the agreement's lock, as a
 * person's erasure does (forgetAgreementsPerson; Claude 5 on #3438):
 *
 *   - a withdraw, a send written down, a signed copy noted or a new version reads the record under the agreement's
 *     lock and writes it back while that lock is still its own (AGREEMENT_SAVE). The delete now takes the same lock
 *     first, so it never runs between such a read and its write: it either deletes after the writer finished, or
 *     answers "try again", and "deleted" is never said while the record could be written back afterward;
 *   - the record and every version's text are deleted in one script only while the lock is the delete's own
 *     (deleteIfHeldOnly), read exactly; the store's list and the person's set are cleaned only after that delete is
 *     confirmed, so a record still kept is still found by the person's erasure (CX-123 rules 24 and 30);
 *   - a version's text that is kept but does not read as recorded is unknown for the person's data copy
 *     (readVersionExact throws), never "no text"; the pages still read it as "can't be read right now", and the
 *     person's data copy names that version with its mark and an "unread" note, so it is never blocked for good;
 *   - a delete that finds the lock taken answers 409 "busy", in its own words, not logged; an unknown reply answers 500.
 *
 * Synthetic store, synthetic people, the in-memory Redis stand-in (lib/redis-memory.ts), the email provider mocked.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { SIGN_MS, readDraft, type AgreementDraft } from "@/lib/agreement-rules";
import {
  agreementKeys,
  createAgreement,
  deleteAgreement,
  forgetAgreementsPerson,
  readAgreement,
  readVersion,
  readVersionExact,
  signAgreement,
  withdrawAgreement,
} from "@/lib/agreement-store";
import { resendSignedCopy } from "@/lib/agreements";
import { erasureScope } from "@/lib/person-erasure";
import { COPIERS } from "@/lib/person-copy";
import { POST as studioRoute } from "@/app/api/store/agreements/route";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let mails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    mails += 1;
    return new Response(JSON.stringify({ id: `email_${mails}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Commands = (string | number)[][];
type Pipeline = (commands: Commands) => Promise<unknown[]>;
const realPipeline: Pipeline = redis.pipeline.bind(redis);
let hook: Pipeline | null = null;
(redis as unknown as { pipeline: Pipeline }).pipeline = (commands) => (hook ? hook(commands) : realPipeline(commands));

const SIGNER = "signer-locked@example.com";
const recordKey = (id: string) => `nl:agree:r:${id}`;
const isSaveOf = (id: string) => (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:agreement-save:v1\n") && c.includes(recordKey(id));
const isRecordDelete = (id: string) => (c: (string | number)[]) =>
  (c[0] === "DEL" || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:fenced-del:v1\n"))) && c.includes(recordKey(id));

function draftFor(email: string): AgreementDraft {
  const read = readDraft({ kind: "agreement", email, name: "Synthetic Signer", title: "Synthetic sessions", body: "Three synthetic sessions.", lines: [], consent: true }, "usd");
  if (!read.ok) throw new Error("synthetic draft refused");
  return read.draft;
}

async function freshStore(): Promise<Store> {
  redis.clear();
  hook = null;
  const owner = "agree-locked@example.com";
  await claimHandle(owner, "agreelocked", "Synthetic Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1AgrLockedxxx", true);
  await setSubscription(owner, { customerId: "cus_agreelocked", subscriptionId: "sub_agreelocked", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function make(store: Store, email: string, at: number) {
  const made = await createAgreement(store, draftFor(email), at);
  if (!made.ok) throw new Error(made.message);
  return made;
}

const indexIds = async (store: Store) => (await realPipeline([["ZREVRANGE", `nl:agree:s:${store.sid}`, 0, -1]]))[0] as string[];
const personKeys = () => [...redis.keys()].filter((k) => k.startsWith("nl:agree:p:"));
/** Whether any person's set still names the agreement (read by its members: the stand-in keeps an emptied set as a key). */
const inPersonSet = async (id: string) => {
  for (const key of personKeys()) if (((await realPipeline([["SMEMBERS", key]]))[0] as string[]).includes(id)) return true;
  return false;
};
const keptKeys = (id: string) => agreementKeys(id).filter((k) => redis.keys().includes(k));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Holds the first pipeline matching `match` before it runs, until `release()`; `arrived` resolves when it is held. */
function holdAt(match: (c: (string | number)[]) => boolean) {
  let release!: () => void;
  let arrive!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  let armed = true;
  hook = async (commands) => {
    if (armed && commands.some(match)) {
      armed = false;
      arrive();
      await gate;
    }
    return realPipeline(commands);
  };
  return { arrived, release };
}

/** Runs a promise to the end, keeping what it answered or that it threw, and whether it had settled by `settledBy`. */
function track<T>(run: Promise<T>) {
  const out: { settled: boolean; value?: T; threw?: string } = { settled: false };
  const finished = run.then(
    (value) => { out.settled = true; out.value = value; },
    (error: unknown) => { out.settled = true; out.threw = error instanceof Error ? error.name : String(error); },
  );
  return { out, finished };
}

/** How many times `run` logged through console.error (the studio route logs only a real failure). */
async function errorsLoggedBy(run: () => Promise<void>): Promise<number> {
  const real = console.error;
  let count = 0;
  console.error = () => { count += 1; };
  try {
    await run();
  } finally {
    console.error = real;
  }
  return count;
}

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_agreements_only_a_stand_in";
  const now = Date.now();
  const lapsed = now - SIGN_MS - 60_000;

  part("A withdraw held between its read and its write: the delete never answers \"deleted\" while the record can be written back");
  {
    const store = await freshStore();
    const { agreement } = await make(store, SIGNER, lapsed);
    const held = holdAt(isSaveOf(agreement.id));
    const withdraw = track(withdrawAgreement(store, agreement.id));
    await held.arrived;
    const del = track(deleteAgreement(store, agreement.id));
    await sleep(300);
    is("while the withdraw holds the agreement, the delete has not answered \"deleted\"", del.out.value === "deleted", false);
    held.release();
    await Promise.all([withdraw.finished, del.finished]);
    hook = null;
    const after = await readAgreement(agreement.id);
    is("the withdraw finished as it was", (withdraw.out.value as { state?: string } | undefined)?.state, "withdrawn");
    if (del.out.value === "deleted") {
      is("answered \"deleted\": the record (with the person's email and name) is not written back", after, null);
      is("answered \"deleted\": no key of it is left", keptKeys(agreement.id), []);
    } else {
      is("not deleted: the record stays listed and in the person's set, so the erasure still finds it", [after?.id, (await indexIds(store)).includes(agreement.id), await inPersonSet(agreement.id)], [agreement.id, true, true]);
    }
    is("nothing is kept outside the store's list and the person's set", after === null || ((await indexIds(store)).includes(agreement.id) && (await inPersonSet(agreement.id))), true);
    is("the person's erasure then leaves nothing of the agreement", [await forgetAgreementsPerson(store.sid!, SIGNER) >= 0, await readAgreement(agreement.id), keptKeys(agreement.id)], [true, null, []]);
  }

  part("A signed copy noted (changeAgreement) held between its read and its write: the same");
  {
    const store = await freshStore();
    const { agreement, version } = await make(store, SIGNER, now);
    const signed = await signAgreement(store, agreement.id, { n: 1, sha256: version.sha256, name: "Synthetic Signer", email: SIGNER, consent: true, ip: "203.0.113.9" }, "Synthetic Signer");
    is("signed, healthy", signed.ok, true);
    const held = holdAt(isSaveOf(agreement.id));
    const copy = track(resendSignedCopy(store, agreement.id, now + 25 * 3_600_000));
    await held.arrived;
    const del = track(deleteAgreement(store, agreement.id));
    await sleep(300);
    is("while the copy's send is being written down, the delete has not answered \"deleted\"", del.out.value === "deleted", false);
    held.release();
    await Promise.all([copy.finished, del.finished]);
    hook = null;
    const after = await readAgreement(agreement.id);
    if (del.out.value === "deleted") {
      is("answered \"deleted\": the signed record is not written back", after, null);
      is("answered \"deleted\": no key of it is left", keptKeys(agreement.id), []);
    } else {
      is("not deleted: the record stays listed and in the person's set", [after?.id, (await indexIds(store)).includes(agreement.id), await inPersonSet(agreement.id)], [agreement.id, true, true]);
    }
    is("nothing is kept outside the store's list and the person's set", after === null || ((await indexIds(store)).includes(agreement.id) && (await inPersonSet(agreement.id))), true);
  }

  part("The agreement's lock taken by someone else: the studio hears \"busy, try again\" (409, as a withdraw), never \"deleted\", and everything stays");
  {
    const store = await freshStore();
    const { agreement } = await make(store, SIGNER, lapsed);
    const session = await openSession("agree-locked@example.com");
    await realPipeline([["SET", `nl:agree:lock:${agreement.id}`, "someone-elses-token", "EX", 60]]);
    let r: Response | undefined;
    const logged = await errorsLoggedBy(async () => {
      r = await studioRoute(new NextRequest("https://marktmorgen.com/api/store/agreements", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "delete", id: agreement.id }) }));
    });
    const body = (await r!.json()) as { ok?: boolean; error?: string; message?: string };
    // Only an agreement no longer open can be deleted, so whoever holds its lock is rarely a signer (a second click, a
    // signed copy being noted): the sentence says it is being changed, never that someone is signing it (Claude 1 on #3467).
    is("the studio: busy, in words true whoever holds the lock (never ok)", [r!.status, body.ok, body.error, body.message], [409, false, "busy", "This agreement is being changed right now. Try again in a moment."]);
    is("a busy delete is not logged as a failure", logged, 0);
    is("the record, its version, the store's list and the person's set all stay", [(await readAgreement(agreement.id))?.id, keptKeys(agreement.id).length, (await indexIds(store)).includes(agreement.id), await inPersonSet(agreement.id)], [agreement.id, 2, true, true]);
    is("the other holder's lock is untouched", (await realPipeline([["GET", `nl:agree:lock:${agreement.id}`]]))[0], "someone-elses-token");
  }

  part("The record's delete answered in an unknown shape, through the studio: \"try again\" (500, logged), never \"busy\" or \"deleted\"");
  {
    const store = await freshStore();
    const { agreement } = await make(store, SIGNER, lapsed);
    const session = await openSession("agree-locked@example.com");
    hook = async (commands) => {
      const replies = await realPipeline(commands);
      return commands.some(isRecordDelete(agreement.id)) ? replies.map(() => undefined) : replies;
    };
    let r: Response | undefined;
    const logged = await errorsLoggedBy(async () => {
      r = await studioRoute(new NextRequest("https://marktmorgen.com/api/store/agreements", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "delete", id: agreement.id }) }));
    });
    hook = null;
    const body = (await r!.json()) as { ok?: boolean; error?: string; message?: string };
    is("the studio: could not be done, try again (never ok, never busy)", [r!.status, body.ok, body.error, /try again/i.test(String(body.message))], [500, false, "server_error", true]);
    is("an unknown reply is logged as a failure", logged, 1);
    is("a retry: the record is gone, so \"gone\" (404), true", (await studioRoute(new NextRequest("https://marktmorgen.com/api/store/agreements", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "delete", id: agreement.id }) }))).status, 404);
  }

  part("The record's delete did not run while the list removals did (a pipeline is not atomic): the person's erasure still finds it");
  {
    const store = await freshStore();
    const { agreement } = await make(store, SIGNER, lapsed);
    let dropped = false;
    hook = async (commands) => {
      const out: unknown[] = [];
      for (const c of commands) {
        if (!dropped && isRecordDelete(agreement.id)(c)) {
          dropped = true;
          out.push(undefined);
        } else {
          out.push((await realPipeline([c]))[0]);
        }
      }
      return out;
    };
    const del = track(deleteAgreement(store, agreement.id));
    await del.finished;
    hook = null;
    is("the delete's reply is unknown: refused as unknown (not as a busy lock), never \"deleted\"", [del.out.value, del.out.threw], [undefined, "UnknownReplyError"]);
    is("the record is still kept", (await readAgreement(agreement.id))?.email, SIGNER);
    is("so it is still in the store's list", (await indexIds(store)).includes(agreement.id), true);
    is("and still in the person's set", await inPersonSet(agreement.id), true);
    is("the person's erasure finds it and deletes it", [await forgetAgreementsPerson(store.sid!, SIGNER), await readAgreement(agreement.id), keptKeys(agreement.id)], [1, null, []]);
  }

  part("The list removals answer in another shape after a confirmed delete: never \"deleted\"");
  for (const [what, reply] of [["the person's removal over one", 2], ["the store's list removal as text", "1"], ["a removal as a list", ["x"]]] as const) {
    const store = await freshStore();
    const { agreement } = await make(store, SIGNER, lapsed);
    hook = async (commands) => {
      const replies = await realPipeline(commands);
      const at = commands.findIndex((c) => c[0] === "SREM" && c[2] === agreement.id && String(c[1]).startsWith("nl:agree:p:"));
      return at < 0 ? replies : replies.map((r, i) => (i === at ? reply : r));
    };
    const del = track(deleteAgreement(store, agreement.id));
    await del.finished;
    hook = null;
    is(`${what}: refused, never "deleted"`, [del.out.value, Boolean(del.out.threw)], [undefined, true]);
  }

  part("Healthy controls");
  {
    const store = await freshStore();
    const lapsedOne = await make(store, SIGNER, lapsed);
    const openOne = await make(store, "signer-open@example.com", now);
    is("an agreement waiting for a signature: \"open\", nothing touched", [await deleteAgreement(store, openOne.agreement.id), keptKeys(openOne.agreement.id).length], ["open", 2]);
    is("a lapsed one: \"deleted\"", await deleteAgreement(store, lapsedOne.agreement.id), "deleted");
    is("no key of it, no lock, no list entry, not in the person's set", [keptKeys(lapsedOne.agreement.id), redis.keys().includes(`nl:agree:lock:${lapsedOne.agreement.id}`), (await indexIds(store)).includes(lapsedOne.agreement.id), await inPersonSet(lapsedOne.agreement.id)], [[], false, false, false]);
    is("deleted again: gone (null)", await deleteAgreement(store, lapsedOne.agreement.id), null);
    is("the other agreement stays", (await readAgreement(openOne.agreement.id))?.id, openOne.agreement.id);
    is("a withdrawn one: \"deleted\"", [(await withdrawAgreement(store, openOne.agreement.id) as { state?: string } | null)?.state, await deleteAgreement(store, openOne.agreement.id), keptKeys(openOne.agreement.id)], ["withdrawn", "deleted", []]);
    is("another store's id: null", await deleteAgreement({ ...store, sid: "someone-else" }, lapsedOne.agreement.id), null);
  }

  part("Cost: the studio's delete stays inside one studio request's commands (UNIT_COST.studio), with no wait added");
  {
    const store = await freshStore();
    const { agreement } = await make(store, SIGNER, lapsed);
    const session = await openSession("agree-locked@example.com");
    // Every command counted, and a script as itself plus each redis.call it runs (the fenced delete once per key).
    let commands = 0;
    hook = async (batch) => {
      for (const c of batch) {
        if (c[0] !== "EVAL") { commands += 1; continue; }
        const source = String(c[1]);
        commands += 1 + (source.match(/redis\.call/g)?.length ?? 0) + (source.startsWith("-- marktmorgen:fenced-del:v1\n") ? Number(c[2]) - 2 : 0);
      }
      return realPipeline(batch);
    };
    const started = Date.now();
    const r = await studioRoute(new NextRequest("https://marktmorgen.com/api/store/agreements", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "delete", id: agreement.id }) }));
    hook = null;
    is("deleted through the studio", r.status, 200);
    is("its commands, scripts counted with what they run, fit one studio request", commands <= 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, true);
    is("the lock is taken at once, never waited for", Date.now() - started < 1_000, true);
  }

  part("A writer held up past its lock while the delete runs: nothing is written back");
  {
    const store = await freshStore();
    const { agreement } = await make(store, SIGNER, lapsed);
    const held = holdAt(isSaveOf(agreement.id));
    const withdraw = track(withdrawAgreement(store, agreement.id));
    await held.arrived;
    redis.advance(11_000);
    const del = track(deleteAgreement(store, agreement.id));
    await del.finished;
    is("the delete answered \"deleted\" once the writer's lock ran out", del.out.value, "deleted");
    held.release();
    await withdraw.finished;
    hook = null;
    is("the late writer wrote nothing", [withdraw.out.threw, await readAgreement(agreement.id), keptKeys(agreement.id)], ["AgreementLockLostError", null, []]);
  }

  part("Rule 30: a version's text kept but not as recorded is unknown for the person's copy, never \"no text\"");
  {
    const store = await freshStore();
    const { agreement, version } = await make(store, SIGNER, now);
    const a = (await readAgreement(agreement.id))!;
    const vKey = `nl:agree:v:${agreement.id}:1`;
    is("healthy: the text reads", (await readVersionExact(a, 1))?.sha256, version.sha256);
    is("a version the record does not list: null", await readVersionExact(a, 2), null);
    const outcome = async () => readVersionExact(a, 1).then((v) => (v ? "text" : "null"), () => "threw");
    const kept = String((await realPipeline([["GET", vKey]]))[0]);
    for (const [what, spoiled] of [
      ["text that is not JSON", "{not json"],
      ["another text under the same number", JSON.stringify({ ...JSON.parse(kept), text: `${JSON.parse(kept).text} changed` })],
      ["a version of another number", JSON.stringify({ ...JSON.parse(kept), n: 2 })],
    ] as const) {
      await realPipeline([["SET", vKey, spoiled]]);
      is(`${what}: unknown (thrown), not null`, await outcome(), "threw");
      is(`${what}: the pages still read it as "can't be read right now"`, await readVersion(a, 1), null);
    }
    // Kept but damaged for good (the last spoiled value is still there): the person's copy is not blocked for ever; it
    // says so, with the version's mark, the way the assignment copier says a record it cannot read (lib/person-copy.ts).
    const scope = (await erasureScope(store, SIGNER))!;
    const mark = a.versions[0];
    const copyOf = async () => (await COPIERS["lib/agreement-store.ts"](scope).catch(() => [])) as { id: string; versions: Record<string, unknown>[] }[];
    const copy = await copyOf();
    is("damaged kept text: the agreement is in the copy", copy.map((c) => c.id), [agreement.id]);
    is("damaged kept text: the version is there with its mark and an unread note, no text", copy[0]?.versions, [{ ...mark, unread: "This version's text is kept but could not be read for this copy." }]);
    await realPipeline([["SET", vKey, "{damaged"]]);
    is("text that is not JSON at all: the same unread note", (await copyOf())[0]?.versions[0]?.unread, "This version's text is kept but could not be read for this copy.");
    for (const [what, reply] of [["a number", 5], ["a list", ["x"]], ["no reply", undefined]] as const) {
      hook = async (commands) => {
        const replies = await realPipeline(commands);
        return commands.some((c) => c[0] === "GET" && c[1] === vKey) ? replies.map(() => reply) : replies;
      };
      const copied = await COPIERS["lib/agreement-store.ts"](scope).then(() => "copied", () => "threw");
      hook = null;
      is(`a reply that is not text or null (${what}): the person's data copy fails instead of leaving the text out`, copied, "threw");
    }
    await realPipeline([["SET", vKey, kept]]);
    const healthy = await copyOf();
    is("healthy: the copy carries the version's text and no unread note", [healthy[0]?.versions[0]?.text, "unread" in (healthy[0]?.versions[0] ?? {})], [version.text, false]);
    await realPipeline([["DEL", vKey]]);
    is("confirmed absent: null", await outcome(), "null");
    await realPipeline([["SET", vKey, kept]]);
    is("put back: the text reads", await outcome(), "text");
  }

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
