/**
 * The product's file written with AI, on the server (758 [STN5], unit 3;
 * lib/ai-file.ts). The model is played by a stand-in for `fetch`, the money
 * ledger by tests/ai-steps-spend-stub.ts, the database by the in-memory one,
 * and the file store by a stand-in passed to the save. What is checked:
 *   - the plan takes one writing job and one call; nothing is taken without
 *     the creator's words;
 *   - a file's parts take one job each, all before the first call, each call
 *     with its own money reserved before it, five at a time, the stop's mark
 *     read once between batches;
 *   - Stop asks for nothing more, gives back the jobs of the parts never
 *     asked for, and brings back the parts already written;
 *   - a part whose money was refused is given back; a part cut off is left
 *     out and its job, sent, stays counted;
 *   - the biggest plan's requests fit the sizes they are priced at, in every
 *     store language;
 *   - a run allows one save; the save draws a tagged PDF into the store's own
 *     folder for that product, attaches it, never publishes it, and undoes
 *     whatever fails on the way;
 *   - the save reserves its room, then one upload of the month, both at the
 *     most a file may be, before it draws the PDF: a full storage takes no
 *     upload, and a refusal of either draws nothing; the run's save comes back
 *     only after a save that drew nothing, so one run draws one PDF at most;
 *   - only a draft that hands over nothing yet may take such a file.
 */
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import * as ai from "@/lib/ai";
import { WRITING_JOB_MICRO_USD, aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import { SUPPORTED_AI_MODELS } from "@/lib/ai-request-rules";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import {
  FILE_PROMPT_BYTES,
  FILE_SECTION_OUTPUT_TOKENS,
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
} from "@/lib/ai-file-rules";
import { type FileSaveIo, fileTargetProblem, grantFileSave, outlineRequest, saveAiFile, saveGivenBack, sectionRequests, takeFileSave, writeFileOutline, writeFileSections } from "@/lib/ai-file";
import { ownsVaultPath } from "@/lib/vault-rules";
import type { Listing } from "@/lib/catalog";
import type { ProductFile } from "@/lib/product-file";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
// The same module lib/ai.ts reads as @/lib/ai-spend (tests/aliases/ai-file.test.ts.json), so its count is the reservations made.
import { refuse, reservations as spent } from "./ai-steps-spend-stub";
// The same module lib/ai-file.ts reads as @/lib/ai-file-pdf, so its count is the PDFs drawn.
import { drawings } from "./ai-file-pdf-count-stub";

const PLAN = { title: "Weeknight Dinners", sections: [{ title: "Start here", points: ["What to buy", "Tools"] }, { title: "Week one", points: [] }] };
const partText = (n: number) => `Part ${n}. Cook the rice first, then the beans.\n\nServe it warm with greens.\n\n${SECTION_END}`;

let calls = 0;
let onCall: (n: number) => void = () => {};
/** Parts whose answer comes back cut off (no end mark). */
let cut = new Set<number>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  calls += 1;
  onCall(calls);
  const body = JSON.parse(String(init?.body ?? "{}")) as { system?: string; messages?: { content?: string }[] };
  const prompt = String(body.messages?.[0]?.content ?? "");
  const n = Number(/Write part (\d+):/.exec(prompt)?.[1] ?? 0);
  const text = String(body.system).startsWith("You plan a guide") ? JSON.stringify(PLAN) : cut.has(n) ? `Part ${n}, cut off` : partText(n);
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
}) as typeof fetch;

const sent: (string | number)[][] = [];
let unknownFor: ((command: (string | number)[]) => boolean) | null = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = async (commands: (string | number)[][]) => {
  sent.push(...commands);
  const replies = await realPipeline(commands);
  return commands.map((command, i) => (unknownFor?.(command) ? { unexpected: true } : replies[i]));
};
const stopGets = () => sent.filter((c) => c[0] === "GET" && String(c[1]).startsWith("nl:ai:stop:")).length;

const outlineOf = (n: number): FileOutline => ({ title: "Weeknight Dinners", sections: Array.from({ length: n }, (_, i) => ({ title: `Part ${i + 1} name`, points: [`Point ${i + 1}`] })) });

const listing = (change: Partial<Listing>): Listing =>
  ({ id: "p1", title: "Recipes", hidden: true, file: null, link: null, options: [], course: null, call: null, bundle: null, podcast: null, shipping: null, ...change }) as unknown as Listing;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle("file@example.com", "fileshop", "File Kitchen", "");
  await ensureStatsId("file@example.com");
  await setSubscription("file@example.com", { customerId: "cus_File000001", subscriptionId: "sub_File000001", active: true, tier: "scale", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail("file@example.com"))!;
  const monthKey = ai.aiMonthKey(store, new Date())!;
  const stopKey = (run: string) => `nl:ai:stop:${store.statsId}:${run}`;
  let spentBefore = 0;
  const reservations = () => spent.count - spentBefore;
  const fresh = () => {
    spentBefore = spent.count;
    calls = 0;
    onCall = () => {};
    cut = new Set();
    refuse.at = 0;
    redis.run(["DEL", monthKey]);
    sent.length = 0;
    unknownFor = null;
  };
  type Line = { step: string; state: string };
  const stepsOf = (run: string, seen: Line[]) => ({ run, onStep: (step: string, state: "started" | "done") => seen.push({ step, state }) });

  part("The plan: one writing job, one call");
  fresh();
  let before = await ai.aiLeft(store);
  const planned = await writeFileOutline(store, { productTitle: "Recipes", notes: "Weeknight dinners for busy parents." });
  is("the plan comes back, read safely", planned.ok ? planned.value : planned.reason, PLAN);
  is("one job, one call, its money reserved before it", [before - (await ai.aiLeft(store)), calls, reservations()], [1, 1, 1]);
  fresh();
  before = await ai.aiLeft(store);
  const nothing = await writeFileOutline(store, { productTitle: "Recipes", notes: "   " });
  is("without the creator's words, nothing is taken or asked", [nothing.ok ? "planned" : nothing.reason, calls, before - (await ai.aiLeft(store))], ["notes", 0, 0]);

  part("Seven parts, no stop");
  fresh();
  let seen: Line[] = [];
  before = await ai.aiLeft(store);
  const seven = await writeFileSections(store, { productTitle: "Recipes", outline: outlineOf(7), notes: "" }, stepsOf("runfileseven0001", seen));
  is("every part comes back, in order, by its title", seven.ok ? seven.value.sections.map((s) => s.title) : seven, outlineOf(7).sections.map((s) => s.title));
  is("a part's text as the model wrote it, its end mark taken off", seven.ok ? seven.value.sections[0].body : null, "Part 1. Cook the rice first, then the beans.\n\nServe it warm with greens.");
  is("seven jobs, seven calls, each with its money reserved", [before - (await ai.aiLeft(store)), calls, reservations()], [7, 7, 7]);
  is("five started at once, then two", seen.slice(0, 5).every((l) => l.state === "started") && seen.filter((l) => l.state === "started").length === 7, true);
  is("each part said done", seen.filter((l) => l.state === "done").map((l) => l.step).sort(), Array.from({ length: 7 }, (_, i) => `section-${i + 1}`).sort());
  is("the stop's mark read once, between the two batches", stopGets(), 1);

  part("Stop asked for while the first batch runs");
  fresh();
  seen = [];
  before = await ai.aiLeft(store);
  onCall = (n) => {
    if (n === 1) redis.run(["SET", stopKey("runfilestopped01"), "1", "EX", 300]);
  };
  const stopped = await writeFileSections(store, { productTitle: "Recipes", outline: outlineOf(8), notes: "" }, stepsOf("runfilestopped01", seen));
  is("the second batch is never asked for", [calls, reservations()], [5, 5]);
  is("the five sent stay counted; the three never asked for are given back", before - (await ai.aiLeft(store)), 5);
  const stoppedSays = stopped as { ok: boolean; reason?: string; returned?: number; left?: number; value?: { sections: { title: string }[] } };
  is("it says it stopped, what came back and what is left", [stoppedSays.ok, stoppedSays.reason, stoppedSays.returned, stoppedSays.left], [false, "stopped", 3, before - 5]);
  is("and brings back the five parts already written", stoppedSays.value?.sections.map((s) => s.title), outlineOf(5).sections.map((s) => s.title));
  is("the parts never asked for never said they started", seen.some((l) => ["section-6", "section-7", "section-8"].includes(l.step)), false);

  part("The creator's Stop, as the page asks it (markAiStop), is taken while the first batch runs (#3474 over #3435)");
  fresh();
  let stopTaken: boolean | null = null;
  onCall = (n) => {
    if (n === 1) {
      void ai.markAiStop(store, "runfilepagestop1").then((taken) => {
        stopTaken = taken;
      });
    }
  };
  const asked = (await writeFileSections(store, { productTitle: "Recipes", outline: outlineOf(8), notes: "" }, stepsOf("runfilepagestop1", []))) as typeof stoppedSays;
  is("the stop is kept, over the run's own live mark", stopTaken, true);
  is("so the second batch is never asked for", [calls, asked.reason, asked.returned], [5, "stopped", 3]);

  part("An unknown reply about the stop asks for nothing more");
  fresh();
  before = await ai.aiLeft(store);
  unknownFor = (c) => c[0] === "GET" && String(c[1]).startsWith("nl:ai:stop:");
  const unsure = (await writeFileSections(store, { productTitle: "Recipes", outline: outlineOf(6), notes: "" }, stepsOf("runfileunsure001", []))) as typeof stoppedSays;
  is("no sixth call; not said as a stop the creator asked for", [calls, unsure.reason, unsure.returned], [5, "failed", 1]);
  is("the parts written still come back", unsure.value?.sections.length, 5);

  part("A part whose money was refused, and a part cut off");
  fresh();
  before = await ai.aiLeft(store);
  refuse.at = spent.count + 2;
  cut = new Set([3]);
  const mixed = (await writeFileSections(store, { productTitle: "Recipes", outline: outlineOf(4), notes: "" }, stepsOf("runfilemixed0001", []))) as typeof stoppedSays;
  is("three calls reach the model", calls, 3);
  is("the refused part's job is given back; the cut-off part, sent, stays counted", [before - (await ai.aiLeft(store)), mixed.returned], [3, 1]);
  is("the parts that came back whole are kept, in order", mixed.value?.sections.map((s) => s.title), ["Part 1 name", "Part 4 name"]);

  part("A run that is not one, or a plan too big for a request, takes nothing");
  fresh();
  before = await ai.aiLeft(store);
  const notARun = await writeFileSections(store, { productTitle: "Recipes", outline: outlineOf(2), notes: "" }, stepsOf("not a run!", []));
  is("refused before anything is taken or asked", [notARun.ok, calls, before - (await ai.aiLeft(store))], [false, 0, 0]);
  const huge = { title: "T", sections: Array.from({ length: 10 }, () => ({ title: "é".repeat(MAX_SECTION_TITLE), points: Array.from({ length: 3 }, () => "é".repeat(MAX_SECTION_POINT)) })) };
  const tooBig = await writeFileSections(store, { productTitle: "Recipes", outline: huge, notes: "é".repeat(MAX_AI_NOTES) }, stepsOf("runfiletoobig001", []));
  is("a plan bigger than its priced size is refused before anything is taken", [tooBig.ok ? "written" : tooBig.reason, calls, before - (await ai.aiLeft(store))], ["notes", 0, 0]);

  part("The biggest plan fits the sizes it is priced at, in every store language");
  const biggest: FileOutline = {
    title: "T".repeat(MAX_FILE_TITLE),
    sections: Array.from({ length: MAX_FILE_SECTIONS }, () => ({ title: "x".repeat(MAX_SECTION_TITLE), points: Array.from({ length: SECTION_POINTS }, () => "y".repeat(MAX_SECTION_POINT)) })),
  };
  const fits = LANGUAGE_CODES.map((language) => {
    const asIn = { ...store, language, name: "N".repeat(60) };
    const parts = sectionRequests(asIn, { productTitle: "P".repeat(MAX_FILE_TITLE), outline: biggest, notes: "z".repeat(MAX_AI_NOTES) });
    const plan = outlineRequest(asIn, { productTitle: "P".repeat(MAX_FILE_TITLE), notes: "z".repeat(MAX_AI_NOTES) });
    return parts !== null && plan !== null;
  });
  is("every part's request and the plan's", fits, LANGUAGE_CODES.map(() => true));
  const one = sectionRequests(store, { productTitle: "Recipes", outline: biggest, notes: "z".repeat(MAX_AI_NOTES) }) ?? { system: "", prompts: ["x".repeat(FILE_PROMPT_BYTES + 1)] };
  const bytes = (t: string) => new TextEncoder().encode(t).byteLength;
  is("and each is at most a writing job on every model", SUPPORTED_AI_MODELS.map((model) => {
    const hold = aiRequestHoldMicroUsd(model, { inputBytes: bytes(one.system) + bytes(one.prompts[0]), blocks: 1, media: null, maxTokens: FILE_SECTION_OUTPUT_TOKENS });
    return hold !== null && hold <= WRITING_JOB_MICRO_USD && bytes(one.system) <= FILE_SYSTEM_BYTES && bytes(one.prompts[0]) <= FILE_PROMPT_BYTES;
  }), SUPPORTED_AI_MODELS.map(() => true));

  part("A run allows one save");
  redis.run(["DEL", `nl:ai:file:${store.statsId}:runfilesave00001`]);
  is("none before the run", await takeFileSave(store, "runfilesave00001"), false);
  is("allowed once the run wrote something", await grantFileSave(store, "runfilesave00001"), true);
  const ttl = Number(redis.run(["TTL", `nl:ai:file:${store.statsId}:runfilesave00001`]));
  is("kept a day at the most", ttl > 0 && ttl <= 86_400, true);
  is("taken once, then gone", [await takeFileSave(store, "runfilesave00001"), await takeFileSave(store, "runfilesave00001")], [true, false]);
  await grantFileSave(store, "runfilesave00002");
  unknownFor = (c) => c[0] === "GETDEL";
  is("a reply that cannot be read makes nothing", await takeFileSave(store, "runfilesave00002"), null);
  unknownFor = null;

  part("Only a draft that hands over nothing yet");
  is("a draft with nothing handed over", fileTargetProblem(listing({})), null);
  is("none", fileTargetProblem(null), "unknown");
  is("a published product", fileTargetProblem(listing({ hidden: false })), "published");
  const file: ProductFile = { pathname: "x", name: "x.pdf", bytes: 1, contentType: "application/pdf", addedAt: "" };
  is("one with a file, a link or price options", [fileTargetProblem(listing({ file })), fileTargetProblem(listing({ link: "https://example.com" })), fileTargetProblem(listing({ options: [{}] as Listing["options"] }))], ["has_file", "has_file", "has_file"]);
  is("a course, a call or a bundle", [fileTargetProblem(listing({ course: {} as Listing["course"] })), fileTargetProblem(listing({ call: {} as Listing["call"] })), fileTargetProblem(listing({ bundle: ["a"] }))], ["kind", "kind", "kind"]);

  part("The save: a tagged PDF in the store's own folder, attached, never published");
  const folder = "a".repeat(32);
  const draft = { title: "Weeknight Dinners", sections: [{ title: "Start here", body: "Buy rice.\n\nThen beans." }, { title: "Week one", body: "Cook on Monday." }] };
  type Log = { written: { pathname: string; bytes: Uint8Array }[]; attached: (ProductFile | null)[]; removed: string[]; room: string[]; released: string[] };
  const fake = (change: Partial<FileSaveIo> = {}): { io: FileSaveIo; log: Log } => {
    const log: Log = { written: [], attached: [], removed: [], room: [], released: [] };
    const io: FileSaveIo = {
      folder: async () => folder,
      reserveUpload: async () => true,
      reserveRoom: async (_f, size) => {
        log.room.push(String(size));
        return "r".repeat(32);
      },
      releaseRoom: async (_f, id) => {
        log.released.push(id);
      },
      write: async (pathname, data) => {
        log.written.push({ pathname, bytes: data });
        return true;
      },
      measure: async () => ({ size: log.written[0]?.bytes.byteLength ?? 0, contentType: "application/pdf" }),
      remove: async (pathname) => {
        log.removed.push(pathname);
      },
      attach: async (attached) => {
        log.attached.push(attached);
        return { ok: true, removed: null };
      },
      rememberOwner: async () => {},
      ...change,
    };
    return { io, log };
  };
  const good = fake();
  const saved = await saveAiFile(store, "prod000001", draft, good.io, new Date("2026-11-09T12:00:00Z"));
  is("kept", [saved.ok, saved.ok ? saved.file.contentType : null], [true, "application/pdf"]);
  is("written once, in the store's own folder for this product", [good.log.written.length, ownsVaultPath(good.log.written[0]?.pathname, folder, "prod000001")], [1, true]);
  const pdf = good.log.written[0]?.bytes ?? new Uint8Array();
  is("a real PDF, under the most a file may be", [new TextDecoder().decode(pdf.slice(0, 5)), pdf.byteLength > 0 && pdf.byteLength <= MAX_AI_FILE_BYTES], ["%PDF-", true]);
  is("attached as this product's file, named by its title", good.log.attached.map((f) => f?.name), ["Weeknight Dinners.pdf"]);
  is("its room reserved, then released", [good.log.room.length, good.log.released.length], [1, 1]);

  const full = fake({ reserveRoom: async () => null });
  is("storage full: nothing written or attached", [await saveAiFile(store, "prod000001", draft, full.io), full.log.written.length, full.log.attached.length], [{ ok: false, error: "storage_full" }, 0, 0]);
  const noUploads = fake({ reserveUpload: async () => false });
  is("no upload left: its room given back, nothing written", [await saveAiFile(store, "prod000001", draft, noUploads.io), noUploads.log.room.length, noUploads.log.released.length, noUploads.log.written.length], [{ ok: false, error: "upload_budget_unavailable" }, 1, 1, 0]);
  const unwritten = fake({ write: async () => false });
  is("a write that fails: nothing attached, room released", [await saveAiFile(store, "prod000001", draft, unwritten.io).then((r) => r.ok), unwritten.log.attached.length, unwritten.log.released.length], [false, 0, 1]);
  const mismeasured = fake({ measure: async () => ({ size: 1, contentType: "application/pdf" }) });
  const wrongSize = await saveAiFile(store, "prod000001", draft, mismeasured.io);
  is("a file the store measures otherwise: removed, never attached", [wrongSize.ok, mismeasured.log.removed.length, mismeasured.log.attached.length], [false, 1, 0]);
  const other: ProductFile = { pathname: `vault/${folder}/prod000001/${"b".repeat(16)}-mine.pdf`, name: "mine.pdf", bytes: 10, contentType: "application/pdf", addedAt: "" };
  let first = true;
  const raced = fake({
    attach: async (attached) => {
      raced.log.attached.push(attached);
      if (first) {
        first = false;
        return { ok: true, removed: other };
      }
      return { ok: true, removed: null };
    },
  });
  const changed = await saveAiFile(store, "prod000001", draft, raced.io);
  is("a file that arrived meanwhile is put back, and this one removed", [changed, raced.log.attached[1]?.name, raced.log.removed.length], [{ ok: false, error: "changed" }, "mine.pdf", 1]);
  const unreadable = fake();
  is("letters the PDF cannot draw: nothing made", [await saveAiFile(store, "prod000001", { ...draft, title: "東京の料理" }, unreadable.io), unreadable.log.written.length], [{ ok: false, error: "letters" }, 0]);

  part("Room and an upload before the PDF is drawn; the run's save given back only when nothing was drawn");
  // What each part of a save saw: the PDFs drawn before it, and the bytes it asked for.
  type Seen = { step: string; drawnBefore: number; bytes?: number };
  const watched = (change: Partial<FileSaveIo> = {}) => {
    const seen: Seen[] = [];
    const base = fake(change);
    const at = drawings.count;
    const io: FileSaveIo = {
      ...base.io,
      folder: async () => {
        seen.push({ step: "folder", drawnBefore: drawings.count - at });
        return base.io.folder();
      },
      reserveRoom: async (f, bytes) => {
        seen.push({ step: "reserveRoom", drawnBefore: drawings.count - at, bytes });
        return base.io.reserveRoom(f, bytes);
      },
      reserveUpload: async (bytes) => {
        seen.push({ step: "reserveUpload", drawnBefore: drawings.count - at, bytes });
        return base.io.reserveUpload(bytes);
      },
    };
    return { io, log: base.log, seen, drawn: () => drawings.count - at };
  };
  // The rule app/api/store/ai-file/route.ts gives the run's save back by.
  const givenBack = saveGivenBack;

  const kept = watched();
  is("kept", (await saveAiFile(store, "prod000001", draft, kept.io)).ok, true);
  is("room first, then the upload, both before the drawing", kept.seen.map((s) => [s.step, s.drawnBefore]), [["folder", 0], ["reserveRoom", 0], ["reserveUpload", 0]]);
  is("both at the most a file may be, since its size is not known before it is drawn", kept.seen.filter((s) => s.bytes !== undefined).map((s) => s.bytes), [MAX_AI_FILE_BYTES, MAX_AI_FILE_BYTES]);
  is("drawn once", kept.drawn(), 1);

  const noRoom = watched({ reserveRoom: async () => null });
  const noRoomResult = await saveAiFile(store, "prod000001", draft, noRoom.io);
  is("storage full: refused, with no upload of the month taken and nothing drawn", [noRoomResult, noRoom.seen.map((s) => s.step), noRoom.drawn()], [{ ok: false, error: "storage_full" }, ["folder", "reserveRoom"], 0]);
  const noUpload = watched({ reserveUpload: async () => false });
  const noUploadResult = await saveAiFile(store, "prod000001", draft, noUpload.io);
  is("no upload left: refused, nothing drawn, the room given back", [noUploadResult, noUpload.drawn(), noUpload.log.released.length], [{ ok: false, error: "upload_budget_unavailable" }, 0, 1]);

  // Every way a save can end without a file: the run's save comes back only when that save drew nothing.
  let firstAttach = true;
  const endings: [string, ReturnType<typeof watched>, FileDraft][] = [
    ["letters", watched(), { ...draft, title: "東京の料理" }],
    ["storage full", noRoom, draft],
    ["no upload left", noUpload, draft],
    ["a write that fails", watched({ write: async () => false }), draft],
    ["a file measured otherwise", watched({ measure: async () => ({ size: 1, contentType: "application/pdf" }) }), draft],
    ["an attach that fails", watched({ attach: async () => ({ ok: false, reason: "gone" }) }), draft],
    ["a file store that throws", watched({ rememberOwner: async () => { throw new Error("down"); } }), draft],
    [
      "a file that arrived meanwhile",
      watched({
        attach: async () => {
          if (!firstAttach) return { ok: true, removed: null };
          firstAttach = false;
          return { ok: true, removed: other };
        },
      }),
      draft,
    ],
  ];
  for (const [name, save, text] of endings) {
    const result = save === noRoom ? noRoomResult : save === noUpload ? noUploadResult : await saveAiFile(store, "prod000001", text, save.io);
    if (result.ok) throw new Error(`${name}: kept`);
    is(`${name} (${result.error}): the run's save comes back only when nothing was drawn`, givenBack(result.error), save.drawn() === 0);
  }
  is("a file that came out too big was drawn: its save does not come back", givenBack("too_big"), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
