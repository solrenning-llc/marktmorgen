/**
 * A certificate's page (app/[handle]/certificate/[id]/page.tsx) is paid for
 * before it reads: its title and its body share one load, which takes one of
 * the store's public requests (lib/traffic.ts, isResting) before the
 * certificate, or the sample's listing and course, is read (anonymous-traffic
 * audit; R20 finding 3 counted the body only).
 *
 * What is checked, against the in-memory Redis double and a synthetic store:
 *   - the tab's title alone takes one public request, as the body does;
 *   - a store past its public requests reads no certificate, listing or
 *     course for the title or the body, and the body says the store rests;
 *   - an admission reply that is not a count (CX-123 rule 24) reads nothing
 *     either;
 *   - the title and the body are one load (React cache), so a page drawn is
 *     one request in production;
 *   - what one load sends to Redis stays inside a later page's commands
 *     (tests/traffic-cost.ts, COMMANDS.laterPage + COMMANDS.laterCount), the
 *     figure each public request is priced at (tests/plan-cost-registry.ts).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import CertificatePage, { generateMetadata } from "@/app/[handle]/certificate/[id]/page";
import { StoreResting } from "@/components/store-resting";
import { coursesWords } from "@/lib/buyer-words/courses";
import { saveCourse, type Course } from "@/lib/course";
import { storeKey } from "@/lib/learn";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { requestsIn } from "@/lib/traffic";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { COMMANDS } from "./traffic-cost";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "certpage-owner@example.com";
const HANDLE = "certpageschool";
const CERT_ID = "certpage00000001";

/** Every command sent to the store from here on. */
const sent: string[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(command.map(String));
  return pipeline(commands);
}) as typeof redis.pipeline;

/** Whether any command since `from` touched a certificate, a listing or a course. */
const readContent = (from: number) => sent.slice(from).some((c) => c.slice(1).some((k) => /^nl:(cert|course|catalog):/.test(k)));

async function main(): Promise<void> {
  redis.clear();
  answering(new NextRequest(`https://marktmorgen.com/@${HANDLE}/certificate/${CERT_ID}`, { headers: { "x-forwarded-for": "203.0.113.17" } }));
  await claimHandle(OWNER, HANDLE, "Cert Page School", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_certpage01", subscriptionId: "sub_certpage01", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Kiln safety", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const product = made.product.id;
  const course = { id: "e".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [] }] } as unknown as Course;
  await saveCourse(course, ROOM, true);
  if (!(await setProductCourse(OWNER, product, { id: course.id, lessons: 0 })).ok) throw new Error("no course");
  const store = (await storeForEmail(OWNER)) as Store;
  const issuedAt = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([["SET", `nl:cert:${CERT_ID}`, JSON.stringify({ id: CERT_ID, store: storeKey(store), productId: product, courseId: course.id, name: "Ada Student", title: "Kiln safety", creator: "Cert Page School", email: "ada@example.com", issuedAt, withdrawnAt: 0 })]]);
  const folder = await storeFolder(OWNER);
  const window = allowanceWindow(store)!.id;
  const counter = `nl:traffic:r:${folder}:${window}`;
  const visits = `nl:traffic:n:${folder}:${window}`;
  const w = coursesWords(store.language);

  const args = (id: string) => ({ params: Promise.resolve({ handle: `@${HANDLE}`, id }), searchParams: Promise.resolve(id === "sample" ? { product } : {}) });
  const title = async (id: string) => String((await generateMetadata(args(id))).title);
  const body = async (id: string) => (await CertificatePage(args(id))) as { type?: unknown };
  const counted = async (run: () => Promise<unknown>) => {
    const before = await requestsIn(folder, window);
    await run();
    return (await requestsIn(folder, window)) - before;
  };

  part("With room: the title is paid for as the body is");
  is("a certificate's title names its holder", await title(CERT_ID), w.metaCert("Ada Student", "Kiln safety"));
  is("the title alone takes one of the store's public requests", await counted(() => title(CERT_ID)), 1);
  is("the sample's title alone takes one too", await counted(() => title("sample")), 1);
  is("the body takes one", await counted(() => body(CERT_ID)), 1);
  is("an id that names no certificate takes one too", await counted(() => title("0".repeat(16))), 1);

  part("What one load sends stays inside a later page's commands");
  for (const id of [CERT_ID, "sample"]) {
    let from = sent.length;
    await body(id);
    const page = sent.length - from;
    from = sent.length;
    await title(id);
    const tab = sent.length - from;
    is(`${id === "sample" ? "the sample" : "a certificate"}: body and title each at most ${COMMANDS.laterPage + COMMANDS.laterCount} commands (${page}, ${tab})`, [page <= COMMANDS.laterPage + COMMANDS.laterCount, tab <= COMMANDS.laterPage + COMMANDS.laterCount], [true, true]);
  }

  part("A store past its public requests reads nothing");
  const publicLimit = publicVisitLimit(requestLimitFor(store, Date.now() / 1000));
  await redis.pipeline([["SET", counter, String(publicLimit)]]);
  for (const id of [CERT_ID, "sample"]) {
    let from = sent.length;
    const tab = await title(id);
    is(`${id === "sample" ? "the sample's" : "a certificate's"} title: no certificate, listing or course read, no name shown`, [readContent(from), tab.includes("Ada Student") || tab.includes("Kiln safety")], [false, false]);
    from = sent.length;
    const page = await body(id);
    is(`${id === "sample" ? "the sample's" : "a certificate's"} body: the store resting, nothing read`, [page.type === StoreResting, readContent(from)], [true, false]);
  }
  await redis.pipeline([["DEL", counter]]);

  part("An admission reply that is not a count reads nothing (CX-123 rule 24)");
  await redis.pipeline([["SET", visits, "not-a-count"]]);
  let from = sent.length;
  const tab = await title(CERT_ID);
  const page = await body(CERT_ID);
  is("title and body: no certificate read, the store resting", [readContent(from), tab.includes("Ada Student"), page.type === StoreResting], [false, false, true]);
  await redis.pipeline([["DEL", visits]]);
  from = sent.length;
  is("with the count readable again, the certificate is read", [await title(CERT_ID), readContent(from)], [w.metaCert("Ada Student", "Kiln safety"), true]);

  part("One load for the title and the body");
  const source = readFileSync("app/[handle]/certificate/[id]/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the load is shared within a request (React cache), so a page drawn is one request", source.includes("const load = cache(async (") && !source.includes("counted = false"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
