/**
 * CX-123 rule 24 on agreements (lib/agreement-store.ts, lib/agreements.ts and the studio's route): a Redis reply is
 * read in its exact shape. Only a confirmed absent record (GET null) is "no agreement"; only a confirmed empty set
 * (SMEMBERS []) is "this person has none". Any other shape is unknown, and what depends on it is refused:
 *
 *   - withdrawing or deleting an agreement never answers "That agreement is gone" while its record may be there
 *     (a withdraw told "gone" left the link taking a signature, a delete told "gone" left the person's record kept);
 *   - a kept record whose text does not read is unknown too, never "gone" (Claude 5 on #3268);
 *   - deleting answers "deleted" only when the record's delete under the agreement's lock (fenced-del) answered 1,
 *     and then each list removal (ZREM, SREM) its exact count (tests/agreements-delete-locked.test.ts holds the lock);
 *   - sending it again never answers "gone" on an unknown read;
 *   - an email that already went is still reported as sent when writing down its time cannot be confirmed, so the
 *     studio never invites a second agreement for the same person;
 *   - a person's erasure (forgetAgreementsPerson) is held by tests/agreements-erase-unknown.test.ts (#3151).
 *
 * The healthy and confirmed-empty paths are checked unchanged. Synthetic store, synthetic people, in-memory Redis,
 * the email provider mocked.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { type AgreementDraft, readDraft, statusOf } from "@/lib/agreement-rules";
import { createAgreement, deleteAgreement, readAgreement, signAgreement, withdrawAgreement } from "@/lib/agreement-store";
import { resendSignedCopy, sendAgain, sendAgreementEmail } from "@/lib/agreements";
import { POST as studioRoute } from "@/app/api/store/agreements/route";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const mails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    mails.push((JSON.parse(String(init?.body)) as { to: string[] }).to[0]);
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

// One command answered in a chosen shape; everything else goes to the in-memory store.
type Pick1 = (cmd: (string | number)[]) => boolean;
let poison: { match: Pick1; reply: unknown } | null = null;
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof real }).pipeline = async (cmds) => {
  if (poison && cmds.length >= 1 && poison.match(cmds[0])) return poison.reply as unknown[];
  return real(cmds);
};
async function under<T>(match: Pick1, reply: unknown, run: () => Promise<T>): Promise<{ value?: T; threw: boolean }> {
  poison = { match, reply };
  try {
    return { value: await run(), threw: false };
  } catch {
    return { threw: true };
  } finally {
    poison = null;
  }
}

const getRecord = (id: string): Pick1 => (cmd) => cmd[0] === "GET" && cmd[1] === `nl:agree:r:${id}`;

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Synthetic Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Unr${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

const draftFor = (email: string): AgreementDraft => {
  const read = readDraft({ kind: "agreement", email, name: "Synthetic Signer", title: "Synthetic sessions", body: "Three synthetic sessions.", lines: [{ text: "Session", quantity: 3, amount: "10" }], consent: true }, "usd");
  if (!read.ok) throw new Error("synthetic draft refused");
  return read.draft;
};

// GET replies that are not a confirmed absence nor one record's text.
const UNKNOWN_GETS: [string, unknown][] = [
  ["no reply", []],
  ["a number", [1]],
  ["a list", [["x"]]],
  ["an object", [{}]],
  ["an undefined slot", [undefined]],
  ["a bare string", "QUEUED"],
  ["two replies for one command", [null, null]],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_agreements_only_a_stand_in";
  const owner = "synthetic-unread@example.com";
  const store = await paidStore(owner, "unreadshapes");
  const session = await openSession(owner);
  const call = async (body: Record<string, unknown>) => {
    const r = await studioRoute(new NextRequest("https://marktmorgen.com/api/store/agreements", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const make = async (email: string) => {
    const made = await createAgreement(store, draftFor(email));
    if (!made.ok) throw new Error(made.message);
    return made;
  };

  part("Withdrawing never says gone on an unknown read");
  const open = await make("signer-one@example.com");
  for (const [what, reply] of UNKNOWN_GETS) {
    const r = await under(getRecord(open.agreement.id), reply, () => withdrawAgreement(store, open.agreement.id));
    is(`withdraw on ${what}: refused, not "gone"`, r.threw, true);
    const route = await under(getRecord(open.agreement.id), reply, () => call({ action: "withdraw", id: open.agreement.id }));
    is(`the studio on ${what}: could not be done, not "That agreement is gone"`, route.value?.status, 500);
  }
  is("the agreement is still open, and the creator was never told it was gone", statusOf((await readAgreement(open.agreement.id))!, Date.now()), "open");

  part("Sending it again never says gone on an unknown read");
  for (const [what, reply] of UNKNOWN_GETS) {
    const r = await under(getRecord(open.agreement.id), reply, () => sendAgain(store, open.agreement.id));
    is(`send again on ${what}: refused, not "gone"`, r.threw, true);
  }

  part("Deleting never says gone on an unknown read");
  is("withdrawn, healthy", (await withdrawAgreement(store, open.agreement.id)) !== null, true);
  for (const [what, reply] of UNKNOWN_GETS) {
    const r = await under(getRecord(open.agreement.id), reply, () => deleteAgreement(store, open.agreement.id));
    is(`delete on ${what}: refused, not "gone"`, r.threw, true);
    const route = await under(getRecord(open.agreement.id), reply, () => call({ action: "delete", id: open.agreement.id }));
    is(`the studio on ${what}: could not be done, not "That agreement is gone"`, route.value?.status, 500);
  }
  is("its record is still kept, as the creator was told", (await readAgreement(open.agreement.id))?.id, open.agreement.id);
  is("then deleted, healthy", await deleteAgreement(store, open.agreement.id), "deleted");
  is("confirmed absent: gone", [await readAgreement(open.agreement.id), await deleteAgreement(store, open.agreement.id), await withdrawAgreement(store, open.agreement.id)], [null, null, null]);

  part("Deleting answers deleted only on each removal's exact count (Claude 5 on #3268 and #3438)");
  // The record and every version's key go first, in one script under the agreement's lock (fenced-del), which answers
  // 1 when it deleted. Answered here without running, so the record is still there, as it may be after such a reply.
  const UNKNOWN_DELETES: [string, unknown][] = [
    ["no reply", []],
    ["a bare string", "QUEUED"],
    ["two replies for one command", [1, 1]],
    ["the delete as an object", [{}]],
    ["the delete as a text", ["1"]],
    ["the lock lost (0)", [0]],
    ["a delete answered null", [null]],
    ["the delete as a list", [["x"]]],
  ];
  const kept = await make("signer-forget@example.com");
  is("withdrawn, healthy", (await withdrawAgreement(store, kept.agreement.id)) !== null, true);
  const deleteOf = (id: string): Pick1 => (cmd) => cmd[0] === "EVAL" && String(cmd[1]).startsWith("-- marktmorgen:fenced-del:v1\n") && cmd.includes(`nl:agree:r:${id}`);
  for (const [what, reply] of UNKNOWN_DELETES) {
    const r = await under(deleteOf(kept.agreement.id), reply, () => deleteAgreement(store, kept.agreement.id));
    is(`delete answered ${what}: refused, never "deleted"`, [r.threw, r.value], [true, undefined]);
    const route = await under(deleteOf(kept.agreement.id), reply, () => call({ action: "delete", id: kept.agreement.id }));
    is(`the studio on ${what}: could not be done, never ok`, [route.value?.status, route.value?.body.ok], [500, false]);
  }
  is("the record is still kept with the person's email, as the creator was told", (await readAgreement(kept.agreement.id))?.email, "signer-forget@example.com");
  is("the store's list and the person's set still name it, so the erasure still finds it", [((await real([["ZREVRANGE", `nl:agree:s:${store.sid}`, 0, -1]]))[0] as string[]).includes(kept.agreement.id), (await real([["SMEMBERS", `nl:agree:p:${store.sid}:${personKey(store.sid!, "signer-forget@example.com")}`]]))[0]], [true, [kept.agreement.id]]);
  is("then deleted, healthy, on exact counts", await deleteAgreement(store, kept.agreement.id), "deleted");
  is("deleted: no key of it is left, the lock let go", [...redis.keys()].filter((k) => k.includes(kept.agreement.id)).length, 0);
  // Then the store's list (ZREM) and the person's set (SREM), each 0 or 1, after the delete was confirmed.
  const UNKNOWN_UNLISTS: [string, unknown][] = [
    ["no reply", []],
    ["a bare string", "QUEUED"],
    ["one reply for two commands", [1]],
    ["the store's list removal over one", [2, 1]],
    ["the store's list removal unknown", [null, 1]],
    ["the store's list removal as text", ["1", 1]],
    ["a negative removal", [-1, 1]],
    ["the person's removal over one", [1, 2]],
    ["the person's removal as a list", [1, ["x"]]],
  ];
  const unlistOf = (id: string): Pick1 => (cmd) => cmd[0] === "ZREM" && cmd[2] === id;
  for (const [what, reply] of UNKNOWN_UNLISTS) {
    const one = await make(`signer-unlist-${what.replace(/\W+/g, "-")}@example.com`);
    is(`withdrawn, healthy (${what})`, (await withdrawAgreement(store, one.agreement.id)) !== null, true);
    const r = await under(unlistOf(one.agreement.id), reply, () => deleteAgreement(store, one.agreement.id));
    is(`list removals answered ${what}: refused, never "deleted"`, [r.threw, r.value], [true, undefined]);
  }
  const listed = await make("signer-unlist-route@example.com");
  await withdrawAgreement(store, listed.agreement.id);
  const unlistRoute = await under(unlistOf(listed.agreement.id), [1, 2], () => call({ action: "delete", id: listed.agreement.id }));
  is("the studio on a list removal over one: could not be done, never ok", [unlistRoute.value?.status, unlistRoute.value?.body.ok], [500, false]);

  part("A kept record that does not read is unknown, never gone (Claude 5 on #3268)");
  const UNREADABLE: [string, (raw: string) => string][] = [
    ["versions that are not a list", (raw) => JSON.stringify({ ...JSON.parse(raw), versions: "x" })],
    ["text that is not JSON", () => "{not json"],
    ["a JSON number", () => "7"],
  ];
  for (const [what, spoil] of UNREADABLE) {
    const made = await make(`signer-unreadable-${what.replace(/\W+/g, "-")}@example.com`);
    const key = `nl:agree:r:${made.agreement.id}`;
    const [raw] = await redis.pipeline([["GET", key]]);
    await redis.pipeline([["SET", key, spoil(String(raw))]]);
    const read = await under(() => false, null, () => readAgreement(made.agreement.id));
    is(`read with ${what}: unknown (thrown), not null`, read.threw, true);
    for (const action of ["withdraw", "delete"]) {
      const route = await call({ action, id: made.agreement.id });
      is(`the studio's ${action} with ${what}: could not be done, not "That agreement is gone"`, [route.status, route.body.ok], [500, false]);
    }
    const resent = await under(() => false, null, () => sendAgain(store, made.agreement.id));
    is(`send again with ${what}: refused, not "gone"`, resent.threw, true);
    is(`the record with ${what} is still kept`, typeof (await redis.pipeline([["GET", key]]))[0], "string");
    await redis.pipeline([["DEL", key]]);
  }

  part("An email that went stays reported as sent, once");
  for (const [what, reply] of UNKNOWN_GETS) {
    const made = await make(`signer-${what.replace(/\W+/g, "-")}@example.com`);
    const before = mails.length;
    const r = await under(getRecord(made.agreement.id), reply, () => sendAgreementEmail(store, made.agreement, made.version));
    is(`writing down the send on ${what}: the email that went is reported, nothing thrown`, [r.threw, r.value?.sent, mails.length - before], [false, true, 1]);
    await withdrawAgreement(store, made.agreement.id);
    await deleteAgreement(store, made.agreement.id);
  }
  const signedOne = await make("signer-copy@example.com");
  const signed = await signAgreement(store, signedOne.agreement.id, { n: 1, sha256: signedOne.version.sha256, name: "Synthetic Signer", email: "signer-copy@example.com", consent: true, ip: "203.0.113.9" }, "Synthetic Signer");
  is("signed, healthy", signed.ok, true);
  const later = Date.now() + 25 * 3_600_000;
  // The first GET is the read that decides the copy; the second, under the lock, writes down that it went.
  let gets = 0;
  const copyBefore = mails.length;
  const copy = await under((cmd) => cmd[0] === "GET" && cmd[1] === `nl:agree:r:${signedOne.agreement.id}` && ++gets === 2, [1], () => resendSignedCopy(store, signedOne.agreement.id, later));
  is("the signed copy again, its writing down unknown: reported as sent, once, nothing thrown", [copy.threw, copy.value, mails.length - copyBefore], [false, { ok: true, sent: true }, 1]);
  // Through the studio: an unknown read while writing down the send is not "could not be done", which would invite
  // a second agreement, and a second email, for the same person.
  const records = () => [...redis.keys()].filter((k) => k.startsWith("nl:agree:r:")).length;
  const before = { mails: mails.length, records: records() };
  poison = { match: (cmd) => cmd[0] === "GET" && String(cmd[1]).startsWith("nl:agree:r:"), reply: [1] };
  const created = await call({ action: "create", kind: "agreement", email: "signer-route@example.com", name: "Synthetic Signer", title: "Synthetic sessions", body: "Three synthetic sessions.", lines: [{ text: "Session", quantity: 3, amount: "10" }], consent: true }).finally(() => { poison = null; });
  is("create: kept and sent once, said as sent", [created.status, created.body.ok, created.body.sent, mails.length - before.mails], [200, true, true, 1]);
  is("create: one agreement kept", records() - before.records, 1);

  part("Healthy controls");
  const healthy = await make("signer-healthy@example.com");
  const sentOnce = await sendAgreementEmail(store, healthy.agreement, healthy.version);
  is("healthy send: sent and written down", [sentOnce.sent, sentOnce.agreement.sent.length, (await readAgreement(healthy.agreement.id))?.sent.length], [true, 1, 1]);
  is("healthy send again within a day: refused by the spacing", (await sendAgain(store, healthy.agreement.id)).ok, false);
  is("healthy withdraw", (await withdrawAgreement(store, healthy.agreement.id) as { state?: string } | null)?.state, "withdrawn");

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
