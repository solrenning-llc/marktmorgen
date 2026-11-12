/**
 * Redis's HSCAN may answer the same field more than once while it walks a hash
 * (a rehash while somebody joins the list): "a given element may be returned
 * multiple times" (redis.io, SCAN guarantees). The list walk (lib/contacts.ts
 * forEachContact) passed every answer on, so an email's audience held the
 * same address twice: its reach was counted too high, a repeat in one batch
 * stopped the send for good (a batch with an address twice is refused, and a
 * listed email cannot be cancelled), and a repeat in two batches emailed the
 * person twice. Now each address is walked once. Synthetic data only; only
 * the HSCAN reply is replaced, to answer one address on two pages.
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { audience, upsertContact } from "@/lib/contacts";
import { advanceBroadcast, createBroadcast } from "@/lib/broadcasts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let repeat = false;
// The first page is the whole hash with a cursor that is not the end; the second page answers its first field again.
redis.pipeline = (async (batch: Command[]) => {
  const out = await real(batch);
  if (!repeat) return out;
  return out.map((reply: unknown, i: number) => {
    const command = batch[i];
    if (command[0] !== "HSCAN" || !Array.isArray(reply)) return reply;
    const flat = reply[1] as string[];
    if (String(command[2]) === "0") return ["7", flat];
    if (String(command[2]) === "7") return ["0", flat.slice(0, 2)];
    return reply;
  });
}) as typeof redis.pipeline;

const OWNER = "scan-repeats@example.com";
const delivery = installSesMailFixture();

async function main(): Promise<void> {
  redis.clear();
  delivery.configure();
  delivery.reset();
  process.env.RESEND_API_KEY = "re_test_scan_repeats_only_a_stand_in";

  const made = await claimHandle(OWNER, "scan-repeats", "Scan Repeats", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ScanRep001", subscriptionId: "sub_ScanRep001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Scan Repeats", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  for (const name of ["ana", "ben", "cy"]) await upsertContact(listId, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);

  part("An address HSCAN answers twice is in the audience once");
  repeat = true;
  const to = await audience(listId);
  is("three people, each once", [to.length, new Set(to).size], [3, 3]);

  part("The email's reach and its sending count each person once");
  const created = await createBroadcast(store, { subject: "News", body: "Hello.", productId: "", notProductId: "", sendAt: undefined });
  if (!created.ok) throw new Error(`no broadcast: ${created.reason}`);
  is("the reach is three", created.broadcast.total, 3);
  delivery.clearCaptured();
  const sent = (await advanceBroadcast(created.broadcast.id, storeForHandle, Date.now() + 60_000))!;
  const got = delivery.sent.flatMap((m) => m.to).sort();
  is("sent, to each person once", [sent.status, sent.sent, sent.total, got], ["sent", 3, 3, ["ana@example.com", "ben@example.com", "cy@example.com"]]);
  repeat = false;

  delivery.restore();
  done();
}

void main();
