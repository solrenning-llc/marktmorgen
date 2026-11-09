/**
 * A notice's emails whose send is not known (audit "envio incerto", 9 November 2026; rule 30): sendEmail answers
 * false also when the sender may have taken the email (a server error, a timeout). Only a certain refusal may be
 * treated as "not sent".
 *
 *   fileReport (lib/takedown.ts:57): an uncertain copy to the support inbox keeps the notice, counts it once on the
 *     transparency page and tells the sender the truth (saved, not confirmed, do not send it again), so the sender
 *     does not file it twice and the count does not miss it. A certain refusal stays "error" and is not counted.
 *   complete (lib/takedown.ts:437): an uncertain notice to the creator is never sent again, neither by pressing the
 *     takedown again nor by "Send the email to the creator" (the provider's key lasts only 24 h, so a later press
 *     would email the creator twice). The page keeps listing it as not confirmed, says it may have gone and offers
 *     no send button; the press says so. A certain refusal still offers the send, as before.
 *
 * Synthetic store, in-memory Redis, the email provider stood in by fetch. No network.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { POST as takedownRoute } from "@/app/api/takedown/route";
import { POST as reportRoute } from "@/app/api/report/route";
import TakedownPage from "@/app/takedown/[token]/page";
import { addStoreLink, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport, unsentNotices } from "@/lib/takedown";
import { transparencyCounts } from "@/lib/transparency";
import { reportAnswer } from "@/lib/report-response";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ORIGIN = "https://marktmorgen.com";
type Mail = { to: string[] | string; subject: string; text: string };
/** Every email the provider was asked for, taken or not. */
const asked: Mail[] = [];
let sender: "ok" | "uncertain" | "refused" = "ok";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    asked.push(JSON.parse(String(init?.body)) as Mail);
    if (sender === "uncertain") return new Response(JSON.stringify({ message: "internal" }), { status: 500 });
    if (sender === "refused") return new Response(JSON.stringify({ message: "invalid" }), { status: 422 });
    return new Response(JSON.stringify({ id: `email_${asked.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const NOTICE = {
  kind: "copyright",
  url: `${ORIGIN}/@unsureshop`,
  work: "My song 'Harbor Lights', played on this page from an upload I did not make.",
  original: "https://example.com/harbor-lights",
  name: "Rita Owner",
  email: "rita@example.com",
  contact: "+1 555 0100",
  signature: "Rita Owner",
  goodFaith: true,
  accurate: true,
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";
  const owner = "unsure@example.com";
  await claimHandle(owner, "unsureshop", "Unsure Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestUnsure001", true);
  await setSubscription(owner, { customerId: "cus_Unsure001", subscriptionId: "sub_Unsure001", active: true, period: paidPeriod() });
  const links: string[] = [];
  for (const title of ["First track", "Second track", "Third track"]) {
    const made = await addStoreLink(owner, title, `https://example.com/${title.toLowerCase().replace(" ", "-")}`);
    if (!made.ok) throw new Error(`setup: ${title}`);
    links.push(made.store.links.find((l) => l.title === title)!.id);
  }
  const store = () => storeForEmail(owner).then((s) => s!);
  const read = readReport(NOTICE);
  if (!read.ok) throw new Error("setup: notice");
  const counted = async () => (await transparencyCounts()).years[0]?.notices.copyright ?? 0;

  part("A notice whose copy to the support inbox may have gone (lib/takedown.ts:57)");
  {
    sender = "uncertain";
    asked.length = 0;
    const result = await fileReport(read.report, "7.7.7.1", ORIGIN);
    sender = "ok";
    const token = asked[0]?.text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
    is("said as saved but not confirmed, never as an error to send again", result, "unsure");
    is("the notice is kept: its link opens it", Boolean(await openReport(token)), true);
    is("counted once on the transparency page", await counted(), 1);

    sender = "uncertain";
    const response = await reportRoute(new NextRequest(`${ORIGIN}/api/report`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "marktmorgen.com" },
      body: JSON.stringify({ ...NOTICE }),
    }));
    sender = "ok";
    const body = (await response.json()) as Record<string, unknown>;
    is("the route answers it as kept, not as a failure", [response.ok, body.ok, body.kept], [true, true, true]);
    const answer = reportAnswer(response.ok, body);
    is("the form reads it as kept (no form to send again)", answer, { ok: true, kept: true });
    is("a plain receipt is still a plain success", reportAnswer(true, { ok: true }), { ok: true });
    const form = readFileSync("components/report-form.tsx", "utf8");
    is("the form's kept screen says it is saved, not confirmed, and not to send it again", [
      form.includes("Your notice is saved, but we could not confirm it reached our team"),
      form.includes("Please do not send the form again"),
    ], [true, true]);
  }

  part("Control: a certain refusal stays an error and is not counted");
  {
    const before = await counted();
    sender = "refused";
    const result = await fileReport(read.report, "7.7.7.2", ORIGIN);
    sender = "ok";
    is("refused: error, not counted", [result, await counted()], ["error", before]);
  }

  // The notice whose link acts on the store, filed while the sender takes it.
  asked.length = 0;
  if ((await fileReport(read.report, "7.7.7.3", ORIGIN)) !== "sent") throw new Error("setup: filed");
  const token = asked[0].text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  const opened = await openReport(token);
  if (!opened?.store) throw new Error("setup: opened");
  const report = opened.report;
  const press = async (action: unknown, owed = false) => {
    const response = await takedownRoute(new NextRequest(`${ORIGIN}/api/takedown`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "marktmorgen.com" },
      body: JSON.stringify(owed ? { token, action, owed: true } : { token, action }),
    }));
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, error: body.error ?? null };
  };
  const toCreator = () => asked.filter((m) => [m.to].flat().includes(owner)).length;
  const page = async () => renderToStaticMarkup(await TakedownPage({ params: Promise.resolve({ token }) }));

  part("The notice to the creator may have gone (lib/takedown.ts:437)");
  {
    const id = links[0];
    asked.length = 0;
    sender = "uncertain";
    const first = await press({ type: "link", id });
    sender = "ok";
    is("the press says the email is not confirmed, never 'press again'", first.error, "notice_unsure");
    is("the link is down, one email asked for", [(await store()).links.some((l) => l.id === id), toCreator()], [false, 1]);
    const again = await press({ type: "link", id });
    const owedPress = await press({ type: "link", id }, true);
    is("pressing the takedown again sends nothing more", [again.error, toCreator()], ["notice_unsure", 1]);
    is("\"Send the email to the creator\" sends nothing more", [owedPress.error, toCreator()], ["notice_unsure", 1]);
    const owed = await unsentNotices(report, await store());
    is("still listed as not confirmed, marked as possibly sent", owed.map((o) => ("unsure" in o ? o.unsure : false)), [true]);
    const html = await page();
    is("the page says it may have gone and offers no send button for it", [
      html.includes("Our email service did not confirm whether this email went out"),
      html.includes("Send the email to the creator"),
    ], [true, false]);
    const button = readFileSync("components/takedown-actions.tsx", "utf8");
    is("the press's words say it is not sent again", button.includes("We do not send it again, so the creator never gets two copies"), true);
  }

  part("Control: a certain refusal is still offered to send, and sends once");
  {
    const id = links[1];
    asked.length = 0;
    sender = "refused";
    const first = await press({ type: "link", id });
    sender = "ok";
    is("refused: notice_unsent", first.error, "notice_unsent");
    is("the page offers the send for it", (await page()).includes("Send the email to the creator"), true);
    const sent = await press({ type: "link", id }, true);
    is("the owed press sends it", [sent.status, toCreator()], [200, 2]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
