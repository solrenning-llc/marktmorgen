/**
 * Rule 24 in readBroadcast (lib/broadcasts.ts). A campaign record that did not
 * parse was read as "this email does not exist": the letters route answered
 * 404 "not one of this store's", copyOf and keepSending said it was not there,
 * and cancelBroadcast refused as if there were nothing to cancel. Now only
 * Redis's own nil is "not there" (null); a reply in another shape throws
 * BroadcastsUnreadable. cancelBroadcast passes that on as it is, because
 * nothing was written yet (never "the cancellation could not be confirmed"),
 * and the studio's email route answers it as unavailable (503) with words
 * that say nothing changed.
 */
import { readFileSync } from "node:fs";
import { BroadcastsUnreadable, readBroadcast } from "@/lib/broadcasts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const id = "1234567890abcdef12345678";
const row = { id, listId: "chosen-list", handle: "chosen-store", subject: "Campaign", body: "Content", productId: null, notProductId: null, who: "all", narrow: null, status: "sent", createdAt: 1, sendAt: 2, finishedAt: 3, total: 3, sent: 3, note: "", failures: 0, listed: false, tagged: true, test: null };

async function main(): Promise<void> {
  const original = redis.pipeline;
  let replies: unknown[] = [];
  redis.pipeline = (async () => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next as unknown[];
  }) as typeof redis.pipeline;
  try {
    part("Redis's own answers");
    replies = [[JSON.stringify(row)]];
    is("a record is read", (await readBroadcast(id))?.id, id);
    replies = [[null]];
    is("nil: not there", await readBroadcast(id), null);
    is("an id this code never writes: not there, nothing read", await readBroadcast("not-an-id"), null);

    part("Anything else is unknown, never \"not there\"");
    for (const bad of [[], ["{"], ["null"], ["[]"], [7], [{}], [undefined]]) {
      replies = [bad];
      let error: unknown = null;
      try {
        await readBroadcast(id);
      } catch (thrown) {
        error = thrown;
      }
      is(`a reply ${JSON.stringify(bad)}: BroadcastsUnreadable`, error instanceof BroadcastsUnreadable, true);
    }
  } finally {
    redis.pipeline = original;
  }

  part("Its callers say what happened");
  const lib = readFileSync("lib/broadcasts.ts", "utf8");
  is("cancelBroadcast passes an unread record on as it is (nothing was written yet)", /catch \(error\) \{\s*\/\/[^\n]*\n\s*if \(error instanceof BroadcastsUnreadable\) throw error;/.test(lib), true);
  const route = readFileSync("app/api/store/mail/route.ts", "utf8");
  is("the email route answers it as unavailable", route.includes('if (error instanceof BroadcastsUnreadable) return fail("broadcast_read_unavailable", 503);'), true);
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the studio says nothing changed", studio.includes('broadcast_read_unavailable: "That email could not be read just now, so nothing was changed. Try again in a moment.",'), true);

  done();
}

void main();
