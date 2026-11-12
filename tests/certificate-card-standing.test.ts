/**
 * The picture a certificate's shared link unfolds into
 * (app/[handle]/certificate/[id]/opengraph-image.tsx; audit R41, item 3).
 *
 * What is checked:
 *   - a certificate that stands is drawn with the holder's name; one that was
 *     withdrawn, or whose validity has run out (639 [GL7](32), validUntil in
 *     the past), unfolds into the store's name alone, as lib/certificate.ts
 *     standingOf and the page say;
 *   - the picture is paid for as the certificate's PDF is: one of the store's
 *     public requests before the record is read and the rest of
 *     CERTIFICATE_PDF_UNITS before anything is drawn, counted against the
 *     asking connection's share of the day too;
 *   - a store past its requests, or an address that names no store, draws
 *     nothing and reads no certificate.
 */
import OpengraphImage from "@/app/[handle]/certificate/[id]/opengraph-image";
import { certKey, issueCertificate, withdrawCertificate, type Certificate } from "@/lib/certificate";
import { CERTIFICATE_PDF_UNITS } from "@/lib/certificate-pdf";
import type { Course } from "@/lib/course";
import { storeKey } from "@/lib/learn";
import { requestsIn } from "@/lib/traffic";
import { clientDayShare, publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { drawn } from "./certificate-card-world";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "card-owner@example.com";
const HANDLE = "cardschool";

/** Every command sent to the store from here on. */
const sent: string[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(command.map(String));
  return pipeline(commands);
}) as typeof redis.pipeline;

function texts(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (node && typeof node === "object" && "props" in (node as Record<string, unknown>)) texts((node as { props: { children?: unknown } }).props.children, out);
  return out;
}

/** The card for this id: "image" with its words when a picture was drawn, or the status answered instead. */
async function cardFor(id: string, handle = `@${HANDLE}`): Promise<{ status: number | "image"; words: string }> {
  const before = drawn.length;
  const result: unknown = await OpengraphImage({ params: Promise.resolve({ handle, id }) });
  const words = drawn.length > before ? texts(drawn[drawn.length - 1]).join(" ") : "";
  return { status: result instanceof Response ? result.status : "image", words };
}

async function main(): Promise<void> {
  redis.clear();
  answering(null);
  await claimHandle(OWNER, HANDLE, "Card School", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_card00001", subscriptionId: "sub_card00001", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const course: Course = { id: "f".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [] }] } as unknown as Course;
  const issue = async (who: string, name: string) => {
    const made = await issueCertificate({ store: storeKey(store), productId: "prod_card", course, title: "Forklift Safety", creator: "Card School", email: `${who}@example.com`, who, name, room: ROOM });
    if (!made.ok) throw new Error("no certificate");
    return made.certificate;
  };
  const valid = await issue("ana", "Ana Example");
  const withdrawn = await issue("ben", "Ben Withdrawn");
  await withdrawCertificate(course.id, withdrawn.id);
  const now = Math.floor(Date.now() / 1000);
  const expired: Certificate = { ...(await issue("cy", "Cy Expired")), issuedAt: now - 400 * 86_400, validUntil: now - 30 * 86_400 };
  await redis.pipeline([["SET", certKey(expired.id), JSON.stringify(expired)]]);
  const folder = await storeFolder(OWNER);
  const window = allowanceWindow(store)!.id;
  const counter = `nl:traffic:r:${folder}:${window}`;

  part("What the picture says");
  is("a certificate that stands: drawn with the holder's name", await cardFor(valid.id).then((c) => [c.status, c.words.includes("Ana Example")]), ["image", true]);
  is("a withdrawn one: the store's name alone", await cardFor(withdrawn.id).then((c) => [c.status, c.words.includes("Ben Withdrawn"), c.words.includes("Card School")]), ["image", false, true]);
  is("one whose validity has run out: the store's name alone, never drawn as standing", await cardFor(expired.id).then((c) => [c.status, c.words.includes("Cy Expired"), c.words.includes("Card School")]), ["image", false, true]);

  part("Paid for as its PDF is");
  let before = await requestsIn(folder, window);
  await cardFor(valid.id);
  is("a picture takes CERTIFICATE_PDF_UNITS of the store's public requests", (await requestsIn(folder, window)) - before, CERTIFICATE_PDF_UNITS);
  before = await requestsIn(folder, window);
  await cardFor("0".repeat(16));
  is("an id that names no certificate is paid for too", (await requestsIn(folder, window)) - before, CERTIFICATE_PDF_UNITS);

  part("A store past its public requests");
  const publicLimit = publicVisitLimit(requestLimitFor(store, Date.now() / 1000));
  await redis.pipeline([["SET", counter, String(publicLimit)]]);
  sent.length = 0;
  let drawnBefore = drawn.length;
  const resting = await cardFor(valid.id);
  is("answered without a picture, its certificate not read", [resting.status, drawn.length - drawnBefore, sent.some((c) => c[0] === "GET" && c[1].startsWith("nl:cert:"))], [503, 0, false]);
  await redis.pipeline([["SET", counter, String(publicLimit - 1)]]);
  drawnBefore = drawn.length;
  is("with one request left: nothing drawn", [(await cardFor(valid.id)).status, drawn.length - drawnBefore], [503, 0]);
  await redis.pipeline([["DEL", counter]]);

  part("An address that names no store");
  drawnBefore = drawn.length;
  sent.length = 0;
  const nobody = await cardFor(valid.id, "@nobody-here");
  is("not found, nothing drawn, no certificate read", [nobody.status, drawn.length - drawnBefore, sent.some((c) => c[1]?.startsWith("nl:cert:"))], [404, 0, false]);

  part("One connection's share of the day");
  answering(new Request(`https://marktmorgen.com/@${HANDLE}/certificate/${valid.id}/opengraph-image`, { headers: { "x-forwarded-for": "203.0.113.41" } }));
  sent.length = 0;
  for (let i = 0; i < 5; i += 1) await cardFor(valid.id);
  const counted = sent.find((c) => c[0] === "HINCRBY" && c[1] === `nl:traffic:c:${folder}:${window}`);
  is("pictures asked for from one connection are counted against its share", Boolean(counted), true);
  if (counted) await redis.pipeline([["HSET", counted[1], counted[2], String(clientDayShare(requestLimitFor(store, Date.now() / 1000)))]]);
  const statuses: (number | "image")[] = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await cardFor(valid.id)).status);
  is("past its share, that connection gets no picture", statuses[statuses.length - 1], 503);
  answering(new Request(`https://marktmorgen.com/@${HANDLE}/certificate/${valid.id}/opengraph-image`, { headers: { "x-forwarded-for": "198.51.100.7" } }));
  is("while another connection still does", (await cardFor(valid.id)).status, "image");
  answering(null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
