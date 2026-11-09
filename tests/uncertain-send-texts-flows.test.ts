/**
 * A workflow's notice to the owner whose send is not known (rule 30, a
 * sibling of 283 [HG2] unit 1's sendEmailOutcome): lib/flows.ts, the
 * "notify" step.
 *
 * Found 9 November 2026: sendEmail answers false also when the sender's
 * answer is not known (a 5xx, a network error after the request may have
 * reached it). The step then gave the email back to the store's month
 * (giveBackToMonth) and wrote "The email to you was not accepted", although
 * the email may have gone and cost one. Checked:
 *
 *   - the sender answers 500: the month's email stays taken, and the step is
 *     held as not confirmed (never repeated by itself), never "failed";
 *   - a 422 (a certain refusal): given back and "not accepted", as before
 *     (control);
 *   - a plain yes: taken and confirmed (control).
 *
 * The sender is a stand-in for `fetch` and the records are synthetic; no
 * real email is sent.
 */
import { enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { listRuns } from "@/lib/flow-runs";
import { usedThisMonth } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "owner-flow-unsure@example.com";
/** Every notice the sender was asked for. */
const toOwner: string[] = [];
let senderAnswer: (() => Response) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string };
    const to = [body.to].flat()[0] ?? "";
    if (to === OWNER) {
      toOwner.push(body.subject);
      if (senderAnswer) return senderAnswer();
    }
    return new Response(JSON.stringify({ id: `email_${toOwner.length}_${Math.random()}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const SERVER_ERROR = () => new Response("{}", { status: 500 });
const REFUSED = () => new Response(JSON.stringify({ message: "not accepted" }), { status: 422 });

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_flow_unsure_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, "flow-unsure", "Flow Unsure", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestFlowUns01", true);
  await setSubscription(OWNER, { customerId: "cus_FlowUnsure1", subscriptionId: "sub_FlowUnsure1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Flow Unsure", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId!;
  const saved = await saveFlow(store, { name: "Tell me", trigger: "joined", active: true, steps: [{ delayHours: 0, action: { do: "notify" } }] }, { activate: true });
  if (!saved.ok) throw new Error(`no flow: ${JSON.stringify(saved)}`);
  const flowId = saved.flows[0].id;
  store = (await storeForEmail(OWNER))!;
  const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
  const reach = async (email: string, answer: (() => Response) | null) => {
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: true });
    senderAnswer = answer;
    const before = { used: await usedThisMonth(list, windowId(store)), asked: toOwner.length };
    for (let i = 0; i < 3; i += 1) await run();
    senderAnswer = null;
    const runRecord = (await listRuns(flowId, 50)).find((r) => r.email === email);
    return { used: (await usedThisMonth(list, windowId(store))) - before.used, asked: toOwner.length - before.asked, status: runRecord?.status, note: runRecord?.note ?? "" };
  };

  part("The sender's answer not known");
  const unsure = await reach("ana@example.com", SERVER_ERROR);
  is("asked once, the month's email kept taken (it may have gone)", [unsure.asked, unsure.used], [1, 1]);
  is("held as not confirmed, never as not accepted", [unsure.status, unsure.note], ["held", "Whether the email to you was sent could not be confirmed."]);

  part("A certain refusal and a plain yes (controls)");
  const refused = await reach("ben@example.com", REFUSED);
  is("a 422: given back, as before", [refused.asked, refused.used], [1, 0]);
  const yes = await reach("cal@example.com", null);
  is("a plain yes: taken, done", [yes.asked, yes.used, yes.status], [1, 1, "done"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
