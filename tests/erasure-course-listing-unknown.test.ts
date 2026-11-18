/**
 * Cases from Claude 6's closed duplicate #3127 (1e65c0f47), adapted to #3119.
 *
 * A person's deletion in a store whose course product is read from its own
 * listing record (rule 24: an unknown or off-shape reply is never read as
 * "no such product"; lib/person-erasure.ts erasureScope, lib/catalog.ts
 * readKindExact).
 *
 * readKind, through readListings, leaves out a product whose listing record
 * does not read (a GET that answers short, in another shape, or text that
 * does not parse). In a store big enough that the course product is past the
 * catalog's head, the course then dropped out of the scope and the deletion
 * answered done while the person's progress, quizzes and certificates were
 * all still kept. Now the scope reads them exactly: an unknown read throws,
 * the deletion answers "unavailable" and deletes none of their course
 * records, so pressing again finishes it.
 *
 * Synthetic: an in-memory Redis whose replies are bent, no email or Stripe call
 * leaves the process.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson, snapshot } from "./erasure-world";
import { erasePerson, erasureScope } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { emailKey } from "@/lib/learn";
import type { Store } from "@/lib/store";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let listing = "";
/** How the course product's listing GET is answered. */
let bend: "none" | "number" | "list" | "unparsable" | "short" | "throw" = "none";
redis.pipeline = (async (commands: Command[]) => {
  const hits = commands.some((c) => c[0] === "GET" && c[1] === listing);
  if (hits && bend === "throw") throw new Error("Redis request failed with status 503");
  const replies = await real(commands);
  if (!hits) return replies;
  if (bend === "short") return replies.slice(1);
  commands.forEach((c, i) => {
    if (c[0] !== "GET" || c[1] !== listing) return;
    if (bend === "number") replies[i] = 7;
    if (bend === "list") replies[i] = [replies[i]];
    if (bend === "unparsable") replies[i] = "{not json";
  });
  return replies;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_erasure_listing_unknown_stand_in";
  process.env.RESEND_API_KEY = "re_test_erasure_listing_unknown_stand_in";
  const world = await makeWorld();
  const tess = normaliseEmail("tess@example.com");
  await seedPerson(world, tess, null);
  const learner = emailKey(tess);
  // A big store: the course product is past the catalog's head, so its listing is read from its own record.
  const catalog = world.store.catalog;
  const big: Store = { ...world.store, catalog: { ...catalog, head: catalog.head.filter((l) => l.id !== world.courseProduct) } };
  listing = `nl:catalog:${catalog.id}:l:${world.courseProduct}`;
  const courseRecords = async () =>
    [...(await snapshot())].filter(([k, v]) => (k.includes(world.courseId) || world.lessons.some((l) => k.includes(l))) && (k.includes(learner) || v.includes(learner) || k.includes(tess) || v.includes(tess))).length;

  part("Setup");
  is("the catalog keeps its own records", typeof catalog.id === "string" && catalog.inline === null, true);
  is("the course product's listing record is there", (await real([["EXISTS", listing]]))[0], 1);
  const plain = await erasureScope(big, tess);
  is("the store has one course, read from its listing record, and the person is in it", plain?.courses.length, 1);
  const kept = await courseRecords();
  is("several of their course records are kept", kept > 3, true);

  for (const how of ["number", "list", "unparsable", "short", "throw"] as const) {
    part(`A deletion while the course product's listing reads as ${how}`);
    bend = how;
    const scope = await erasureScope(big, tess).then((s) => (s ? s.courses.length : "none"), () => "unknown");
    const result = await erasePerson(big, tess, { kind: "person" });
    bend = "none";
    is("the scope is unknown, never a store without that course", scope, "unknown");
    is("the deletion never answers done", [result.ok, result.ok ? "" : result.reason], [false, "unavailable"]);
    is("and nothing of their courses was taken on that guess, so pressing again finishes it", await courseRecords(), kept);
  }

  part("Pressed again once the listing reads");
  const again = await erasePerson(big, tess, { kind: "person" });
  is("done", again.ok, true);
  is("and none of their course records is kept", await courseRecords(), 0);

  part("A listing Redis confirms is not there");
  await real([["DEL", listing]]);
  const gone = await erasureScope(big, tess);
  is("is left out of the scope, as an outline that is not there", gone?.courses.length, 0);
  is("and a deletion still finishes", (await erasePerson(big, tess, { kind: "person" })).ok, true);

  done();
}

void main();
