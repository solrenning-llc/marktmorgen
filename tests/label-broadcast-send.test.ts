/**
 * An email to the people with one label, end to end (99 [E2-TAG-BROADCAST];
 * added 2 November 2026): made with createBroadcast and sent by
 * advanceBroadcast, against a stand-in sender. Checked: the reach counts only
 * the people with the label; the record keeps the label cleaned, and the
 * strict reader takes it back; each batch goes only to them; a label nobody
 * carries is refused as nobody; a label cleaned twice is the same label
 * (a long one cut at its limit does not end in a space).
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { changeLabels, readTags, upsertContact } from "@/lib/contacts";
import { MAX_TAG_LENGTH } from "@/lib/contact-rules";
import { advanceBroadcast, createBroadcast, readBroadcast } from "@/lib/broadcasts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "owner@example.com";
const batches: { to: string[] }[][] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    batches.push(JSON.parse(String(init?.body)) as { to: string[] }[]);
    return new Response(JSON.stringify({ data: [] }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_label_broadcast_only_a_stand_in";

  part("A label, cleaned twice, is the same label");
  const long = `${"a".repeat(MAX_TAG_LENGTH - 1)} bcd`;
  is("cut at its limit, it does not end in a space", [readTags([long])[0].length < MAX_TAG_LENGTH, readTags([readTags([long])[0]])[0] === readTags([long])[0]], [true, true]);
  is("inner spaces become one", readTags(["VIP  members"])[0], "VIP members");

  part("Made and sent to the people with the label");
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  for (const name of ["ana", "ben", "cy", "dee"]) await upsertContact(listId, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  await changeLabels(listId, ["ana@example.com", "cy@example.com"], (tags) => [...tags, "VIP members"], ROOM);

  const nobody = await createBroadcast(store, { subject: "News", body: "Hello.", productId: "", notProductId: "", sendAt: undefined, label: "nobody has this" });
  is("a label nobody carries is nobody, refused", nobody.ok ? "made" : nobody.reason, "empty");
  const created = await createBroadcast(store, { subject: "News", body: "Hello.", productId: "", notProductId: "", sendAt: undefined, label: "  vip   MEMBERS " });
  if (!created.ok) throw new Error(`no broadcast: ${created.reason}`);
  is("the reach is only the people with the label, and the label is kept cleaned", [created.broadcast.total, created.broadcast.label], [2, "vip MEMBERS"]);
  const read = await readBroadcast(created.broadcast.id);
  is("read back, the label is there", read?.label, "vip MEMBERS");
  batches.length = 0;
  const sent = (await advanceBroadcast(created.broadcast.id, storeForHandle, Date.now() + 60_000))!;
  is("sent only to them", [sent.status, sent.sent, batches.flat().flatMap((m) => m.to).sort()], ["sent", 2, ["ana@example.com", "cy@example.com"]]);

  const plain = await createBroadcast(store, { subject: "News for all", body: "Hello.", productId: "", notProductId: "", sendAt: undefined });
  is("with no label, everyone, as before, and no label on the record", [plain.ok && plain.broadcast.total, plain.ok && "label" in plain.broadcast], [4, false]);

  done();
}

void main();
