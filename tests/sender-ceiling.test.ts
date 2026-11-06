/**
 * The Resend ceiling still protects service and import email, while creator
 * list delivery waits for confirmed Amazon SES capacity.
 *
 * Resend pauses a whole account at five times its plan's monthly emails
 * (resend.com/docs/knowledge-base/account-quotas-and-limits, read October 6,
 * 2026). The account includes login links and emails that hand buyers their
 * files. These checks preserve that ceiling and its service reserve, then
 * prove that a saved list waits for SES, loses nothing and resumes by itself
 * without falling through to Resend.
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { advanceBroadcast, createBroadcast } from "@/lib/broadcasts";
import { sendBatch, sendEmail, sentKey, sentThisMonth } from "@/lib/email";
import { SENDER_WAIT_NOTE, listCeiling, reserve, reserveDay, senderQuota, senderRoom, usedThisMonth } from "@/lib/mail";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { windowId } from "@/lib/allowance-window";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "owner@example.com";
type Message = { to: string[]; subject: string };
const single: Message[] = [];
const batches: Message[][] = [];
let senderDown = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.resend.com") return new Response("{}", { status: 404 });
  if (senderDown) return new Response("{}", { status: 500 });
  if (url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as Message[];
    batches.push(batch);
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  else single.push(JSON.parse(String(init?.body)) as Message);
  return new Response(JSON.stringify({ id: "email_1" }));
}) as typeof fetch;

const message = (to: string) => ({ meter: { by: "company" } as const, from: "Marktmorgen <hello@marktmorgen.com>", to, subject: "Hello", text: "Hello.", html: "<p>Hello.</p>" });

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_ceiling_only_a_stand_in";
  delete process.env.SENDER_MONTHLY_QUOTA;

  part("The ceiling");
  is("the sender's plan, unless the host says otherwise", senderQuota(), 50_000);
  is("list email waits at four fifths of five times that", listCeiling(), 200_000);
  process.env.SENDER_MONTHLY_QUOTA = "100000";
  is("a larger plan, set on the host, moves it", [senderQuota(), listCeiling()], [100_000, 400_000]);
  process.env.SENDER_MONTHLY_QUOTA = "plenty";
  is("a setting that is not a number is not believed", senderQuota(), 50_000);
  delete process.env.SENDER_MONTHLY_QUOTA;

  part("Everything sent is counted, whatever it is");
  await sendEmail({ ...message("buyer@example.com"), subject: "Your login link" });
  is("a login link counts", await sentThisMonth(), 1);
  await sendBatch([message("a@example.com"), message("b@example.com"), message("not an address")], "batch-1", { by: "company" });
  is("a batch counts what actually went, not what could not be addressed", await sentThisMonth(), 3);
  senderDown = true;
  await sendEmail(message("c@example.com"));
  await sendBatch([message("d@example.com")], "batch-2", { by: "company" });
  senderDown = false;
  is("what the sender did not take is not counted", await sentThisMonth(), 3);

  part("A store's list email meets it");
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "scale", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  for (let i = 0; i < 30; i += 1) await upsertContact(store.listId as string, `reader${i}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);

  is("with room, it is taken as always", await reserve(store, 10), "ok");
  is("and counted against the store's own month", await usedThisMonth(store.listId, windowId(store)), 10);

  // Every other store's month, all at once: twenty emails short of the ceiling.
  redis.run(["SET", sentKey(), String(listCeiling() - 20)]);
  is("room for twenty", await senderRoom(), 20);
  is("twenty still fit", await reserve(store, 20), "ok");
  single.length = 0;
  is("twenty-one do not, and the reason is the sender, not the store", await reserve(store, 21), "sender");
  is("nothing was taken from the store's month for them", await usedThisMonth(store.listId, windowId(store)), 30);
  is("a bulk notice is refused the same way", await reserveDay(21), false);

  part("The owner is told, once");
  is("one email to the site's own inbox", single.map((m) => [m.to[0], m.subject]), [["support@marktmorgen.com", "List email is waiting for Amazon SES"]]);
  await reserve(store, 21);
  await reserve(store, 21);
  is("and not again this month, however many sends meet it", single.length, 1);

  part("What a store cannot run without still goes");
  redis.run(["SET", sentKey(), String(listCeiling())]);
  is("list email has no room left", await senderRoom(), 0);
  single.length = 0;
  const went = await sendEmail({ ...message("buyer@example.com"), subject: "Your login link" });
  is("a login link is sent all the same", [went, single.length], [true, 1]);

  part("A broadcast waits for SES, and goes on by itself");
  redis.run(["SET", sentKey(), String(listCeiling() - 10)]);
  const mail = installSesMailFixture({ fallback: globalThis.fetch });
  mail.configure();
  await mail.setReady(false);
  const created = await createBroadcast(store, { subject: "The plan is here", body: "It is ready.", productId: "", notProductId: "", sendAt: undefined });
  if (!created.ok) throw new Error(`no broadcast: ${created.reason}`);
  batches.length = 0;
  let b = (await advanceBroadcast(created.broadcast.id, storeForHandle, Date.now() + 30_000))!;
  is("it waits, and says why in words a creator can read", [b.status, b.note === SENDER_WAIT_NOTE], ["waiting", true]);
  is("nobody was written to, and nobody was dropped", [b.sent, b.total, mail.sesAttempts.length, batches.length], [0, 30, 0, 0]);
  await mail.setReady(true);
  b = (await advanceBroadcast(created.broadcast.id, storeForHandle, Date.now() + 30_000))!;
  is("with SES capacity confirmed, it finishes without anyone pressing anything", [b.status, b.sent, b.note], ["sent", 30, ""]);
  is("to everyone through SES once, never through Resend", [mail.ses.length, new Set(mail.ses.flatMap((m) => m.to)).size, mail.resend.length, batches.length], [30, 30, 0, 0]);
  mail.restore();


  part("Unconfirmed sender usage cannot authorize list admission");
  const originalPipeline = redis.pipeline;
  const usageRead = (commands: (string | number)[][]) =>
    commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === sentKey();
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, { 0: null });
  let getterCalls = 0;
  const computed = new Array(1);
  Object.defineProperty(computed, "0", { get: () => { getterCalls += 1; return null; } });
  const malformed: [string, unknown][] = [
    ["not an array", {}], ["null envelope", null], ["empty", []],
    ["extra position", [null, null]], ["sparse", new Array(1)],
    ["inherited absence", inherited], ["computed absence", computed],
    ["undefined", [undefined]], ["numeric coercion", [0]], ["boolean", [false]],
    ["object coercion", [{ valueOf: () => 0 }]], ["empty string", [""]],
    ["space", [" 0"]], ["leading zero", ["01"]], ["negative", ["-1"]],
    ["fraction", ["0.5"]], ["exponent", ["1e2"]],
    ["unsafe integer", ["9007199254740992"]], ["lost reply", new Error("synthetic usage read lost")],
  ];
  const beforeUsage = await usedThisMonth(store.listId, windowId(store));
  batches.length = 0;
  try {
    for (const [name, reply] of malformed) {
      redis.pipeline = async commands => {
        if (usageRead(commands)) {
          if (reply instanceof Error) throw reply;
          return reply as unknown[];
        }
        return originalPipeline.call(redis, commands);
      };
      is(`${name}: missing proof remains distinct from zero`, await sentThisMonth(), null);
      is(`${name}: no confirmed capacity for list admission`, await senderRoom(), 0);
      is(`${name}: actual reservation waits before taking a store unit`, await reserve(store, 1), "sender");
      is(`${name}: store allowance remains intact`, await usedThisMonth(store.listId, windowId(store)), beforeUsage);
    }
    is("usage getters were never invoked", getterCalls, 0);
    is("no list provider batch was dispatched", batches.length, 0);
    for (const [raw, expected] of [[null, 0], ["0", 0], ["37", 37], ["9007199254740991", Number.MAX_SAFE_INTEGER]] as const) {
      redis.pipeline = async commands => usageRead(commands) ? [raw] : originalPipeline.call(redis, commands);
      is(`confirmed ${String(raw)} has its exact value`, await sentThisMonth(), expected);
    }

    redis.pipeline = async commands => usageRead(commands) ? [] : originalPipeline.call(redis, commands);
    redis.run(["DEL", `nl:sender:${new Date().toISOString().slice(0, 7)}:told`]);
    single.length = 0;
    await reserve(store, 1);
    is("unknown usage does not invent a new diagnosis or dispatch an accepted owner notice again",
      [single.map(m => m.subject), redis.run(["GET", `nl:sender:${new Date().toISOString().slice(0, 7)}:told`])], [[], "1"]);
    single.length = 0;
    is("an essential login link remains available while list usage is unknown",
      [await sendEmail({ ...message("buyer@example.com"), subject: "Your login link" }), single.length], [true, 1]);
  } finally {
    redis.pipeline = originalPipeline;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
