/**
 * 239 [CF2], unit 1, review of #3012 (Codex T, 5808096062): the guides' public sentences held against what the
 * import really admits, with the code's own runtime controls unchanged (no quota, gate, price or entitlement moved).
 *
 *   - MEDIUM: "Your list, up to 50,000 a file" under "What comes across on its own", on a page badged "Working
 *     today", while a store brings in IMPORT_ALLOWANCES rows a month in all (1,000 on a store with no plan, every
 *     upload counting at least IMPORT_MIN_ROWS_PER_UPLOAD). The section now says the month's figure, per plan when
 *     plans are on sale, and the figure it says is the one the real route admits: that many rows pass, one more is
 *     refused (429 rows_month), and a one-row upload counts as the minimum it states.
 *   - LOW: "Calls and products with several prices cannot be given to past buyers", while a course or a podcast with
 *     several prices is given (lib/imports.ts classifyPurchases). The sentence now says the exception, and the real
 *     import is held to it both ways: the course is given, a plain product with several prices is not.
 *
 * Codex T's own probe (d0103e1f, tests/t-3012-migration-guides.proof.ts) stays as the history of the old sentences;
 * this is the permanent regression of the corrected ones. Synthetic only, through the real routes and the in-memory
 * Redis stand-in.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/import/route";
import { addOption, addProduct, claimHandle, ensureListId, ensureStatsId, setProductCourse, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { IMPORT_ALLOWANCES, IMPORT_MIN_ROWS_PER_UPLOAD, importRowsFor } from "@/lib/import-limits";
import { PLAN_TITLES } from "@/lib/plan";
import type { Tier } from "@/lib/plan";
import { addRows, finishUpload, runImport, startImport } from "@/lib/imports";
import { paidCourses } from "@/lib/learn";
import { emptyCourse, newItemId, saveCourse } from "@/lib/course";
import { MIGRATION_GUIDES, migrationGuidePage, migrationGuides } from "@/lib/migration-guides";
import { PAGES } from "@/lib/site-pages";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const fmt = (n: number) => n.toLocaleString("en-US");
type Features = { kind: string; title: string; intro?: string; items: { title: string; body: string }[] };
const moving = (onSale: boolean, i: number) => (migrationGuidePage(migrationGuides(onSale)[i]).blocks as unknown as Features[]).find((b) => b.kind === "features" && b.title === "What comes across on its own");

async function seed(owner: string, handle: string) {
  await claimHandle(owner, handle, "Synthetic migration store", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const store = (await storeForEmail(owner))!;
  if (store.subscriptionActive) throw new Error("the synthetic store must have no plan");
  return store;
}

async function main(): Promise<void> {
  redis.clear();

  part("What the section says moves in a month, on every guide");
  const planless = IMPORT_ALLOWANCES.creator.rows;
  for (let i = 0; i < MIGRATION_GUIDES.length; i += 1) {
    const p = MIGRATION_GUIDES[i].platform;
    for (const onSale of [false, true]) {
      const block = moving(onSale, i);
      const intro = block?.intro ?? "";
      const when = onSale ? "plans on sale" : "plans not on sale";
      is(`${p}, ${when}: the section says a month's rows, all imports together`, /a month/.test(intro) && /all (these )?imports together|in all/.test(intro), true);
      is(`${p}, ${when}: a store with no plan: ${fmt(planless)} rows a month`, intro.includes(`${fmt(planless)} rows a month`), true);
      is(`${p}, ${when}: each upload counts at least ${IMPORT_MIN_ROWS_PER_UPLOAD} rows`, intro.includes(`at least ${IMPORT_MIN_ROWS_PER_UPLOAD} rows`), true);
      for (const tier of ["pro", "scale"] as Tier[]) {
        const said = intro.includes(`${PLAN_TITLES[tier]}, ${fmt(IMPORT_ALLOWANCES[tier].rows)}`);
        is(`${p}, ${when}: ${PLAN_TITLES[tier]}'s ${fmt(IMPORT_ALLOWANCES[tier].rows)} rows named only while plans are on sale`, said, onSale);
      }
      is(`${p}, ${when}: no line's title reads the file's figure as what moves ("up to N a file")`, (block?.items ?? []).filter((m) => /up to [\d,]+ a file/.test(m.title)).map((m) => m.title), []);
    }
  }

  // Rule 30: the same two sentences on the other public pages (the general moving page, the email and course pages,
  // their questions and the comparisons). A file's import figure is never said without the month's rows, in the
  // same sentence or in its section's introduction; "several prices cannot be given" never without its exception.
  part("The same figures and the same exception on every other public page");
  const perFile = /\b(50,000|20,000|500)\b[^.;]*\ba file\b|\bfile of up to (50,000|20,000|500)\b/;
  const strings = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : []);
  const unqualified: string[] = [];
  const noException: string[] = [];
  for (const page of PAGES) {
    for (const block of (page.blocks ?? []) as unknown as Record<string, unknown>[]) {
      const sectionSays = typeof block.intro === "string" && block.intro.includes("rows a month");
      for (const text of strings(block)) {
        if (perFile.test(text) && !sectionSays && !text.includes("rows a month")) unqualified.push(`${page.slug}: ${text.slice(0, 90)}`);
        if (/several prices cannot be given/.test(text) && !(/course/.test(text) && /podcast/.test(text))) noException.push(`${page.slug}: ${text.slice(0, 90)}`);
      }
    }
  }
  is("no import figure a file without the month's rows", unqualified, []);
  is("no 'several prices cannot be given' without the course or podcast exception", noException, []);

  part("The month's figure the page says is what the real route admits (no plan)");
  const owner = "move-claims@example.com";
  let store = await seed(owner, "moveclaims");
  is("control: the store's month is the figure the page says", importRowsFor(store), planless);
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/import", { method: "POST", headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie }, body: JSON.stringify(body) }));
    const data = (await response.json()) as { error?: string; limit?: number; import?: { id: string } };
    return { status: response.status, error: data.error ?? "ok", limit: data.limit, id: data.import?.id };
  };
  const started = await post({ action: "start", kind: "contacts", expected: 50_000, file: "synthetic.csv", agreed: true });
  is("a file of up to 50,000 rows starts", started.status, 200);
  const row = (line: number) => [String(line), `person${line}@example.com`, "Synthetic", "", ""];
  is("a one-row upload is taken", (await post({ action: "rows", id: started.id, rows: [row(2)] })).status, 200);
  const rest = planless - IMPORT_MIN_ROWS_PER_UPLOAD;
  is(`after it counted ${IMPORT_MIN_ROWS_PER_UPLOAD} rows, ${fmt(rest)} more are taken`, (await post({ action: "rows", id: started.id, rows: Array.from({ length: rest }, (_, k) => row(k + 3)) })).status, 200);
  const over = await post({ action: "rows", id: started.id, rows: [row(rest + 3)] });
  is(`one row past ${fmt(planless)} in the month is refused, with that figure`, [over.status, over.error, over.limit], [429, "rows_month", planless]);

  part("Several prices: the sentence says the exception, and the real import keeps to it");
  for (const guide of MIGRATION_GUIDES) {
    const line = guide.notMoved.find((x) => /several prices/.test(x)) ?? "";
    is(`${guide.platform}: says a product with several prices cannot be given`, /several prices/.test(line), true);
    is(`${guide.platform}: says a course or a podcast with several prices can`, /course/.test(line) && /podcast/.test(line), true);
    is(`${guide.platform}: says calls cannot be given`, guide.notMoved.some((x) => /\bcalls?\b/i.test(x) && /cannot be given/.test(x)), true);
  }
  const owner2 = "move-prices@example.com";
  store = await seed(owner2, "moveprices");
  const course = await addProduct(owner2, "Synthetic course", "", "20", null);
  const plain = await addProduct(owner2, "Synthetic guide", "", "20", null);
  if (!course.ok || !plain.ok) throw new Error("synthetic products not made");
  const lessons = emptyCourse();
  lessons.modules[0].lessons.push({ id: newItemId(), title: "Synthetic lesson", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null });
  await saveCourse(lessons, store);
  is("control: the course has its lesson", (await setProductCourse(owner2, course.product.id, { id: lessons.id, lessons: 1 })).ok, true);
  for (const id of [course.product.id, plain.product.id]) {
    await addOption(owner2, id, "Standard", "20");
    await addOption(owner2, id, "Extra", "30");
  }
  store = (await storeForEmail(owner2))!;
  is("control: both have two prices", [course.product.id, plain.product.id].map((id) => store.catalog.items.find((p) => p.id === id)?.options.length), [2, 2]);
  const job = await startImport(store, owner2, "purchases", { expected: 2, file: "buyers.csv", email: false });
  if (!job.ok) throw new Error(`purchases import not started: ${JSON.stringify(job)}`);
  await addRows(store, job.job.id, [["2", "student@example.com", "Synthetic course", "paid"], ["3", "reader@example.com", "Synthetic guide", "paid"]]);
  await finishUpload(store, job.job.id);
  let finished = await runImport(job.job.id, Date.now() + 10_000);
  for (let k = 0; k < 5 && finished?.state !== "done"; k += 1) finished = await runImport(job.job.id, Date.now() + 10_000);
  is("the import finishes: the course row given, the plain product's row left out", [finished?.state, finished?.counts.added], ["done", 1]);
  const current = (await storeForEmail(owner2))!;
  is("the student is given the course with several prices", (await paidCourses(current, "student@example.com")).has(course.product.id), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
