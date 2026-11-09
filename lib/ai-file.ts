/**
 * The product's file written with AI (758 [STN5], unit 3), on the server: the
 * plan (one writing job), the parts (one job each, told step by step, in
 * batches of FILE_BATCH, with a stop between batches that gives back the jobs
 * of the parts never asked for and keeps the parts already written), and the
 * save that makes the creator's checked text into a tagged PDF kept as the
 * file of their draft product (lib/ai-file-pdf.ts). Rules the browser shares
 * are in lib/ai-file-rules.ts.
 *
 * Money: every call goes through askModel (lib/ai.ts), which reserves the hard
 * bound of that very request from the store's automatic AI ceiling before it
 * is sent; the jobs come from the month's AI_MONTHLY before the first call.
 * Nothing here adds a credit or a limit. Making the PDF calls no model: it is
 * allowed once for each run of parts (a mark kept AI_FILE_KEEP_SECONDS), so
 * its cost is bounded by the writing jobs that came before it.
 *
 * Never published: the file is attached only to a product the store does not
 * show (a draft), and stays a draft until the creator publishes it themselves.
 */
import { randomBytes } from "node:crypto";
import { type AiResult, type AiStepsRun, type AiStopped, type Unrun, askModel, counted, countedRun, jsonIn, stopAsked, writingModel, writingRules } from "@/lib/ai";
import { aiDispatchCount } from "@/lib/ai-call-budget";
import {
  AI_FILE_KEEP_SECONDS,
  FILE_BATCH,
  FILE_OUTLINE_OUTPUT_TOKENS,
  FILE_PROMPT_BYTES,
  FILE_SECTION_OUTPUT_TOKENS,
  FILE_SECTION_WORDS,
  FILE_SYSTEM_BYTES,
  MAX_AI_FILE_BYTES,
  MAX_FILE_SECTIONS,
  MAX_FILE_TITLE,
  MAX_SECTION_POINT,
  MAX_SECTION_TITLE,
  SECTION_END,
  SECTION_POINTS,
  type FileDraft,
  type FileOutline,
  type FileSection,
  parseOutline,
  readSectionText,
} from "@/lib/ai-file-rules";
import { AI_RUN_ID, type AiStepId } from "@/lib/ai-steps";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import { fileDrawable, filePdf } from "@/lib/ai-file-pdf";
import type { Listing } from "@/lib/catalog";
import { repliesFor } from "@/lib/redis-reply";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { LANGUAGES } from "@/lib/store-language";
import type { ProductFile } from "@/lib/product-file";
import type { Store } from "@/lib/store";
import { vaultPath } from "@/lib/vault-rules";

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const language = (store: Store) => LANGUAGES[store.language]?.english ?? "English";
const oneLine = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Why a product cannot take a file written here, or null when it can: it has
 * to be one the store does not show yet (a draft), with nothing handed over
 * yet (no file, no link, no price options) and not a course, call, bundle,
 * podcast or shipped product, which hand over something else.
 */
export function fileTargetProblem(product: Listing | null): "unknown" | "published" | "has_file" | "kind" | null {
  if (!product) return "unknown";
  if (!product.hidden) return "published";
  if (product.file || product.link || product.options.length > 0) return "has_file";
  if (product.course || product.call || product.bundle || product.podcast || product.shipping) return "kind";
  return null;
}

/** The instructions for the plan. */
function outlineSystem(store: Store): string {
  return [
    "You plan a guide a creator will sell as a PDF: its title and its parts, in the order a reader needs them.",
    writingRules(language(store)),
    "The rules above about facts are about the creator, the product and its results. The guide's subject may be planned in general, widely known terms.",
    [
      "Return only a JSON object with these keys:",
      `"title": the guide's title, at most ${MAX_FILE_TITLE} characters.`,
      `"sections": 3 to ${MAX_FILE_SECTIONS} parts, each {"title": at most ${MAX_SECTION_TITLE} characters, "points": up to ${SECTION_POINTS} things the part covers, each at most ${MAX_SECTION_POINT} characters}.`,
      "No links, no web addresses, no numbers of pages.",
    ].join("\n"),
  ].join("\n\n");
}

/** The instructions for one part. */
function sectionSystem(store: Store): string {
  return [
    "You write one part of a guide a creator will sell as a PDF. Write it for the reader of the guide, plainly, in the creator's voice, not about the creator.",
    writingRules(language(store)),
    "The rules above about facts are about the creator, the product and its results. The guide's subject may be explained in general, widely known terms. Never state a statistic, a study, a figure, a price, a quote, a person's name or a source as fact; never tell a personal story; never claim the creator's experience or credentials; never promise what the reader will earn or achieve.",
    [
      `Write about ${FILE_SECTION_WORDS} words of plain paragraphs, separated by one blank line.`,
      "No headings, no lists, no bullet points, no tables, no links or web addresses, no emoji. Do not repeat the part's title.",
      `End with a line that says exactly ${SECTION_END} and nothing after it.`,
    ].join("\n"),
  ].join("\n\n");
}

/** The plan as words, for every part's request. */
function planWords(outline: FileOutline): string {
  return outline.sections.map((s, i) => `${i + 1}. ${s.title}${s.points.length ? `\n   ${s.points.join("\n   ")}` : ""}`).join("\n");
}

/** The request for the plan, or null when it is bigger than a request may be (FILE_SYSTEM_BYTES, FILE_PROMPT_BYTES). */
export function outlineRequest(store: Store, input: { productTitle: string; notes: string }): { system: string; prompt: string } | null {
  const notes = input.notes.trim().slice(0, MAX_AI_NOTES);
  if (!notes) return null;
  const system = outlineSystem(store);
  const prompt = [`Store: ${oneLine(store.name, 60)}`, `Product: ${oneLine(input.productTitle, MAX_FILE_TITLE) || "(no name yet)"}`, `\nWhat the creator says the guide is about:\n${notes}`].join("\n");
  return bytes(system) <= FILE_SYSTEM_BYTES && bytes(prompt) <= FILE_PROMPT_BYTES ? { system, prompt } : null;
}

/** The requests for every part of a plan, or null when one is bigger than a request may be. */
export function sectionRequests(store: Store, input: { productTitle: string; outline: FileOutline; notes: string }): { system: string; prompts: string[] } | null {
  const system = sectionSystem(store);
  if (bytes(system) > FILE_SYSTEM_BYTES) return null;
  const notes = input.notes.trim().slice(0, MAX_AI_NOTES);
  const plan = planWords(input.outline);
  const prompts = input.outline.sections.map((section, i) =>
    [
      `Store: ${oneLine(store.name, 60)}`,
      `Product: ${oneLine(input.productTitle, MAX_FILE_TITLE) || "(no name yet)"}`,
      `Guide: ${input.outline.title}`,
      `\nThe whole guide, part by part:\n${plan}`,
      `\nWrite part ${i + 1}: ${section.title}`,
      section.points.length ? `It covers:\n${section.points.join("\n")}` : "",
      notes ? `\nWhat the creator says the guide is about:\n${notes}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return prompts.every((p) => bytes(p) <= FILE_PROMPT_BYTES) ? { system, prompts } : null;
}

/** The plan: one writing job, one request. */
export async function writeFileOutline(store: Store, input: { productTitle: string; notes: string }, now = Date.now()): Promise<AiResult<FileOutline>> {
  const request = outlineRequest(store, input);
  if (!request) return { ok: false, reason: "notes" };
  return counted(store, now, async () => {
    const answer = await askModel(store, request.system, request.prompt, FILE_OUTLINE_OUTPUT_TOKENS, writingModel());
    const json = answer ? jsonIn(answer) : null;
    return json ? parseOutline(json) : null;
  });
}

/**
 * The parts: one writing job each, all taken before the first call. Each
 * batch says its steps as they start and end; between batches a stop asked
 * for (or a mark that cannot be read) asks for nothing more, and the jobs of
 * the parts never asked for are given back. Parts already written come back
 * with the stop, in the plan's order; a part that did not come back is left
 * out, and its job stays counted when its call was sent (it may be billed).
 */
export async function writeFileSections(
  store: Store,
  input: { productTitle: string; outline: FileOutline; notes: string },
  steps: AiStepsRun,
  now = Date.now(),
): Promise<AiResult<FileDraft> | AiStopped> {
  if (!AI_RUN_ID.test(steps.run)) return { ok: false, reason: "off" };
  const requests = sectionRequests(store, input);
  if (!requests) return { ok: false, reason: "notes" };
  const parts = input.outline.sections;
  const say = (step: AiStepId, state: "started" | "done") => {
    try {
      steps.onStep(step, state);
    } catch (error) {
      console.error("a step could not be said", error);
    }
  };
  const unrun: Unrun = { jobs: 0, asked: false, partial: true };
  return countedRun<FileDraft>(
    store,
    now,
    async () => {
      const written: (FileSection | null)[] = parts.map(() => null);
      for (let start = 0; start < parts.length; start += FILE_BATCH) {
        if (start > 0) {
          const asked = await stopAsked(store, steps.run);
          if (asked !== false) {
            unrun.jobs += parts.length - start;
            unrun.asked = asked === true;
            break;
          }
        }
        const batch = parts.slice(start, start + FILE_BATCH).map((_, k) => start + k);
        for (const i of batch) say(`section-${i + 1}`, "started");
        const before = aiDispatchCount();
        const answers = await Promise.all(batch.map((i) => askModel(store, requests.system, requests.prompts[i], FILE_SECTION_OUTPUT_TOKENS, writingModel()).catch(() => null)));
        const after = aiDispatchCount();
        // Calls whose money was refused or that were never sent are not charged; a count that cannot be read is taken as all sent.
        const reached = before === null || after === null ? batch.length : Math.min(batch.length, Math.max(0, after - before));
        unrun.jobs += batch.length - reached;
        batch.forEach((i, k) => {
          const part = readSectionText(answers[k], parts[i].title);
          if (!part) return;
          written[i] = part;
          say(`section-${i + 1}`, "done");
        });
      }
      const sections = written.filter((s): s is FileSection => s !== null);
      return sections.length ? { title: input.outline.title, sections } : null;
    },
    parts.length,
    unrun,
  );
}

// ------------------------------------------------------------------ one save for each run

const saveKey = (statsId: string, run: string) => `nl:ai:file:${statsId}:${run}`;

/** Allows one save of what this run wrote, for AI_FILE_KEEP_SECONDS. True only once it is confirmed kept. */
export async function grantFileSave(store: Store, run: string): Promise<boolean> {
  if (!store.statsId || !AI_RUN_ID.test(run) || !isRedisConfigured()) return false;
  const replies = repliesFor(await redisPipeline([["SET", saveKey(store.statsId, run), "1", "EX", AI_FILE_KEEP_SECONDS]]).catch(() => null), 1);
  return replies !== null && replies[0] === "OK";
}

/** Takes the one save of this run: true once, false when there is none, null when the reply cannot be read (nothing is made). */
export async function takeFileSave(store: Store, run: string): Promise<boolean | null> {
  if (!store.statsId || !AI_RUN_ID.test(run) || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GETDEL", saveKey(store.statsId, run)]]).catch(() => null), 1);
  if (!replies) return null;
  if (replies[0] === null) return false;
  return replies[0] === "1" ? true : null;
}

// ------------------------------------------------------------------ the save

/** What a save touches outside this file, so a test can play each part. */
export type FileSaveIo = {
  folder: () => Promise<string>;
  reserveUpload: (bytes: number) => Promise<boolean>;
  reserveRoom: (folder: string, bytes: number) => Promise<string | null>;
  releaseRoom: (folder: string, id: string) => Promise<void>;
  write: (pathname: string, bytes: Uint8Array) => Promise<boolean>;
  measure: (pathname: string) => Promise<{ size: number; contentType: string }>;
  remove: (pathname: string) => Promise<void>;
  attach: (file: ProductFile | null) => Promise<{ ok: true; removed: ProductFile | null } | { ok: false; reason: string }>;
  rememberOwner: (folder: string) => Promise<void>;
};

export type FileSaveResult = { ok: true; file: ProductFile; pages: number } | { ok: false; error: "letters" | "too_big" | "upload_budget_unavailable" | "storage_full" | "failed" | "changed" };

/**
 * The checked file as a tagged PDF, kept as this draft product's file: drawn,
 * measured against MAX_AI_FILE_BYTES, counted as one of the plan's uploads,
 * its room reserved under the store's storage limit, written into the store's
 * own folder for this product, measured again by the store, then attached.
 * Whatever fails on the way is undone; the product is never published here.
 */
export async function saveAiFile(store: Store, productId: string, draft: FileDraft, io: FileSaveIo, at = new Date()): Promise<FileSaveResult> {
  if (!(await fileDrawable(draft, store.name))) return { ok: false, error: "letters" };
  const made = await filePdf({ draft, storeName: store.name, lang: store.language || "en", at });
  const size = made.bytes.byteLength;
  if (size > MAX_AI_FILE_BYTES) return { ok: false, error: "too_big" };
  const folder = await io.folder();
  if (!(await io.reserveUpload(size))) return { ok: false, error: "upload_budget_unavailable" };
  const room = await io.reserveRoom(folder, size).catch(() => null);
  if (!room) return { ok: false, error: "storage_full" };
  const name = `${draft.title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Guide"}.pdf`;
  const pathname = vaultPath(folder, productId, randomBytes(8).toString("hex"), name);
  try {
    await io.rememberOwner(folder);
    if (!(await io.write(pathname, made.bytes))) return { ok: false, error: "failed" };
    const measured = await io.measure(pathname);
    if (measured.size !== size || measured.contentType !== "application/pdf") {
      await io.remove(pathname).catch(() => {});
      return { ok: false, error: "failed" };
    }
    const file: ProductFile = { pathname, name, bytes: size, contentType: "application/pdf", addedAt: at.toISOString() };
    const attached = await io.attach(file);
    if (!attached.ok) {
      await io.remove(pathname).catch(() => {});
      return { ok: false, error: "failed" };
    }
    if (attached.removed) {
      // A file arrived on the product meanwhile: it is put back, and this one goes.
      await io.attach(attached.removed).catch(() => null);
      await io.remove(pathname).catch(() => {});
      return { ok: false, error: "changed" };
    }
    return { ok: true, file, pages: made.pages };
  } catch (error) {
    console.error("saving a file written with AI failed", error);
    await io.remove(pathname).catch(() => {});
    return { ok: false, error: "failed" };
  } finally {
    await io.releaseRoom(folder, room).catch((error) => console.error("a storage reservation was kept", error));
  }
}
