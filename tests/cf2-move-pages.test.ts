/**
 * 239 [CF2], unit 1: "Move from [platform] to Marktmorgen" guides
 * (lib/migration-guides.ts, served at /platform/move-from-<platform> like the
 * existing ClickFunnels guide). Checked against the code, not against a plan:
 *
 *   - every line under "What comes across on its own" names an import that
 *     exists (lib/imports.ts IMPORT_LIMITS, the route's kinds, the studio's
 *     tab) and starts today on a store with no plan, so nothing promised is
 *     behind PLANS_ON_SALE; the members import and the email to past buyers,
 *     which need a paid plan, are never promised and are said to wait;
 *   - the figures are the code's own limits;
 *   - every source is the platform's own help center, with the date it was read;
 *   - the pages are out of the menu, in the sitemap, linked from the general
 *     moving page, and written in plain US English with no superiority claim;
 *   - a file's figure is not shown as what comes in today: each guide says the
 *     monthly rows the real import route admits (a 429 "rows_month" past it),
 *     and that a course or podcast with several prices can still be given, as
 *     a real import gives it (review of #3012: Codex T, review 5808096062).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/import/route";
import { addOption, addProduct, claimHandle, ensureListId, ensureStatsId, setProductCourse, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { IMPORT_MIN_ROWS_PER_UPLOAD } from "@/lib/import-limits";
import { addRows, finishUpload, runImport, startImport } from "@/lib/imports";
import { importedFor } from "@/lib/imported-purchases";
import { paidCourses } from "@/lib/learn";
import { emptyCourse, newItemId, saveCourse } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { MIGRATION_GUIDES, MOVE_CAPABILITIES, type MoveCapability } from "@/lib/migration-guides";
import { IMPORT_LIMITS, startProblem } from "@/lib/imports";
import { SWITCHING_WORDS } from "@/lib/switching-faq";
import { findPage, type TopicPage } from "@/lib/site-pages";
import sitemap from "@/app/sitemap";
import { britishCopyHits } from "./us-english-source";
import { done, is, part } from "./check";

const flat = (s: string) => s.replace(/\s+/g, " ");
const route = flat(readFileSync("app/api/store/import/route.ts", "utf8"));
const studio = flat(readFileSync("app/studio/import/page.tsx", "utf8"));
const none = { sid: "s".repeat(32), catalog: { items: [] }, subscriptionActive: false, subscriptionId: null, trialEnds: 0, stripeAccountId: "", stripeChargesEnabled: false, tier: "creator" } as never;
const go = (kind: Parameters<typeof startProblem>[1], extra: Record<string, unknown>) => startProblem(none, kind, { expected: 5, ...extra } as never)?.reason ?? null;

part("Each capability is an import that exists and is on today");
const caps = Object.entries(MOVE_CAPABILITIES) as [MoveCapability, (typeof MOVE_CAPABILITIES)[MoveCapability]][];
is("three capabilities: the list, products and past buyers", caps.map(([, c]) => c.kind), ["contacts", "products", "purchases"]);
for (const [key, cap] of caps) {
  is(`${key}: the limit is the code's own`, cap.limit, IMPORT_LIMITS[cap.kind]);
  is(`${key}: the studio's tab is its own words`, (SWITCHING_WORDS.tabs as readonly string[]).includes(cap.tab), true);
  is(`${key}: the import route takes this kind`, /const KINDS = new Set<ImportKind>\(\[[^\]]*"/.test(route) && route.includes(`"${cap.kind}"`), true);
  is(`${key}: the studio's import page offers this kind`, studio.includes(`kind: "${cap.kind}"`), true);
  is(`${key}: starts on a store with no plan (not behind the sales flags)`, go(cap.kind, cap.start), null);
}
is("members and the email to past buyers wait for a paid plan, so neither is a capability", [go("members", { stopped: true }) !== null, go("purchases", { email: true }) !== null], [true, true]);

part("The guides");
is("unit 1: Gumroad and Teachable", MIGRATION_GUIDES.map((g) => g.slug), ["move-from-gumroad", "move-from-teachable"]);
// Gumroad's help.gumroad.com/article pages now redirect to its generic help page; its articles are under gumroad.com/help/article/.
const sources: Record<string, string> = { Gumroad: "gumroad.com", Teachable: "support.teachable.com" };
const paths: Record<string, string> = { Gumroad: "/help/article/", Teachable: "/en/articles/" };
for (const guide of MIGRATION_GUIDES) {
  const page = findPage("platform", guide.slug) as TopicPage | undefined;
  const text = JSON.stringify(page);
  is(`${guide.platform}: published at /platform/${guide.slug}`, Boolean(page), true);
  is(`${guide.platform}: out of the menu`, page?.menu, undefined);
  is(`${guide.platform}: names the platform in its heading`, page?.title.includes(guide.platform), true);
  is(`${guide.platform}: read on a stated date`, guide.checked, "November 6, 2026");
  is(`${guide.platform}: every source is its own help center, over https`, guide.sources.length > 0 && guide.sources.every((s) => new URL(s.href).protocol === "https:" && new URL(s.href).host === sources[guide.platform] && new URL(s.href).pathname.startsWith(paths[guide.platform])), true);
  is(`${guide.platform}: each source has a label that says where it leads`, guide.sources.every((s) => s.label.startsWith(`${guide.platform}'s help center:`)), true);
  is(`${guide.platform}: at least one automatic line, each a known capability`, guide.moves.length > 0 && guide.moves.every((m) => m.capability in MOVE_CAPABILITIES), true);
  is(`${guide.platform}: each automatic line carries its code limit`, guide.moves.every((m) => `${m.title} ${m.body}`.includes(MOVE_CAPABILITIES[m.capability].limit.toLocaleString("en-US"))), true);
  is(`${guide.platform}: nothing automatic promises an email to buyers or members`, guide.moves.some((m) => /\bemail(ed)? (to )?(each|every|your) (buyer|member)|members?\b/i.test(m.title + " " + m.body)), false);
  is(`${guide.platform}: says members and the buyer email wait for a paid plan`, guide.notMoved.some((x) => /members/i.test(x) && /paid plan/i.test(x)), true);
  is(`${guide.platform}: things to redo by hand`, guide.byHand.length > 0, true);
  const blocks = (page?.blocks ?? []).map((b) => `${b.kind}:${"title" in b ? b.title : ""}`);
  is(`${guide.platform}: the page's sections, in order`, blocks.slice(0, 6), [
    `how:How a move from ${guide.platform} works`,
    "features:What comes across on its own",
    "limits:What you redo by hand",
    "limits:What does not come across",
    "terms:Words on this page",
    `features:Where the ${guide.platform} steps come from`,
  ]);
  const cited = (page?.blocks ?? []).find((b) => b.kind === "features" && b.title.startsWith("Where the")) as { items: { title: string; href?: string }[] } | undefined;
  is(`${guide.platform}: the sources are linked by their own label`, cited?.items.map((i) => [i.title, i.href]), guide.sources.map((s) => [s.label, s.href]));
  is(`${guide.platform}: no superiority claim or competitor figure`, /\b(best|better|fastest|easiest|cheaper|only platform|#1|number one)\b|\$\d/i.test(text), false);
  is(`${guide.platform}: says it is not affiliated`, text.includes(`${guide.platform} is a trademark of its owner. Marktmorgen is not affiliated with it`), true);
  const prose = [page?.intro ?? "", ...(page?.blocks ?? []).map((b) => ("intro" in b && typeof b.intro === "string" ? b.intro : "")), ...(page?.blocks ?? []).flatMap((b) => ("items" in b ? (b.items as unknown[]).map((i) => (typeof i === "string" ? i : Object.values(i as object).filter((v) => typeof v === "string" && !String(v).startsWith("http") && !String(v).startsWith("/")).join(". "))) : []))].join(" ");
  const sentences = prose.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  is(`${guide.platform}: no sentence over 30 words`, sentences.filter((s) => words(s) > 30), []);
  is(`${guide.platform}: sentences average under 18 words`, sentences.reduce((n, s) => n + words(s), 0) / sentences.length < 18, true);
  is(`${guide.platform}: the general moving page links to it`, JSON.stringify(findPage("platform", "switching-to-marktmorgen")).includes(`"href":"/platform/${guide.slug}"`), true);
  is(`${guide.platform}: in the sitemap`, sitemap().some((e) => e.url.endsWith(`/platform/${guide.slug}`)), true);
}
is("ClickFunnels keeps its own existing guide, not a second one", MIGRATION_GUIDES.some((g) => g.platform === "ClickFunnels"), false);

part("US English");
is("no British spelling in the guides' source", britishCopyHits("lib/migration-guides.ts", readFileSync("lib/migration-guides.ts", "utf8")), []);

const owner = "cf2-move@example.test";
async function seed() {
  redis.clear();
  await claimHandle(owner, "cf2move", "Synthetic move store", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const store = await storeForEmail(owner);
  if (!store || store.subscriptionActive) throw new Error("the synthetic store must exist with no plan");
  return store;
}
const automatic = (guide: (typeof MIGRATION_GUIDES)[number]) =>
  (findPage("platform", guide.slug) as TopicPage | undefined)?.blocks.find((b) => b.kind === "features" && b.title === "What comes across on its own") as { intro?: string } | undefined;

async function main(): Promise<void> {
  part("What comes in a month is what the real import route admits, and the guides say it");
  await seed();
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/import", { method: "POST", headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
  };
  const start = await post({ action: "start", kind: "contacts", expected: MOVE_CAPABILITIES.list.limit, file: "list.csv", agreed: true });
  const id = (start.data.import as { id?: string } | undefined)?.id;
  is("control: a file at the list's figure starts on a store with no plan", [start.status, typeof id], [200, "string"]);
  // Probe the month: uploads of 100 rows until the route refuses one, as the studio sends them.
  let taken = 0;
  let refused: { status: number; data: Record<string, unknown> } | null = null;
  for (let i = 0; i < 400 && !refused; i += 1) {
    const rows = Array.from({ length: 100 }, (_, j) => [String(taken + j + 2), `person${taken + j}@example.test`, "Synthetic", "", ""]);
    const r = await post({ action: "rows", id, rows });
    if (r.status === 200) taken += rows.length;
    else refused = r;
  }
  const month = Number(refused?.data.limit);
  is("the route refuses past the month's rows (429, rows_month), below the file's figure", [refused?.status, refused?.data.error, taken === month, month < MOVE_CAPABILITIES.list.limit], [429, "rows_month", true, true]);
  for (const guide of MIGRATION_GUIDES) {
    const intro = automatic(guide)?.intro ?? "";
    is(`${guide.platform}: "What comes across on its own" says the rows a month the route admits, all imports together`, [intro.includes(`at most ${month.toLocaleString("en-US")} rows a month`), /all of them together/.test(intro)], [true, true]);
    is(`${guide.platform}: says each upload counts at least its minimum`, intro.includes(`at least ${IMPORT_MIN_ROWS_PER_UPLOAD} rows`), true);
  }

  part("A course with several prices is given by a real import; a download with several prices is not; the guides say so");
  await seed();
  const course = await addProduct(owner, "Synthetic course", "", "20", null);
  const download = await addProduct(owner, "Synthetic download", "", "20", null);
  if (!course.ok || !download.ok) throw new Error("the synthetic products must be made");
  const lessons = emptyCourse();
  lessons.modules[0].lessons.push({ id: newItemId(), title: "Synthetic lesson", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null });
  await saveCourse(lessons, (await storeForEmail(owner))!);
  await setProductCourse(owner, course.product.id, { id: lessons.id, lessons: 1 });
  for (const productId of [course.product.id, download.product.id]) {
    await addOption(owner, productId, "Standard", "20");
    await addOption(owner, productId, "Extra", "30");
  }
  const store = (await storeForEmail(owner))!;
  is("control: both products have several prices", [course.product.id, download.product.id].map((pid) => (store.catalog.items.find((i) => i.id === pid)?.options.length ?? 0) > 1), [true, true]);
  const started = await startImport(store, owner, "purchases", { expected: 2, file: "buyers.csv", email: false } as never);
  if (!started.ok) throw new Error(`the purchases import must start: ${JSON.stringify(started)}`);
  await addRows(store, started.job.id, [["2", "student@example.test", "Synthetic course", "paid"], ["3", "buyer@example.test", "Synthetic download", "paid"]]);
  await finishUpload(store, started.job.id);
  let finished = await runImport(started.job.id, Date.now() + 10_000);
  for (let i = 0; i < 5 && finished?.state !== "done"; i += 1) finished = await runImport(started.job.id, Date.now() + 10_000);
  const after = (await storeForEmail(owner))!;
  const granted = (await importedFor(after, "student@example.test")).some((g) => g.productId === course.product.id);
  const entitled = (await paidCourses(after, "student@example.test")).has(course.product.id);
  const downloadGiven = (await importedFor(after, "buyer@example.test")).some((g) => g.productId === download.product.id);
  is("the real import: done, the course given and opened, the download refused", [finished?.state, finished?.counts.added, finished?.counts.errors, granted, entitled, downloadGiven], ["done", 1, 1, true, true, false]);
  for (const guide of MIGRATION_GUIDES) {
    const line = guide.notMoved.find((x) => /several prices/.test(x)) ?? "";
    is(`${guide.platform}: the several-prices line keeps the course and podcast exception`, [/\bcourse\b/.test(line), /\bpodcast\b/.test(line), /^Calls and products with several prices cannot be given/.test(line)], [true, true, false]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
