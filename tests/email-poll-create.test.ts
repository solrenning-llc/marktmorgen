/**
 * A creator writes a poll into an email to the list (125 [F2-EMAIL-POLLS],
 * unit 7a: createBroadcast in lib/broadcasts.ts, and the studio's mail route).
 *
 * What fails here:
 *   - a poll kept that does not read (no question, one answer, six answers,
 *     too long, days past the most), or kept changed from what was asked;
 *   - an email refused for a poll, or with "poll", having written anything;
 *   - an email without a poll changed by any of this.
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { createBroadcast, readBroadcast } from "@/lib/broadcasts";
import { MAX_POLL_DAYS, MAX_POLL_OPTION, MAX_POLL_QUESTION } from "@/lib/email-poll-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "poll-maker@example.com";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "kiln-room", "Kiln Room", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PollMk0001", subscriptionId: "sub_PollMk0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Kiln Room", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  for (let i = 0; i < 3; i += 1) await upsertContact(store.listId as string, `reader${i}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  const later = Date.now() + 3 * 86_400_000;
  const send = (poll?: unknown) => createBroadcast(store, { subject: "What next?", body: "Tell me what to make next.", productId: "", notProductId: "", sendAt: later, ...(poll === undefined ? {} : { poll }) });
  const written = () => Number(redis.run(["LLEN", `nl:mail:bcs:${store.listId}`]));

  part("A poll is kept with the email, as the rules read it");
  const made1 = await send({ question: "  Which   class next? ", options: [" Glazing", "Trimming ", "Firing"], days: 7 });
  is("made", made1.ok, true);
  const kept = made1.ok ? await readBroadcast(made1.broadcast.id) : null;
  is("kept, spaces tidied", kept?.poll, { question: "Which class next?", options: ["Glazing", "Trimming", "Firing"], days: 7 });

  part("A poll that does not read: refused, nothing written");
  const before = written();
  for (const [what, poll] of [
    ["no question", { question: " ", options: ["a", "b"], days: 7 }],
    ["one answer", { question: "Q?", options: ["a"], days: 7 }],
    ["six answers", { question: "Q?", options: ["a", "b", "c", "d", "e", "f"], days: 7 }],
    ["a question too long", { question: "x".repeat(MAX_POLL_QUESTION + 1), options: ["a", "b"], days: 7 }],
    ["an answer too long", { question: "Q?", options: ["x".repeat(MAX_POLL_OPTION + 1), "b"], days: 7 }],
    ["days past the most", { question: "Q?", options: ["a", "b"], days: MAX_POLL_DAYS + 1 }],
    ["not an object", "Which class?"],
    ["null", null],
  ] as [string, unknown][]) {
    const refused = await send(poll);
    is(`refused: ${what}`, refused.ok ? "made" : refused.reason, "poll");
  }
  is("nothing written by any of them", written(), before);

  part("An email without a poll is unchanged");
  const plain = await send();
  is("made", plain.ok, true);
  is("no poll kept", plain.ok ? (await readBroadcast(plain.broadcast.id))?.poll : "x", undefined);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
