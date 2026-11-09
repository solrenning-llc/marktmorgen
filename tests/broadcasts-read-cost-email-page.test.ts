/**
 * What the studio's email page (app/studio/email/page.tsx) reads of the
 * store's one-off emails, measured on the real database calls (regra 30,
 * sibling of #3034's "Change where a link goes"): the page read the newest
 * thirty emails whole (listBroadcastsStrict, each up to MAX_MAIL_BODY
 * characters, about 120 KB as stored and twice that as they cross, about
 * 7 MB in all) inside its own STUDIO_PAGE_UNITS (about 200 KB and 80
 * commands), and it uses none of their bodies. Held here, with synthetic
 * stores only:
 *
 *   1. The page reads each email without its body (readBroadcastHeads,
 *      lib/broadcasts.ts: the body's string emptied inside the database,
 *      BROADCAST_HEADS), every field it shows exactly as stored.
 *   2. Before any take, only the list is asked, inside the page's own
 *      studio requests; each one's size without its body is paid before it
 *      is asked (Codex P 5811379332, Codex J 5811457165 on #3034), and the
 *      studio requests reading them comes to are taken before any is read;
 *      every command and byte after the first take is inside what was taken
 *      when it is sent. One that grows between
 *      its size and its read is read once more, paid first, then not at all.
 *   3. Without those studio requests none is read or measured, and the page
 *      says why.
 *   4. All or nothing, as listBroadcastsStrict: a record missing, of another
 *      list, malformed or without a body makes the page say the emails could
 *      not be read, never a shorter list.
 */
import { readFileSync } from "node:fs";
import * as broadcasts from "@/lib/broadcasts";
import { listBroadcastsStrict } from "@/lib/broadcasts";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { LONGEST, SMALL, UNIT_BYTES, emailKey, idsFor, leaveStudio, makeStore, payFrom, pipeline, record, redis, utf8, watched, wire, writeEmails } from "./broadcasts-read-cost-world";
import { done, is, part } from "./check";

/** The emails the page reads (listBroadcastsStrict's default, which it read before). */
const READ = 30;
const OWNER = "emailpageread@example.com";
const read = (path: string) => readFileSync(path, "utf8");
/** A record as listBroadcastsStrict reads it, but its body. */
const withoutBody = <T extends { body: string }>(b: T): Omit<T, "body"> => {
  const copy: Partial<T> = { ...b };
  delete copy.body;
  return copy as Omit<T, "body">;
};

type Head = Record<string, unknown> & { id: string };
type Heads = { ok: true; heads: Head[] } | { ok: false; refused: string };
type Reader = (listId: string | null, pay: (units: number) => Promise<{ ok: true } | { ok: false; message: string }>, limit?: number) => Promise<Heads>;

async function main(): Promise<void> {
  redis.clear();
  const store = await makeStore(OWNER, "emailpageread");
  const listId = store.listId!;
  const ids = idsFor(READ, "cd");
  await writeEmails(store, ids, () => LONGEST);
  is("an email at its longest, as stored, past a hundred kilobytes", utf8(record(store, ids[0], LONGEST)) > 100_000, true);

  // The proof: the thirty emails read whole, as the page did, against the page's own studio requests.
  {
    const strict = await listBroadcastsStrict(listId);
    is("listBroadcastsStrict reads all thirty, bodies and all", strict.length === READ && strict.every((b) => b.body === LONGEST), true);
    const raws = (await pipeline(ids.map((id) => ["GET", emailKey(id)]))) as string[];
    const whole = wire(ids.map((id) => ["GET", emailKey(id)])) + wire(raws);
    is(`read whole, thirty emails are more than the page's own ${STUDIO_PAGE_UNITS} studio requests (${whole} bytes)`, whole > STUDIO_PAGE_UNITS * UNIT_BYTES, true);
  }

  const page = read("app/studio/email/page.tsx");
  is("the page reads its emails without their bodies, paying from the store's studio requests, and no longer whole", /readBroadcastHeads\(/.test(page) && /countStudio\(/.test(page) && !/listBroadcastsStrict\(/.test(page), true);
  is("and says, in words, when there are not enough studio requests left to read them", /emailsRefused/.test(page) && /not enough left/.test(page), true);

  const reader = (broadcasts as unknown as { readBroadcastHeads?: Reader }).readBroadcastHeads;
  is("the reader of the emails without their bodies exists", typeof reader, "function");
  if (typeof reader !== "function") return done();
  const pay = payFrom(store);
  const run = (then: Parameters<typeof watched>[1] = null, limit?: number) => watched(() => reader(listId, pay, limit), then);

  // ---------------------------------------------------------------- part 1
  part("1. Thirty emails at their longest: every field the page shows, without the body");
  {
    const { result, sum } = await run();
    const strict = await listBroadcastsStrict(listId);
    const expected = strict.map(withoutBody);
    is("every email, newest first, each field as listBroadcastsStrict reads it, and no body", result !== "threw" && result.ok ? result.heads : result, expected);
    is(`only the list is asked inside the page's own studio requests, small (${JSON.stringify(sum.own)})`, sum.own.commands <= 1 && sum.own.bytes <= 8_000, true);
    is("no email's size is asked before the studio requests asking it comes to are taken", sum.sizedBefore, false);
    is("no email is read before the studio requests are taken", sum.readBefore, false);
    is(`every command and byte after it is inside what was taken when sent (${JSON.stringify({ paid: sum.paid, commands: sum.commands, bytes: sum.bytes })})`, sum.ok, true);
    is(`no body crosses: all of it is a few kilobytes (${sum.own.bytes + sum.bytes})`, sum.own.bytes + sum.bytes < 40_000, true);
  }

  part("1b. What a body holds never moves where the body ends");
  {
    // Quotes, backslashes, the key's own words and a closing brace inside the body; quotes and backslashes in the subject.
    const tricky = [
      '<p>He said "hi" \\ and \\"so\\" "body":"x" },{"id":"0"</p>',
      "\\".repeat(9) + '"' + "\\".repeat(10),
      '","body":"',
      " \u{1F600}é<>&\u0000",
    ];
    const few = ids.slice(0, tricky.length);
    await writeEmails(store, few, (i) => tricky[i], (i) => ({ subject: `A "quoted" \\ subject ${i} "body":"`, note: i === 1 ? 'Waiting: "body":"' : "" }));
    const { result } = await run();
    const strict = await listBroadcastsStrict(listId);
    is("each read exactly as stored, but its body", result !== "threw" && result.ok ? result.heads : result, strict.map(withoutBody));
  }

  part("1c. Small emails cost what they are; none costs nothing more");
  {
    await writeEmails(store, ids.slice(0, 3), () => SMALL);
    const { result, sum, log } = await run();
    is("three small emails", result !== "threw" && result.ok ? result.heads.length : result, 3);
    // Asking their sizes is its own take now, before the script is sent (Codex P 5811379332 on #3034): one for the sizes, one for the read.
    is(`a small read takes two studio requests more, in two takes: one for the sizes, one for the read (${sum.paid})`, [sum.paid, log.filter((e) => e.kind === "pay").length], [2, 2]);
    is("inside what was taken", sum.ok, true);
    await writeEmails(store, [], () => SMALL);
    const none = await run();
    is("with no email, nothing is taken and only the list is asked", [none.result !== "threw" && none.result.ok && none.result.heads.length, none.log.filter((e) => e.kind === "pay").length, none.log.filter((e) => e.kind === "db").length], [0, 0, 1]);
    const noList = await reader(null, pay);
    is("a store with no list has no email, read from nowhere", noList.ok && noList.heads.length, 0);
    for (const limit of [0, -1, 101, 1.5, Number.NaN]) is(`an invalid limit is refused (${limit})`, (await run(null, limit)).result, "threw");
  }

  part("1d. An email that grows between its size and its read is read no further than paid");
  {
    await writeEmails(store, ids, () => LONGEST);
    const sized = (batch: (string | number)[][]) => batch[0]?.[0] === "EVAL" && batch[0][3 + Number(batch[0][2])] === "size";
    const grown = await run(async (batch) => {
      if (sized(batch)) await pipeline([["SET", emailKey(ids[0]), record(store, ids[0], LONGEST, { note: "n".repeat(300), failures: 12 })]]);
    });
    is(`inside what was taken (${JSON.stringify({ paid: grown.sum.paid, commands: grown.sum.commands, bytes: grown.sum.bytes })})`, grown.sum.ok, true);
    is("the grown one is read again, paid first, and shown as it is now", grown.result !== "threw" && grown.result.ok ? [grown.result.heads.length, grown.result.heads[0].note, grown.result.heads[0].failures] : grown.result, [READ, "n".repeat(300), 12]);
    // Three takes since asking the sizes is paid before it is sent (Codex P 5811379332 on #3034): the sizes, all of them, the grown one.
    is("it was taken three times: for the sizes, for all, once more for the grown one", grown.log.filter((e) => e.kind === "pay").length, 3);
    await writeEmails(store, ids, () => LONGEST);
    const far = await run(async (batch) => {
      if (sized(batch)) await pipeline([["SET", emailKey(ids[0]), record(store, ids[0], LONGEST, { note: "n".repeat(20_000) })]]);
    });
    is("grown past what a send writes on it: could not be read", far.result, "threw");
    is("and still inside what was taken", far.sum.ok, true);
  }

  // ---------------------------------------------------------------- part 2
  part("2. Without the studio requests they need, none is read");
  {
    await writeEmails(store, ids, () => LONGEST);
    await leaveStudio(0, 5_000);
    const { result, log } = await run();
    is("refused, in words", result !== "threw" && !result.ok && result.refused.length > 10, true);
    is("no email read", log.some((e) => e.kind === "db" && e.reads.length > 0), false);
    is("no email's size asked either", log.some((e) => e.kind === "db" && e.sizes > 0), false);
    await leaveStudio(5_000, 5_000);
  }

  // ---------------------------------------------------------------- part 3
  part("3. All or nothing, as listBroadcastsStrict");
  {
    const small = (i: number) => `${SMALL}<p>${i}</p>`;
    const cases: [string, () => Promise<void>][] = [
      ["a record missing from the list", () => pipeline([["DEL", emailKey(ids[4])]]).then(() => undefined)],
      ["a record of another list", () => pipeline([["SET", emailKey(ids[4]), record(store, ids[4], small(4), { listId: "another-list" })]]).then(() => undefined)],
      ["a malformed record", () => pipeline([["SET", emailKey(ids[4]), record(store, ids[4], small(4), { sent: -1 })]]).then(() => undefined)],
      ["a record with an empty body", () => pipeline([["SET", emailKey(ids[4]), record(store, ids[4], "")]]).then(() => undefined)],
      ["a record with no body", () => pipeline([["SET", emailKey(ids[4]), JSON.stringify({ ...JSON.parse(record(store, ids[4], "x")), body: undefined })]]).then(() => undefined)],
      ["a record that is not JSON", () => pipeline([["SET", emailKey(ids[4]), '{"id":"x","body":"unterminated']]).then(() => undefined)],
      // No record has one (createBroadcast writes the body fifth, and no nested field is called "body"): the body read is then its own, and refused.
      ["a record whose first body is a nested one", () => pipeline([["SET", emailKey(ids[4]), JSON.stringify({ extra: { body: "x" }, ...JSON.parse(record(store, ids[4], small(4))) })]]).then(() => undefined)],
    ];
    for (const [what, spoil] of cases) {
      await writeEmails(store, ids.slice(0, 8), small);
      await spoil();
      is(`${what}: could not be read`, (await run()).result, "threw");
    }
    await writeEmails(store, ids.slice(0, 8), small, (i) => (i === 4 ? { links: undefined, sent: 0, status: "scheduled", finishedAt: 0 } : {}));
    const fine = await run();
    is("an email not sent yet is read as it is", fine.result !== "threw" && fine.result.ok ? [fine.result.heads[4].status, fine.result.heads[4].sent] : fine.result, ["scheduled", 0]);
    await writeEmails(store, [], small);
    await pipeline([["RPUSH", `nl:mail:bcs:${listId}`, "not-an-id"]]);
    is("an index that is not one: could not be read", (await run()).result, "threw");
    await writeEmails(store, [], small);
  }

  // Merge of #3034 with main (57ca6e5a3, decision 2 of C4-20261108-0217): with { expired: "skip" }, as the page asks,
  // a record Redis says is gone is a campaign gone after RECORD_DAYS, left out; anything else still throws.
  part("4. With expired: skip, as the page reads them, a record that is gone is left out, known");
  {
    const small = (i: number) => `${SMALL}<p>${i}</p>`;
    const skipping = (broadcasts as unknown as { readBroadcastHeads: (l: string, p: typeof pay, n?: number, o?: { expired?: "skip" }) => ReturnType<Reader> }).readBroadcastHeads;
    const runSkip = () => watched(() => skipping(listId, pay, undefined, { expired: "skip" }), null);
    await writeEmails(store, ids.slice(0, 8), small);
    await pipeline([["DEL", emailKey(ids[4])]]);
    const skipped = await runSkip();
    is("the seven left are read, the gone one left out", skipped.result !== "threw" && skipped.result.ok ? skipped.result.heads.map((h) => h.id) : skipped.result, [...ids.slice(0, 4), ...ids.slice(5, 8)]);
    is("without the option, the same list still could not be read", (await run()).result, "threw");
    await writeEmails(store, ids.slice(0, 8), small);
    await pipeline([["SET", emailKey(ids[4]), record(store, ids[4], small(4), { listId: "another-list" })]]);
    is("with the option, a record of another list still could not be read", (await runSkip()).result, "threw");
    await writeEmails(store, [], small);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
