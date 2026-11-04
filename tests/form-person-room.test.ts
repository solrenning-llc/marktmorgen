/**
 * Deleting a person (lib/person-erasure.ts) takes their form responses out
 * and gives back to the store's data room exactly what each took when it
 * was kept (lib/form-store.ts, addResponse), once.
 */
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, forgetFormsPerson, readResponses, writeForm } from "@/lib/form-store";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const STATS = "f".repeat(16);
const answer = (email: string, at: number, note = "Hello"): FormResponse => ({ at, page: "/apply", answers: { email1: email, note1: note }, outcome: "", joined: false });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const form = parseForm({ id: "applyform1", name: "Application", fields: [{ id: "email1", type: "email", label: "Email", required: true }, { id: "note1", type: "text", label: "Note", required: false }], offerList: false })!;
  const other = parseForm({ id: "otherform1", name: "Waitlist", fields: [{ id: "email1", type: "email", label: "Email", required: true }], offerList: false })!;
  await writeForm(STATS, form);
  await writeForm(STATS, other);

  part("A deleted person's responses give their room back, exactly and once");
  await addResponse(STATS, form.id, answer("ben@example.com", 1), ROOM);
  await addResponse(STATS, other.id, answer("ben@example.com", 2), ROOM);
  const withBen = await used();
  await addResponse(STATS, form.id, answer("ana@example.com", 3, "A long note about the course and the team"), ROOM);
  await addResponse(STATS, form.id, answer("Ana@Example.com ", 4), ROOM);
  await addResponse(STATS, other.id, answer("ana@example.com", 5), ROOM);
  is("Ana's responses take room", (await used()) > withBen, true);
  is("three responses of Ana's deleted", await forgetFormsPerson(STATS, "ana@example.com", ROOM), 3);
  is("exactly their room given back", await used(), withBen);
  is("Ben's are kept", [(await readResponses(STATS, form.id)).total, (await readResponses(STATS, other.id)).total], [1, 1]);
  is("a second deletion deletes and gives back nothing", [await forgetFormsPerson(STATS, "ana@example.com", ROOM), await used()], [0, withBen]);

  part("The same response kept twice goes, and gives back, twice");
  const twice = answer("cy@example.com", 6);
  await addResponse(STATS, form.id, twice, ROOM);
  await addResponse(STATS, form.id, twice, ROOM);
  is("both deleted", await forgetFormsPerson(STATS, "cy@example.com", ROOM), 2);
  is("both given back", await used(), withBen);

  part("Without a room nothing is counted, and nothing breaks");
  is("Ben deleted", await forgetFormsPerson(STATS, "ben@example.com"), 2);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
