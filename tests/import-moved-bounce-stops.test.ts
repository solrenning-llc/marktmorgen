/**
 * A moved member who said no through the sender is never sent the move's reminder (lib/imports.ts sendMoveReminders;
 * review of #3476, consent MEDIUM 2, Claude 7, kept by Claude 2). Synthetic only: Stripe and the sender are stand-ins
 * for fetch, Redis is lib/redis-memory.ts.
 *
 * The members' emails carry their store's stats id (lib/mail-health.ts moveTags), and the sender's notice, read with
 * the email's own tags as app/api/mail/inbound and lib/mail-report.ts recordSesEvent read them, writes that store's
 * reminders' stop mark, the one the reminder reads (remindersStoppedAmong). A spam report and a bounce for good stop
 * the reminder; a bounce that may yet deliver changes nothing; a write of the mark not confirmed throws, so the notice
 * is heard again.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { addRows, finishUpload, runImport, sendMoveReminders, startImport } from "@/lib/imports";
import { LIST_TAG, MOVE_TAG, STORE_TAG, heardFromSender } from "@/lib/mail-health";
import { recordSesEvent } from "@/lib/mail-report";
import { remindersStoppedAmong } from "@/lib/checkout-recovery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const POSTAL = "12 Harbor Lane, Portland, ME 04101, USA";
type Sent = { to: string | string[]; text: string; tags?: { name: string; value: string }[] };
const emails: Sent[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com" && url.pathname.startsWith("/emails")) {
    const body = JSON.parse(String(init?.body)) as Sent | Sent[];
    for (const one of Array.isArray(body) ? body : [body]) emails.push(one);
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const to = (e: Sent) => [e.to].flat()[0];
const sentTo = (address: string, from = 0) => emails.slice(from).filter((e) => to(e) === address);
/** An email's tags as the sender hands them back in its notice. */
const tagsOf = (e: Sent | undefined) => Object.fromEntries((e?.tags ?? []).map((t) => [t.name, t.value]));

const original = redis.pipeline.bind(redis);
const restore = () => {
  redis.pipeline = original;
};
async function openStore(owner: string, handle: string, account: string, id: string): Promise<Store> {
  await claimHandle(owner, handle, "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setMailSettings(owner, { fromName: "Harbor Kitchen", address: POSTAL });
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { customerId: `cus_${id}`, subscriptionId: `sub_${id}`, active: true, period: paidPeriod() });
  const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(owner, club.product.id, "https://example.com/club");
  return (await storeForEmail(owner))!;
}

/** Imports these members, renewing on `renews`, and runs the import to its end. */
async function invite(store: Store, owner: string, members: string[], renews: string): Promise<void> {
  const j = await startImport(store, owner, "members", { expected: members.length, file: "patrons.csv", stopped: true });
  if (!j.ok) throw new Error(`members not started: ${j.reason}`);
  await addRows(store, j.job.id, members.map((e, i) => [String(i + 2), e, "The Inner Circle", renews, ""]));
  await finishUpload(store, j.job.id);
  let job = await runImport(j.job.id, Date.now() + 30_000);
  for (let i = 0; i < 10 && job && job.state !== "done"; i += 1) job = await runImport(j.job.id, Date.now() + 30_000);
  if (job?.state !== "done") throw new Error("the import did not finish");
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();
  const in20 = Math.floor(Date.now() / 1000) + 20 * DAY;
  const renews = new Date(in20 * 1000).toISOString().slice(0, 10);
  // The renewal date as the invitation keeps it (lib/move-rules.ts: noon UTC of that day), and the reminder's due time.
  const [y, mo, d] = renews.split("-").map(Number);
  const r = Date.UTC(y, mo - 1, d, 12) / 1000;
  const due = r - 3 * DAY;

  part("Consent MEDIUM 2: the members' emails carry their store's stats id");
  const OWNER = "bounce-owner@example.com";
  const store = await openStore(OWNER, "bounceshop", "acct_1TestHeldRem003", "HeldRem3");
  const SPAM = "spammer@example.com";
  const BOUNCE = "bouncer@example.com";
  const SOFT = "soft@example.com";
  const FINE = "fine@example.com";
  const firstBefore = emails.length;
  await invite(store, OWNER, [SPAM, BOUNCE, SOFT, FINE], renews);
  const first = (address: string) => sentTo(address, firstBefore)[0];
  is("each member emailed their link", [SPAM, BOUNCE, SOFT, FINE].map((e) => sentTo(e, firstBefore).length), [1, 1, 1, 1]);
  is("tagged with the store and its stats id, no list", [tagsOf(first(SPAM))[STORE_TAG], tagsOf(first(SPAM))[MOVE_TAG], tagsOf(first(SPAM))[LIST_TAG]], [store.sid, store.statsId, undefined]);

  part("Consent MEDIUM 2: a spam report, and a bounce for good, keep the member's no; a bounce that may deliver does not");
  // As app/api/mail/inbound reads a Resend notice: the email's own tags.
  const resendNotice = (kind: "bounced" | "complained", permanent: boolean, address: string) => {
    const tags = tagsOf(first(address));
    return heardFromSender({ kind, permanent, to: address, store: tags[STORE_TAG] ?? "", list: tags[LIST_TAG] ?? "", move: tags[MOVE_TAG] ?? "" });
  };
  is("the spam report is counted", await resendNotice("complained", false, SPAM), "counted");
  // As lib/mail-report.ts reads an Amazon SES notice: the email's own tags.
  is("the bounce for good is counted", await recordSesEvent({ kind: "bounced", permanent: true, recipients: [BOUNCE], tags: tagsOf(first(BOUNCE)), messageId: "ses-synthetic-1" }), "counted");
  is("the bounce that may yet deliver is not acted on", await resendNotice("bounced", false, SOFT), "ignored");
  is("the stop mark is kept for the spam report and the bounce for good only", [...(await remindersStoppedAmong(store, [SPAM, BOUNCE, SOFT, FINE]))].sort(), [BOUNCE, SPAM]);

  part("Consent MEDIUM 2: the reminder goes only to the members who said no to nothing");
  const before = emails.length;
  const sent = await sendMoveReminders(Date.now() + 30_000, (due + 60) * 1000);
  is("control: the soft bounce and the member never heard from are reminded", [sentTo(SOFT, before).length, sentTo(FINE, before).length], [1, 1]);
  is("the member who marked it as spam, and the one whose address bounced for good, are not", [sentTo(SPAM, before).length, sentTo(BOUNCE, before).length], [0, 0]);
  is("two reminders in all", sent.sent, 2);
  is("the reminder carries the stats id too", tagsOf(sentTo(FINE, before)[0])[MOVE_TAG], store.statsId);

  part("Consent MEDIUM 2: a spam report on the reminder itself keeps the no as well");
  {
    const tags = tagsOf(sentTo(FINE, before)[0]);
    is("counted", await heardFromSender({ kind: "complained", permanent: false, to: FINE, store: tags[STORE_TAG] ?? "", list: tags[LIST_TAG] ?? "", move: tags[MOVE_TAG] ?? "" }), "counted");
    is("the stop mark is kept", (await remindersStoppedAmong(store, [FINE])).has(FINE), true);
  }

  part("Consent MEDIUM 2: a stop mark write not confirmed throws, so the sender's notice is heard again");
  {
    const LATE = "late@example.com";
    redis.pipeline = async (commands: (string | number)[][]) => {
      const out = (await original(commands)) as unknown[];
      return commands.map((c, i) => (c[0] === "SET" && String(c[1]).startsWith("nl:recover:off:") ? "QUEUED" : out[i]));
    };
    let threw = false;
    try {
      await heardFromSender({ kind: "complained", permanent: false, to: LATE, store: store.sid, list: "", move: store.statsId });
    } catch {
      threw = true;
    } finally {
      restore();
    }
    is("an unknown answer to the mark's write throws", threw, true);
  }
  done();
}

void main();
