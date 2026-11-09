/**
 * CX-123 rule 24, lot L10b: each signed Zoom notice is acted on once (app/api/integrations/zoom/deauthorize/route.ts),
 * under a ten-minute mark of its signature taken with SET NX, so a notice captured and sent again cannot disconnect an
 * account connected again since. A reply to that SET in any shape but "OK" or nil is read back: our own value is ours
 * and the notice is acted on; another value is a notice already handled; nothing readable (the database not answering
 * included, where before it carried on) acts on nothing and answers 503, letting go of a mark this request may have
 * written, so Zoom's retry is heard. A notice that failed lets go of its mark only while it still holds its own value.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/integrations/zoom/deauthorize/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, count, getOf, setNx } from "./l10b-replies";

process.env.ZOOM_CLIENT_ID = "z-id";
process.env.ZOOM_CLIENT_SECRET = "z-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "z-token";

const SEEN = "nl:meet:zoomseen:";
let n = 0;
/** One signed app_deauthorized notice: the same body, timestamp and signature each time it is sent. */
function notice() {
  const body = JSON.stringify({ event: "app_deauthorized", payload: { user_id: `zoom-user-${(n += 1)}`, client_id: "z-id" } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", "z-token").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const send = async () =>
    (
      await POST(
        new NextRequest("https://marktmorgen.com/api/integrations/zoom/deauthorize", {
          method: "POST",
          headers: { "content-type": "application/json", "x-zm-request-timestamp": timestamp, "x-zm-signature": signature, "x-forwarded-for": `198.51.100.${n % 250}` },
          body,
        }),
      )
    ).status;
  return { send, key: `${SEEN}${signature.slice(3, 67)}` };
}
/** The Zoom user's stores, read once each time a notice is acted on (lib/meet-connect.ts forgetUser). */
const forgotten = () => count("SMEMBERS", "nl:meet:user:zoom:");
/** forgetUser's read of the user's stores: its pipeline opens with the deletion's mark (lib/meet-connect.ts goneKey). */
const forgetRead = (c: (string | number)[]) => c[0] === "SET" && String(c[1] ?? "").startsWith("nl:meet:gone:zoom:");

async function main(): Promise<void> {
  redis.clear();

  part("The plain case: acted on once, the same notice again ignored");
  clearAnswers();
  const plain = notice();
  is("acted on, then acknowledged and ignored", [await plain.send(), await plain.send(), forgotten()], [200, 200, 1]);

  part("A notice already handled is never taken for a new one");
  for (const [shape, reply] of ODD) {
    const one = notice();
    await one.send();
    clearAnswers();
    answer(setNx(SEEN), reply);
    is(`the same notice again, the mark answered with ${shape}: acknowledged, not acted on again`, [await one.send(), forgotten()], [200, 0]);
  }

  part("The mark written and its answer lost: our own value read back, acted on once");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const one = notice();
    answer(setNx(SEEN), reply);
    is(`answered with ${shape}, the write landed: acted on`, [await one.send(), forgotten()], [200, 1]);
  }

  part("Nothing readable: not acted on, 503 so Zoom tries again, and a mark this request may have written let go");
  for (const [shape, reply] of [...UNREADABLE, ["the write failing too", THROWS] as const]) {
    clearAnswers();
    const one = notice();
    answer(setNx(SEEN), shape === "the write failing too" ? THROWS : () => ["QUEUED"]);
    answer(getOf(SEEN), reply);
    is(`the mark unknown and its read-back ${shape}: 503, not acted on, no mark left behind`, [await one.send(), forgotten(), redis.run(["EXISTS", one.key])], [503, 0, 0]);
    clearAnswers();
    is(`and Zoom's retry is acted on (${shape})`, [await one.send(), forgotten()], [200, 1]);
  }

  part("A notice that failed lets go of its own mark, never another's");
  clearAnswers();
  const failed = notice();
  // forgetUser's read now opens with the deletion's mark, then SMEMBERS, in one pipeline (lib/meet-connect.ts, Claude 5
  // zoom-forget-race): the rule matches that pipeline by its first command, and the failure and the outcome are unchanged.
  answer(forgetRead, THROWS);
  is("forgetting failed: 500, its mark let go so the retry is heard", [await failed.send(), redis.run(["EXISTS", failed.key])], [500, 0]);
  clearAnswers();
  const outlasted = notice();
  answer(forgetRead, THROWS, { before: () => void redis.run(["SET", outlasted.key, "another-request", "EX", 600]) });
  is("its mark ran out and was taken by another request: that one is left alone", [await outlasted.send(), redis.run(["GET", outlasted.key])], [500, "another-request"]);
  clearAnswers();
  done();
}

void main();
