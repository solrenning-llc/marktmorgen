/**
 * A workflow run's field step writes only under its own take of the lease
 * (lib/flows.ts, leaseScore; lib/crm.ts, SET_CRM_VALUE): a run under way
 * when its person is deleted writes nothing, even when the person came back
 * and a later run took the same lease entry before the old run wrote (Codex
 * G2's proof on #2287). The earlier parts are the form workflow's setup
 * (as in tests/flow-people.test.ts). Synthetic store, people and
 * mail only.
 */
import { readAction } from "@/lib/flow-rules";
import { enroll, forgetWorkflowPerson, saveFlow, sendDueSteps } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { forgetCrmPerson, personReturned, readDeals, readStages, readValues, writeDeal, writeFields } from "@/lib/crm";
import { writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { personKey } from "@/lib/person-key";
import { forgetNotesPerson, readPersonNotes } from "@/lib/buyer-profile";
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

  part("A run under way when its person is deleted writes nothing, even when a later run took the same lease entry (Codex G2, #2287)");
  await upsertContact(list, "gus@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "gus@example.com", { joined: false, form: "applyform1" });
  const gus = personKey(statsId, "gus@example.com");
  const passOn = redis.pipeline;
  let raced = false; let resumedNewRun: (() => void) | undefined; let newRun: Promise<unknown> | undefined; let reusedLease = false;
  redis.pipeline = async (commands) => {
    // Right before the step reads his generation: deleted from the workflows and the CRM, then back by a later purchase.
    if (!raced && commands.some((c) => c[0] === "GET" && c[1] === `nl:crm:gen:${statsId}:${gus}`)) {
      raced = true;
      redis.pipeline = passOn;
      await forgetWorkflowPerson(store, "gus@example.com");
      await forgetCrmPerson(statsId, gus, "gus@example.com", ROOM);
      await personReturned(statsId, "gus@example.com", Date.now() + 1);
      await enroll(store, "gus@example.com", { joined: false, form: "applyform1" });
      let started!: () => void;
      const waiting = new Promise<void>(r => { started = r; });
      const release = new Promise<void>(r => { resumedNewRun = r; });
      redis.pipeline = async nextCommands => {
        if (nextCommands.some(c => c[0] === "GET" && c[1] === `nl:crm:gen:${statsId}:${gus}`)) {
          reusedLease = true; started(); await release;
        }
        return passOn.call(redis, nextCommands);
      };
      newRun = run();
      await Promise.race([waiting, new Promise<void>(r => setTimeout(r, 2000))]);
      redis.pipeline = passOn;
    }
    return passOn.call(redis, commands);
  };
  await run();
  const beforeReleasingNewRunner = await value("gus@example.com");
  const member = `${list}|harbor|${saved.ok ? saved.flows[0].id : "missing"}|0|gus@example.com`;
  const [remainingLease] = await passOn.call(redis, [["ZSCORE", "nl:mail:flowq:lease", member]]);
  is("control: a genuine new run has claimed the same member and is still blocked before reading", reusedLease, true);
  is("the OLD run cannot use a NEW run's lease to restore the field", beforeReleasingNewRunner, "");
  is("(and the deletion's erasure ran)", raced, true);
  is("the old runner leaves the new runner's claimed lease in place", remainingLease !== null, true);
  is("the old runner does not advance to a later note while the new runner is blocked", (await readPersonNotes(statsId, gus)).map(n => n.text), []);
  resumedNewRun?.();if(newRun)await newRun;
  is("the legitimate new runner still completes its field after the old runner exits", await value("gus@example.com"), "Pro");
  redis.pipeline = passOn;

  part("A run taken over between reading who it holds and the step's effect does nothing for that person (C3-141)");
  await writeForm(statsId, parseForm({ id: "noteform01", name: "Waitlist", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }] })!);
  const noted = await saveFlow(store, { name: "Noted", trigger: "form", formId: "noteform01", active: true, steps: [{ delayHours: 0, action: { do: "note", text: "Joined the waitlist" } }] }, { activate: true });
  is("(a workflow whose one step writes a note)", noted.ok, true);
  await upsertContact(list, "hal@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "hal@example.com", { joined: false, form: "noteform01" });
  const hal = personKey(statsId, "hal@example.com");
  let tookOver = false;
  redis.pipeline = async (commands) => {
    const answer = await passOn.call(redis, commands);
    // Right after the old run read who it holds: deleted, back, enrolled again, and a later run does the step whole.
    if (!tookOver && commands[0]?.[0] === "HMGET" && commands.some((c) => c[0] === "ZSCORE" && String(c[2]).endsWith("|hal@example.com"))) {
      tookOver = true;
      redis.pipeline = passOn;
      await forgetWorkflowPerson(store, "hal@example.com");
      await forgetCrmPerson(statsId, hal, "hal@example.com", ROOM);
      await forgetNotesPerson(statsId, hal);
      await personReturned(statsId, "hal@example.com", Date.now() + 1);
      await enroll(store, "hal@example.com", { joined: false, form: "noteform01" });
      await run();
      redis.pipeline = async (next) => passOn.call(redis, next);
    }
    return answer;
  };
  await run();
  redis.pipeline = passOn;
  is("(taken over in between)", tookOver, true);
  is("only the run that took over wrote its note", (await readPersonNotes(statsId, hal)).map((n) => n.text), ["Joined the waitlist (Sequence “Noted”, step 1.)"]);
  mail.restore();
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
