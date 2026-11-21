/**
 * #4810 (Codex G, transcribed by Claude 2; coordinator's note 6998817601 on #2287): a person's CRM erasure must never
 * read a deal it cannot parse as somebody else's. A truncated value such as `{"email":"person@example.com"` names the
 * person but does not read; before this, forgetCrmPerson filtered it out of "theirs", sent no HDEL for it and answered
 * done, with the address still stored. Now any deal value that does not read as an object makes the step unknown
 * (UnknownReplyError) before anything is deleted, so the erasure says it did not finish. Synthetic data, in-memory Redis.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { forgetCrmPerson } from "@/lib/crm";
import { personKey } from "@/lib/person-key";

const settled = (run: () => Promise<unknown>) => run().then((v) => ({ ok: true, v }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }));

async function main(): Promise<void> {
  const statsId = "crm_erasure_stats";
  const email = "person@example.com";
  const key = `nl:crm:deals:${statsId}`;
  const other = JSON.stringify({ email: "someone-else@example.com", title: "Synthetic other deal" });

  for (const [label, raw] of [
    ["a truncated deal naming the person", `{"email":"${email}"`],
    ["a deal that is JSON but not an object", JSON.stringify([email])],
    ["a deal that is a bare string", JSON.stringify(email)],
  ] as const) {
    part(`A store's deals hold ${label}`);
    redis.clear();
    await redis.pipeline([["HSET", key, "deal_1", raw, "deal_2", other]]);
    is("the erasure does not answer done", await settled(() => forgetCrmPerson(statsId, personKey(statsId, email), email)), { ok: false, error: "UnknownReplyError" });
    const [kept, untouched] = await redis.pipeline([["HGET", key, "deal_1"], ["HGET", key, "deal_2"]]);
    is("the unreadable deal is not taken on a guess", kept, raw);
    is("and somebody else's deal is untouched", untouched, other);
  }
  done();
}

void main();
