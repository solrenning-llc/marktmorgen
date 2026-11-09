/**
 * Whose a form response is, for the copy of a person's data (lib/person-copy.ts) and for their erasure
 * (lib/form-store.ts, forgetFormsPerson): the address the form's email questions hold, when they hold one and the
 * same one (lib/form-respondent.ts), the same rule both read. Claude 6's audit R19, MEDIUM 1: Olly answers "Who referred
 * you?" with Tess's address; Tess's copy must not carry Olly's answers, and deleting Tess must not delete Olly's
 * response. Tess's address is hers, so her copy shows that answer alone and her erasure takes that answer out.
 *
 * A response no email question of the form tells the sender of (a form without one, one left empty, two holding
 * different addresses) is "unknown":
 * the copy shows only the answers that are the address, and the erasure deletes the whole response, because
 * taking it for somebody else's would leave the person's other answers behind if it is theirs.
 */
import { readFileSync } from "node:fs";
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, forgetFormsPerson, readResponses, writeForm } from "@/lib/form-store";
import { COPIERS, COPY_PLAN } from "@/lib/person-copy";
import { formDealDraft } from "@/lib/form-deal";
import { emailQuestionIds, respondentOf } from "@/lib/form-respondent";
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
  // Claude 5's pre-review of this branch, LIGHT 1: the copy's own line said "Your answers to the store's forms", which
  // promises a whole response that is hers but whose sender cannot be told (the poll above, sent with no email
  // question). It says what comes: the whole response only when its email questions give her address and no other.
  is("the copy's line says what comes, and no more", COPY_PLAN["lib/form-store.ts"], { how: "copied", what: "Each response to the store's forms whose email questions give your address and no other, all of it. From any other response, only the answers that are your address" });

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

  part("The deal drafted from a response names the same sender");
  const twoEmails = parseForm({ id: "twomailfrm", name: "Two emails", fields: [{ id: "email1", type: "email", label: "Friend's email", required: false }, { id: "email2", type: "email", label: "Your email", required: true }, { id: "refby1", type: "short", label: "Note", required: false }], offerList: false })!;
  const sender = (answers: FormResponse["answers"]) => formDealDraft(twoEmails, response(1, answers)).email;
  // Rule 23 (Claude 5's pre-review of this branch, HIGH): this used to take the first email question that holds an
  // address, here a friend's, for the sender. Two email questions with different addresses cannot tell who sent it,
  // so the draft names nobody (the copy and the erasure read it as "unknown"); the same address in both still tells.
  is("two email questions with different addresses: nobody", sender({ email1: "Ana@Example.com", email2: OLLY }), "");
  is("the same address in both: that one", sender({ email1: "Olly@Example.com ", email2: OLLY }), OLLY);
  is("an empty or broken one is passed over", [sender({ email1: "", email2: OLLY }), sender({ email1: "not an address", email2: OLLY })], [OLLY, OLLY]);
  is("an address in another question never is", sender({ refby1: TESS }), "");
  is("the same as the copy and the erasure read", respondentOf(emailQuestionIds(twoEmails), { email1: "not an address", email2: OLLY, refby1: TESS }), OLLY);

  part("The deal's note never copies an address that is not the sender's");
  // Claude 5's pre-review of this branch, LIGHT 3 (already on main): the note copied every answer, a friend's or a
  // referrer's address included, and deleting that person deletes only the deals that name them as the contact, so the
  // copy in another person's deal stayed. Now an answer that is an address other than the sender's never goes into the
  // note; the sender's own address is the deal's contact, and deleting the sender deletes the deal.
  const note = (answers: FormResponse["answers"]) => formDealDraft(twoEmails, response(1, answers)).note;
  const known = note({ email1: "Ana@Example.com", email2: "Ana@example.com", refby1: "Tess@Example.com " });
  is("a known sender: their address is kept, a referrer's is not", [known.includes("Friend's email: Ana@Example.com"), known.toLowerCase().includes(TESS)], [true, false]);
  const friend = note({ email1: "", email2: OLLY, refby1: TESS });
  is("an address in another question is left out, the sender's kept", [friend.includes("Your email: " + OLLY), friend.includes(TESS), friend.includes("Note:")], [true, false, false]);
  const unknownNote = note({ email1: "Ana@Example.com", email2: OLLY, refby1: "Bring your laptop" });
  is("the sender not known: no address at all, the other answers kept", [unknownNote.toLowerCase().includes("ana@example.com"), unknownNote.includes(OLLY), unknownNote.includes("Note: Bring your laptop")], [false, false, true]);
  // Claude 5's pre-review of this branch, LIGHT (VR 2): with the sender not known, the deal has no contact, and the
  // note dropped the email questions' lines whole, so the creator could not tell an address had been given. Each
  // line stays, with the address itself never copied.
  is("the sender not known: each line that held an address stays, without it", [unknownNote.includes("Friend's email: (address not copied)"), unknownNote.includes("Your email: (address not copied)")], [true, true]);
  const invited = parseForm({ id: "invitefrm1", name: "Invite", fields: [{ id: "friend", type: "email", label: "Invite a friend (email)", required: false }, { id: "yours1", type: "email", label: "Your email", required: true }], offerList: true })!;
  const inviteDraft = formDealDraft(invited, response(1, { friend: TESS, yours1: OLLY }));
  is("the invite form: no contact, both lines kept, neither address", [inviteDraft.email, inviteDraft.note.split("\n").slice(-2), inviteDraft.note.includes(TESS) || inviteDraft.note.includes(OLLY)], ["", ["Invite a friend (email): (address not copied)", "Your email: (address not copied)"], false]);
  is("a known sender: a friend's address is still left out whole", note({ email1: "", email2: OLLY, refby1: TESS }).includes("(address not copied)"), false);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the privacy policy says so", privacy.includes("the deal&apos;s note copies the answers but never an email address other than the sender&apos;s, and a deal is deleted with the person it names as its contact."), true);
  is("a text that is not only an address is the person's words, kept as typed", note({ email2: OLLY, refby1: "Ask tess@example.com too" }).includes("Note: Ask tess@example.com too"), true);

  part("A response that does not read and holds her address is deleted, never taken for somebody else's");
  const key = `nl:form:r:${STATS}:${join.id}`;
  await redis.pipeline([["RPUSH", key, `{"at":"later","answers":{"email1":"${TESS}"}}`, "not a response at all"]]);
  is("the one with her address goes", await forgetFormsPerson(STATS, TESS), 1);
  is("the one without it stays", (await redis.pipeline([["LRANGE", key, 0, -1]]))[0], ["not a response at all"]);
  await redis.pipeline([["DEL", key]]);

  part("A reply from the script in any other shape is unknown: nothing given back");
  await addResponse(STATS, join.id, response(60, { email1: OLLY, refby1: TESS }), ROOM);
  const before = await used();
  const raw = JSON.stringify(response(60, { email1: OLLY, refby1: TESS }));
  const keptRaw = JSON.stringify(response(60, { email1: OLLY }));
  const real = redis.pipeline.bind(redis) as typeof redis.pipeline;
  for (const bad of [[[1, raw, 1]], [[1, raw, 2, keptRaw]], [[1, raw, 1, "not a response"]], [[1, raw, 1, raw]], [[1, raw, 1, 5]], [[1, raw, 0, ""]], [[9, raw, 1, ""]], [[1, raw, 1, ""], 0]]) {
    redis.pipeline = (async (commands: (string | number)[][]) => (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:form-forget:")) ? bad : real(commands))) as typeof redis.pipeline;
    let refused = false;
    try {
      await forgetFormsPerson(STATS, TESS, ROOM);
    } catch {
      refused = true;
    } finally {
      redis.pipeline = real;
    }
    is(`refused on ${JSON.stringify(bad).slice(0, 60)}`, [refused, await used()], [true, before]);
  }
  is("then her address goes out of it for real", await forgetFormsPerson(STATS, TESS, ROOM), 1);
  is("and Olly's response stays", (await kept(join.id)).map((r) => r.answers), [{ email1: OLLY }]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
