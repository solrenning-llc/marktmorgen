/**
 * 568 [GD2] (c), email sequences: a sequence is never switched on while one of its emails poses as Marktmorgen.
 *
 * A sequence sends itself to everyone it starts, with nobody reading each email as it goes, so "Marktmorgen
 * Support: verify your account" in one of its steps is a phishing email sent on its own from our servers. With the
 * real route on the in-memory database and a real session (app/api/store/mail; lib/flows.ts):
 *
 *   - switched off, a sequence may keep such words, as a draft does;
 *   - switching it on is refused with "brand_imitation", which step, its subject or text, the passage, why (said of a
 *     sequence) and the fix, and it stays off;
 *   - saving it switched on is refused the same way and nothing is written: a sequence already on keeps the emails
 *     it had;
 *   - "keep sending" a sent email that poses (one written before this rule) is refused, and no sequence is made;
 *   - plain emails, saying the store runs on Marktmorgen, and steps that act (they send nothing) pass;
 *   - the composer says it for each of the three, with the creator's words left as typed.
 *
 * Synthetic store, contact and data only; nothing is sent.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { createBroadcast } from "@/lib/broadcasts";
import { flowImitation, readFlows } from "@/lib/flows";
import { IMITATION_FIX, imitationWhy } from "@/lib/brand-imitation-rules";
import { sequenceImitationWords } from "@/lib/mail-response";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "posing.sequence@example.com";
type Json = Record<string, unknown> & { ok?: boolean; error?: string; passage?: { field?: string; step?: number; excerpt?: string; why?: string; fix?: string }; flows?: { id: string; active: boolean }[] };
const SEQUENCE_WHY = imitationWhy("the sequence cannot send it");
const POSING = "Marktmorgen Support: verify your account";

async function main(): Promise<void> {
  part("The rule over a sequence's steps");
  is("a subject that poses, at step 1", flowImitation([{ subject: POSING, body: "Hello." }])?.step, 1);
  is("a text that poses, at step 2, in the text", [flowImitation([{ subject: "Hi", body: "Welcome." }, { subject: "Next", body: "Enter your Marktmorgen password here." }])?.step, flowImitation([{ subject: "Hi", body: "Welcome." }, { subject: "Next", body: "Enter your Marktmorgen password here." }])?.field], [2, "body"]);
  is("steps that act send nothing and are passed over", flowImitation([{ subject: "", body: "", action: { do: "tag", tag: "vip" } as never }, { subject: "Hi", body: "Sold on Marktmorgen." }]), null);
  is("the reason is said of a sequence, with the fix", [flowImitation([{ subject: POSING, body: "x" }])?.why, flowImitation([{ subject: POSING, body: "x" }])?.fix], [SEQUENCE_WHY, IMITATION_FIX]);

  redis.clear();
  await claimHandle(OWNER, "posingsequence", "Posing Sequence", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PosingSeq01", subscriptionId: "sub_PosingSeq01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Posing Sequence", address: "1 Test Street" });
  const listId = (await storeForEmail(OWNER))!.listId!;
  await upsertContact(listId, "reader@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${session}` };
  const mail = async (body: unknown): Promise<Json & { status: number }> => {
    const response = await mailRoute(new NextRequest(`${ORIGIN}/api/store/mail`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, ...((await response.json().catch(() => ({}))) as Json) };
  };
  const flow = (steps: { subject: string; body: string }[], extra: Record<string, unknown> = {}) => ({ action: "flow", flow: { name: "Welcome", trigger: "joined", steps: steps.map((step, i) => ({ delayHours: i * 24, ...step })), ...extra } });
  const flowsNow = async () => readFlows(listId);

  part("Switched off, it may keep the words; switched on, it may not");
  const kept = await mail(flow([{ subject: POSING, body: "Hello." }]));
  const keptId = kept.flows?.[0]?.id ?? "";
  is("saved switched off", [kept.status, kept.ok, (await flowsNow()).map((f) => f.active)], [200, true, [false]]);
  const on = await mail({ action: "flow-activate", id: keptId, active: true });
  is("switching it on is refused: which step, which part, the passage, why and the fix", [on.status, on.error, on.passage?.step, on.passage?.field, on.passage?.excerpt?.includes("Marktmorgen Support"), on.passage?.why, on.passage?.fix], [409, "brand_imitation", 1, "subject", true, SEQUENCE_WHY, IMITATION_FIX]);
  is("and it stays off", (await flowsNow()).find((f) => f.id === keptId)?.active, false);
  const savedOn = await mail(flow([{ subject: "Welcome", body: "Hello." }, { subject: "Your files", body: "Download them at https://marktmorgen-login.com/files" }], { id: keptId, active: true }));
  is("saving it switched on is refused for the email that poses", [savedOn.status, savedOn.error, savedOn.passage?.step, savedOn.passage?.field], [409, "brand_imitation", 2, "body"]);
  is("and nothing is written", (await flowsNow()).find((f) => f.id === keptId)?.steps.map((s) => s.subject), [POSING]);

  part("A plain sequence is switched on, and keeps its emails when an edit poses");
  const plainSaved = await mail(flow([{ subject: "Welcome", body: "Glad you are here. My store runs on Marktmorgen." }], { id: keptId }));
  const plainOn = await mail({ action: "flow-activate", id: keptId, active: true });
  is("plain words: saved and switched on", [plainSaved.status, plainOn.status, (await flowsNow()).find((f) => f.id === keptId)?.active], [200, 200, true]);
  const edit = await mail(flow([{ subject: "Welcome", body: "Your Marktmorgen account has been suspended until you verify it." }], { id: keptId, active: true }));
  is("an edit that poses, on a sequence already on, is refused", [edit.status, edit.error], [409, "brand_imitation"]);
  is("and it goes on with the emails it had", (await flowsNow()).find((f) => f.id === keptId)?.steps.map((s) => s.body), ["Glad you are here. My store runs on Marktmorgen."]);
  const off = await mail({ action: "flow-activate", id: keptId, active: false });
  is("switching it off is never refused", [off.status, (await flowsNow()).find((f) => f.id === keptId)?.active], [200, false]);

  part("Keep sending a sent email that poses");
  const store = (await storeForEmail(OWNER))!;
  const created = await createBroadcast(store, { subject: POSING, body: "Hello from the store.", productId: null, notProductId: null, sendAt: Date.now() + 86_400_000 });
  if (!created.ok) throw new Error(`no campaign: ${created.reason}`);
  const key = `nl:mail:bc:${created.broadcast.id}`;
  const record = JSON.parse(String((await redis.pipeline([["GET", key]]))[0])) as Record<string, unknown>;
  await redis.pipeline([["SET", key, JSON.stringify({ ...record, status: "sent", sent: record.total, sendAt: Math.floor(Date.now() / 1000) - 3_600 })]]);
  const before = (await flowsNow()).length;
  const keep = await mail({ action: "keep", id: created.broadcast.id });
  is("refused with the step and part", [keep.status, keep.error, keep.passage?.field, keep.passage?.step], [409, "brand_imitation", "subject", 1]);
  is("and no sequence is made", (await flowsNow()).length, before);

  part("The composer says it");
  is("which step and part, the passage, why, the fix", sequenceImitationWords(on, "The sequence was not switched on"), `The sequence was not switched on. In the subject of step 1: “${on.passage?.excerpt}”. ${SEQUENCE_WHY} ${IMITATION_FIX} Nothing you wrote was changed.`);
  is("without a step it names one of its emails", sequenceImitationWords({ ok: false, error: "brand_imitation", passage: { field: "body" } }, "Your sequence was not saved").startsWith("Your sequence was not saved. In the text of one of its emails."), true);
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("for keep sending, saving and switching on", [
    studio.includes('a.error === "brand_imitation" ? sequenceImitationWords(a, "This email was not kept sending") : message(a)'),
    studio.includes('setError(a.error === "brand_imitation" ? sequenceImitationWords(a, "Your sequence was not saved") : message(a));'),
    studio.includes('setError(a.error === "brand_imitation" ? sequenceImitationWords(a, "The sequence was not switched on") : message(a));'),
  ], [true, true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
