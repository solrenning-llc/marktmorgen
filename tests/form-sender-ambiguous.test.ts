/**
 * Pre-review proof (Claude 5 on the R19 MEDIUM 1 fix): a form whose first email question is not the sender's, here
 * "Invite a friend (email)" before "Your email". Taking the first email question that holds an address as the sender
 * made the friend the sender, so deleting the person who really sent it left their name behind. When two email
 * questions hold different addresses, who sent the response cannot be told: it is "unknown", whose erasure deletes it
 * whole and whose copy gives only the answers that are the person's address (lib/form-respondent.ts).
 */
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, forgetFormsPerson, readResponses, writeForm } from "@/lib/form-store";
import { COPIERS } from "@/lib/person-copy";
import { emailQuestionIds, respondentOf } from "@/lib/form-respondent";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const STATS = "p".repeat(16);
const TESS = "tess@example.com";
const OLLY = "olly@example.com";
const copyOf = async (email: string) => (await COPIERS["lib/form-store.ts"]({ statsId: STATS, email } as ErasureScope)) as Record<string, unknown>[];
const response = (at: number, answers: FormResponse["answers"]): FormResponse => ({ at, page: "/x", answers, outcome: "", joined: false });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const invite = parseForm({
    id: "invitefrm1",
    name: "Invite",
    fields: [
      { id: "friend", type: "email", label: "Invite a friend (email)", required: false },
      { id: "yours1", type: "email", label: "Your email", required: true },
      { id: "name01", type: "short", label: "Your name", required: false },
    ],
    offerList: false,
  })!;
  await writeForm(STATS, invite);
  await addResponse(STATS, invite.id, response(10, { friend: TESS, yours1: OLLY, name01: "Olly Grant" }), ROOM);

  part("Two email questions with different addresses: who sent it cannot be told");
  is("not the friend", respondentOf(emailQuestionIds(invite), { friend: TESS, yours1: OLLY }), null);
  is("the same address twice still tells", respondentOf(emailQuestionIds(invite), { friend: OLLY, yours1: "Olly@Example.com " }), OLLY);

  part("Tess's copy must not carry Olly's name");
  is("no Olly name in Tess's copy", JSON.stringify(await copyOf(TESS)).includes("Olly Grant"), false);

  part("Deleting Olly must delete his name");
  await forgetFormsPerson(STATS, OLLY, ROOM);
  is("Olly's name gone", JSON.stringify((await readResponses(STATS, invite.id)).responses).includes("Olly Grant"), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
