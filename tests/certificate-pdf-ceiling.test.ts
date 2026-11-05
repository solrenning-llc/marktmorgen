/**
 * What a certificate's PDF takes from its store before it is drawn
 * (app/[handle]/certificate/[id]/pdf/route.ts; C3, 4 November 2026): one of
 * the store's public requests before the record is read and the rest of
 * CERTIFICATE_PDF_UNITS before the file is made; a store past its requests
 * is answered honestly and nothing is drawn or kept by any cache. The sample
 * is kept by the CDN; a certificate, which can be withdrawn, by none: the
 * browser asks again each time and gets "not modified" only while it stands.
 * tests/plan-cost-registry.test.ts holds the units above what a file costs.
 */
import { NextRequest } from "next/server";
import { GET } from "@/app/[handle]/certificate/[id]/pdf/route";
import { CERTIFICATE_PDF_MAX_BYTES, CERTIFICATE_PDF_UNITS, certificatePdf } from "@/lib/certificate-pdf";
import { issueCertificate, withdrawCertificate } from "@/lib/certificate";
import { saveCourse, type Course } from "@/lib/course";
import { storeKey } from "@/lib/learn";
import { requestsIn } from "@/lib/traffic";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "kiln@example.com";

/** Every command sent to the store from here on. */
const sent: string[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(command.map(String).join(" "));
  return pipeline(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_kiln00001", subscriptionId: "sub_kiln00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Glazing basics", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const course: Course = { id: "e".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [{ id: "lesson000001", title: "First", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }] }] } as unknown as Course;
  await saveCourse(course, ROOM, true);
  const attached = await setProductCourse(OWNER, made.product.id, { id: course.id, lessons: 1 });
  if (!attached.ok) throw new Error(`no course: ${attached.reason}`);
  const store = (await storeForEmail(OWNER)) as Store;
  const issued = await issueCertificate({ store: storeKey(store), productId: made.product.id, course, title: "Glazing basics", creator: "Kiln Works", email: "ana@example.com", who: "ana", name: "Ana Lopes", room: ROOM });
  if (!issued.ok) throw new Error("no certificate");
  const id = issued.certificate.id;
  const folder = await storeFolder(OWNER);
  const window = allowanceWindow(store)!.id;
  const counter = `nl:traffic:r:${folder}:${window}`;
  const get = (path: string, headers: Record<string, string> = {}) =>
    GET(new NextRequest(`https://marktmorgen.com/@kilnworks/certificate/${path}`, { headers }), { params: Promise.resolve({ handle: "@kilnworks", id: path.split("/")[0] }) });

  part("Paid for before it is drawn");
  let before = await requestsIn(folder, window);
  const file = await get(`${id}/pdf`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  is("a certificate's file is drawn, as a PDF", [file.status, file.headers.get("content-type"), new TextDecoder().decode(bytes.slice(0, 5))], [200, "application/pdf", "%PDF-"]);
  is("and takes CERTIFICATE_PDF_UNITS of the store's requests", (await requestsIn(folder, window)) - before, CERTIFICATE_PDF_UNITS);
  is("no cache keeps it (it can be withdrawn): the browser asks again, with its tag", [file.headers.get("cache-control"), /^"[A-Za-z0-9_-]{32}"$/.test(file.headers.get("etag") ?? "")], ["private, no-cache", true]);

  part("Asked again, the same certificate");
  const tag = file.headers.get("etag")!;
  before = await requestsIn(folder, window);
  const same = await get(`${id}/pdf`, { "if-none-match": tag });
  is("not modified: nothing drawn, one request taken", [same.status, (await requestsIn(folder, window)) - before, (await same.arrayBuffer()).byteLength, same.headers.get("etag")], [304, 1, 0, tag]);
  is("a tag that is not its own: drawn again", (await get(`${id}/pdf`, { "if-none-match": "\"another-tag\"" })).status, 200);

  part("Withdrawn");
  await withdrawCertificate(course.id, id);
  before = await requestsIn(folder, window);
  const gone = await get(`${id}/pdf`, { "if-none-match": tag });
  is("its old tag gets nothing: not found, so no browser keeps showing it as standing", [gone.status, gone.headers.get("etag"), (await requestsIn(folder, window)) - before], [404, null, 1]);

  part("The sample");
  before = await requestsIn(folder, window);
  const sample = await get(`sample/pdf?product=${made.product.id}`);
  is("drawn for the public, kept by the CDN five minutes, with no tag", [sample.status, sample.headers.get("cache-control"), sample.headers.get("etag"), (await requestsIn(folder, window)) - before], [200, "public, max-age=0, s-maxage=300", null, CERTIFICATE_PDF_UNITS]);

  part("A store past its requests");
  const limit = requestLimitFor(store, Date.now() / 1000);
  await redis.pipeline([["SET", counter, String(limit)]]);
  sent.length = 0;
  const refused = await get(`sample/pdf?product=${made.product.id}`);
  is("refused honestly, and kept by no cache", [refused.status, refused.headers.get("cache-control"), (await refused.text()).length > 0], [503, "no-store", true]);
  is("nothing read for it: not its course", sent.some((c) => c.includes("nl:course:")), false);
  // One request left on the buyers' side: the record may be read, the file is not drawn.
  const second = issueCertificate({ store: storeKey(store), productId: made.product.id, course, title: "Glazing basics", creator: "Kiln Works", email: "ben@example.com", who: "ben", name: "Ben Ito", room: ROOM });
  const other = await second;
  if (!other.ok) throw new Error("no certificate");
  // The public side is full, the buyers' reserve is not: a certificate's public address does not spend it.
  const publicLimit = publicVisitLimit(limit);
  await redis.pipeline([["SET", counter, String(publicLimit)]]);
  const strangers = await get(`${other.certificate.id}/pdf`);
  is("a certificate is paid on the public side: refused once the public's requests are used, the buyers' reserve left", [publicLimit < limit, strangers.status, Number((await redis.pipeline([["GET", counter]]))[0]) <= limit], [true, 503, true]);
  await redis.pipeline([["SET", counter, String(publicLimit - 1)]]);
  const half = await get(`${other.certificate.id}/pdf`);
  is("with one request left: the record read, the file not drawn, refused", [half.status, half.headers.get("content-type"), half.headers.get("cache-control")], [503, "text/plain; charset=utf-8", "no-store"]);
  const source = (await import("node:fs")).readFileSync("app/[handle]/certificate/[id]/pdf/route.ts", "utf8");
  is("the rest is taken before the letters are checked and the file is made", source.indexOf("CERTIFICATE_PDF_UNITS - 1") > 0 && source.indexOf("CERTIFICATE_PDF_UNITS - 1") < source.indexOf("canDraw(certificate.name") && source.indexOf("canDraw(certificate.name") < source.indexOf("await certificatePdf(sheet)"), true);

  part("The heaviest file fits what it is priced at");
  const long = "Ãbçdéfghîjklmñöpqrstüvwxyz ÀBÇDÉFGHÎJKLMÑÖPQRSTÜVWXYZ Łódź Ελένη Анна ".repeat(4);
  let heaviest = 0;
  for (const font of ["modern", "editorial", "elegant", "friendly", "bold"] as const) {
    for (const backdrop of ["plain", "dots", "grid", "glow", "aurora"] as const) {
      const drawn = await certificatePdf({ name: long.slice(0, 80), title: long.slice(0, 200), storeName: long.slice(0, 80), kicker: "Certificate of completion", certifies: "This certifies that", hasCompleted: "has completed", taughtBy: `taught by ${long.slice(0, 80)}, on October 11, 2026`, idLine: "Certificate ID abcdefgh12345678 · Valid until October 11, 2027", checkLine: "Check it at marktmorgen.com/@kilnworks/certificate/abcdefgh12345678", stamp: "Sample", accent: "#5a36ee", lang: "en", look: { font, backdrop }, monogram: "K" });
      heaviest = Math.max(heaviest, drawn.length);
    }
  }
  is(`under CERTIFICATE_PDF_MAX_BYTES (${heaviest} bytes)`, heaviest <= CERTIFICATE_PDF_MAX_BYTES, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
