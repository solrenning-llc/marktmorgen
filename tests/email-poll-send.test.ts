/**
 * A broadcast with a poll goes out with each recipient's own signed links
 * (125 [F2-EMAIL-POLLS], unit 6: lib/broadcasts.ts, lib/mail.ts render and
 * sendTo, pollEmailBlock in lib/email-poll-rules.ts).
 *
 * What fails here:
 *   - a recipient's links signed for another place than theirs in the list
 *     (their answer would count as someone else's);
 *   - a poll's links in the email after it closed (shown and not working);
 *   - an email that says nothing of how answers count, or an answer's link
 *     without the answer's words;
 *   - a poll's email sent with no key to sign its links (it waits, nothing
 *     is sent);
 *   - an email without a poll changed by any of this.
 */
import { advanceBroadcast } from "@/lib/broadcasts";
import { checkPollLink, pollLinkPart } from "@/lib/email-poll-links";
import { claimHandle, ensureListId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const DAY = 86_400_000;
const poll = { question: "Which class next?", options: ["Glazing", "Trimming", "Firing"], days: 7 };

async function main() {
  redis.clear();
  const owner = "poll-owner@example.com";
  await claimHandle(owner, "poll-check", "Poll Check", "");
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_Poll000001", subscriptionId: "sub_Poll000001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Poll Check", address: "1 Test Street, Test City" });
  const store = (await storeForEmail(owner))!;
  const emails = ["reader0@example.com", "reader1@example.com", "reader2@example.com"];
  for (const email of emails) await upsertContact(store.listId!, email, { agreed: true, explicit: true, source: "free" }, ROOM);
  process.env.RESEND_API_KEY = "re_test_poll_send_only";
  const mail = installSesMailFixture();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  const id = "222222222222222222222222", key = "nl:mail:bc:" + id, toKey = key + ":to";
  const base = { id, listId: store.listId, handle: store.handle, subject: "Subject", body: "Message", productId: null, notProductId: null, who: "all", narrow: null, status: "sending", createdAt: Date.now() - 60_000, sendAt: Date.now() - 60_000, finishedAt: 0, total: 3, sent: 0, note: "", failures: 0, listed: true, tagged: true, test: null };
  const seed = async (over: Record<string, unknown> = {}) => {
    mail.clearCaptured();
    for (const k of [`bc:${id}:0:0:3`]) mail.clearBatch(k, emails);
    await redis.pipeline([["SET", key, JSON.stringify({ ...base, ...over })], ["DEL", toKey], ["RPUSH", toKey, ...emails], ["SADD", "nl:mail:queue", id]]);
  };
  const advance = () => advanceBroadcast(id, storeForHandle, Date.now() + 5000);
  const linkIn = (text: string, option: number) => (text.match(new RegExp(`https://marktmorgen\\.com/poll\\?b=${id}&k=([0-9]+\\.[0-9a-f]{32})&a=${option}\\b`)) ?? [])[1] ?? null;

  part("Each recipient's own links, for their place in the list");
  await seed({ poll });
  const sent = await advance();
  is("all three sent", sent?.sent, 3);
  is("three messages", mail.ses.length, 3);
  for (const message of mail.ses) {
    const place = emails.indexOf(message.to[0]);
    const k = linkIn(message.text, 0);
    is(`${message.to[0]}: a link for every answer`, poll.options.every((_, i) => linkIn(message.text, i) === k), true);
    is(`${message.to[0]}: signed for their own place`, k ? checkPollLink(id, k) : null, { ok: true, recipient: place });
    is(`${message.to[0]}: the same link as made for that place`, k, pollLinkPart(id, place));
    is(`${message.to[0]}: each answer's words with its link`, poll.options.every((o, i) => message.text.includes(`${o}: https://marktmorgen.com/poll?b=${id}&k=${k}&a=${i}`)), true);
    is(`${message.to[0]}: the question`, message.text.includes("Which class next?"), true);
    is(`${message.to[0]}: how answers count`, /counted only when you press Confirm/.test(message.text), true);
    is(`${message.to[0]}: the totals only`, /never who answered what/.test(message.text), true);
    is(`${message.to[0]}: in the HTML, each answer a link named by its words`, poll.options.every((o, i) => message.html.includes(`href="https://marktmorgen.com/poll?b=${id}&amp;k=${k}&amp;a=${i}"`) && message.html.includes(`>${o}</a>`)), true);
    is(`${message.to[0]}: the creator's words still first`, message.text.indexOf("Message") < message.text.indexOf("Which class next?"), true);
  }

  part("A closed poll: no links, the email still goes");
  await seed({ poll, sendAt: Date.now() - 8 * DAY, createdAt: Date.now() - 8 * DAY });
  const late = await advance();
  is("sent", late?.sent, 3);
  is("no poll link in any of them", mail.ses.every((m) => !m.text.includes("/poll?") && !m.html.includes("/poll?")), true);

  part("No key to sign the links: it waits, nothing sent");
  const saved = { data: process.env.NIMBUS_DATA_KEY, stripe: process.env.STRIPE_SECRET_KEY };
  delete process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  await seed({ poll });
  const unsigned = await advance();
  if (saved.data !== undefined) process.env.NIMBUS_DATA_KEY = saved.data;
  if (saved.stripe !== undefined) process.env.STRIPE_SECRET_KEY = saved.stripe;
  is("waiting", unsigned?.status, "waiting");
  is("nothing sent", [unsigned?.sent, mail.ses.length], [0, 0]);
  is("saying why", /poll/i.test(unsigned?.note ?? ""), true);

  part("An email without a poll is unchanged");
  await seed();
  await advance();
  is("sent", mail.ses.length, 3);
  is("no poll words or links", mail.ses.every((m) => !m.text.includes("/poll?") && !/press Confirm/.test(m.text)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
