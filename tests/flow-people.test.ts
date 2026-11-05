/**
 * Sequences that act on the store's own people, and that start with a form
 * (lib/flow-rules.ts, lib/flows.ts; added 13 October 2026). Checked:
 *
 *   - saving refuses a field the store does not have, a value the field does
 *     not keep, a stage the board does not have, a note with no words, and a
 *     form that does not ask for an address;
 *   - a form sent by somebody on the list starts the sequences that start
 *     with it, once; somebody not on the list starts nothing;
 *   - the steps set the field, put the person's deal in the stage (made for
 *     them when they have none open, moved when they have one), write a note
 *     on their page, and tell the owner by email who reached the step;
 *   - a sign-up asked from a form remembers the form, so confirming starts it;
 *   - a workflow can start only for one of a quiz's results, and a sign-up
 *     from the quiz remembers that result too.
 */
import { readAction } from "@/lib/flow-rules";
import { enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { readDeals, readStages, readValues, writeDeal, writeFields } from "@/lib/crm";
import { writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { personKey } from "@/lib/person-key";
import { readPersonNotes } from "@/lib/buyer-profile";
import { askToJoin, readJoinToken } from "@/lib/store-join";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_people_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_people_only_a_stand_in";

  const OWNER = "harbor@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPeople0001", true);
  await setSubscription(OWNER, { customerId: "cus_People0001", subscriptionId: "sub_People0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const list = store.listId!;
  const fields = await writeFields(statsId, [
    { id: "lvl001", name: "Level", type: "choice", options: ["Beginner", "Pro"] },
    { id: "src001", name: "Came from", type: "text", options: [] },
  ]);
  const stages = await readStages(statsId);
  const talking = stages.find((s) => s.name === "Talking")!;
  const offer = stages.find((s) => s.name === "Offer sent")!;
  await writeForm(statsId, parseForm({ id: "applyform1", name: "Coaching application", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }, { id: "q2what", type: "short", label: "What?", required: false }] })!);
  await writeForm(statsId, parseForm({ id: "noemail001", name: "Poll", fields: [{ id: "q1what", type: "short", label: "What?", required: true }] })!);

  part("Read and saved strictly");
  const ctx = { field: (id: string) => fields.find((f) => f.id === id), isStage: (id: string) => stages.some((s) => s.id === id) };
  is("a field and a value it keeps; a stage the board has; a note with words", [
    readAction({ do: "field", field: "lvl001", value: "Pro" }, () => false, ctx),
    readAction({ do: "field", field: "lvl001", value: "Expert" }, () => false, ctx),
    readAction({ do: "field", field: "nope00", value: "x" }, () => false, ctx),
    readAction({ do: "deal", stage: talking.id, title: "  Coaching  " }, () => false, ctx),
    readAction({ do: "deal", stage: "nope00", title: "" }, () => false, ctx),
    readAction({ do: "note", text: "   " }, () => false, ctx),
    readAction({ do: "notify" }, () => false, ctx),
  ], [{ do: "field", field: "lvl001", value: "Pro" }, "bad", "bad", { do: "deal", stage: talking.id, title: "Coaching" }, "bad", "bad", { do: "notify" }]);
  is("a form that asks for no address cannot start a sequence", (await saveFlow(store, { name: "X", trigger: "form", formId: "noemail001", active: true, steps: [{ delayHours: 0, subject: "a", body: "b" }] }, { activate: true })), { ok: false, reason: "form" });
  const saved = await saveFlow(store, {
    name: "Applicants",
    trigger: "form",
    formId: "applyform1",
    active: true,
    steps: [
      { delayHours: 0, action: { do: "field", field: "lvl001", value: "Pro" } },
      { delayHours: 0, action: { do: "deal", stage: talking.id, title: "Coaching" } },
      { delayHours: 0, action: { do: "note", text: "Applied for coaching" } },
      { delayHours: 0, action: { do: "notify" } },
      { delayHours: 0, subject: "We got your application", body: "Thank you." },
    ],
  }, { activate: true });
  is("a sequence that starts with the form, its steps kept", saved.ok ? [saved.flows[0].trigger, saved.flows[0].formId, saved.flows[0].steps.map((s) => s.action?.do ?? "email")] : saved, ["form", "applyform1", ["field", "deal", "note", "notify", "email"]]);

  part("Started by the form, for people on the list");
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(list, "ben@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  // Ben already has an open deal: it moves rather than a second one being made.
  await writeDeal(statsId, { id: "bendeal001", title: "Ben's course", email: "ben@example.com", cents: 9900, stage: offer.id, note: "", createdAt: 1, updatedAt: 1 }, ROOM);
  store = (await storeForEmail(OWNER))!;
  for (const email of ["ana@example.com", "ben@example.com", "ana@example.com", "nobody@example.com"]) await enroll(store, email, { joined: false, form: "applyform1" });
  await enroll(store, "ana@example.com", { joined: false, form: "noemail001" });
  for (let i = 0; i < 5; i += 1) await run();

  const value = async (email: string) => (await readValues(statsId, personKey(statsId, email), fields)).lvl001 ?? "";
  is("the field is set for those on the list, not for somebody who is not", [await value("ana@example.com"), await value("ben@example.com"), await value("nobody@example.com")], ["Pro", "Pro", ""]);
  const deals = await readDeals(statsId, stages);
  is("Ana gets a new deal in the stage; Ben's open deal moves there", [
    deals.filter((d) => d.email === "ana@example.com").map((d) => [d.title, d.stage]),
    deals.filter((d) => d.email === "ben@example.com").map((d) => [d.id, d.stage, d.cents]),
  ], [[["Coaching", talking.id]], [["bendeal001", talking.id, 9900]]]);
  const notes = await readPersonNotes(statsId, personKey(statsId, "ana@example.com"));
  is("a note on her page, saying where it came from", notes.map((n) => n.text), ["Applied for coaching (Sequence “Applicants”, step 3.)"]);
  const told = mail.ses.filter((message) => message.to.includes(OWNER));
  is("the owner told once, with both of them", [told.length, told[0]?.subject, told[0]?.text.includes("ana@example.com") && told[0]?.text.includes("ben@example.com")], [1, "2 people reached step 4 of “Applicants”", true]);
  is("and the email goes to each, once", mail.ses.filter((message) => message.subject === "We got your application").flatMap((message) => message.to).sort(), ["ana@example.com", "ben@example.com"]);

  part("A sign-up asked from a form remembers it");
  mail.clearCaptured();
  mail.disableSes();
  await askToJoin({ store, email: "cleo@example.com", ip: "10.0.0.9", origin: "https://marktmorgen.com", fromForm: true, formId: "applyform1" });
  const token = /join\?token=([0-9a-f]{48})/.exec(mail.resend[0]?.text ?? "")?.[1] ?? "";
  is("the confirmation link uses the service route and knows the form", [mail.ses.length, mail.resend.length, (await readJoinToken(token))?.f], [0, 1, "applyform1"]);
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });

  part("A workflow for one quiz result (added 17 October 2026)");
  await writeForm(statsId, parseForm({
    id: "scorequiz1", name: "Readiness", scoring: "points",
    fields: [{ id: "q1mail", type: "email", label: "Email", required: true }, { id: "q2lvl0", type: "choice", label: "Level?", required: true, options: [{ id: "lowopt", label: "New", points: 0 }, { id: "hiopt0", label: "Old", points: 10 }] }],
    outcomes: [{ id: "tierlo", title: "Starting", min: 0, max: 4 }, { id: "tierhi", title: "Ready", min: 5, max: 10 }],
  })!);
  const quizFlow = (formOutcome: string) => saveFlow(store, { name: "Ready ones", trigger: "form", formId: "scorequiz1", formOutcome, active: true, steps: [{ delayHours: 0, subject: "You are ready", body: "Here is the next step." }] }, { activate: true });
  is("a result the quiz does not have is refused", await quizFlow("nope00"), { ok: false, reason: "form" });
  const forReady = await quizFlow("tierhi");
  is("one of its results is kept on the workflow", forReady.ok ? forReady.flows.find((f) => f.name === "Ready ones")?.formOutcome : forReady, "tierhi");
  mail.clearCaptured();
  await upsertContact(list, "dan@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(list, "eve@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "dan@example.com", { joined: false, form: "scorequiz1", formOutcome: "tierlo" });
  await enroll(store, "eve@example.com", { joined: false, form: "scorequiz1", formOutcome: "tierhi" });
  for (let i = 0; i < 3; i += 1) await run();
  is("only the person who got that result starts it", mail.ses.filter((message) => message.subject === "You are ready").flatMap((message) => message.to), ["eve@example.com"]);
  mail.clearCaptured();
  mail.disableSes();
  await askToJoin({ store, email: "fay@example.com", ip: "10.0.0.10", origin: "https://marktmorgen.com", fromForm: true, formId: "scorequiz1", formOutcome: "tierhi" });
  const quizToken = /join\?token=([0-9a-f]{48})/.exec(mail.resend[0]?.text ?? "")?.[1] ?? "";
  const grant = await readJoinToken(quizToken);
  is("a sign-up asked from a quiz keeps the service route, form and result", [mail.ses.length, mail.resend.length, grant?.f, grant?.r], [0, 1, "scorequiz1", "tierhi"]);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
