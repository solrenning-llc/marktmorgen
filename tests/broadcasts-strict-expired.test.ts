/**
 * Decision 2 of C4-20261108-0217 (Codex M's MEDIUM on #3146): a campaign's
 * record lives RECORD_DAYS (400 days) under its own EXPIRE, while the list of
 * its ids never expires. The record is written before its id enters the list
 * (createBroadcast: SET, then LPUSH), so an id whose record Redis answers as
 * nil is a campaign that is gone, known: listBroadcastsStrict with
 * `{ expired: "skip" }` leaves it out and reads the rest. Without the option,
 * nothing changes (tests/broadcast-history.test.ts). Any other answer is still
 * unknown and throws (rule 24): only Redis's own nil is "gone".
 *
 * The studio's email page uses the option, so an old store's page is not left
 * saying its campaigns could not be read forever.
 */
import { readFileSync } from "node:fs";
import { listBroadcastsStrict } from "@/lib/broadcasts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const id = "1234567890abcdef12345678";
const old = "abcdef1234567890abcdef12";
const row = { id, listId: "chosen-list", handle: "chosen-store", subject: "Campaign", body: "Content", productId: null, notProductId: null, who: "all", narrow: null, status: "sent", createdAt: 1, sendAt: 2, finishedAt: 3, total: 3, sent: 3, note: "", failures: 0, listed: false, tagged: true, test: null };

async function main(): Promise<void> {
  const original = redis.pipeline;
  let replies: unknown[] = [];
  redis.pipeline = (async () => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next as unknown[];
  }) as typeof redis.pipeline;
  const skip = () => listBroadcastsStrict("chosen-list", 30, { expired: "skip" });
  const rejects = async (label: string, read: () => Promise<unknown>) => {
    let failed = false;
    try {
      await read();
    } catch {
      failed = true;
    }
    is(label, failed, true);
  };
  try {
    part("A record Redis says is gone (nil) is left out, the rest read");
    replies = [[[id, old]], [JSON.stringify(row), null]];
    const read = await skip();
    is("the live campaign is read", read.map((b) => b.id), [id]);
    replies = [[[old]], [null]];
    is("only gone ones: an empty history, known", await skip(), []);

    part("Without the option, nothing changes: one missing record still withholds the list");
    replies = [[[id, old]], [JSON.stringify(row), null]];
    await rejects("the default still refuses a partial list", () => listBroadcastsStrict("chosen-list"));

    part("Anything but Redis's own nil is still unknown with the option");
    for (const bad of [undefined, "", "{", "null", "[]", 7, {}]) {
      replies = [[[id, old]], [JSON.stringify(row), bad]];
      await rejects(`a record answered as ${JSON.stringify(bad) ?? "undefined"} is unknown`, skip);
    }
    replies = [[[id, old]], [JSON.stringify(row)]];
    await rejects("fewer records than ids is unknown", skip);
    replies = [[[id]], new Error("timed out")];
    await rejects("a read that throws is unknown", skip);
  } finally {
    redis.pipeline = original;
  }

  part("The studio's email page reads its history this way");
  const page = readFileSync("app/studio/email/page.tsx", "utf8");
  is("listBroadcastsStrict with expired: skip", page.includes('listBroadcastsStrict(store.listId, 30, { expired: "skip" })'), true);

  done();
}

void main();
