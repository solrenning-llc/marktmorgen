/**
 * Issue #4304 (Claude 2 C, cost MEDIUM; Claude 6 block of the coordinator's split, 5437), part A: the certificates.
 * The studio's course page (app/studio/course/[product]/page.tsx) draws certificatesFor (lib/certificate.ts) on every
 * visit, and it read every certificate the course ever issued (SMEMBERS of the course's set, then one GET each)
 * before keeping the newest MAX_LISTED_CERTS. A studio page is priced at STUDIO_PAGE_UNITS units of about 20 commands
 * (tests/plan-cost-registry.ts, the "studio" line), so a course with 2,000 certificates paid about 25 times that on
 * every draw, growing with every student who finished. One draw now reads a bounded page, whatever the course holds.
 * Synthetic records, the in-memory Redis.
 */
import { allKey, certKey, certificatesFor } from "@/lib/certificate";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COURSE = "c".repeat(12);
const ISSUED = 2_000;

async function main(): Promise<void> {
  redis.clear();
  for (let i = 0; i < ISSUED; i += 1) {
    const id = i.toString(36).padStart(16, "a");
    redis.run(["SADD", allKey(COURSE), id]);
    redis.run(["SET", certKey(id), JSON.stringify({ id, name: "Ada Student", title: "Course", store: "shop", creator: "Shop", courseId: COURSE, productId: "p", email: "a@example.com", issuedAt: 1_700_000_000 + i, withdrawnAt: 0 })]);
  }
  const real = redis.pipeline.bind(redis);
  let commands = 0;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    commands += batch.length;
    return real(batch);
  }) as typeof redis.pipeline;

  part(`A course with ${ISSUED} certificates: one studio draw reads a bounded page`);
  const read = await certificatesFor(COURSE);
  is(`the draw sends at most a studio page's ${STUDIO_PAGE_UNITS * 20} commands (it sent ${commands})`, commands <= STUDIO_PAGE_UNITS * 20, true);
  is("it still knows how many were issued", read?.total ?? null, ISSUED);
  is("and lists the newest first", read?.list[0]?.issuedAt ?? null, 1_700_000_000 + ISSUED - 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
