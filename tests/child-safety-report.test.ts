/**
 * Reports of child sexual exploitation and of intimate images shared without
 * consent (C1-20261109-1546-TODOS-70; 18 U.S.C. § 2258A; TAKE IT DOWN Act).
 *
 * /report takes two more kinds of notice. A child-safety report takes the
 * product it points at off the store at once, without deleting anything (the
 * evidence is kept), and the owner gets an urgent email that never carries
 * the reported content, the reporter's description of it, or a preview. A
 * report of an intimate image shared without consent is held to what the
 * TAKE IT DOWN Act asks of a request, and the owner's urgent email says by
 * when it has to be removed (48 hours). An anonymous form must not become a
 * way to take any store down, so the automatic step is capped per store per
 * day. Synthetic store, email stand-in and in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { REPORT_KINDS, readReport } from "@/lib/takedown-rules";
import { CHILD_SAFETY_HOLDS_PER_DAY, TAKE_IT_DOWN_HOURS, alertOwner, holdReported } from "@/lib/child-safety";
import { POST as reportRoute } from "@/app/api/report/route";
import { readListing } from "@/lib/catalog";
import { fileReport, openReport, takeDown } from "@/lib/takedown";
import TakedownPage from "@/app/takedown/[token]/page";
import { type ReactNode, isValidElement } from "react";
import { transparencyCounts } from "@/lib/transparency";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[] | string; subject: string; text: string; key?: string };
const sent: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const headers = new Headers(init?.headers);
    sent.push({ ...(JSON.parse(String(init?.body)) as Sent), key: headers.get("idempotency-key") ?? undefined });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const DESCRIPTION = "This product page sells material that exploits a child. Please act now.";
const CHILD = { kind: "child_safety", url: "", work: DESCRIPTION, name: "", email: "worried@example.com", signature: "", goodFaith: true, accurate: false };
const INTIMATE = { kind: "intimate_image", url: "", work: "This is an intimate photo of me, shared here without my consent.", name: "Dana Doe", email: "dana@example.com", signature: "Dana Doe", goodFaith: true, accurate: true };

/** The words a server page puts on screen: text children and title, label and eyebrow props, without running any component. */
function wordsOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(wordsOf).join("");
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const named = ["title", "label", "eyebrow"].map((key) => (typeof props[key] === "string" ? ` ${props[key]} ` : "")).join("");
    return named + wordsOf(props.children as ReactNode);
  }
  return "";
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const owner = "safety@example.com";
  await claimHandle(owner, "safetyshop", "Safety Shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_cs", subscriptionId: "sub_cs", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const made = await addProduct(owner, "A Reported Product", "On sale", "19", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const url = `https://marktmorgen.com/@safetyshop/p/${id}`;

  part("The kinds of notice");
  is("two more kinds", REPORT_KINDS.includes("child_safety" as never) && REPORT_KINDS.includes("intimate_image" as never), true);
  is("a child-safety report needs no name, signature or sworn statement", readReport({ ...CHILD, url }).ok, true);
  is("it asks for no words about the content at all", readReport({ ...CHILD, url, work: "" }).ok, true);
  is("but it needs the address and an email to reply to", [readReport({ ...CHILD, url: "" }).ok, readReport({ ...CHILD, url, email: "" }).ok], [false, false]);
  is("an intimate-image request is signed by the person, with the statement that it is shared without consent", [readReport({ ...INTIMATE, url }).ok, readReport({ ...INTIMATE, url, signature: "" }).ok, readReport({ ...INTIMATE, url, goodFaith: false }).ok], [true, false, false]);

  part("A child-safety report takes the product off the store at once, and deletes nothing");
  const store = (await storeForEmail(owner))!;
  const held = await holdReported({ kind: "child_safety", url }, store);
  is("held", held, "held");
  const after = await readListing((await storeForEmail(owner))!, id);
  is("the product is a draft now, and still there with its files", [after?.hidden, after?.title], [true, "A Reported Product"]);
  is("an address that names no product of the store: nothing is touched", await holdReported({ kind: "child_safety", url: "https://marktmorgen.com/@safetyshop" }, store), "no_product");
  is("an intimate-image request is not taken down automatically: the owner removes it within the 48 hours", await holdReported({ kind: "intimate_image", url }, store), "not_held");

  part("Capped per store per day, so the form is not a weapon");
  is("the cap", CHILD_SAFETY_HOLDS_PER_DAY, 3);
  const again = [];
  for (let n = 0; n < 2; n++) again.push(await holdReported({ kind: "child_safety", url }, (await storeForEmail(owner))!));
  is("the same product reported again, or a retry, is held again and does not spend the day", again, ["held", "held"]);
  const others = [];
  for (let n = 0; n < 4; n++) {
    const other = await addProduct(owner, `Another ${n}`, "On sale", "9", null);
    if (other.ok) others.push(other.product.id);
  }
  const results = [];
  for (const other of others) results.push(await holdReported({ kind: "child_safety", url: `https://marktmorgen.com/@safetyshop/p/${other}` }, (await storeForEmail(owner))!));
  is("after the cap, the owner decides", results, ["held", "held", "capped", "capped"]);
  is("a product over the cap stays over it when reported again", await holdReported({ kind: "child_safety", url: `https://marktmorgen.com/@safetyshop/p/${others[2]}` }, (await storeForEmail(owner))!), "capped");
  is("and it was never taken off", (await readListing((await storeForEmail(owner))!, others[2]))?.hidden, false);
  const failing = redis.pipeline.bind(redis);
  // Only the day's count answers off its shape; the product is read as it is.
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "SADD" ? [null, null, null] : failing(commands))) as typeof redis.pipeline;
  const unread = await holdReported({ kind: "child_safety", url: `https://marktmorgen.com/@safetyshop/p/${others[3]}` }, (await storeForEmail(owner))!).catch(() => "threw");
  redis.pipeline = failing;
  is("a count that cannot be read holds nothing and does not throw", unread, "unknown");

  part("The owner's urgent email carries no content");
  sent.length = 0;
  await alertOwner({ kind: "child_safety", url, work: DESCRIPTION }, "held", Date.UTC(2026, 10, 9, 18));
  const alert = sent.at(-1);
  is("one urgent email to the support inbox", [sent.length, /^URGENT/.test(alert?.subject ?? "")], [1, true]);
  is("it says what was done and where", [alert?.text.includes(url), alert?.text.includes("taken off the store")], [true, true]);
  is("it never quotes the reporter's description", alert?.text.includes(DESCRIPTION), false);
  is("it says not to open the content, and that no AI agent may look at it", [alert?.text.includes("Do not open, download, forward or describe"), alert?.text.includes("AI")], [true, true]);
  is("it names the CyberTipline and the procedure", [alert?.text.includes("NCMEC's CyberTipline (report.cybertip.org)"), alert?.text.includes("docs/incident-response.md")], [true, true]);
  sent.length = 0;
  await alertOwner({ kind: "child_safety", url: "https://elsewhere.example/page" }, "no_product", Date.UTC(2026, 10, 9, 18));
  is("an address outside Marktmorgen is named, never shown, in the urgent email", [sent.at(-1)?.text.includes("elsewhere.example"), sent.at(-1)?.text.includes("an address outside Marktmorgen")], [false, true]);
  sent.length = 0;
  await alertOwner({ kind: "intimate_image", url, work: INTIMATE.work }, "not_held", Date.UTC(2026, 10, 9, 18));
  is("an intimate-image request says by when it has to be removed", [TAKE_IT_DOWN_HOURS, sent.at(-1)?.text.includes("by November 11, 2026, 6:00 PM UTC")], [48, true]);

  part("Through the form");
  sent.length = 0;
  const fresh = await addProduct(owner, "Reported Through The Form", "On sale", "9", null);
  if (!fresh.ok) throw new Error("no product");
  redis.run(["DEL", ...redis.keys().filter((key) => key.startsWith("nl:csa:"))]);
  const response = await reportRoute(new NextRequest("https://marktmorgen.com/api/report", { method: "POST", headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: JSON.stringify({ ...CHILD, url: `https://marktmorgen.com/@safetyshop/p/${fresh.product.id}` }) }));
  is("accepted", response.status, 200);
  is("the product is off the store", (await readListing((await storeForEmail(owner))!, fresh.product.id))?.hidden, true);
  is("the notice and the urgent email both reach the inbox", [sent.length, sent.some((mail) => /^URGENT/.test(mail.subject))], [2, true]);
  is("counted by kind only on the transparency page", (await transparencyCounts(Date.now())).years.some((year) => year.notices.child_safety === 1), true);
  const store2 = await addProduct(owner, "Reported While The Store Cannot Be Read", "On sale", "9", null);
  if (!store2.ok) throw new Error("no product");
  sent.length = 0;
  const reading = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "GET" && String(commands[0]?.[1]).includes("safetyshop")) throw new Error("timed out");
    return reading(commands);
  }) as typeof redis.pipeline;
  const blind = await reportRoute(new NextRequest("https://marktmorgen.com/api/report", { method: "POST", headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: JSON.stringify({ ...CHILD, url: `https://marktmorgen.com/@safetyshop/p/${store2.product.id}` }) }));
  redis.pipeline = reading;
  is("a store that cannot be read: the owner is told it could not be confirmed, never that the address names nothing", [blind.status, sent.some((mail) => /^URGENT/.test(mail.subject) && mail.text.includes("could not be confirmed"))], [200, true]);

  part("A product that cannot be read is said as such, never as an address that names nothing");
  const many = [];
  for (let n = 0; n < 26; n++) {
    const extra = await addProduct(owner, `Item ${n}`, "On sale", "9", null);
    if (extra.ok) many.push(extra.product.id);
  }
  redis.run(["DEL", ...redis.keys().filter((key) => key.startsWith("nl:csa:"))]);
  const headNow = (await storeForEmail(owner))!.catalog.head.map((listing) => listing.id);
  const deep = many.find((id) => !headNow.includes(id))!;
  const reads = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "GET" && String(command[1] ?? "").endsWith(`:l:${deep}`))) throw new Error("timed out");
    return reads(commands);
  }) as typeof redis.pipeline;
  const blindProduct = await holdReported({ kind: "child_safety", url: `https://marktmorgen.com/@safetyshop/p/${deep}` }, (await storeForEmail(owner))!).catch(() => "threw");
  redis.pipeline = reads;
  is("a product read that times out is unknown", blindProduct, "unknown");

  part("The urgent email is not sent twice for one retry, and says when the notice was not kept");
  sent.length = 0;
  const retried = `https://marktmorgen.com/@safetyshop/p/${many[1]}`;
  await alertOwner({ kind: "intimate_image", url: retried, work: INTIMATE.work }, "not_held", Date.UTC(2026, 10, 9, 18));
  await alertOwner({ kind: "intimate_image", url: retried, work: INTIMATE.work }, "not_held", Date.UTC(2026, 10, 9, 18, 0, 5));
  is("the same address and kind on the same day carry the same key, so the provider sends one", sent.length === 1 || (sent.length === 2 && sent[0].key === sent[1].key && Boolean(sent[0].key)), true);
  sent.length = 0;
  const shared = `https://marktmorgen.com/@safetyshop/p/${many[2]}`;
  await alertOwner({ kind: "intimate_image", url: shared, work: INTIMATE.work, email: "first@example.com" }, "not_held", Date.UTC(2026, 10, 9, 18));
  await alertOwner({ kind: "intimate_image", url: shared, work: "Another image of me on the same page, shared without my consent.", email: "second@example.com" }, "not_held", Date.UTC(2026, 10, 9, 18, 5));
  is("a new request on the same address the same day still reaches the owner", sent.length === 2 && sent[0].key !== sent[1].key, true);

  sent.length = 0;
  await alertOwner({ kind: "intimate_image", url, work: INTIMATE.work }, "not_held", Date.UTC(2026, 10, 9, 18), false);
  is("a notice that was not kept is said, not pointed to", [sent.at(-1)?.text.includes("could not be confirmed as kept"), sent.at(-1)?.text.includes("is in the notice email")], [true, false]);

  part("Where people read it");
  const page = readFileSync("app/report/page.tsx", "utf8") + readFileSync("components/report-form.tsx", "utf8");
  is("the form offers both kinds and points to the CyberTipline", [page.includes("child_safety"), page.includes("intimate_image"), page.includes('href="https://report.cybertip.org"')], [true, true, true]);
  is("it asks people not to send or describe the images", page.includes("Do not upload, attach or describe"), true);
  is("it does not promise more than is done: an intimate image is removed within 48 hours", [page.includes("we act on those at once"), page.includes("removed within 48")], [false, true]);
  is("the form note does not promise more either, and an intimate-image confirmation does not speak of a product", [page.includes("We take the product off the store at once"), page.includes("We remove the image within 48 hours of a complete request")], [false, true]);
  is("a child-safety report usually comes off at once, and is otherwise acted on by hand, in the intro and after sending", [page.includes("usually comes off the store at once"), (page.match(/act on it\s+by hand/g)?.length ?? 0) >= 2], [true, true]);
  const terms = readFileSync("app/terms/page.tsx", "utf8");
  is("the Terms forbid it and say it is reported", [terms.includes('id="child-safety"'), terms.includes("Exploited Children (NCMEC)")], [true, true]);
  const procedure = readFileSync("docs/incident-response.md", "utf8");
  is("the procedure is written down, with the law", [procedure.includes("18 U.S.C. § 2258A"), procedure.includes("TAKE IT DOWN"), procedure.includes("Nenhum agente abre")], [true, true, true]);

  part("Each kind's notice email, notice page and email to the creator say only what that kind's sender stated (Revisor 2 on #3587)");
  // A child-safety report asks for no name, signature or sworn statement, and an intimate-image request's statements are
  // its own: nobody stated "under penalty of perjury" for either. The reporter's words never reach the creator.
  const kinds = [
    { report: CHILD, ip: "10.35.87.1" },
    { report: INTIMATE, ip: "10.35.87.2" },
    { report: { ...INTIMATE, kind: "other", work: "This page sells a counterfeit of a registered trademark, shown in its first picture.", contact: "" }, ip: "10.35.87.3" },
  ] as const;
  for (const { report, ip } of kinds) {
    const made = await addProduct(owner, `Reported For ${report.kind}`, "On sale", "9", null);
    if (!made.ok) throw new Error("no product");
    const read = readReport({ ...report, url: `https://marktmorgen.com/@safetyshop/p/${made.product.id}` });
    if (!read.ok) throw new Error(`notice ${report.kind}`);
    sent.length = 0;
    is(`${report.kind}: filed`, await fileReport(read.report, ip, "https://marktmorgen.com"), "sent");
    const notice = sent[0];
    is(`${report.kind}: the notice email states no oath under penalty of perjury`, /perjury/i.test(notice?.text ?? ""), false);
    is(`${report.kind}: no empty sender name`, /From:\s*</.test(notice?.text ?? ""), false);
    if (report.kind === "child_safety") {
      is("child_safety: the notice email names the kind, not illegal content in general", [/^Child safety report/.test(notice?.subject ?? ""), (notice?.text ?? "").includes("Notice of illegal content")], [true, false]);
      is("child_safety: no signature line, since none was asked for", /Signed:/.test(notice?.text ?? ""), false);
    } else if (report.kind === "intimate_image") {
      is("intimate_image: the notice email names the kind", /^Request to remove an intimate image/.test(notice?.subject ?? ""), true);
      is("intimate_image: it states what the person confirmed on the form", [(notice?.text ?? "").includes("Signed: Dana Doe"), (notice?.text ?? "").includes("this intimate image of them was published without their consent")], [true, true]);
    } else {
      is("other: it states what the person confirmed on the form", (notice?.text ?? "").includes("accurate and complete to the best of their knowledge"), true);
    }
    const token = notice?.text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
    const page = wordsOf(await TakedownPage({ params: Promise.resolve({ token }) }));
    is(`${report.kind}: the notice page states no oath under penalty of perjury, nor both statements for a report that has none`, [/perjury/i.test(page), report.kind === "child_safety" && /Signed:|both statements/.test(page)], [false, false]);
    is(`${report.kind}: the notice page shows no empty sender name`, /From:\s*</.test(page), false);
    if (report.kind === "child_safety") is("child_safety: the notice page names the kind", [page.includes("Child safety report"), page.includes("Notice of illegal content")], [true, false]);
    if (report.kind === "intimate_image") is("intimate_image: the notice page says what the person confirmed", page.includes("this intimate image of them was published without their consent"), true);
    const opened = await openReport(token);
    if (!opened?.store) throw new Error("opened");
    sent.length = 0;
    await takeDown(opened.report, opened.store, { type: "product", id: made.product.id }, "https://marktmorgen.com");
    const creator = sent.find((mail) => [mail.to].flat().includes(owner));
    is(`${report.kind}: the creator is told what was taken down`, (creator?.text ?? "").includes(`Reported For ${report.kind}`), true);
    const private_ = report.kind === "child_safety" || report.kind === "intimate_image";
    is(`${report.kind}: the reporter's words reach the creator only for a notice that is not about a child or an intimate image`, (creator?.text ?? "").includes(report.work), !private_);
    if (private_) is(`${report.kind}: and no "The notice says" line, nor a ground that points at those words`, [(creator?.text ?? "").includes("The notice says"), (creator?.text ?? "").includes("for the reason it gives above")], [false, false]);
  }

  part("The urgent email shows only the reported page's path, never what the reporter added to the address (Revisor 2 on #3587, LEVE)");
  sent.length = 0;
  await alertOwner({ kind: "child_safety", url: `${url}?ref=a-tracking-code#a-fragment` }, "no_product", Date.UTC(2026, 10, 9, 18));
  is("the canonical address, without the query or the fragment", [(sent.at(-1)?.text ?? "").includes(`Where: ${url}\n`), (sent.at(-1)?.text ?? "").includes("a-tracking-code"), (sent.at(-1)?.text ?? "").includes("a-fragment")], [true, false, false]);

  done();
}

main();
