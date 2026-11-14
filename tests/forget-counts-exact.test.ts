/**
 * Five erasure parts read their deletion's count exactly (CX-123 rule 24;
 * Claude 3 cloud I, erasure audit 14/11/2026).
 *
 * Each read its DEL or HDEL reply with `Number(reply) || 0`: a reply of another
 * shape (none, null, text) became "0 deleted", so the part answered done,
 * although the record (the team's notes about the person, the person's
 * affiliate bond, the store's calendar feed naming buyers, the person's
 * delivery-check mark, the person's waitlist places) may still be there.
 * Now a reply that is not a count throws, so lib/person-erasure.ts says the
 * erasure is not finished and a retry runs it again. Synthetic data only.
 */
import { forgetNotesPerson } from "@/lib/buyer-profile";
import { forgetBondPerson } from "@/lib/affiliate-bond";
import { forgetFeedCopyPerson } from "@/lib/calendar-sync";
import { forgetHealthPerson } from "@/lib/mail-health";
import { forgetWaitlistPerson } from "@/lib/waitlist";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const STATS = "7f1e2d3c4b5a49687f6e5d4c3b2a1908";
const EMAIL = "person@example.com";

let bad: { commands: string[]; reply: unknown[] } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (bad && bad.commands.includes(String(commands[0]?.[0]))) return bad.reply;
  return pipeline(commands);
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

const parts: [string, () => Promise<unknown>][] = [
  ["the team's notes about the person", () => forgetNotesPerson(STATS, "a".repeat(32))],
  ["the person's affiliate bond", () => forgetBondPerson(STATS, EMAIL)],
  ["the store's calendar feed copy", () => forgetFeedCopyPerson(STATS)],
  ["the person's delivery-check mark", () => forgetHealthPerson({ sid: "sid_fc", listId: "list_fc_1" }, EMAIL)],
  ["the person's waitlist places", () => forgetWaitlistPerson("sid_fc", ["prod_fc_1"], EMAIL)],
];

void (async () => {
  for (const [what, run] of parts) {
    for (const [label, reply] of [["no reply", []], ["null", [null]], ["text", ["1"]]] as const) {
      redis.clear();
      bad = { commands: ["DEL", "HDEL"], reply: [...reply] };
      is(`${what}: a deletion answered ${label} is not done`, await outcome(run), "rejected: UnknownReplyError");
      bad = null;
    }
    redis.clear();
    is(`${what}: nothing there is a confirmed 0`, await outcome(run), 0);
  }
  done();
})();
