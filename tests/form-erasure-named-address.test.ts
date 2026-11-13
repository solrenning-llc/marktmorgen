/**
 * A person's erasure takes their address out of every other person's form
 * response too (Codex L's and Claude 2's review of #4436). A response is its
 * sender's (`by`, lib/form-store.ts isResponderOf), so Bob's erasure keeps Ana's
 * "refer a friend" response; but an answer in it that is Bob's address is Bob's
 * personal data, and it was left there after his erasure. Now the erasure empties
 * that answer inside Ana's response, on the Redis side in the same script that
 * deletes Bob's own responses, keeps everything else of Ana's response as it was,
 * and gives back to the data room what the response no longer takes. Synthetic
 * data only.
 */
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, forgetFormsPerson, readResponses, writeForm } from "@/lib/form-store";
import { dataUsed } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const STATS = "e".repeat(16);
const fields = [
  { id: "name01", type: "short", label: "Your name", required: true },
  { id: "mine01", type: "email", label: "Your email", required: true },
  { id: "friend", type: "email", label: "Friend's email", required: false },
  { id: "other1", type: "email", label: "Another friend's email", required: false },
  { id: "pick01", type: "choices", label: "Topics", required: false, options: [{ id: "opta01", label: "A" }, { id: "optb01", label: "B" }] },
];
const referral = parseForm({ id: "namedform1", name: "Refer a friend", fields, offerList: false })!;
const answer = (answers: FormResponse["answers"], at: number, by?: string): FormResponse => ({ at, page: "/refer", answers, outcome: "", joined: false, ...(by !== undefined ? { by } : {}) });
const used = async () => (await dataUsed(ROOM))?.used ?? 0;
const kept = async (): Promise<string[]> => {
  const [list] = await redisPipeline([["LRANGE", `nl:form:r:${STATS}:${referral.id}`, 0, -1]]);
  return Array.isArray(list) ? (list as string[]) : [];
};
const holds = (list: string[], text: string) => list.some((raw) => raw.toLowerCase().includes(text));

async function main(): Promise<void> {
  part("Bob's address in Ana's response is emptied by Bob's erasure");
  redis.clear();
  await writeForm(STATS, referral);
  const ana = answer({ name01: "Ana", mine01: "ana@example.com", friend: "bob@example.com", other1: " Bob@Example.COM ", pick01: [] }, 1, "ana@example.com");
  await addResponse(STATS, referral.id, ana, ROOM);
  await addResponse(STATS, referral.id, answer({ name01: "Bob", mine01: "bob@example.com", friend: "" }, 2, "bob@example.com"), ROOM);
  await addResponse(STATS, referral.id, answer({ name01: "Cleo", mine01: "cleo@example.com", friend: "bob@example.com.br" }, 3, "cleo@example.com"), ROOM);
  const before = await kept();
  const roomBefore = await used();
  is("Bob's erasure removes only his own response", await forgetFormsPerson(STATS, "bob@example.com", ROOM), 1);
  const after = await readResponses(STATS, referral.id);
  is("Ana's and Cleo's responses are kept", after.responses.map((r) => r.answers.name01), ["Cleo", "Ana"]);
  const anas = after.responses.find((r) => r.answers.name01 === "Ana")!;
  is("Ana's answers that were Bob's address are empty", [anas.answers.friend, anas.answers.other1], ["", ""]);
  is("and the rest of her response is as she sent it", { ...anas, answers: { ...anas.answers, friend: "bob@example.com", other1: " Bob@Example.COM " } }, ana);
  is("Bob's address is nowhere in the store's responses", holds(await kept(), "bob@example.com\""), false);
  is("an address that only begins like Bob's is someone else's, and kept", after.responses.find((r) => r.answers.name01 === "Cleo")!.answers.friend, "bob@example.com.br");
  const list = await kept();
  // What went: Bob's own response whole, and what Ana's no longer takes.
  const gone = before.filter((raw) => !list.includes(raw));
  const taken = (raws: string[]) => raws.reduce((sum, raw) => sum + dataBytes([raw], 1), 0);
  is("the data room gives back exactly what is no longer kept", await used(), roomBefore - taken(gone) + taken(list.filter((raw) => !before.includes(raw))));
  is("a second erasure of Bob finds nothing more", await forgetFormsPerson(STATS, "bob@example.com", ROOM), 0);
  is("and changes nothing", await kept(), list);
  is("Ana's erasure then removes hers whole", await forgetFormsPerson(STATS, "ana@example.com", ROOM), 1);
  is("Cleo's erasure removes hers", await forgetFormsPerson(STATS, "cleo@example.com", ROOM), 1);
  is("and the room is back to nothing", await used(), 0);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
