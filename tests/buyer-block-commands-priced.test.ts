/**
 * The block check on every buyer message is measured and priced, and a blocked person's refused attempts are bounded
 * (Claude 7's MEDIUM and LOW on #3839; rule MR: an unmeasured cost is never zero).
 *
 * The defects this file was written around:
 *   - lib/buyer-block.ts mayWrite sends EXISTS and HGET (the entry, up to BLOCK_ENTRY_BYTES) on every buyer message:
 *     startChat, handOver, visitorSend and sendContact. The registry's inbox unit (UNIT_COST.inbox) stayed at its 16
 *     commands and 4,000 bytes, while startChat's inbox part measured 18;
 *   - in visitorSend the check ran before the chat-send limit, so a loop with a valid token was never limited;
 *   - in sendContact the check ran after the store's daily contact count, so a blocked person rotating addresses still
 *     used up the store's MAX_PER_DAY contact slots and real buyers were told "limited".
 * Synthetic stores, the memory Redis.
 */
import { claimHandle, ensureStatsId, setContact, setInboxSetting, setSubscription, storeForEmail, type Store } from "@/lib/store";
import * as block from "@/lib/buyer-block";
import { BLOCK_ENTRY_BYTES, blockPerson } from "@/lib/buyer-block";
import { handOver, readInbox, startChat, visitorSend } from "@/lib/inbox";
import { VISITOR_PER_HOUR } from "@/lib/inbox-rules";
import { MAX_PER_DAY, sendContact } from "@/lib/store-contact";
import { TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_inbox_only_a_stand_in";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }), { status: 200 })) as typeof fetch;

type Command = (string | number)[];
const OWNER = "mara@example.com";
const RUDE = "rude@example.com";
const KIND = "kind@example.com";

async function shop(): Promise<Store> {
  await claimHandle(OWNER, "mara", "mara shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_mara00001", subscriptionId: "sub_mara00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setInboxSetting(OWNER, { chat: true, saved: [] });
  await setContact(OWNER, { on: true, heading: "Contact", line: "" });
  return (await storeForEmail(OWNER))!;
}

const real = redis.pipeline.bind(redis);
async function counted<T>(run: () => Promise<T>): Promise<{ result: T; sent: Command[] }> {
  const sent: Command[] = [];
  redis.pipeline = (async (batch: Command[]) => {
    sent.push(...batch);
    return real(batch);
  }) as typeof redis.pipeline;
  try {
    return { result: await run(), sent };
  } finally {
    redis.pipeline = real;
  }
}
const blockReads = (sent: Command[]) => sent.filter((c) => String(c[1]).startsWith("nl:blk:")).length;

async function main(): Promise<void> {
  redis.clear();
  const store = await shop();
  const checkCommands = (block as Record<string, unknown>).BLOCK_CHECK_COMMANDS;

  part("The block check's commands are a named figure, measured on each of the four doors");
  is("BLOCK_CHECK_COMMANDS is a whole number", typeof checkCommands === "number" && Number.isSafeInteger(checkCommands) && checkCommands > 0, true);
  const most = typeof checkCommands === "number" ? checkCommands : 0;
  const chat = await counted(() => startChat({ store, email: KIND, name: "", text: "Hello there", ip: "10.0.0.1" }));
  is("startChat: at most BLOCK_CHECK_COMMANDS on the block list", [chat.result.ok, blockReads(chat.sent) <= most && blockReads(chat.sent) > 0], [true, true]);
  const asked = await counted(() => handOver({ store, email: KIND, name: "", text: "A question for you" }));
  is("handOver: at most BLOCK_CHECK_COMMANDS", blockReads(asked.sent) <= most && blockReads(asked.sent) > 0, true);
  const [conversation] = await readInbox(store.statsId!);
  const [kept] = await redis.pipeline([["GET", `nl:inbox:${store.statsId}:c:${conversation.id}`]]);
  const token = (JSON.parse(String(kept)) as { token: string }).token;
  const sent = await counted(() => visitorSend(token, "One more line", async () => store));
  is("visitorSend: at most BLOCK_CHECK_COMMANDS", blockReads(sent.sent) <= most && blockReads(sent.sent) > 0, true);
  const contact = await counted(() => sendContact({ store, name: "K", email: KIND, message: "A message for the creator", ip: "10.0.0.2" }));
  is("sendContact: at most BLOCK_CHECK_COMMANDS", blockReads(contact.sent) <= most && blockReads(contact.sent) > 0, true);

  part("The inbox unit prices them: the message's 12 commands, the take, and the check with its entry's bytes");
  is("UNIT_COST.inbox covers the check", UNIT_COST.inbox >= request("light", 12 + TAKE_COMMANDS + most, 4_000 + BLOCK_ENTRY_BYTES) && most > 0, true);

  part("A blocked person's refused messages are bounded by the chat's own hourly limit");
  await blockPerson(store, KIND, "");
  let reads = 0;
  for (let n = 0; n < VISITOR_PER_HOUR * 3; n += 1) reads += blockReads((await counted(() => visitorSend(token, "Still here", async () => store))).sent);
  is("the block is read at most once a try inside the hour's limit, never on every try", reads <= VISITOR_PER_HOUR * most, true);

  part("A blocked person never uses up the store's contact slots for real buyers (Claude 7's LOW)");
  await blockPerson(store, RUDE, "");
  for (let n = 0; n < MAX_PER_DAY + 5; n += 1) await sendContact({ store, name: "R", email: RUDE, message: "Answer me now please", ip: `10.1.${n}.1` });
  is("a real buyer still reaches the creator", await sendContact({ store, name: "B", email: "buyer@example.com", message: "A real question, please", ip: "10.2.0.1" }), "sent");
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
