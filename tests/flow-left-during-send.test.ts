/**
 * sendGroup reads the contacts' rows and claims each attempt; sendTo (lib/mail.ts) reads the rows again and leaves out
 * whoever left the list meanwhile (unsubscribed, bounced, removed). That person was in neither done, rest nor
 * uncertain, so settleAttempts never closed their attempt: nothing was sent (right), but the run stayed "running"
 * with an open attempt for good (Claude 2 (nuvem D) bug hunt, lib/flows.ts). Synthetic: the memory Redis and the SES
 * stand-in.
 */
import { personOf, readRun } from "@/lib/flow-runs";
import { enroll, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { forgetContactPerson, upsertContact } from "@/lib/contacts";
import { forgetWorkflowPerson } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

type Command = (string | number)[];
const realNow = Date.now;
const shift = 0;
Date.now = () => realNow() + shift;
const real = redis.pipeline.bind(redis);
let leaveAfterRead: string | null = null;
let eraseAfterRead: (() => Promise<void>) | null = null;
let takeOverAfterRead: string | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  if (leaveAfterRead && batch[0]?.[0] === "HMGET" && batch.length > 1 && batch.slice(1).every((c) => c[0] === "ZSCORE")) {
    // The person unsubscribes right after sendGroup read their row (before sendTo's own tokensFor read).
    const key = String(batch[0][1]);
    const [raw] = await real([["HGET", key, leaveAfterRead]]);
    const contact = JSON.parse(raw as string);
    await real([["HSET", key, leaveAfterRead, JSON.stringify({ ...contact, unsub: true, unsubAt: new Date().toISOString() })]]);
    leaveAfterRead = null;
  }
  if (eraseAfterRead && batch[0]?.[0] === "HMGET" && batch.length > 1 && batch.slice(1).every((c) => c[0] === "ZSCORE")) {
    // The person is erased right after sendGroup read their row (before sendTo's own read).
    const erase = eraseAfterRead;
    eraseAfterRead = null;
    await erase();
  }
  if (takeOverAfterRead && batch[0]?.[0] === "HMGET" && batch.length > 1 && batch.slice(1).every((c) => c[0] === "ZSCORE")) {
    // A later take writes its own score on this person's lease entry right after sendGroup read it (Codex G2 on #2287).
    const member = batch.slice(1).map((c) => String(c[2])).find((m) => m.endsWith(`|${takeOverAfterRead}`));
    takeOverAfterRead = null;
    if (member) await real([["ZADD", "nl:mail:flowq:lease", Math.floor(Date.now() / 1000) + 7200.5, member]]);
  }
  return values;
}) as typeof redis.pipeline;

const mail = installSesMailFixture({ fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })) });
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000).catch(() => null);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";
  const OWNER = "hunt-race@example.test";
  await claimHandle(OWNER, "huntrace", "Hunt Race", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHuntRce", true);
  await setSubscription(OWNER, { customerId: "cus_HuntRce001", subscriptionId: "sub_HuntRce001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Hunt Race", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const made = await saveFlow(store, { name: "Welcome", trigger: "tagged", tag: "welcome", steps: [
    { id: "c000000000000001", delayHours: 0, subject: "Welcome, step one", body: "Hello." },
    { id: "c000000000000002", delayHours: 24 * 30, subject: "Welcome, step two", body: "Again." },
  ] });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  const sentTo = (email: string) => mail.sesAttempts.filter((m) => m.subject === "Welcome, step one" && JSON.stringify(m).includes(email)).length;

  part("Unsubscribed between the step's row read and the send");
  await upsertContact(list, "race@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "race@example.com", { joined: false, tag: "welcome" });
  leaveAfterRead = "race@example.com";
  await run();
  const after = await readRun(flowId, personOf("race@example.com"));
  console.log(JSON.stringify(after?.run));
  is("nothing was sent to them", sentTo("race@example.com"), 0);
  is("the run is closed as left, with no attempt left open", [after?.run.status, after?.run.open], ["left", ""]);

  part("Erased between the step's row read and the send (Claude 7 on #4307)");
  await upsertContact(list, "erased@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "erased@example.com", { joined: false, tag: "welcome" });
  eraseAfterRead = async () => {
    await forgetContactPerson(list, "erased@example.com");
    await forgetWorkflowPerson(store, "erased@example.com");
  };
  await run();
  is("the erasure was injected", eraseAfterRead, null);
  is("nothing was sent to them", sentTo("erased@example.com"), 0);
  is("their run is not written back: nothing of them is left", await readRun(flowId, personOf("erased@example.com")), null);
  const [indexed] = await real([["ZSCORE", `nl:wf:runs:${flowId}`, personOf("erased@example.com")]]);
  is("and they are not in the workflow's list of runs", indexed, null);

  part("Taken over by a later take between the step's row read and the send: their run is that take's, never cleared here (Codex G2 on #2287)");
  await upsertContact(list, "taken@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "taken@example.com", { joined: false, tag: "welcome" });
  takeOverAfterRead = "taken@example.com";
  await run();
  const takenRun = await readRun(flowId, personOf("taken@example.com"));
  is("the take-over was injected", takeOverAfterRead, null);
  is("nothing was sent to them by this take", sentTo("taken@example.com"), 0);
  is("their run is kept, with its address, for the take that holds it", takenRun?.run.email, "taken@example.com");

  part("Refused by the email service, address by address: failed with the service's words, never also 'left' (Claude 1 on #4307)");
  // On main since #3489, sendTo answers a fourth list, `refused`, in neither done nor rest. The PR's rule (whoever is
  // in none of done, rest and uncertain left the list) took them as left too: written twice, the run's status and
  // note overwritten to "left", and the history saying they left a list they may still be on.
  await upsertContact(list, "refused@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "refused@example.com", { joined: false, tag: "welcome" });
  // Amazon refuses this one address by name (lib/email.ts recipientsOwn: a refusal whose text names the recipient's
  // address is that address's own), so sendTo answers it in `refused`, not as the batch's refusal.
  const sesFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/v2/email/outbound-emails" && String(init?.body ?? "").includes("refused@example.com")) {
      return new Response(JSON.stringify({ message: "Illegal address: refused@example.com" }), { status: 400, headers: { "content-type": "application/json", "x-amzn-errortype": "BadRequestException" } });
    }
    return sesFetch(input, init);
  }) as typeof fetch;
  await run();
  globalThis.fetch = sesFetch;
  const refusedRun = await readRun(flowId, personOf("refused@example.com"));
  const text = JSON.stringify(refusedRun ?? null);
  is("their run ends as failed, not left", refusedRun?.run.status, "failed");
  is("with the email service's words", /did not accept this email|refused this address/.test(text), true);
  is("and never with the 'no longer on your list' note", text.includes("No longer on your list"), false);
  mail.restore();
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
