/**
 * Durable RED for #2669: the shared erasure world must keep its seeded quiz
 * attempt readable by the real person-copy path.
 */
import { normaliseEmail } from "@/lib/auth";
import { copyPerson } from "@/lib/person-copy";
import { erasureScope } from "@/lib/person-erasure";
import { storeForEmail } from "@/lib/store";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_quiz_attempt_person_copy_red";
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const world = await makeWorld("quiz-attempt-copy-red");
  const person = normaliseEmail("tess.trent@example.com");
  await seedPerson(world, person, null);
  const store = (await storeForEmail(OWNER))!;
  const scope = await erasureScope(store, person);
  if (!scope) throw new Error("no erasure scope");

  const copy = await copyPerson(scope);
  is("the real person copy can read the seeded quiz attempt", copy.sections.some((section) => section.module === "lib/quiz.ts"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
