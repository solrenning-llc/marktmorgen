/**
 * MM-SA-40 (docs/security-audit-2026-10-28.md): a form must never start a
 * sequence for an address it has not proven. Anybody can type an address
 * that is already on a store's list into one of its forms, with the quiz
 * result they choose; that must not start the creator's emails, deal moves
 * or field writes for that person, nor spend the one start a person gets in
 * a sequence (claimed for 400 days) on a moment they never chose.
 *
 * Checked through the real route (app/api/store/form/route.ts):
 *
 *   - a typed address already on the list, with no confirmation, starts
 *     nothing, sends nothing and claims no start;
 *   - the same address with the form's list box checked gets the
 *     confirmation email, which remembers the form and its result, and still
 *     nothing starts before the button is pressed;
 *   - pressing it (app/api/store/join/confirm/route.ts) starts the form's
 *     sequence, once.
 */
import { NextRequest } from "next/server";
import { saveFlow, sendDueSteps } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { readJoinToken } from "@/lib/store-join";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSitePages, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { POST as sendForm } from "@/app/api/store/form/route";
import { POST as confirmRoute } from "@/app/api/store/join/confirm/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
const claims = () => [...redis.keys()].filter((key) => key.startsWith("nl:mail:enr:")).length;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_form_proof_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_form_proof_a_stand_in";

  const OWNER = "quay@example.com";
  await claimHandle(OWNER, "quay", "Quay Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestFormProof01", true);
  await setSubscription(OWNER, { customerId: "cus_FormProof01", subscriptionId: "sub_FormProof01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Quay Studio", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const list = store.listId!;

  const quiz = (offerList: boolean) => parseForm({
    id: "proofquiz1",
    name: "Readiness quiz",
    offerList,
    scoring: "points",
    fields: [{ id: "q1mail", type: "email", label: "Email", required: true }, { id: "q2lvl0", type: "choice", label: "Level?", required: true, options: [{ id: "lowopt", label: "New", points: 0 }, { id: "hiopt0", label: "Old", points: 10 }] }],
    outcomes: [{ id: "tierlo", title: "Starting", min: 0, max: 4 }, { id: "tierhi", title: "Ready", min: 5, max: 10 }],
  })!;
  await writeForm(statsId, quiz(false));
  await setSitePages(OWNER, [{ id: "pagequiz01", slug: "quiz", title: "Quiz", nav: false, target: "", from: 0 }]);
  store = (await storeForEmail(OWNER))!;
  await writePage(statsId, siteKey("pagequiz01"), { ...parsePage({}), blocks: [{ id: "blk001", kind: "form", heading: "", form: "proofquiz1" }] } as never, ROOM);
  const saved = await saveFlow(store, { name: "Ready ones", trigger: "form", formId: "proofquiz1", formOutcome: "tierhi", active: true, steps: [{ delayHours: 0, subject: "You are ready", body: "Here is the next step." }] }, { activate: true });
  is("the quiz's sequence is saved and active", saved.ok, true);
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);

  let ip = 10;
  const post = (fields: [string, string][]) =>
    sendForm(new NextRequest("https://marktmorgen.com/api/store/form", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${(ip += 1)}` }, body: new URLSearchParams(fields) }));
  const answers: [string, string][] = [["handle", "quay"], ["form", "proofquiz1"], ["page", "pagequiz01"], ["q_q1mail", "ana@example.com"], ["q_q2lvl0", "hiopt0"]];
  const ready = () => mail.ses.filter((message) => message.subject === "You are ready").flatMap((message) => message.to);

  part("A typed address on the list, never confirmed, starts nothing");
  mail.clearCaptured();
  const typed = await post(answers);
  is("the stranger still sees the quiz's result", [typed.status, (typed.headers.get("location") ?? "").includes("r=tierhi")], [303, true]);
  await settle();
  for (let i = 0; i < 3; i += 1) await run();
  is("nothing is sent to the address typed", ready(), []);
  is("and no start of the sequence is claimed for it", claims(), 0);

  part("With the list box checked, the address must confirm first");
  await writeForm(statsId, quiz(true));
  mail.clearCaptured();
  const asked = await post([...answers, ["consent", "yes"]]);
  is("the person is told to look for the email", (asked.headers.get("location") ?? "").includes("j=1"), true);
  const token = /join\?token=([0-9a-f]{48})/.exec(mail.ses[0]?.text ?? "")?.[1] ?? "";
  const grant = await readJoinToken(token);
  is("the confirmation goes to the address typed and remembers the form and its result", [mail.ses[0]?.to, grant?.f, grant?.r], [["ana@example.com"], "proofquiz1", "tierhi"]);
  await settle();
  for (let i = 0; i < 3; i += 1) await run();
  is("before the button is pressed, nothing starts", [ready(), claims()], [[], 0]);

  part("Pressing the button starts the form's sequence, once");
  const confirm = () =>
    confirmRoute(new NextRequest("https://marktmorgen.com/api/store/join/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams([["token", token]]) }));
  await confirm();
  await settle();
  for (let i = 0; i < 3; i += 1) await run();
  is("the person who confirmed gets the sequence's email", ready(), ["ana@example.com"]);
  await confirm();
  await settle();
  for (let i = 0; i < 3; i += 1) await run();
  is("and a second press starts nothing more", ready(), ["ana@example.com"]);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
