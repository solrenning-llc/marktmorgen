/**
 * A person's form answers are deleted only after which forms there are is read
 * exactly (lib/form-store.ts forgetFormsPerson, Codex G on #2584): a missing
 * reply, a hole, a non-list, a value of another type or one that is not a form
 * leaves the deletion unknown, so it is refused and nothing is taken for gone.
 * A confirmed empty inventory is still a valid absence. Codex G's
 * tests/g-2584-forms-discovery.proof.ts, ported to a test the suite runs, with
 * the same assertions. Synthetic only.
 */
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, forgetFormsPerson, readResponses, writeForm } from "@/lib/form-store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const stats = "g".repeat(16);
  const email = "private@example.com";
  const form = parseForm({ id: "exactform1", name: "Application", fields: [{ id: "email1", type: "email", label: "Email", required: true }], offerList: false });
  if (!form) throw new Error("no form");
  const answer: FormResponse = { at: 1, page: "/apply", answers: { email1: email }, outcome: "", joined: false };
  const real = redis.pipeline.bind(redis);

  part("Which forms there are, read in another shape: the deletion is refused, nothing taken for gone");
  for (const [label, bad] of [["missing", []], ["undefined", [undefined]], ["null", [null]], ["wrong-type", [0]], ["sparse", [new Array(1)]], ["unparseable", [["broken JSON"]]]] as [string, unknown[]][]) {
    redis.clear();
    await writeForm(stats, form);
    await addResponse(stats, form.id, answer, ROOM);
    let refused = false;
    redis.pipeline = (async (commands: (string | number)[][]) => (commands.some((c) => c[0] === "HVALS" && c[1] === `nl:forms:${stats}`) ? bad : real(commands))) as typeof redis.pipeline;
    try {
      await forgetFormsPerson(stats, email, ROOM);
    } catch {
      refused = true;
    } finally {
      redis.pipeline = real;
    }
    is(`${label}: the private answer is still kept`, (await readResponses(stats, form.id)).total, 1);
    is(`${label}: an unknown inventory fails the deletion`, refused, true);
    is(`${label}: read again in its shape, the deletion takes it`, await forgetFormsPerson(stats, email, ROOM), 1);
  }

  part("A confirmed empty inventory is a valid absence");
  redis.clear();
  is("no form: nothing to delete", await forgetFormsPerson(stats, email, ROOM), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
