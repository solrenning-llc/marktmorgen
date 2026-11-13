/**
 * Issue #4304 (cost; decision by the coordinator, C2 to nuvem C on 13/11/2026: read at most MAX_LISTED_CERTS and
 * say "Showing 500 of N"; the exact words stay open for review).
 *
 * The studio's course page read every certificate of a course on each draw: one GET per certificate, with no
 * ceiling (1,965 commands at 2,000 certificates). Now certificatesFor reads at most MAX_LISTED_CERTS records, and
 * says how many exist (`total`) and whether it read them all (`partial`). The page then says "Showing X of N"
 * instead of counting only what it read as all of them, for the certificates and for the students (studentsOf
 * already reads at most 500, but the page counted "finished" over those 500 as if they were everyone).
 *
 * Against the Redis stand-in only; nothing real is reached.
 */
import { readFileSync } from "node:fs";
import { allKey, certKey, certificatesFor, MAX_LISTED_CERTS } from "@/lib/certificate";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);
const COURSE = "c".repeat(32);

function id(n: number): string {
  return `cert${String(n).padStart(12, "0")}`;
}

async function main(): Promise<void> {
  redis.clear();
  const many = MAX_LISTED_CERTS + 100;
  const writes: Commands = [];
  for (let n = 0; n < many; n += 1) {
    const record = { id: id(n), store: "storekey01", productId: "prod01", courseId: COURSE, name: `Student ${n}`, title: "Course", creator: "Shop", email: `s${n}@example.com`, issuedAt: 1_800_000_000 + n, withdrawnAt: 0 };
    writes.push(["SET", certKey(id(n)), JSON.stringify(record)], ["SADD", allKey(COURSE), id(n)]);
  }
  await realPipeline(writes);

  part("Reading a course's certificates has a ceiling");
  let commands = 0;
  redis.pipeline = async (batch: Commands) => {
    commands += batch.length;
    return realPipeline(batch);
  };
  const read = await certificatesFor(COURSE);
  redis.pipeline = realPipeline;
  is("at most one SMEMBERS and MAX_LISTED_CERTS reads", commands <= 1 + MAX_LISTED_CERTS, true);
  is("it lists at most MAX_LISTED_CERTS", read ? read.list.length : -1, MAX_LISTED_CERTS);
  is("it says how many exist", read?.total, many);
  is("and that it did not read them all", (read as { partial?: boolean } | null)?.partial, true);

  part("Under the ceiling, everything is read and nothing is partial");
  redis.clear();
  await realPipeline(writes.slice(0, 20));
  const few = await certificatesFor(COURSE);
  is("ten certificates: all listed, total ten, not partial", [few?.list.length, few?.total, (few as { partial?: boolean } | null)?.partial], [10, 10, false]);

  part("The page says what it shows");
  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  // Since unit A (tabs), each tab shows a page at a time with "Showing X–Y of N" and Previous/Next links.
  is("certificates: a pager over a page of them", /label="Pages of certificates"[\s\S]{0,200}total=\{certificates\.total\}/.test(page), true);
  is("certificates: the issued count is never one over a partial read", /standing = certificates && !certificates\.partial/.test(page), true);
  is("students: a pager over a page of them", /label="Pages of students"[\s\S]{0,200}total=\{total\}/.test(page), true);
  is("the pager says where the page sits", page.includes("`Showing ${first}–${last} of ${total === null ? `at least ${last}` : total}`"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
