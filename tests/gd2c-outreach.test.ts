/**
 * 568 [GD2] (c), outreach: a first email to a business that poses as Marktmorgen is neither kept nor opened to send.
 *
 * Outreach opens each pitch as a draft in the creator's own mailbox (lib/outreach-rules.ts draftLinks), with the
 * store's link in its footer. One signed "Marktmorgen Support", or about the business's Marktmorgen account being
 * locked, is a phishing email with our name on it. With the real route on the in-memory database and a real session
 * (app/api/store/outreach, action "edit"):
 *
 *   - an edit whose subject or text poses is refused with "brand_imitation", where, the passage, why (said of an
 *     email) and the fix; nothing is written and the kept draft stays as it was;
 *   - plain words, saying the store runs on Marktmorgen and the protective opposite are kept as before;
 *   - the studio checks the words before it opens them in Gmail or the mail app or copies them, changed or as first
 *     written, and says the server's refusal with where, the passage, why and the fix, the text left as typed.
 *
 * Synthetic store and pitch only; nothing is sent and no page is read.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { listPitches, saveSender } from "@/lib/outreach";
import { pitchImitation, pitchImitationPart } from "@/lib/outreach-rules";
import { IMITATION_FIX, imitationMessage, imitationWhy } from "@/lib/brand-imitation-rules";
import { POST as outreachRoute } from "@/app/api/store/outreach/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "posing.pitch@example.com";
const ID = "0000000000000001";
const FIRST = { subject: "A partnership idea", body: "Hi,\n\nI make recipe books and would love to work with you." };
type Json = Record<string, unknown> & { ok?: boolean; error?: string; passage?: { field?: string; excerpt?: string; why?: string; fix?: string } };
const PITCH_WHY = imitationWhy("the email cannot be kept or opened to send with it");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "posingpitch", "Posing Pitch", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PosingPitch1", subscriptionId: "sub_PosingPitch1", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  await saveSender(store, { name: "Jenny Park", address: "1 Test Street, Columbus, OH 43004, USA" });
  const now = Math.floor(Date.now() / 1000);
  redis.run([
    "HSET",
    `nl:outreach:${store.statsId}:pitches`,
    ID,
    JSON.stringify({ id: ID, domain: "copperoak.com", to: "partnerships@copperoak.com", company: "Copper & Oak", status: "draft", createdAt: now, sentAt: 0, footer: "Jenny Park", ...FIRST }),
  ]);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${session}` };
  const edit = async (subject: string, body: string): Promise<Json & { status: number }> => {
    const response = await outreachRoute(new NextRequest(`${ORIGIN}/api/store/outreach`, { method: "POST", headers, body: JSON.stringify({ action: "edit", id: ID, subject, body }) }));
    return { status: response.status, ...((await response.json().catch(() => ({}))) as Json) };
  };
  const kept = async () => {
    const pitch = (await listPitches(store)).find((p) => p.id === ID);
    return { subject: pitch?.subject, body: pitch?.body };
  };

  part("A plain edit is kept");
  const plain = await edit("A partnership idea for Copper & Oak", "Hi,\n\nMy store runs on Marktmorgen and I would love to work with you.");
  is("kept", [plain.status, plain.ok, (await kept()).subject], [200, true, "A partnership idea for Copper & Oak"]);
  const before = await kept();

  part("An edit that poses is refused, and the kept draft stays as it was");
  const subject = await edit("Marktmorgen Support: your account", "Hello.");
  is("a subject posing as Marktmorgen's staff: where, the passage, why for an email and the fix", [subject.status, subject.error, subject.passage?.field, subject.passage?.excerpt?.includes("Marktmorgen Support"), subject.passage?.why, subject.passage?.fix], [409, "brand_imitation", "subject", true, PITCH_WHY, IMITATION_FIX]);
  const locked = await edit("About your listing", "Your Marktmorgen account has been locked until you verify it.");
  is("the business's account in trouble, in the text", [locked.status, locked.error, locked.passage?.field], [409, "brand_imitation", "body"]);
  const link = await edit("Your listing", "Sign in at https://rnarktmorgen.com/partners to see it.");
  is("a look-alike address in the text", [link.status, link.error, link.passage?.field], [409, "brand_imitation", "body"]);
  const password = await edit("Your listing", "Reply with your Marktmorgen password and I will set it up.");
  is("a password asked in Marktmorgen's name", [password.status, password.error], [409, "brand_imitation"]);
  is("nothing was written by any of them", await kept(), before);

  part("The protective opposite is kept");
  const opposite = await edit("A partnership idea", "Marktmorgen will never ask for your password, and neither will I.");
  is("kept", [opposite.status, opposite.ok], [200, true]);

  part("The studio says it, and opens nothing that poses");
  is("the same check, before anything leaves the page", [pitchImitation("Hello", "Regards, The Marktmorgen Team")?.field, pitchImitation("Official Marktmorgen offer", "Hi")?.field, pitchImitation(FIRST.subject, FIRST.body)], ["body", "subject", null]);
  is("where it was found", [pitchImitationPart({ field: "subject" }), pitchImitationPart({ field: "body" }), pitchImitationPart(null)], ["the subject line", "the email's text", "the email's text"]);
  is(
    "the sentence: not saved, where, the passage, why, the fix, nothing changed",
    imitationMessage(subject.passage, pitchImitationPart(subject.passage), "Your email was not saved"),
    `Your email was not saved. In the subject line: “${subject.passage?.excerpt}”. ${PITCH_WHY} ${IMITATION_FIX} Nothing you wrote was changed.`,
  );
  const studio = readFileSync("components/outreach-studio.tsx", "utf8");
  is("the server's refusal is said with where, the passage, why and the fix", /if \(data\.error === "brand_imitation"\) return \{ ok: false, error: imitationMessage\(data\.passage, pitchImitationPart\(data\.passage\), "Your email was not saved"\) \};/.test(studio), true);
  is(
    "opening in Gmail, in the mail app and copying are checked first, changed or not",
    /async function saveThen\(open: \(\) => void\) \{\n(?:\s*\/\/.*\n)*\s+const posing = pitchImitation\(subject, body\);\n\s+if \(posing\) \{\n\s+setError\(imitationMessage\(posing, pitchImitationPart\(posing\), "Your email was not opened or copied"\)\);\n\s+return;\n\s+\}/.test(studio) &&
      (studio.match(/saveThen\(/g) ?? []).length === 4,
    true,
  );

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
