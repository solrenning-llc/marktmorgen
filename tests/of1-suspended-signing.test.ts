/**
 * 662 [OF1], unit 2 (the buyer's pages): a proposal or agreement sent by a
 * store that is then switched off after a report (lib/takedown.ts). Nothing new
 * is signed there and nothing is paid there: the page shows the text with
 * "This can't be signed now" in place of the form, the form's route refuses,
 * and a signed one keeps its record without the button to pay. Switched back
 * on, it signs and pays as before. The real page and route, with a synthetic
 * store and agreement.
 */
import { createElement } from "react";
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import SignPage from "@/app/[handle]/sign/[agreement]/page";
import { POST as signRoute } from "@/app/api/store/agreement-sign/route";
import { readDraft, type AgreementDraft } from "@/lib/agreement-rules";
import { createAgreement } from "@/lib/agreement-store";
import { agreementWords } from "@/lib/buyer-words/agreements";
import { claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "of1-signing@example.com";
const HANDLE = "of1signing";
const BASE = "https://marktmorgen.com";

globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_of1" }))) as typeof fetch;

async function html(node: unknown): Promise<string> {
  const stream = await renderToReadableStream(createElement("div", null, node as React.ReactElement), { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_of1_signing_only_a_stand_in";
  await claimHandle(OWNER, HANDLE, "Mara's Coaching", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestOfOneSig", true);
  await setSubscription(OWNER, { customerId: "cus_OfOneSign001", subscriptionId: "sub_OfOneSign001", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  // The payment request the proposal names, paid once it is signed (lib/payment-request-store.ts, its record).
  const now = Date.now();
  const payId = "b".repeat(32);
  await redis.pipeline([["SET", `nl:payreq:r:${payId}`, JSON.stringify({ id: payId, sid: store.sid, email: "client@example.com", name: "Dana Reyes", lines: [{ text: "Repair", quantity: 1, cents: 30_000 }], note: "", currency: "usd", total: 30_000, createdAt: now - 1000, dueDate: "", expiresAt: now + 30 * 86_400_000, state: "open", autoReminders: 0, sent: [now - 1000], failed: "" })]]);
  const read = readDraft({ payRequest: payId,  kind: "proposal", email: "client@example.com", name: "Dana Reyes", title: "Kiln repair", body: "Repair the kiln in November.", lines: [{ text: "Repair", quantity: 1, amount: "300" }], consent: true }, "usd");
  if (!read.ok) throw new Error("no draft");
  const created = await createAgreement(store, (read as { ok: true; draft: AgreementDraft }).draft, Date.now());
  if (!created.ok) throw new Error(created.message);
  const { agreement, version } = created;
  const w = agreementWords(store.language);

  const drawnWith = async (query: Record<string, string>) => {
    answering(new NextRequest(`${BASE}/@${HANDLE}/sign/${agreement.id}`));
    return html(await SignPage({ params: Promise.resolve({ handle: `@${HANDLE}`, agreement: agreement.id }), searchParams: Promise.resolve(query) } as never));
  };
  const page = async () => {
    const drawn = await drawnWith({});
    return {
      text: drawn.includes("Repair the kiln in November."),
      form: drawn.includes('action="/api/store/agreement-sign"'),
      closed: drawn.includes(escaped(w.notices.closed.title)),
      record: drawn.includes(escaped(w.copyRecord)),
      pay: drawn.includes(`/@${HANDLE}/pay/${payId}`),
    };
  };
  const sign = () =>
    signRoute(new NextRequest(`${BASE}/api/store/agreement-sign`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
      body: new URLSearchParams({ handle: HANDLE, agreement: agreement.id, version: String(version.n), sha256: version.sha256, name: "Dana Reyes", email: "client@example.com", agree: "yes" }),
    }));

  part("The store on (control)");
  is("the text, with the form to sign it", await page(), { text: true, form: true, closed: false, record: false, pay: false });

  part("The store switched off after a report");
  await noteTakedown(OWNER, null, true);
  is("the text stays, with no form: it can't be signed now", await page(), { text: true, form: false, closed: true, record: false, pay: false });
  const refused = await sign();
  is("the form's route signs nothing and says so", refused.headers.get("location"), `${BASE}/@${HANDLE}/sign/${agreement.id}?notice=closed`);
  // Where the route sends the form: "This can't be signed now" said once, so a screen reader hears it once (Claude 4 on #3203).
  const sentBack = await drawnWith({ notice: "closed" });
  is("sent back from the form, it is said once", sentBack.split(escaped(w.notices.closed.title)).length - 1, 1);

  part("Switched back on");
  await noteTakedown(OWNER, null, false);
  is("the form is back", await page(), { text: true, form: true, closed: false, record: false, pay: false });
  const signed = await sign();
  is("and signing works", signed.headers.get("location"), `${BASE}/@${HANDLE}/sign/${agreement.id}?notice=signed`);
  is("signed: the record, with the way to pay", await page(), { text: true, form: false, closed: false, record: true, pay: true });

  part("Signed, then the store switched off");
  await noteTakedown(OWNER, null, true);
  is("the signed record stays, with no way to pay", await page(), { text: true, form: false, closed: false, record: true, pay: false });
  await noteTakedown(OWNER, null, false);
  is("back on, the way to pay is back", (await page()).pay, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
