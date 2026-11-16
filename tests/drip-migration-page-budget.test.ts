/**
 * The drip index's migration is priced once, not twice (line course-drip-index-migration; Claude 4 cloud V for #3344,
 * 16 November 2026).
 *
 * A course of the old global set has no card yet. In lib/learn.ts (walkPending) such a course takes one page of the
 * run's walk budget (`budget -= 1`), and on that page it does only two things: its card's room (one EVAL) and its card
 * (one SET NX), one card's bytes. The monthly line (course-drip-run) already pays DRIP_INDEX_PAGES_RUN full pages every
 * run, each DRIP_WALK_PAGE_COMMANDS commands and a card plus a page of student rows. So the card writes are inside a
 * page that line pays, and the migration line pays only what no page holds:
 * - the outlines, read at most once each through the drip walk's MGET (readCoursesEach): one MGET a run whose courses
 *   have no card, at most DRIP_INDEX_PAGES_RUN outlines in it, all outlines together at most the store's data room;
 * - the store's pending set and the stores' set, written once.
 *
 * Checked here:
 * - the model: a card write fits in a walk page, and the migration line does not count the cards again;
 * - the real code: one run writes at most DRIP_INDEX_PAGES_PER_RUN cards and student pages together, reads the
 *   outlines in one MGET of at most that many, and a run spent on cards walks no student page.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts) and the synthetic SES (tests/ses-mail-fixture.ts).
 */
import { claimHandle, setSubscription, storeForEmail, type Store } from "@/lib/store";
import * as learn from "@/lib/learn";
import { emailKey, sendDripEmails } from "@/lib/learn";
import { type Course } from "@/lib/course";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import * as R from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

const mail = installSesMailFixture({});
type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
const seen: Cmd[] = [];
redis.pipeline = (async (commands: Cmd[]) => {
  seen.push(...commands);
  return original(commands);
}) as typeof redis.pipeline;

const TIERS = ["creator", "pro", "scale"] as const;
const PAGES = (learn as unknown as Record<string, number>).DRIP_INDEX_PAGES_PER_RUN;
const NOW = Math.floor(Date.now() / 1000);
const OWNER = "drip-migration@example.com";
const ORIGIN = "https://marktmorgen.com";
const lesson = { id: "lesson000001", title: "First", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null };
const hex = (n: number) => n.toString(16).padStart(32, "0");
const courseOf = (id: string) =>
  ({ id, certificate: false, startsAt: null, modules: [{ id: "module000001", title: "Later", dripDays: 30, lessons: [lesson] }] }) as unknown as Course;

part("The model: a card write fits in a walk page the monthly line already pays");
{
  // walkPending's card path: noteData (one EVAL, lib/store-data.ts run) and the card's SET NX.
  const CARD_WRITE_COMMANDS = 2;
  is("a card write's commands are within a walk page's", CARD_WRITE_COMMANDS <= R.DRIP_WALK_PAGE_COMMANDS, true);
  const pageBytes = R.DRIP_CARD_MAX_BYTES + R.DRIP_PAGE_HINT * R.DRIP_PAGE_ROWS * R.DRIP_ROW_MAX_BYTES;
  is("a card write's bytes are within a walk page's", R.DRIP_CARD_MAX_BYTES <= pageBytes, true);
  is("the monthly line's walk budget is the code's", R.DRIP_INDEX_PAGES_RUN, PAGES);
}

part("The migration line counts the outlines and the sets, never the cards a second time");
for (const tier of TIERS) {
  const outlineReads = Math.ceil(MAX_PRODUCTS / R.DRIP_INDEX_PAGES_RUN);
  const expected = (outlineReads + 3) * R.COMMAND + (DATA_ROOM_BYTES[tier] + MAX_PRODUCTS * R.DRIP_PENDING_MEMBER_BYTES) * R.DB_BYTE;
  is(`${tier}: the migration is its outline reads and its sets (${R.dripMigrationUsd(tier).toFixed(6)})`, Math.abs(R.dripMigrationUsd(tier) - expected) < 1e-12, true);
  const cards = 2 * MAX_PRODUCTS * R.COMMAND + MAX_PRODUCTS * R.DRIP_CARD_MAX_BYTES * R.DB_BYTE;
  is(`${tier}: the cards (2 × MAX_PRODUCTS commands, MAX_PRODUCTS cards' bytes) are not in it again`, R.dripMigrationUsd(tier) + cards - expected >= cards - 1e-12 && R.dripMigrationUsd(tier) - expected < 1e-12, true);
}

async function setup(courses: Course[]): Promise<Store> {
  redis.clear();
  mail.configure();
  await claimHandle(OWNER, "drip-migration-shop", "Drip Migration Shop", "");
  await setSubscription(OWNER, { customerId: "cus_DripMigrate01", subscriptionId: "sub_DripMigrate01", active: true, tier: "creator", cycle: "month", trialEnds: 0, period: paidPeriod() });
  const real = (await storeForEmail(OWNER))!;
  const products = courses.map((course, n) => ({ id: `prod${String(n).padStart(8, "0")}`, title: `Course ${n}`, summary: "", priceCents: 6900, createdAt: 1, course: { id: course.id } }));
  return { ...real, catalog: { ...real.catalog, items: products.map((p) => ({ id: p.id })), inline: products } } as unknown as Store;
}

async function main(): Promise<void> {
  part("The real code: cards and student pages share one budget a run");
  {
    const courses = Array.from({ length: PAGES + 4 }, (_, n) => courseOf(hex(n + 1)));
    const store = await setup(courses);
    const byId = new Map(courses.map((c) => [c.id, c]));
    await original(
      courses.flatMap((course, n): Cmd[] => [
        ["SADD", "nl:courses:drip", `${course.id}|${store.handle}|prod${String(n).padStart(8, "0")}`],
        ["HSET", `nl:course:${course.id}:students`, emailKey(`s${n}@example.com`), JSON.stringify({ e: `s${n}@example.com`, s: NOW - 3600, l: NOW })],
      ]),
    );
    const asked: string[][] = [];
    const loadCourses = async (ids: string[]) => {
      asked.push(ids);
      return new Map<string, Course | null | "unknown">(ids.map((id) => [id, byId.get(id) ?? null]));
    };
    const runOnce = () => sendDripEmails(async (h) => (h === store.handle ? store : null), async (id) => byId.get(id) ?? null, ORIGIN, NOW, Date.now() + 60_000, loadCourses);
    const cardsWritten = () => seen.filter((c) => c[0] === "SET" && String(c[1]).startsWith("nl:drip:card:")).length;
    const pagesWalked = () => seen.filter((c) => c[0] === "HSCAN").length;

    const perRun: { cards: number; pages: number; asked: number }[] = [];
    for (let n = 0; n < courses.length && perRun.reduce((sum, r) => sum + r.cards, 0) < courses.length; n += 1) {
      seen.length = 0;
      const before = asked.length;
      await runOnce();
      perRun.push({ cards: cardsWritten(), pages: pagesWalked(), asked: asked.slice(before).reduce((sum, ids) => sum + ids.length, 0) });
    }
    is("the first run writes cards", (perRun[0]?.cards ?? 0) > 0, true);
    is("each card takes a page of the run's budget: cards and student pages together never pass it", perRun.every((r) => r.cards + r.pages <= PAGES), true);
    is("each run reads its outlines in at most one call of at most the budget", perRun.every((r) => r.asked <= PAGES) && asked.every((ids) => ids.length <= PAGES), true);
    is("every course gets its card, each once", [perRun.reduce((sum, r) => sum + r.cards, 0), courses.length], [courses.length, courses.length]);
    // The code itself, so the model above is held to it: a cardless course spends its page before its card is written.
    const code = (await import("node:fs")).readFileSync("lib/learn.ts", "utf8");
    const at = code.indexOf("A course of the old set, with no card yet");
    is("walkPending takes the page from the budget before a card is written", at > 0 && /budget -= 1;[\s\S]{0,900}noteData\(store, \[cardRoom/.test(code.slice(at, at + 1200)), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
