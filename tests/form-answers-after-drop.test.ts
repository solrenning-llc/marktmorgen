/**
 * Synthetic only (#4368, Codex L): a form submission that read the form before its deletion and keeps its answer after
 * it must not create the answer list again. The deletion removed the definition, so a person's erasure (which walks the
 * current forms) would never reach that list: an answer holding the person's address would outlive the erasure.
 * The keep checks the form in the same step as the write, and the room charged for the answer is given back.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, dropForm, forgetFormsPerson, writeForm } from "@/lib/form-store";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  redis.clear();
  const STATS = "h".repeat(16);
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const form = parseForm({ id: "lateform01", name: "Application", fields: [{ id: "email1", type: "email", label: "Email", required: true }], offerList: false })!;
  const answer: FormResponse = { id: "a".repeat(32), at: 1, page: "/apply", answers: { email1: "late@example.com" }, outcome: "", joined: false };
  const key = `nl:form:r:${STATS}:${form.id}`;

  part("Control: an answer to a form that exists is kept");
  await writeForm(STATS, form);
  await addResponse(STATS, form.id, answer, ROOM);
  is("the answer is kept", redis.run(["LLEN", key]), 1);

  part("A submission that read the form before its deletion keeps its answer after it (Codex L, #4368)");
  is("the deletion succeeds", await dropForm(STATS, form.id, ROOM), true);
  const before = await used();
  let refused = false;
  try {
    await addResponse(STATS, form.id, { ...answer, id: "b".repeat(32) }, ROOM);
  } catch {
    refused = true;
  }
  is("[CORRETO] the late answer is declined (the form is gone)", refused, true);
  is("[CORRETO] no answer list exists for the deleted form", redis.run(["EXISTS", key]), 0);
  is("[CORRETO] the room charged for it is given back", await used(), before);
  is("person erasure finds nothing to delete", await forgetFormsPerson(STATS, "late@example.com", ROOM), 0);
  is("[CORRETO] and no answer with the person's address survives the erasure", redis.run(["LLEN", key]), 0);
  done();
}

void main();
