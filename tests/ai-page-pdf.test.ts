/**
 * A sales page drafted from the product's own PDF too (lib/ai.ts,
 * readPdfFacts; added 10 October 2026). The model is played by a stand-in
 * for `fetch`. What is checked: the first pages are cut from the file with
 * nothing past them; they go to the smaller model as a PDF, which is told to
 * list only what they show; what it lists is handed to the writer as the
 * product's contents; the reading takes its jobs from the month and gives
 * them back when nothing comes of it; a page can be drafted from the file
 * alone.
 */
import { PDFDocument } from "pdf-lib";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { aiLeft, writePage } from "@/lib/ai";
import { READ_PDF_JOBS, READ_PDF_PAGES } from "@/lib/ai-rules";
import { firstPages } from "@/lib/pdf-preview";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Asked = { model: string; system: string; content: unknown };
const asked: Asked[] = [];
let replies: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  const body = JSON.parse(String(init?.body)) as { model: string; system: string; messages: { content: unknown }[] };
  asked.push({ model: body.model, system: body.system, content: body.messages[0].content });
  const text = replies.shift() ?? "{}";
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
}) as typeof fetch;

const FACTS = { parts: [{ title: "Week 1: Pantry basics", detail: "Ten dinners from what is in the cupboard" }, { title: "Week 2: One-pan dinners", detail: "" }], format: "A printable PDF, one recipe per page", for: "Busy parents" };
const DRAFT = {
  headline: "Forty weeknight dinners your kids will eat",
  sub: "One page per recipe.",
  story: null,
  benefits: ["One recipe per page", "A shopping list each week", "Fast dinners"],
  inside: [{ title: "Week 1: Pantry basics", detail: "Ten dinners from the cupboard" }],
  faq: [{ q: "What format is it?", a: "A printable PDF." }],
  guarantee: "",
  cta: "Get the pack",
  seoTitle: "Weeknight Recipe Pack",
  seoDescription: "Forty weeknight dinners.",
};

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail("owner@example.com"))!;

  part("Only the first pages");
  const book = await PDFDocument.create();
  for (let i = 0; i < 30; i += 1) book.addPage([300, 400]).drawText(`Page ${i + 1}`);
  const cut = await PDFDocument.load(await firstPages(await book.save(), READ_PDF_PAGES));
  is("a thirty-page book is cut to its first ten", cut.getPageCount(), READ_PDF_PAGES);

  part("Read, then written from");
  const before = await aiLeft(store);
  replies = [JSON.stringify(FACTS), JSON.stringify(DRAFT)];
  const drafted = await writePage(store, { title: "Recipe Pack", price: "$27", kind: "download", summary: "", about: "", notes: "", pdf: await firstPages(await book.save(), READ_PDF_PAGES) });
  is("drafted from the file alone", drafted.ok ? drafted.value.headline : drafted.reason, DRAFT.headline);
  const [reading, writing] = asked;
  const parts = Array.isArray(reading?.content) ? (reading.content as { type: string; source?: { media_type?: string } }[]) : [];
  is("the pages go to the smaller model, as a PDF", [reading?.model.includes("haiku"), parts[0]?.type, parts[0]?.source?.media_type], [true, "document", "application/pdf"]);
  is("which is told to list only what they show", /only what these pages actually show/i.test(reading?.system ?? ""), true);
  is("and what it lists is handed to the writer as the product's contents", [String(writing?.content).includes("Week 1: Pantry basics"), String(writing?.content).includes("Format: A printable PDF, one recipe per page")], [true, true]);
  is("the reading takes its jobs from the month, with the page's own", before - (await aiLeft(store)), 1 + READ_PDF_JOBS);

  part("Nothing comes of it: nothing taken");
  asked.length = 0;
  const left = await aiLeft(store);
  replies = ["not json", "not json"];
  const failed = await writePage(store, { title: "Recipe Pack", price: "$27", kind: "download", summary: "", about: "", notes: "", pdf: await firstPages(await book.save(), 3) });
  is("a reading that says nothing, with nothing else said, drafts nothing", failed.ok ? "drafted" : failed.reason, "failed");
  is("the reading, sent, stays counted; the page, never asked for, is given back (758 [STN5])", [await aiLeft(store), asked.length], [left - READ_PDF_JOBS, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
