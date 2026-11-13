/**
 * A form response is a person's by the address they gave as their own: the form's
 * first email question they answered, which is the address the store replies to and
 * offers its list to (lib/forms.ts readAnswers). Before, both a person's data copy
 * and their erasure took every response with ANY answer equal to the address, so a
 * "friend's email" question put Ana's answers in Bob's copy, and Bob's erasure
 * deleted Ana's response. A form with no email question at all is still matched by
 * any answer, since nothing else says whose it is. Synthetic data only.
 */
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, forgetFormsPerson, readResponses, writeForm } from "@/lib/form-store";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is } from "./check";

const STATS = "f".repeat(16);
const referral = parseForm({
  id: "referform1",
  name: "Refer a friend",
  fields: [
    { id: "name01", type: "short", label: "Your name", required: true },
    { id: "mine01", type: "email", label: "Your email", required: true },
    { id: "friend", type: "email", label: "Friend's email", required: false },
  ],
  offerList: false,
})!;
const plain = parseForm({ id: "plainform1", name: "Notes", fields: [{ id: "note01", type: "short", label: "Anything", required: true }], offerList: false })!;
const answer = (answers: Record<string, string>, at: number): FormResponse => ({ at, page: "/refer", answers, outcome: "", joined: false });
const copy = (email: string) => COPIERS["lib/form-store.ts"]({ statsId: STATS, email } as unknown as ErasureScope);

async function main(): Promise<void> {
  redis.clear();
  await writeForm(STATS, referral);
  await writeForm(STATS, plain);
  await addResponse(STATS, referral.id, answer({ name01: "Ana", mine01: "ana@example.com", friend: "bob@example.com" }, 1), ROOM);
  await addResponse(STATS, referral.id, answer({ name01: "Bob", mine01: " Bob@Example.com ", friend: "" }, 2), ROOM);
  await addResponse(STATS, plain.id, answer({ note01: "bob@example.com" }, 3), ROOM);

  const bobs = (await copy("bob@example.com")) as { form: string; answers: Record<string, string> }[];
  is("Bob's copy has his own referral, not Ana's", bobs.filter((r) => r.form === "Refer a friend").map((r) => r.answers["Your name"]), ["Bob"]);
  is("and a form with no email question, by any answer", bobs.filter((r) => r.form === "Notes").length, 1);
  const anas = (await copy("ana@example.com")) as { answers: Record<string, string> }[];
  is("Ana's copy has hers", anas.map((r) => r.answers["Your name"]), ["Ana"]);

  is("Bob's erasure removes his two responses", await forgetFormsPerson(STATS, "bob@example.com", ROOM), 2);
  const left = (await readResponses(STATS, referral.id)).responses.map((r) => r.answers.name01);
  is("and leaves Ana's, which names him as a friend", left, ["Ana"]);
  is("Ana's erasure then removes hers", await forgetFormsPerson(STATS, "ana@example.com", ROOM), 1);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
