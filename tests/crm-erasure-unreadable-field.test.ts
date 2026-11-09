/**
 * A person's erasure, by the real door (lib/person-erasure.ts, erasePerson),
 * when the store's fields record holds a field that does not read, and a
 * value is kept for the person under it (CX-123 rules 24 and 30; merge of
 * #2901 with main).
 *
 * A lenient fields read (one that drops the entry it cannot read) would let
 * forgetCrmPerson delete the other answers and the deal, count them, and
 * confirm, with the value under the unreadable field still kept for the
 * person. The fields are read whole (readFields delegates to
 * readFieldsWhole): the CRM part fails and says so, the erasure answers
 * "incomplete" naming lib/crm.ts, and nothing of the person's CRM records is
 * taken on that guess. Once the record reads again, pressing again takes
 * every answer, the one under that field included.
 *
 * Synthetic store and person only, in the in-memory Redis stand-in.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { personKey } from "@/lib/person-key";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_crm_erasure_unreadable_stand_in";
  process.env.RESEND_API_KEY = "re_test_crm_erasure_unreadable_stand_in";
  const world = await makeWorld();
  const ana = normaliseEmail("ana@example.com");
  await seedPerson(world, ana, null);
  const statsId = world.store.statsId as string;
  const person = personKey(statsId, ana);
  const fieldsKey = `nl:crm:fields:${statsId}`;
  const dealsKey = `nl:crm:deals:${statsId}`;
  // A second field whose entry does not read (a type no field has), with Ana's answer kept under it.
  const odd = { id: "fld002", name: "Old tier", type: "not-a-type", options: [] };
  await redis.pipeline([
    ["SET", fieldsKey, JSON.stringify([world.field, odd])],
    ["HSET", `nl:crm:v:${statsId}:${odd.id}`, person, "Platinum"],
  ]);
  const kept = async () => {
    const [readable, unreadable, deals] = await redis.pipeline([
      ["HGET", `nl:crm:v:${statsId}:${world.field.id}`, person],
      ["HGET", `nl:crm:v:${statsId}:${odd.id}`, person],
      ["HGETALL", dealsKey],
    ]);
    const theirDeals = (deals as string[]).filter((value, i) => i % 2 === 1 && value.includes(ana)).length;
    return { readable, unreadable, theirDeals };
  };

  part("Setup");
  is("Ana has an answer under each field and a deal", await kept(), { readable: "Gold", unreadable: "Platinum", theirDeals: 1 });

  part("Erased while a field of the fields record does not read");
  const result = await erasePerson(world.store, ana, { kind: "person" });
  is("the erasure never answers done", [result.ok, result.ok ? "" : result.reason], [false, "incomplete"]);
  is("and it names the CRM as the part that did not finish", !result.ok && result.reason === "incomplete" ? result.failed.includes("lib/crm.ts") : false, true);
  is("the CRM part is never listed among what was erased", result.ok || result.reason !== "incomplete" ? "n/a" : result.parts.some((p) => p.module === "lib/crm.ts"), false);
  is("nothing of Ana's CRM records was taken on that guess, the value under the unreadable field included", await kept(), { readable: "Gold", unreadable: "Platinum", theirDeals: 1 });

  part("Pressed again once the fields record reads");
  await redis.pipeline([["SET", fieldsKey, JSON.stringify([world.field, { ...odd, type: "text" }])]]);
  const again = await erasePerson(world.store, ana, { kind: "person" });
  is("done", again.ok, true);
  is("every answer of Ana's and her deal are gone, the one under that field included", await kept(), { readable: null, unreadable: null, theirDeals: 0 });

  done();
}

void main();
