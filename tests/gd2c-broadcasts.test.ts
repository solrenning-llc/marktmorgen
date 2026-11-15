/**
 * 568 [GD2] (c), list emails: a broadcast that poses as Marktmorgen itself is neither sent nor scheduled.
 *
 * An email to the whole list reading "Marktmorgen Support: verify your account" goes out from our servers under the
 * store's name, so it is a phishing email with our name on both ends. With the real route on the in-memory database
 * and a real session (app/api/store/mail, action "broadcast"):
 *
 *   - a subject, a second subject (the subject test) or a text that poses is refused with "brand_imitation", where,
 *     the passage, why (said of an email) and the fix; no campaign is written, sending now or later;
 *   - a plain email, saying the store runs on Marktmorgen and the protective opposite are scheduled as before;
 *   - the composer reads it as a refusal (never as an unconfirmed write, which would pause sending), and says it
 *     with where, the passage, why and the fix, with the creator's text left as typed.
 *
 * Synthetic store, contact and data only; nothing is sent (every email here is scheduled for tomorrow).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { IMITATION_FIX, imitationMessage, imitationWhy } from "@/lib/brand-imitation-rules";
import { broadcastAnswer, broadcastImitationPart } from "@/lib/broadcast-response";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "posing.mail@example.com";
type Json = Record<string, unknown> & { ok?: boolean; error?: string; passage?: { field?: string; excerpt?: string; why?: string; fix?: string } };
const MAIL_WHY = imitationWhy("the email cannot be sent with it");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "posingmail", "Posing Mail", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PosingMail01", subscriptionId: "sub_PosingMail01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Posing Mail", address: "1 Test Street" });
  const listId = (await storeForEmail(OWNER))!.listId!;
  await upsertContact(listId, "reader@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${session}` };
  const tomorrow = () => Date.now() + 86_400_000;
  const broadcast = async (input: { subject: string; body: string; test?: unknown; sendAt?: number }): Promise<Json & { status: number }> => {
    const payload = { action: "broadcast", who: "all", productId: "", notProductId: "", sendAt: tomorrow(), ...input };
    const response = await mailRoute(new NextRequest(`${ORIGIN}/api/store/mail`, { method: "POST", headers, body: JSON.stringify(payload) }));
    return { status: response.status, ...((await response.json().catch(() => ({}))) as Json) };
  };
  const campaigns = async () => ((await redis.pipeline([["LRANGE", `nl:mail:bcs:${listId}`, 0, -1]]))[0] as string[]).length;

  part("A plain email is scheduled");
  const plain = await broadcast({ subject: "New recipes this week", body: "Ten dinners, sold on Marktmorgen like the rest of the store." });
  is("scheduled", [plain.status, plain.ok, await campaigns()], [200, true, 1]);

  part("An email that poses is refused, and no campaign is written");
  const subject = await broadcast({ subject: "Marktmorgen Support: action needed", body: "Hello." });
  is("a subject posing as Marktmorgen's staff: where, the passage, why for an email and the fix", [subject.status, subject.error, subject.passage?.field, subject.passage?.excerpt?.includes("Marktmorgen Support"), subject.passage?.why, subject.passage?.fix], [409, "brand_imitation", "subject", true, MAIL_WHY, IMITATION_FIX]);
  const text = await broadcast({ subject: "About your order", body: "Hi,\n\nYour Marktmorgen account has been suspended until you verify it.\n\nThanks" });
  is("its account in trouble, in the text", [text.status, text.error, text.passage?.field], [409, "brand_imitation", "body"]);
  const link = await broadcast({ subject: "Your files", body: "Download them at https://marktmorgen-login.com/files" });
  is("a look-alike address in the text", [link.status, link.error, link.passage?.field], [409, "brand_imitation", "body"]);
  const password = await broadcast({ subject: "Your course", body: "Reply with your Marktmorgen password to open the course." });
  is("a password asked in Marktmorgen's name", [password.status, password.error], [409, "brand_imitation"]);
  const second = await broadcast({ subject: "New recipes", body: "Ten dinners.", test: { subjectB: "Regards, The Marktmorgen Team", share: 20, hours: 4, by: "visits" } });
  is("the second subject of a subject test", [second.status, second.error, second.passage?.field], [409, "brand_imitation", "test_subject"]);
  const now = await broadcast({ subject: "Marktmorgen Support: action needed", body: "Hello.", sendAt: undefined });
  is("sending now is refused the same way", [now.status, now.error], [409, "brand_imitation"]);
  is("no campaign was written by any of them", await campaigns(), 1);

  part("The protective opposite passes");
  const opposite = await broadcast({ subject: "A note on safety", body: "Marktmorgen will never ask for your password. Neither will I." });
  is("scheduled", [opposite.status, opposite.ok, await campaigns()], [200, true, 2]);

  part("The composer says it");
  is("the answer is read as a refusal, never as an unconfirmed write", broadcastAnswer(false, { ok: false, error: "brand_imitation", passage: subject.passage }, { action: "broadcast" }).error, "brand_imitation");
  is("where it was found", [broadcastImitationPart({ field: "subject" }), broadcastImitationPart({ field: "test_subject" }), broadcastImitationPart({ field: "body" }), broadcastImitationPart(null)], ["the subject line", "the second subject line", "the email's text", "the email's text"]);
  const said = imitationMessage(subject.passage, broadcastImitationPart(subject.passage), "Your email was not sent");
  is("the sentence: not sent, where, the passage, why, the fix, nothing changed", said, `Your email was not sent. In the subject line: “${subject.passage?.excerpt}”. ${MAIL_WHY} ${IMITATION_FIX} Nothing you wrote was changed.`);
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the composer uses it, for sending and scheduling, before the other refusals", /if \(payload\.action === "broadcast" && a\.error === "brand_imitation"\) \{\n\s+setError\(imitationMessage\(a\.passage, broadcastImitationPart\(a\.passage\), later \? "Your email was not scheduled" : "Your email was not sent"\)\);\n\s+return false;\n\s+\}\n\s+setError\(message\(a\)\);/.test(studio), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
