/**
 * A form response is a person's by the address they gave as their own, kept with
 * the response when it is sent (`by`: the form's first email question they
 * answered, the address the store replies to and offers its list to, lib/forms.ts
 * readAnswers). Before, both a person's data copy and their erasure took every
 * response with ANY answer equal to the address, so a "friend's email" question put
 * Ana's answers in Bob's copy and Bob's erasure deleted Ana's response. Deciding by
 * the form's questions as they stand now failed too once the creator deleted,
 * retyped or reordered the email question (review of #4436). A response kept before
 * `by` existed is still matched by any answer, which erases more rather than leave
 * data behind. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, forgetFormsPerson, readResponses, writeForm } from "@/lib/form-store";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const STATS = "f".repeat(16);
const fields = [
  { id: "name01", type: "short", label: "Your name", required: true },
  { id: "mine01", type: "email", label: "Your email", required: true },
  { id: "friend", type: "email", label: "Friend's email", required: false },
];
const referral = parseForm({ id: "referform1", name: "Refer a friend", fields, offerList: false })!;
const plain = parseForm({ id: "plainform1", name: "Notes", fields: [{ id: "note01", type: "short", label: "Anything", required: true }], offerList: false })!;
const answer = (answers: Record<string, string>, at: number, by?: string): FormResponse => ({ at, page: "/refer", answers, outcome: "", joined: false, ...(by !== undefined ? { by } : {}) });
const copy = (email: string) => COPIERS["lib/form-store.ts"]({ statsId: STATS, email } as unknown as ErasureScope);
type Copied = { form: string; answers: Record<string, string> };

async function world(): Promise<void> {
  redis.clear();
  await writeForm(STATS, referral);
  await writeForm(STATS, plain);
  await addResponse(STATS, referral.id, answer({ name01: "Ana", mine01: "ana@example.com", friend: "bob@example.com" }, 1, "ana@example.com"), ROOM);
  await addResponse(STATS, referral.id, answer({ name01: "Bob", mine01: "bob@example.com", friend: "" }, 2, "bob@example.com"), ROOM);
  await addResponse(STATS, plain.id, answer({ note01: "bob@example.com" }, 3, ""), ROOM);
}

async function main(): Promise<void> {
  part("By the address kept with each response");
  await world();
  const bobs = (await copy("bob@example.com")) as Copied[];
  is("Bob's copy has his own referral, not Ana's", bobs.filter((r) => r.form === "Refer a friend").map((r) => r.answers["Your name"]), ["Bob"]);
  is("and a response that names no address, by any answer", bobs.filter((r) => r.form === "Notes").length, 1);
  is("Ana's copy has hers", ((await copy("ana@example.com")) as Copied[]).map((r) => r.answers["Your name"]), ["Ana"]);
  is("Bob's erasure removes his two responses", await forgetFormsPerson(STATS, "bob@example.com", ROOM), 2);
  is("and leaves Ana's, which names him as a friend", (await readResponses(STATS, referral.id)).responses.map((r) => r.answers.name01), ["Ana"]);
  is("Ana's erasure then removes hers", await forgetFormsPerson(STATS, "ana@example.com", ROOM), 1);

  part("The creator changes the email questions after the answers came in");
  await world();
  // The friend's question first, the person's own question made a short answer.
  await writeForm(STATS, parseForm({ ...referral, fields: [fields[2], fields[0], { ...fields[1], type: "short" }] })!);
  is("Bob's copy still has only his", ((await copy("bob@example.com")) as Copied[]).filter((r) => r.form === "Refer a friend").map((r) => r.answers["Your name"]), ["Bob"]);
  is("Bob's erasure still leaves Ana's", await forgetFormsPerson(STATS, "bob@example.com", ROOM), 2);
  is("Ana's erasure still finds hers", await forgetFormsPerson(STATS, "ana@example.com", ROOM), 1);
  await world();
  await writeForm(STATS, parseForm({ ...referral, fields: [fields[0]] })!);
  is("with the email questions deleted, Ana's erasure still finds hers", await forgetFormsPerson(STATS, "ana@example.com", ROOM), 1);

  part("A response kept before the address was");
  redis.clear();
  await writeForm(STATS, referral);
  await addResponse(STATS, referral.id, answer({ name01: "Old", mine01: "old@example.com", friend: "bob@example.com" }, 1), ROOM);
  is("is matched by any answer, so nothing about the person stays behind", await forgetFormsPerson(STATS, "bob@example.com", ROOM), 1);

  part("The form's page keeps the address with the response");
  const route = readFileSync(join(process.cwd(), "app/api/store/form/route.ts"), "utf8");
  is("the response is written with by: read.email", /addResponse\([^;]*by: read\.email/.test(route), true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
