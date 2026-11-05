/**
 * 639 [GL7](26) unit 2: one answer to a form as a tagged PDF, over as many
 * pages as it takes (lib/tagged-pdf.ts now tags several pages), downloaded
 * from the studio by a role that may download the store's files.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from "pdf-lib";
import { parseForm, type FormDef, type FormResponse } from "@/lib/forms";
import { responsePdf, responseTexts, wrap } from "@/lib/form-response-pdf";
import { claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { readResponses } from "@/lib/form-store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as saveForms } from "@/app/api/store/forms/route";
import { POST as sendForm } from "@/app/api/store/form/route";
import { GET as responseFile } from "@/app/api/store/forms/response-pdf/route";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const form = parseForm({
  id: "frm0000001", name: "Coaching application", button: "", doneHeading: "", doneBody: "", offerList: false, updatedAt: 1,
  outcomes: [{ id: "res001", title: "A good fit", body: "", product: "" }],
  fields: [
    { id: "aaaaaa", type: "email", label: "Your email", required: true, options: [] },
    { id: "bbbbbb", type: "choice", label: "What do you want help with?", required: false, options: [{ id: "opt001", label: "Pricing", outcome: "res001" }, { id: "opt002", label: "Launching", outcome: "" }] },
    { id: "cccccc", type: "long", label: "Tell me about your business", required: false, options: [] },
  ],
}) as FormDef;
const response: FormResponse = { id: "a".repeat(32), at: 1_790_000_000, page: "p1", answers: { aaaaaa: "dana@example.com", bbbbbb: "opt001", cccccc: "I sell recipes.\nMostly to busy parents." }, outcome: "res001", joined: true };
const sheet = { form, response, storeName: "Harbor Kitchen", sentLine: "Sent on September 21, 2026", lang: "en" };

/** Each element of the structure tree, with the page it is on. */
async function elements(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages().map((p) => p.ref.toString());
  const root = doc.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
  const document = root.lookup(PDFName.of("K"), PDFDict);
  const kids = document.lookup(PDFName.of("K"), PDFArray).asArray().map((ref) => doc.context.lookup(ref as PDFRef, PDFDict));
  const nums = root.lookup(PDFName.of("ParentTree"), PDFDict).lookup(PDFName.of("Nums"), PDFArray).asArray();
  return {
    doc,
    pageCount: pages.length,
    list: kids.map((k) => ({ role: k.get(PDFName.of("S"))!.toString(), page: pages.indexOf((k.get(PDFName.of("Pg")) as PDFRef).toString()) })),
    parentKeys: nums.filter((_, i) => i % 2 === 0).map((n) => (n as PDFNumber).asNumber()),
    structParents: doc.getPages().map((p) => (p.node.get(PDFName.of("StructParents")) as PDFNumber).asNumber()),
  };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("Lines");
  const font = { widthOfTextAtSize: (text: string, size: number) => Array.from(text).length * size * 0.5 };
  is("words kept whole within the width", wrap(font, "one two three four", 10, 50), ["one two", "three four"]);
  is("a line break starts a new line", wrap(font, "first\nsecond", 10, 500), ["first", "second"]);
  is("a word wider than the line is cut where it must be", wrap(font, "x".repeat(25), 10, 50), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);

  part("What it says, in order");
  is("the form, when, each question and its answer, the result, and the list", responseTexts(sheet).map((t) => `${t.role}:${t.text}`), [
    "H1:Coaching application", "P:Sent on September 21, 2026",
    "H2:Your email", "P:dana@example.com",
    "H2:What do you want help with?", "P:Pricing",
    "H2:Tell me about your business", "P:I sell recipes.\nMostly to busy parents.",
    "H2:Result", "P:A good fit",
    "H2:Asked to hear from you by email", "P:Yes",
  ]);
  is("an unanswered question says so", responseTexts({ ...sheet, response: { ...response, answers: {} } })[3].text, "No answer.");

  part("The file, one page");
  const short = await elements(await responsePdf(sheet));
  is("one page, tagged, a heading then the rest in order", [short.pageCount, short.list[0].role, short.list.length], [1, "/H1", 12]);
  is("its title and language", [short.doc.getTitle(), short.doc.catalog.get(PDFName.of("Lang"))?.toString()], ["Coaching application — Sent on September 21, 2026", "(en)"]);

  part("Over several pages");
  const long = parseForm({ ...form, fields: Array.from({ length: 12 }, (_, i) => ({ id: `q${String(i).padStart(5, "0")}`, type: "long", label: `Question ${i + 1}`, required: false, options: [] })) }) as FormDef;
  const answers = Object.fromEntries(long.fields.map((f) => [f.id, "A long answer about the business and its plans. ".repeat(40).slice(0, 2000)]));
  const many = await elements(await responsePdf({ ...sheet, form: long, response: { ...response, answers } }));
  is("as many pages as it takes", many.pageCount > 3, true);
  is("each page has its own number in the structure, in order", [many.structParents, many.parentKeys], [Array.from({ length: many.pageCount }, (_, i) => i), Array.from({ length: many.pageCount }, (_, i) => i)]);
  is("every element points at a page of the file", many.list.every((e) => e.page >= 0), true);
  is("a heading is never left alone at the foot of a page", many.list.every((e, i) => e.role !== "/H2" || many.list[i + 1]?.page === e.page), true);
  is("a paragraph is one element per page, not one per line", many.list.filter((e) => e.role === "/P").length < 12 * 3 + 4, true);

  part("Downloaded from the studio");
  const OWNER = "pdfanswers@example.com";
  await claimHandle(OWNER, "pdfanswers", "PDF Answers", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const saved = (await (await saveForms(new NextRequest("https://marktmorgen.com/api/store/forms", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ form: { ...form, id: undefined } }) }))).json()).form as FormDef;
  await setSitePages(OWNER, [{ id: "pagepage01", slug: "apply", title: "Apply", nav: false, target: "", from: 0 }]);
  const store = (await storeForEmail(OWNER))!;
  await writePage(store.statsId!, siteKey("pagepage01"), { ...parsePage({}), blocks: [{ id: "blk001", kind: "form", heading: "", form: saved.id }] } as never, ROOM);
  await sendForm(new NextRequest("https://marktmorgen.com/api/store/form", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" }, body: new URLSearchParams([["handle", "pdfanswers"], ["form", saved.id], ["page", "pagepage01"], ["q_aaaaaa", "dana@example.com"], ["q_bbbbbb", "opt001"]]) }));
  const kept = (await readResponses(store.statsId, saved.id)).responses[0];
  const get = (query: string, signedIn = true) => responseFile(new NextRequest(`https://marktmorgen.com/api/store/forms/response-pdf?${query}`, { headers: signedIn ? { cookie: `${SESSION_COOKIE}=${session}` } : {} }));
  is("signed out: refused", (await get(`id=${saved.id}&response=${kept.id}`, false)).status >= 300, true);
  is("which form, which answer: asked", (await get("id=nope&response=nope")).status, 400);
  is("an answer no longer kept: said so", (await get(`id=${saved.id}&response=${"b".repeat(32)}`)).status, 404);
  const ok = await get(`id=${saved.id}&response=${kept.id}`);
  is("the file, made on request, kept nowhere", [ok.status, ok.headers.get("content-type"), ok.headers.get("cache-control"), (await PDFDocument.load(new Uint8Array(await ok.arrayBuffer()))).getPageCount()], [200, "application/pdf", "private, no-store", 1]);
  const studio = readFileSync("components/form-answers.tsx", "utf8");
  is("each answer in the studio has its download, named by when it was sent", studio.includes("Download as PDF<span className=\"sr-only\">") && studio.includes("the answer sent"), true);

  done();
}

void main();
