/**
 * Whose a form response is, for the copy of a person's data (lib/person-copy.ts) and for their erasure
 * (lib/form-store.ts, forgetFormsPerson): the address in the form's first email question that holds one
 * (lib/form-respondent.ts), the same rule both read. Claude 6's audit R19, MEDIUM 1: Olly answers "Who referred
 * you?" with Tess's address; Tess's copy must not carry Olly's answers, and deleting Tess must not delete Olly's
 * response. Tess's address is hers, so her copy shows that answer alone and her erasure takes that answer out.
 *
 * A response no email question of the form tells the sender of (a form without one, one left empty) is "unknown":
 * the copy shows only the answers that are the address, and the erasure deletes the whole response, because
 * taking it for somebody else's would leave the person's other answers behind if it is theirs.
 */
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, forgetFormsPerson, readResponses, writeForm } from "@/lib/form-store";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { type DataStore, dataUsed, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const STATS = "r".repeat(16);
const TESS = "tess@example.com";
const OLLY = "olly@example.com";
const used = async () => (await dataUsed(ROOM))?.used ?? 0;
const copyOf = async (email: string) => (await COPIERS["lib/form-store.ts"]({ statsId: STATS, email } as ErasureScope)) as Record<string, unknown>[];
const kept = async (formId: string) => (await readResponses(STATS, formId)).responses;
/** What the room would count for exactly the responses kept now, counted afresh in a store of its own. */
let checks = 0;
const room = async (formIds: string[]) => {
  const fresh: DataStore = { ...ROOM, sid: `room-check-${(checks += 1)}` };
  for (const id of formIds) {
    const [list] = (await redis.pipeline([["LRANGE", `nl:form:r:${STATS}:${id}`, 0, -1]])) as string[][];
    const bytes = list.reduce((total, raw) => total + dataBytes([raw], 1), 0);
    if (bytes) await noteData(fresh, [{ slot: `fr:${id}`, bytes }]);
  }
  return (await dataUsed(fresh))?.used ?? 0;
};
const response = (at: number, answers: FormResponse["answers"]): FormResponse => ({ at, page: "/join", answers, outcome: "", joined: false });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const join = parseForm({
    id: "joinform01",
    name: "Join the program",
    fields: [
      { id: "email1", type: "email", label: "Your email", required: true },
      { id: "name01", type: "short", label: "Your name", required: false },
      { id: "refby1", type: "short", label: "Who referred you?", required: false },
    ],
    offerList: false,
  })!;
  const poll = parseForm({
    id: "pollform01",
    name: "Quick poll",
    fields: [
      { id: "short1", type: "short", label: "Anything else?", required: false },
      { id: "long01", type: "long", label: "Tell us more", required: false },
    ],
    offerList: false,
  })!;
  const optional = parseForm({
    id: "optform001",
    name: "Feedback",
    fields: [
      { id: "email1", type: "email", label: "Email (optional)", required: false },
      { id: "contac", type: "short", label: "How to reach you", required: false },
      { id: "note01", type: "long", label: "Feedback", required: false },
    ],
    offerList: false,
  })!;
  for (const form of [join, poll, optional]) await writeForm(STATS, form);
  const base = await used();

  await addResponse(STATS, join.id, response(10, { email1: TESS, name01: "Tess Moreau", refby1: "A podcast" }), ROOM);
  await addResponse(STATS, join.id, response(20, { email1: OLLY, name01: "Olly Grant", refby1: "Tess@Example.com " }), ROOM);
  await addResponse(STATS, poll.id, response(30, { short1: TESS, long01: "Loved the last workshop." }), ROOM);
  await addResponse(STATS, optional.id, response(40, { contac: TESS, note01: "Please slow down the videos." }), ROOM);
  await addResponse(STATS, optional.id, response(50, { email1: OLLY, note01: "Great course." }), ROOM);

  part("Tess's copy: her own response whole, never Olly's answers");
  const tess = await copyOf(TESS);
  const text = JSON.stringify(tess);
  is("her own response, all of it", tess.some((r) => (r.answers as Record<string, string>)?.["Your name"] === "Tess Moreau"), true);
  is("Olly's name is nowhere in it", text.includes("Olly Grant"), false);
  is("Olly's address is nowhere in it", text.includes(OLLY), false);
  is("Olly's feedback is nowhere in it", text.includes("Great course."), false);
  const named = tess.find((r) => r.form === "Join the program" && r.from === "another person");
  is("the answer of Olly's that is her address, alone", named?.answers, { "Who referred you?": "Tess@Example.com " });
  const unknown = tess.filter((r) => r.from === "not known").map((r) => [r.form, r.answers]);
  is("a response whose sender is not known: only the answers that are her address", unknown, [
    ["Quick poll", { "Anything else?": TESS }],
    ["Feedback", { "How to reach you": TESS }],
  ]);
  is("the other words of those responses are not in her copy", [text.includes("Loved the last workshop."), text.includes("Please slow down the videos.")], [false, false]);

  part("Olly's copy: his own responses whole, and nothing of Tess's");
  const olly = await copyOf(OLLY);
  is("his two responses", olly.map((r) => r.form).sort(), ["Feedback", "Join the program"]);
  is("his referral answer is his", olly.find((r) => r.form === "Join the program")?.answers, { "Your email": OLLY, "Your name": "Olly Grant", "Who referred you?": "Tess@Example.com " });
  is("Tess's name is not in it", JSON.stringify(olly).includes("Tess Moreau"), false);

  part("Deleting Tess: her responses go, Olly's stay without her address");
  const gone = await forgetFormsPerson(STATS, TESS, ROOM);
  is("her response, the two whose sender is not known, and her address in Olly's", gone, 4);
  const joined = await kept(join.id);
  is("Olly's response to the join form is kept", joined.map((r) => r.answers.name01), ["Olly Grant"]);
  is("with his own answers", [joined[0]?.answers.email1, joined[0]?.at], [OLLY, 20]);
  is("and without Tess's address", JSON.stringify(joined).toLowerCase().includes(TESS), false);
  is("the poll's response naming her, sender not known, is deleted whole", (await kept(poll.id)).length, 0);
  is("the feedback without an address in its email question is deleted whole", (await kept(optional.id)).map((r) => r.answers.email1), [OLLY]);
  is("the room counts exactly what is kept", (await used()) - base, await room([join.id, poll.id, optional.id]));
  is("nothing of Tess is left to copy", await copyOf(TESS), []);
  is("a second deletion finds nothing", await forgetFormsPerson(STATS, TESS, ROOM), 0);

  part("Deleting Olly: his responses go whole");
  is("both of his", await forgetFormsPerson(STATS, OLLY, ROOM), 2);
  is("nothing kept", [(await kept(join.id)).length, (await kept(optional.id)).length], [0, 0]);
  is("all the room given back", await used(), base);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
